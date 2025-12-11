import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = process.cwd();
const localesSrc = resolve(rootDir, "_locales");
const localesDest = resolve(rootDir, "dist", "_locales");

if (!existsSync(localesSrc)) {
  process.exit(0);
}

await mkdir(localesDest, { recursive: true });
await cp(localesSrc, localesDest, { recursive: true });

console.log("Copied _locales to dist/_locales");

