<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { loadHistory } from "./services/history";
import type { FreshnessState, HistoryFile, QueueSnapshot } from "./types";

const history = ref<HistoryFile | null>(null);
const loading = ref(true);
const loadError = ref("");

const tripDate = ref("2026-09-18");
const arrivalTime = ref("23:00");
const travelMin = ref(7);
const travelMax = ref(8);
const safetyBuffer = ref(2.5);

const latest = computed<QueueSnapshot | null>(() => history.value?.snapshots.at(-1) ?? null);
const snapshots = computed(() => history.value?.snapshots ?? []);

const minskDateTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Minsk",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const minskFullDateTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Minsk",
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const numberFormatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

function parseMinskInput(date: string, time: string) {
  const parsed = new Date(`${date}T${time}:00+03:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 3_600_000);
}

function formatDateTime(value: string | Date | null) {
  if (!value) return "—";
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : minskFullDateTime.format(parsed);
}

function formatShortDateTime(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : minskDateTime.format(parsed);
}

function formatHours(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 1) return `${Math.round(value * 60)} мин`;
  if (value < 24) return `${numberFormatter.format(value)} ч`;
  const days = Math.floor(value / 24);
  const hours = Math.round(value % 24);
  return hours ? `${days} д ${hours} ч` : `${days} д`;
}

function formatSigned(value: number | null) {
  if (value === null) return "—";
  return value > 0 ? `+${value}` : String(value);
}

function freshnessLabel(value: FreshnessState | undefined) {
  const labels: Record<FreshnessState, string> = {
    fresh: "Свежие данные",
    possibly_stale: "Возможно, данные устарели",
    partial: "Данные получены частично",
    unavailable: "API недоступны",
  };
  return value ? labels[value] : "Нет данных";
}

async function refresh() {
  loading.value = true;
  loadError.value = "";
  try {
    history.value = await loadHistory();
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "Не удалось загрузить данные";
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

const queueLength = computed(() => latest.value?.queueLength ?? null);
const currentSpeed = computed(() => latest.value?.statistics?.carLastHour ?? null);
const daySpeed = computed(() => latest.value?.statistics?.averagePerHour24 ?? null);
const expectedWait = computed(() => {
  if (queueLength.value === null || !daySpeed.value) return null;
  return queueLength.value / daySpeed.value;
});

function rollingSpeed(hours: number) {
  const lastDate = latest.value ? Date.parse(latest.value.collectedAt) : 0;
  const start = lastDate - hours * 3_600_000;
  const values = snapshots.value
    .filter((snapshot) => Date.parse(snapshot.collectedAt) >= start)
    .map((snapshot) => snapshot.statistics?.carLastHour)
    .filter((value): value is number => typeof value === "number");
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

const speed6h = computed(() => rollingSpeed(6));
const speed12h = computed(() => rollingSpeed(12));
const speed24h = computed(() => rollingSpeed(24));

const arrivalAt = computed(() => parseMinskInput(tripDate.value, arrivalTime.value));
const targetCallAt = computed(() =>
  arrivalAt.value ? addHours(arrivalAt.value, Math.max(0, safetyBuffer.value || 0)) : null,
);

const historicalSpeeds = computed(() =>
  snapshots.value
    .map((snapshot) => snapshot.statistics?.carLastHour)
    .filter((value): value is number => typeof value === "number" && value > 0),
);

const speedP90 = computed(() => {
  if (!historicalSpeeds.value.length) return null;
  const sorted = [...historicalSpeeds.value].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
});

const conservativeSpeed = computed(() => Math.max(30, speedP90.value ?? 0));
const recommendedRegistrationAt = computed(() => {
  if (queueLength.value === null || !targetCallAt.value) return null;
  return addHours(targetCallAt.value, -queueLength.value / conservativeSpeed.value);
});

const scenarios = computed(() => {
  if (queueLength.value === null || !targetCallAt.value) return [];
  return [20, 24, 30].map((speed) => {
    const waitHours = queueLength.value! / speed;
    return {
      speed,
      waitHours,
      registrationAt: addHours(targetCallAt.value!, -waitHours),
      callAtRecommended: recommendedRegistrationAt.value
        ? addHours(recommendedRegistrationAt.value, waitHours)
        : null,
    };
  });
});

const departureWindow = computed(() => {
  if (!arrivalAt.value) return null;
  const minimum = Math.max(0, Number(travelMin.value) || 0);
  const maximum = Math.max(minimum, Number(travelMax.value) || minimum);
  return {
    from: addHours(arrivalAt.value, -maximum),
    to: addHours(arrivalAt.value, -minimum),
  };
});

const earlyCallThreshold = computed(() => {
  if (!arrivalAt.value || !recommendedRegistrationAt.value || queueLength.value === null) return null;
  const availableHours =
    (arrivalAt.value.getTime() - recommendedRegistrationAt.value.getTime()) / 3_600_000;
  if (availableHours <= 0) return null;
  return queueLength.value / availableHours;
});

const riskAssessment = computed(() => {
  if (earlyCallThreshold.value === null) {
    return { level: "unknown", title: "Риск пока не рассчитан", detail: "Нет текущих данных." };
  }

  if (historicalSpeeds.value.length < 12) {
    return {
      level: "unknown",
      title: "Недостаточно истории",
      detail: `Вызов раньше прибытия возможен при скорости выше ${numberFormatter.format(earlyCallThreshold.value)} авто/ч.`,
    };
  }

  const fasterSamples = historicalSpeeds.value.filter((speed) => speed > earlyCallThreshold.value!).length;
  const probability = fasterSamples / historicalSpeeds.value.length;
  const level = probability <= 0.05 ? "low" : probability <= 0.2 ? "medium" : "high";
  const title = level === "low" ? "Низкий наблюдаемый риск" : level === "medium" ? "Умеренный риск" : "Высокий риск";
  return {
    level,
    title,
    detail: `${Math.round(probability * 100)}% собранных часовых значений были выше порога ${numberFormatter.format(earlyCallThreshold.value)} авто/ч.`,
  };
});

const chartSeries = computed(() =>
  snapshots.value
    .slice(-168)
    .map((snapshot) => ({
      at: snapshot.collectedAt,
      value: snapshot.statistics?.carLastHour,
    }))
    .filter((point): point is { at: string; value: number } => typeof point.value === "number"),
);

const chart = computed(() => {
  const width = 840;
  const height = 250;
  const paddingX = 32;
  const paddingY = 24;
  const values = chartSeries.value.map((point) => point.value);
  const maximum = Math.max(40, Math.ceil(Math.max(...values, 0) / 10) * 10);
  const points = chartSeries.value.map((point, index) => {
    const x =
      chartSeries.value.length === 1
        ? width / 2
        : paddingX + (index / (chartSeries.value.length - 1)) * (width - paddingX * 2);
    const y = height - paddingY - (point.value / maximum) * (height - paddingY * 2);
    return { ...point, x, y };
  });
  const line = points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" ");
  const area = points.length
    ? `${line} L${points.at(-1)!.x},${height - paddingY} L${points[0].x},${height - paddingY} Z`
    : "";
  return { width, height, paddingY, maximum, points, line, area };
});

const recentHistory = computed(() => [...snapshots.value].reverse().slice(0, 24));
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Электронная очередь · легковые автомобили</p>
        <h1>Брест <span aria-hidden="true">→</span> Тересполь</h1>
      </div>
      <button class="refresh-button" type="button" :disabled="loading" @click="refresh">
        {{ loading ? "Обновление…" : "Обновить экран" }}
      </button>
    </header>

    <main>
      <div v-if="loadError" class="notice notice-error" role="alert">
        <strong>История не загрузилась.</strong> {{ loadError }}
      </div>

      <section class="status-strip" aria-live="polite">
        <div class="freshness" :data-state="latest?.freshness ?? 'unavailable'">
          <span class="status-dot" aria-hidden="true"></span>
          <span>{{ freshnessLabel(latest?.freshness) }}</span>
        </div>
        <span>Сбор: {{ formatDateTime(latest?.collectedAt ?? null) }}</span>
        <span v-if="latest?.queueTiming?.latestChangedAt">
          Последнее изменение в очереди: {{ formatDateTime(latest.queueTiming.latestChangedAt) }}
        </span>
      </section>

      <section class="metrics" aria-label="Текущее состояние очереди">
        <article class="metric metric-primary">
          <p>В очереди</p>
          <strong>{{ queueLength ?? "—" }}</strong>
          <span>легковых автомобилей</span>
        </article>
        <article class="metric">
          <p>Прошло за час</p>
          <strong>{{ currentSpeed ?? "—" }}</strong>
          <span>по statistics API</span>
        </article>
        <article class="metric">
          <p>Средняя скорость за сутки</p>
          <strong>{{ daySpeed === null ? "—" : numberFormatter.format(daySpeed) }}</strong>
          <span>авто/ч · {{ latest?.statistics?.carLastDay ?? "—" }} за 24 ч</span>
        </article>
        <article class="metric">
          <p>Ожидание по суточной скорости</p>
          <strong class="metric-time">{{ formatHours(expectedWait) }}</strong>
          <span>очередь ÷ средняя скорость</span>
        </article>
      </section>

      <div class="workspace-grid">
        <section class="panel calculator-panel">
          <div class="panel-heading">
            <div>
              <p class="section-number">01</p>
              <h2>Параметры поездки</h2>
            </div>
            <p>Время указано по Беларуси</p>
          </div>

          <form class="calculator-form" @submit.prevent>
            <label>
              <span>Дата прибытия</span>
              <input v-model="tripDate" type="date" />
            </label>
            <label>
              <span>Прибытие в Брест</span>
              <input v-model="arrivalTime" type="time" />
            </label>
            <div class="field-pair">
              <label>
                <span>Путь, минимум</span>
                <div class="input-suffix"><input v-model.number="travelMin" type="number" min="0" max="24" step="0.5" /><b>ч</b></div>
              </label>
              <label>
                <span>Путь, максимум</span>
                <div class="input-suffix"><input v-model.number="travelMax" type="number" min="0" max="24" step="0.5" /><b>ч</b></div>
              </label>
            </div>
            <label>
              <span>Запас после прибытия</span>
              <div class="input-suffix"><input v-model.number="safetyBuffer" type="number" min="0" max="12" step="0.5" /><b>ч</b></div>
            </label>
          </form>

          <div v-if="departureWindow" class="trip-summary">
            <span>Ориентир выезда из Гомеля</span>
            <strong>{{ formatDateTime(departureWindow.from) }} — {{ formatDateTime(departureWindow.to) }}</strong>
          </div>
        </section>

        <section class="panel recommendation-panel">
          <div class="panel-heading">
            <div>
              <p class="section-number">02</p>
              <h2>Когда регистрироваться</h2>
            </div>
            <p>Консервативный расчёт</p>
          </div>

          <div class="recommendation-time">
            <span>Рекомендуемое время</span>
            <strong>{{ formatDateTime(recommendedRegistrationAt) }}</strong>
            <p>
              Расчёт по {{ conservativeSpeed }} авто/ч на вызов около
              {{ formatDateTime(targetCallAt) }}.
            </p>
          </div>

          <div class="risk" :data-risk="riskAssessment.level">
            <span class="risk-mark" aria-hidden="true"></span>
            <div>
              <strong>{{ riskAssessment.title }}</strong>
              <p>{{ riskAssessment.detail }}</p>
            </div>
          </div>

          <p class="calculation-note">
            Пока прогноз использует текущую длину очереди. После накопления истории консервативная скорость автоматически учитывает 90-й процентиль наблюдений.
          </p>
        </section>
      </div>

      <section class="panel scenarios-panel">
        <div class="panel-heading">
          <div>
            <p class="section-number">03</p>
            <h2>Сценарии скорости</h2>
          </div>
          <p>Цель: вызов с выбранным запасом</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Скорость</th>
                <th>Ожидание</th>
                <th>Регистрация для целевого вызова</th>
                <th>Вызов при рекомендуемой регистрации</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="scenario in scenarios" :key="scenario.speed">
                <td><strong>{{ scenario.speed }}</strong> авто/ч</td>
                <td>{{ formatHours(scenario.waitHours) }}</td>
                <td>{{ formatDateTime(scenario.registrationAt) }}</td>
                <td>{{ formatDateTime(scenario.callAtRecommended) }}</td>
              </tr>
              <tr v-if="!scenarios.length">
                <td colspan="4">Для расчёта нужны данные об очереди.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel chart-panel">
        <div class="panel-heading chart-heading">
          <div>
            <p class="section-number">04</p>
            <h2>Скорость прохождения</h2>
          </div>
          <div class="rolling-speeds" aria-label="Средняя скорость">
            <span><b>{{ speed6h === null ? "—" : numberFormatter.format(speed6h) }}</b> за 6 ч</span>
            <span><b>{{ speed12h === null ? "—" : numberFormatter.format(speed12h) }}</b> за 12 ч</span>
            <span><b>{{ speed24h === null ? "—" : numberFormatter.format(speed24h) }}</b> за 24 ч</span>
          </div>
        </div>

        <div v-if="chart.points.length" class="chart-wrap">
          <svg
            class="speed-chart"
            :viewBox="`0 0 ${chart.width} ${chart.height}`"
            role="img"
            aria-label="График количества прошедших автомобилей за последний час"
          >
            <defs>
              <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#36d6ad" stop-opacity="0.32" />
                <stop offset="100%" stop-color="#36d6ad" stop-opacity="0" />
              </linearGradient>
            </defs>
            <line x1="32" :y1="chart.paddingY" x2="808" :y2="chart.paddingY" class="grid-line" />
            <line x1="32" y1="125" x2="808" y2="125" class="grid-line" />
            <line x1="32" y1="226" x2="808" y2="226" class="grid-line" />
            <text x="2" :y="chart.paddingY + 4" class="axis-label">{{ chart.maximum }}</text>
            <text x="12" y="129" class="axis-label">{{ Math.round(chart.maximum / 2) }}</text>
            <text x="20" y="230" class="axis-label">0</text>
            <path v-if="chart.area" :d="chart.area" fill="url(#area-fill)" />
            <path v-if="chart.line" :d="chart.line" class="chart-line" />
            <circle
              v-for="point in chart.points"
              :key="`${point.at}-${point.value}`"
              :cx="point.x"
              :cy="point.y"
              r="3.5"
              class="chart-point"
            >
              <title>{{ formatDateTime(point.at) }}: {{ point.value }} авто</title>
            </circle>
          </svg>
          <div class="chart-range">
            <span>{{ formatShortDateTime(chart.points[0]?.at ?? null) }}</span>
            <span>{{ formatShortDateTime(chart.points.at(-1)?.at ?? null) }}</span>
          </div>
        </div>
        <div v-else class="empty-chart">График появится после первого успешного сбора.</div>
      </section>

      <section class="panel history-panel">
        <div class="panel-heading">
          <div>
            <p class="section-number">05</p>
            <h2>Последние замеры</h2>
          </div>
          <p>{{ snapshots.length }} точек в истории</p>
        </div>
        <div class="table-wrap history-table">
          <table>
            <thead>
              <tr>
                <th>Собрано</th>
                <th>Очередь</th>
                <th>Изменение</th>
                <th>За час</th>
                <th>Среднее 24 ч</th>
                <th>Качество</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="snapshot in recentHistory" :key="snapshot.collectedAt">
                <td>{{ formatShortDateTime(snapshot.collectedAt) }}</td>
                <td><strong>{{ snapshot.queueLength ?? "—" }}</strong></td>
                <td :class="{ positive: (snapshot.queueChange ?? 0) > 0, negative: (snapshot.queueChange ?? 0) < 0 }">
                  {{ formatSigned(snapshot.queueChange) }}
                </td>
                <td>{{ snapshot.statistics?.carLastHour ?? "—" }}</td>
                <td>{{ snapshot.statistics ? numberFormatter.format(snapshot.statistics.averagePerHour24) : "—" }}</td>
                <td><span class="quality-chip" :data-state="snapshot.freshness">{{ freshnessLabel(snapshot.freshness) }}</span></td>
              </tr>
              <tr v-if="!recentHistory.length">
                <td colspan="6">История пока пуста.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="latest?.warnings.length" class="notice" aria-label="Замечания к данным">
        <strong>Проверка свежести</strong>
        <ul>
          <li v-for="warning in latest.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </section>

      <footer>
        <p>
          Источник: belarusborder.by. API statistics не содержит собственного времени формирования ответа, поэтому его свежесть оценивается вместе с временными метками monitoring-new и повторяемостью ответов.
        </p>
        <p>Номера автомобилей не сохраняются.</p>
      </footer>
    </main>
  </div>
</template>
