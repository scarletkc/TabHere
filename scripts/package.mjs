import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

function runBuild() {
  console.log("Running build...");
  let command = "npm";
  let args = ["run", "build"];
  let options = {
    cwd: rootDir,
    stdio: "inherit"
  };

  if (process.platform === "win32") {
    // Spawn .cmd safely on Windows by going through cmd.exe.
    command = "cmd.exe";
    args = ["/c", "npm", "run", "build"];
  }

  const result = spawnSync(command, args, options);
  if (result.error) {
    console.error(`Failed to run build (${command} ${args.join(" ")}):`, result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function walkFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(fullPath)));
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function toZipPath(filePath) {
  return relative(rootDir, filePath).split(sep).join("/");
}

function dateToDos(date) {
  let year = date.getFullYear();
  if (year < 1980) year = 1980;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const b of buffer) {
    c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n & 0xffff, 0);
  return buf;
}

function u32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n >>> 0, 0);
  return buf;
}

async function createZip(entries, outPath) {
  const chunks = [];
  let offset = 0;
  const centralRecords = [];
  const utf8Flag = 0x0800;

  const push = (buf) => {
    chunks.push(buf);
    offset += buf.length;
  };

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const { dosTime, dosDate } = dateToDos(entry.mtime);
    const crc = crc32(data);

    let method = 8;
    let compressed = deflateRawSync(data);
    if (compressed.length >= data.length) {
      method = 0;
      compressed = data;
    }

    const localHeaderOffset = offset;

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(utf8Flag),
      u16(method),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf
    ]);

    push(localHeader);
    push(compressed);

    centralRecords.push({
      nameBuf,
      crc,
      compressedSize: compressed.length,
      size: data.length,
      method,
      dosTime,
      dosDate,
      localHeaderOffset
    });
  }

  const centralDirOffset = offset;

  for (const record of centralRecords) {
    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(utf8Flag),
      u16(record.method),
      u16(record.dosTime),
      u16(record.dosDate),
      u32(record.crc),
      u32(record.compressedSize),
      u32(record.size),
      u16(record.nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(record.localHeaderOffset),
      record.nameBuf
    ]);
    push(centralHeader);
  }

  const centralDirSize = offset - centralDirOffset;

  const endOfCentralDir = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(centralRecords.length),
    u16(centralRecords.length),
    u32(centralDirSize),
    u32(centralDirOffset),
    u16(0)
  ]);

  push(endOfCentralDir);

  await writeFile(outPath, Buffer.concat(chunks));
}

async function main() {
  if (process.env.SKIP_BUILD !== "1") {
    runBuild();
  } else {
    console.log("SKIP_BUILD=1, using existing dist/");
  }

  const manifestPath = resolve(rootDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const version = manifest.version || "0.0.0";

  const keepSourcemap = process.env.KEEP_SOURCEMAP === "1";

  const files = [manifestPath];
  const maybeDirs = ["dist", "public", "_locales"];
  for (const dirName of maybeDirs) {
    const dirPath = resolve(rootDir, dirName);
    if (existsSync(dirPath)) {
      const dirFiles = await walkFiles(dirPath);
      for (const f of dirFiles) {
        if (!keepSourcemap && f.endsWith(".map")) continue;
        files.push(f);
      }
    }
  }

  for (const extra of ["LICENSE"]) {
    const p = resolve(rootDir, extra);
    if (existsSync(p)) files.push(p);
  }

  const entries = [];
  for (const filePath of files) {
    const st = await stat(filePath);
    entries.push({
      name: toZipPath(filePath),
      data: await readFile(filePath),
      mtime: st.mtime
    });
  }

  const outDir = resolve(rootDir, "release");
  await mkdir(outDir, { recursive: true });
  const zipPath = resolve(outDir, `tabhere-${version}.zip`);

  console.log(`Packaging ${entries.length} files...`);
  await createZip(entries, zipPath);
  console.log(`Packaged: ${zipPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
