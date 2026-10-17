// Build a deterministic extension archive from dist/.
// Fixed timestamps, sorted entries, and a stable byte layout keep the ZIP
// reproducible across machines and CI runs.
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");
const OUTPUT = path.join(ROOT, "lingolens-extension.zip");
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 10;
const VERSION = 20;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 8;
const UNX_FILE_MODE = (0o100644 << 16) >>> 0;

async function walk(directory, prefix = "") {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) entries.push(...await walk(full, relative));
    else if (entry.isFile()) entries.push({ relative, full });
  }
  return entries;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function localHeader(name, crc, compressedSize, size) {
  const buffer = Buffer.alloc(30);
  buffer.writeUInt32LE(0x04034b50, 0);
  buffer.writeUInt16LE(VERSION, 4);
  buffer.writeUInt16LE(UTF8_FLAG, 6);
  buffer.writeUInt16LE(STORE_METHOD, 8);
  buffer.writeUInt16LE(DOS_TIME, 10);
  buffer.writeUInt16LE(DOS_DATE, 12);
  buffer.writeUInt32LE(crc, 14);
  buffer.writeUInt32LE(compressedSize, 18);
  buffer.writeUInt32LE(size, 22);
  buffer.writeUInt16LE(name.length, 26);
  buffer.writeUInt16LE(0, 28);
  return buffer;
}

function centralHeader(name, crc, compressedSize, size, offset) {
  const buffer = Buffer.alloc(46);
  buffer.writeUInt32LE(0x02014b50, 0);
  buffer.writeUInt16LE((3 << 8) | VERSION, 4);
  buffer.writeUInt16LE(VERSION, 6);
  buffer.writeUInt16LE(UTF8_FLAG, 8);
  buffer.writeUInt16LE(STORE_METHOD, 10);
  buffer.writeUInt16LE(DOS_TIME, 12);
  buffer.writeUInt16LE(DOS_DATE, 14);
  buffer.writeUInt32LE(crc, 16);
  buffer.writeUInt32LE(compressedSize, 20);
  buffer.writeUInt32LE(size, 24);
  buffer.writeUInt16LE(name.length, 28);
  buffer.writeUInt16LE(0, 30);
  buffer.writeUInt16LE(0, 32);
  buffer.writeUInt16LE(0, 34);
  buffer.writeUInt16LE(0, 36);
  buffer.writeUInt32LE(UNX_FILE_MODE, 38);
  buffer.writeUInt32LE(offset, 42);
  return buffer;
}

function endOfCentralDirectory(count, size, offset) {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt32LE(0x06054b50, 0);
  buffer.writeUInt16LE(0, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt16LE(count, 8);
  buffer.writeUInt16LE(count, 10);
  buffer.writeUInt32LE(size, 12);
  buffer.writeUInt32LE(offset, 16);
  buffer.writeUInt16LE(0, 20);
  return buffer;
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(DIST, "manifest.json"), "utf8"));
  const files = (await walk(DIST)).sort((left, right) => left.relative.localeCompare(right.relative));
  if (!files.length) throw new Error("dist/ is empty; run npm run build first");

  const parts = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const data = await readFile(file.full);
    const compressed = deflateRawSync(data, { level: 9 });
    const name = Buffer.from(file.relative, "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([localHeader(name, crc, compressed.length, data.length), name]);
    directory.push(Buffer.concat([centralHeader(name, crc, compressed.length, data.length, offset), name]));
    parts.push(local, compressed);
    offset += local.length + compressed.length;
  }

  const central = Buffer.concat(directory);
  const eocd = endOfCentralDirectory(files.length, central.length, offset);
  const archive = Buffer.concat([...parts, central, eocd]);
  await writeFile(OUTPUT, archive);

  const digest = createHash("sha256").update(archive).digest("hex");
  console.log(`Packaged ${files.length} files from dist/ (manifest v${manifest.version})`);
  console.log(`Output: ${path.relative(ROOT, OUTPUT)} (${archive.length} bytes)`);
  console.log(`SHA-256: ${digest}`);
}

await main();
