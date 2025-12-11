import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/set-version.mjs <version>");
  process.exit(1);
}

const semverRegex =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
if (!semverRegex.test(input)) {
  console.error(`Invalid version "${input}". Expected semver like 0.1.1`);
  process.exit(1);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

async function main() {
  const manifestPath = resolve(rootDir, "manifest.json");
  const packagePath = resolve(rootDir, "package.json");
  const lockPath = resolve(rootDir, "package-lock.json");

  const manifest = await readJson(manifestPath);
  const pkg = await readJson(packagePath);

  manifest.version = input;
  pkg.version = input;

  await writeJson(manifestPath, manifest);
  await writeJson(packagePath, pkg);

  if (existsSync(lockPath)) {
    const lock = await readJson(lockPath);
    lock.version = input;
    if (lock.packages && lock.packages[""]) {
      lock.packages[""].version = input;
    }
    await writeJson(lockPath, lock);
  }

  console.log(`Version set to ${input}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

