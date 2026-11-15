// Builds a copy of the extension that also records on localhost and
// 127.0.0.1, where the fixtures are served. The patch exists only in the
// copy, so the shipped manifest never matches a local address.
//
//   node test/test-extension.mjs [outDir]   default: tmp/test-extension
//   (then chrome://extensions > Load unpacked, for a manual fixture check)

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const LOCAL_MATCHES = ['http://localhost/*', 'http://127.0.0.1/*'];

export async function buildTestExtension(outDir) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const p of ['src', 'popup', 'welcome', 'icons']) await cp(join(ROOT, p), join(outDir, p), { recursive: true });
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
