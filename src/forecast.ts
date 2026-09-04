import type { QueueSnapshot } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export type ForecastConfidence = "insufficient" | "low" | "medium" | "high";

export interface QueueForecast {
  value: number;
  confidence: ForecastConfidence;
  samples: number;
  method: string;
}

export interface QueueScenario {
  registrationAt: Date;
  waitHours: number;
  forecast: QueueForecast;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function weightedMedian(values: Array<{ value: number; weight: number }>) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left.value - right.value);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  let accumulated = 0;

  for (const item of sorted) {
    accumulated += item.weight;
    if (accumulated >= totalWeight / 2) return item.value;
  }

  return sorted.at(-1)!.value;
}

function minskParts(date: Date) {
  const shifted = new Date(date.getTime() + 3 * HOUR_MS);
  return {
    day: shifted.getUTCDay(),
    hour: shifted.getUTCHours() + shifted.getUTCMinutes() / 60,
    dateKey: shifted.toISOString().slice(0, 10),
  };
}

function hourDistance(left: number, right: number) {
  const direct = Math.abs(left - right);
  return Math.min(direct, 24 - direct);
}

export function forecastQueueAt(
  target: Date,
  snapshots: QueueSnapshot[],
  fallbackQueue: number,
): QueueForecast {
  const valid = snapshots
    .filter((snapshot) => typeof snapshot.queueLength === "number")
    .map((snapshot) => ({
      at: new Date(snapshot.collectedAt),
      value: snapshot.queueLength as number,
    }))
    .filter((point) => Number.isFinite(point.at.getTime()))
    .sort((left, right) => left.at.getTime() - right.at.getTime());

  const latest = valid.at(-1);
  if (!latest) {
    return {
      value: Math.max(0, Math.round(fallbackQueue)),
      confidence: "insufficient",
      samples: 0,
      method: "текущая очередь — исторических точек пока нет",
    };
  }

  const hoursFromLatest = (target.getTime() - latest.at.getTime()) / HOUR_MS;
  if (hoursFromLatest >= 0 && hoursFromLatest <= 6) {
    const recentCutoff = latest.at.getTime() - 12 * HOUR_MS;
    const recent = valid.filter((point) => point.at.getTime() >= recentCutoff);
    const rates: number[] = [];

    for (let index = 1; index < recent.length; index += 1) {
      const hours = (recent[index].at.getTime() - recent[index - 1].at.getTime()) / HOUR_MS;
      if (hours < 0.2 || hours > 2) continue;
      rates.push((recent[index].value - recent[index - 1].value) / hours);
    }

    const recentRate = median(rates);
    if (recentRate !== null && rates.length >= 3) {
      const limitedRate = clamp(recentRate, -15, 15);
      return {
        value: Math.max(0, Math.round(latest.value + limitedRate * hoursFromLatest)),
        confidence: rates.length >= 8 ? "medium" : "low",
        samples: rates.length,
        method: "недавний чистый тренд очереди",
      };
    }
  }

  const targetParts = minskParts(target);
  const cutoff = latest.at.getTime() - 42 * DAY_MS;
  const historical = valid.filter((point) => point.at.getTime() >= cutoff);
  const sameWeekday = historical.filter((point) => {
    const parts = minskParts(point.at);
    return parts.day === targetParts.day && hourDistance(parts.hour, targetParts.hour) <= 2.25;
  });

  if (sameWeekday.length >= 6) {
    const distinctDays = new Set(sameWeekday.map((point) => minskParts(point.at).dateKey)).size;
    const value = weightedMedian(
      sameWeekday.map((point) => ({
        value: point.value,
        weight: 1 / (0.5 + hourDistance(minskParts(point.at).hour, targetParts.hour)),
      })),
    );

    if (value !== null) {
      return {
        value: Math.max(0, Math.round(value)),
        confidence: distinctDays >= 3 ? "high" : distinctDays >= 2 ? "medium" : "low",
        samples: sameWeekday.length,
        method: "история того же дня недели и времени суток",
      };
    }
  }

  const sameTime = historical.filter(
    (point) => hourDistance(minskParts(point.at).hour, targetParts.hour) <= 1.25,
  );
  const distinctDays = new Set(sameTime.map((point) => minskParts(point.at).dateKey)).size;
  if (sameTime.length >= 12 && distinctDays >= 3) {
    const value = weightedMedian(
      sameTime.map((point) => ({
        value: point.value,
        weight: 1 / (0.5 + hourDistance(minskParts(point.at).hour, targetParts.hour)),
      })),
    );

    if (value !== null) {
      return {
        value: Math.max(0, Math.round(value)),
        confidence: distinctDays >= 7 ? "medium" : "low",
        samples: sameTime.length,
        method: "история похожего времени суток",
      };
    }
  }

  return {
    value: Math.max(0, Math.round(latest.value)),
    confidence: "insufficient",
    samples: valid.length,
    method: "текущая очередь — для календарного прогноза истории ещё мало",
  };
}

export function solveQueueScenario(
  targetCallAt: Date,
  speed: number,
  snapshots: QueueSnapshot[],
  fallbackQueue: number,
): QueueScenario {
  let registrationAt = new Date(targetCallAt.getTime() - (fallbackQueue / speed) * HOUR_MS);

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const forecast = forecastQueueAt(registrationAt, snapshots, fallbackQueue);
    registrationAt = new Date(targetCallAt.getTime() - (forecast.value / speed) * HOUR_MS);
  }

  const forecast = forecastQueueAt(registrationAt, snapshots, fallbackQueue);
  return {
    registrationAt,
    waitHours: forecast.value / speed,
    forecast,
  };
}
