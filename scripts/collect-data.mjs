import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKPOINT_ID = "a9173a85-3fc0-424c-84f0-defa632481e4";
const API_ROOT = "https://belarusborder.by/info";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_PATH = resolve(ROOT, "data/history.json");
const DETAILS_RETENTION_MS = 72 * 60 * 60 * 1000;
const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function endpoint(pathname) {
  const url = new URL(`${API_ROOT}/${pathname}`);
  url.searchParams.set("token", "test");
  url.searchParams.set("checkpointId", CHECKPOINT_ID);
  url.searchParams.set("_", Date.now().toString());
  return url;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function fetchJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "User-Agent": "boardline-monitor/1.0",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      const data = JSON.parse(text);

      return {
        data,
        hash: createHash("sha256").update(text).digest("hex").slice(0, 16),
        headers: {
          responseDate: response.headers.get("date"),
          cacheControl: response.headers.get("cache-control"),
          age: response.headers.get("age"),
        },
      };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(2_000);
    }
  }

  throw lastError;
}

function parseMinskDate(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;

  const [, hour, minute, second, day, month, year] = match.map(Number);
  const utcMilliseconds = Date.UTC(year, month - 1, day, hour - 3, minute, second);
  const parsed = new Date(utcMilliseconds);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message.slice(0, 180);
  return String(error).slice(0, 180);
}

function sourceResult(result, previous) {
  if (result.status === "rejected") {
    return { state: "error", error: errorMessage(result.reason) };
  }

  const repeatCount = previous?.hash === result.value.hash ? (previous.repeatCount ?? 1) + 1 : 1;
  return {
    state: "ok",
    hash: result.value.hash,
    repeatCount,
    ...result.value.headers,
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function toVehicleTimeline(queue) {
  return queue.map((vehicle) => ({
    registrationAt: parseMinskDate(vehicle?.registration_date),
    changedAt: parseMinskDate(vehicle?.changed_date),
    orderId: numberOrNull(vehicle?.order_id),
    status: numberOrNull(vehicle?.status),
    typeQueue: numberOrNull(vehicle?.type_queue),
  }));
}

function countValues(queue, field) {
  return queue.reduce((counts, vehicle) => {
    const raw = numberOrNull(vehicle?.[field]);
    const key = raw === null ? "null" : String(raw);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function getQueueComposition(queue) {
  const withOrderId = queue.filter((vehicle) => numberOrNull(vehicle?.order_id) !== null).length;
  return {
    statusCounts: countValues(queue, "status"),
    typeQueueCounts: countValues(queue, "type_queue"),
    withOrderId,
    withoutOrderId: queue.length - withOrderId,
  };
}

function findHourlyReference(snapshots, collectedAt) {
  const collectedMs = Date.parse(collectedAt);
  return snapshots
    .map((snapshot) => ({
      snapshot,
      hours: (collectedMs - Date.parse(snapshot.collectedAt)) / 3_600_000,
    }))
    .filter(
      ({ snapshot, hours }) =>
        typeof snapshot.queueLength === "number" && hours >= 0.75 && hours <= 1.5,
    )
    .sort((left, right) => Math.abs(left.hours - 1) - Math.abs(right.hours - 1))[0] ?? null;
}

function getQueueTiming(vehicleTimeline, collectedAt) {
  const registrations = vehicleTimeline
    .map((vehicle) => vehicle.registrationAt)
    .filter(Boolean)
    .sort();
  const changes = vehicleTimeline
    .map((vehicle) => vehicle.changedAt)
    .filter(Boolean)
    .sort();
  const collectedMs = Date.parse(collectedAt);
  const waitingHours = registrations
    .map((date) => (collectedMs - Date.parse(date)) / 3_600_000)
    .filter((hours) => Number.isFinite(hours) && hours >= 0);

  return {
    oldestRegistrationAt: registrations[0] ?? null,
    newestRegistrationAt: registrations.at(-1) ?? null,
    latestChangedAt: changes.at(-1) ?? null,
    medianWaitingHours: waitingHours.length ? Number(median(waitingHours).toFixed(2)) : null,
  };
}

function assessFreshness({ source, queueTiming, collectedAt }) {
  const warnings = [];
  const successfulSources = [source.statistics, source.monitoring].filter((item) => item.state === "ok").length;

  if (successfulSources === 0) {
    return { freshness: "unavailable", warnings: ["Оба API недоступны — текущие значения не получены."] };
  }

  if (successfulSources === 1) {
    warnings.push("Получен ответ только одного API — данные неполные.");
  }

  let monitoringAgeMinutes = null;
  if (queueTiming?.latestChangedAt) {
    monitoringAgeMinutes = (Date.parse(collectedAt) - Date.parse(queueTiming.latestChangedAt)) / 60_000;
    if (monitoringAgeMinutes > 180) {
      warnings.push(`Последнее изменение в очереди было ${Math.round(monitoringAgeMinutes)} мин назад.`);
    }
  } else if (source.monitoring.state === "ok") {
    warnings.push("В monitoring-new нет времени последнего изменения; свежесть нельзя подтвердить.");
  }

  if ((source.monitoring.repeatCount ?? 0) >= 3) {
    warnings.push("Ответ monitoring-new повторился без изменений не менее трёх раз.");
  }

  if ((source.statistics.repeatCount ?? 0) >= 3) {
    warnings.push("Ответ statistics повторился без изменений не менее трёх раз.");
  }

  if (successfulSources === 1) return { freshness: "partial", warnings };

  const looksStale =
    monitoringAgeMinutes === null ||
    monitoringAgeMinutes > 180 ||
    (source.monitoring.repeatCount ?? 0) >= 3 ||
    (source.statistics.repeatCount ?? 0) >= 3;

  return {
    freshness: looksStale ? "possibly_stale" : "fresh",
    warnings,
  };
}

async function readHistory() {
  try {
    return JSON.parse(await readFile(HISTORY_PATH, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      checkpoint: { id: CHECKPOINT_ID, name: "Брест — Тересполь" },
      updatedAt: null,
      snapshots: [],
    };
  }
}

async function main() {
  const collectedAt = new Date().toISOString();
  const history = await readHistory();
  const previous = history.snapshots.at(-1);

  const [statisticsResult, monitoringResult] = await Promise.allSettled([
    fetchJson(endpoint("monitoring/statistics")),
    fetchJson(endpoint("monitoring-new")),
  ]);

  const source = {
    statistics: sourceResult(statisticsResult, previous?.source?.statistics),
    monitoring: sourceResult(monitoringResult, previous?.source?.monitoring),
  };

  const statisticsRaw = statisticsResult.status === "fulfilled" ? statisticsResult.value.data : null;
  const monitoringRaw = monitoringResult.status === "fulfilled" ? monitoringResult.value.data : null;
  const queue = Array.isArray(monitoringRaw?.carLiveQueue) ? monitoringRaw.carLiveQueue : null;
  const vehicleTimeline = queue ? toVehicleTimeline(queue) : undefined;
  const queueComposition = queue ? getQueueComposition(queue) : null;
  const queueLength = queue?.length ?? null;
  const queueChange =
    queueLength !== null && typeof previous?.queueLength === "number" ? queueLength - previous.queueLength : null;

  const carLastHour = numberOrNull(statisticsRaw?.carLastHour);
  const carLastDay = numberOrNull(statisticsRaw?.carLastDay);
  const statistics =
    carLastHour !== null && carLastDay !== null
      ? {
          carLastHour,
          carLastDay,
          averagePerHour24: Number((carLastDay / 24).toFixed(2)),
        }
      : null;

  const collectedMs = Date.parse(collectedAt);
  const oneHourAgo = collectedMs - 3_600_000;
  const registrationsObservedLastHour = vehicleTimeline
    ? vehicleTimeline.filter(
        (vehicle) => vehicle.registrationAt && Date.parse(vehicle.registrationAt) >= oneHourAgo,
      ).length
    : null;
  const previousMs = previous ? Date.parse(previous.collectedAt) : NaN;
  const rawIntervalHours = (collectedMs - previousMs) / 3_600_000;
  const collectionIntervalHours =
    Number.isFinite(rawIntervalHours) && rawIntervalHours > 0 && rawIntervalHours <= 2.5
      ? Number(rawIntervalHours.toFixed(3))
      : null;
  const registrationsObservedSincePrevious =
    vehicleTimeline && collectionIntervalHours !== null
      ? vehicleTimeline.filter(
          (vehicle) =>
            vehicle.registrationAt &&
            Date.parse(vehicle.registrationAt) > previousMs &&
            Date.parse(vehicle.registrationAt) <= collectedMs,
        ).length
      : null;
  const estimatedRegistrationsSincePrevious =
    queueChange !== null && carLastHour !== null && collectionIntervalHours !== null
      ? Math.max(0, Number((queueChange + carLastHour * Math.min(collectionIntervalHours, 1)).toFixed(1)))
      : null;
  const hourlyReference = findHourlyReference(history.snapshots, collectedAt);
  const estimatedRegistrationsLastHour =
    queueLength !== null && carLastHour !== null && hourlyReference
      ? Math.max(
          0,
          Number(
            (
              (queueLength - hourlyReference.snapshot.queueLength) / hourlyReference.hours +
              carLastHour
            ).toFixed(1),
          ),
        )
      : null;
  const queueTiming = vehicleTimeline ? getQueueTiming(vehicleTimeline, collectedAt) : null;
  const quality = assessFreshness({ source, queueTiming, collectedAt });

  const snapshot = {
    collectedAt,
    checkpointId: CHECKPOINT_ID,
    queueLength,
    queueChange,
    statistics,
    registrationsObservedLastHour,
    estimatedRegistrationsLastHour,
    collectionIntervalHours,
    registrationsObservedSincePrevious,
    estimatedRegistrationsSincePrevious,
    queueComposition,
    freshness: quality.freshness,
    warnings: quality.warnings,
    queueTiming,
    ...(vehicleTimeline ? { vehicleTimeline } : {}),
    source,
  };

  const cutoff = Date.parse(collectedAt) - HISTORY_RETENTION_MS;
  const detailsCutoff = Date.parse(collectedAt) - DETAILS_RETENTION_MS;
  const snapshots = [...history.snapshots, snapshot]
    .filter((item) => Date.parse(item.collectedAt) >= cutoff)
    .map((item) => {
      if (Date.parse(item.collectedAt) >= detailsCutoff || !item.vehicleTimeline) return item;
      const { vehicleTimeline: _removed, ...aggregateOnly } = item;
      return aggregateOnly;
    });

  const nextHistory = {
    schemaVersion: 2,
    checkpoint: { id: CHECKPOINT_ID, name: "Брест — Тересполь" },
    updatedAt: collectedAt,
    snapshots,
  };
  const temporaryPath = `${HISTORY_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(nextHistory, null, 2)}\n`, "utf8");
  await rename(temporaryPath, HISTORY_PATH);

  console.log(
    JSON.stringify({
      collectedAt,
      queueLength,
      carLastHour,
      carLastDay,
      freshness: quality.freshness,
      warnings: quality.warnings,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
