import type { HistoryFile } from "../types";

const BUNDLED_DATA_URL = `${import.meta.env.BASE_URL}data/history.json`;
const LIVE_DATA_URL = "https://raw.githubusercontent.com/breligor/boardline/main/data/history.json";

async function fetchHistory(url: string) {
  const response = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = (await response.json()) as Partial<HistoryFile>;
  if (!Array.isArray(data.snapshots)) {
    throw new Error("Файл истории имеет неверный формат");
  }

  return data as HistoryFile;
}

export async function loadHistory(): Promise<HistoryFile> {
  if (import.meta.env.PROD) {
    try {
      return await fetchHistory(LIVE_DATA_URL);
    } catch {
      const fallback = await fetchHistory(BUNDLED_DATA_URL);
      const latest = fallback.snapshots.at(-1);
      if (latest) {
        latest.freshness = latest.freshness === "unavailable" ? "unavailable" : "possibly_stale";
        latest.warnings = [
          ...(latest.warnings ?? []),
          "Не удалось загрузить актуальную историю из GitHub; показана резервная копия из последней публикации.",
        ];
      }
      return fallback;
    }
  }

  return fetchHistory(BUNDLED_DATA_URL);
}
