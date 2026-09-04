import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDirectory = resolve(root, "public/data");

await mkdir(targetDirectory, { recursive: true });
await copyFile(resolve(root, "data/history.json"), resolve(targetDirectory, "history.json"));
