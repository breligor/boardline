import type { HistoryFile } from "../types";

const DATA_URL = `${import.meta.env.BASE_URL}data/history.json`;

export async function loadHistory(): Promise<HistoryFile> {
  const response = await fetch(`${DATA_URL}?v=${Date.now()}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Не удалось загрузить историю: HTTP ${response.status}`);
  }

  const data = (await response.json()) as Partial<HistoryFile>;
  if (!Array.isArray(data.snapshots)) {
    throw new Error("Файл истории имеет неверный формат");
  }

  return data as HistoryFile;
}
