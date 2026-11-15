// Builds a copy of the extension that also records on localhost and
// 127.0.0.1, where the fixtures are served. The patch exists only in the
// copy, so the shipped manifest never matches a local address. Everything
// else is the file list the store zip is built from (scripts/package.mjs),
// so the e2e suite tests what ships.
//
//   node test/test-extension.mjs [outDir]   default: tmp/test-extension
//   (then chrome://extensions > Load unpacked, for a manual fixture check)

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, shippedFiles } from '../scripts/package.mjs';
export const LOCAL_MATCHES = ['http://localhost/*', 'http://127.0.0.1/*'];

export async function buildTestExtension(outDir) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const f of await shippedFiles()) {
    await mkdir(dirname(join(outDir, f)), { recursive: true });
    await copyFile(join(ROOT, f), join(outDir, f));
  }
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches.push(...LOCAL_MATCHES);
  manifest.name += ' (test build)';
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return outDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] || join(ROOT, 'tmp', 'test-extension'));
  await buildTestExtension(out);
  console.log(`Test build written to ${out}`);
}
