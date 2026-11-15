// Fixture server. Serves fixtures/ and accepts the submissions they make,
// so no test ever posts to a real employer.
//
//   node test/serve.mjs          port 7072, for manual checks
//   import { serve } ...         port 0 (ephemeral), for test/e2e.mjs

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(ROOT, 'fixtures');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

const drain = req => new Promise(resolve => { req.on('data', () => {}); req.on('end', resolve); });

export function serve(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // An image that is never cached, so every load is a request: a fixture
    // puts it inside a label to catch anything that makes the page fetch it.
    if (url.pathname === '/pixel.gif') {
      server.pixelHits++;
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
      return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    }
    if (req.method === 'POST') {
      await drain(req);
      if (url.pathname === '/api/apply') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true}');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!DOCTYPE html><title>Thanks</title><h1 id="thanks">Thanks for applying!</h1>');
    }
    if (url.pathname === '/') {
      const files = (await readdir(FIXTURES)).filter(f => f.endsWith('.html'));
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(`<!DOCTYPE html><title>Carbon Copy fixtures</title><h1>Fixtures</h1><ul>${
        files.map(f => `<li><a href="/fixtures/${f}">${f}</a></li>`).join('')}</ul>`);
    }
    const rel = normalize(url.pathname).replace(/^\/fixtures\//, '');
    if (rel.includes('..')) { res.writeHead(400); return res.end(); }
    try {
      const body = await readFile(join(FIXTURES, rel));
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  server.pixelHits = 0;
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 7072);
  await serve(port);
  console.log(`Carbon Copy fixtures: http://localhost:${port}/`);
}
