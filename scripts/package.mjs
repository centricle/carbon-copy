// The one list of what ships, and the zip uploaded to the Chrome Web Store.
// test/test-extension.mjs builds the e2e copy from the same list, so the
// suite runs against exactly the files that ship.
//
//   node scripts/package.mjs [out.zip]   default: carbon-copy.zip
//
// The zip is reproducible: entries sorted, every timestamp fixed at
// 1980-01-01, stored without compression (deflate output can change with
// the zlib version). The same tree gives the same bytes on any machine, so
// a local build can be checked against the release zip CI attests. Upload
// the release zip, not a local one.

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const SHIPPED = [
  'manifest.json',
  'src',
  'popup',
  'welcome',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  'LICENSE',
  'PRIVACY.md',
];

const IGNORED = new Set(['.DS_Store', 'Thumbs.db']);

// Every file under SHIPPED, as sorted POSIX paths relative to root.
export async function shippedFiles(root = ROOT) {
  const out = [];
  const walk = async rel => {
    const abs = join(root, rel);
    if ((await stat(abs)).isDirectory()) {
      for (const name of await readdir(abs)) if (!IGNORED.has(name)) await walk(join(rel, name));
    } else {
      out.push(rel.split(sep).join('/'));
    }
  };
  for (const p of SHIPPED) await walk(p);
  return out.sort();
}

// A minimal zip writer: stored entries, UTF-8 names, fixed DOS timestamps.
export function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // version needed: stored
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export async function buildZip(root = ROOT) {
  const files = await shippedFiles(root);
  const entries = await Promise.all(files.map(async name => ({ name, data: await readFile(join(root, name)) })));
  return { files, buffer: zip(entries) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] || join(ROOT, 'carbon-copy.zip');
  try {
    const dirty = execFileSync('git', ['status', '--porcelain', '--', ...SHIPPED], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (dirty) console.warn(`warning: uncommitted changes in shipped files; this zip matches no commit\n${dirty}`);
  } catch { /* not a git checkout */ }
  const { files, buffer } = await buildZip();
  await writeFile(out, buffer);
  const sha = createHash('sha256').update(buffer).digest('hex');
  console.log(`${relative(process.cwd(), out) || out}: ${files.length} files, ${buffer.length} bytes\nsha256 ${sha}`);
}
