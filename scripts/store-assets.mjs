// Chrome Web Store screenshots: three 1280x800 PNGs in tmp/store/.
//
//   node scripts/store-assets.mjs
//
// 1. An application filled in, with the popup open beside it
// 2. The Markdown file a submission produces
// 3. The welcome page
//
// Runs the test build in Playwright's Chromium, with the fleet's fake cast
// (ACME, Wile E. Coyote). Nothing is submitted and nothing is downloaded:
// the popup's records are written straight into the extension's store, and
// the popup is told which tab it is looking at. Everything else on screen is
// the real popup, page and renderer.

import { chromium } from 'playwright';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTestExtension } from '../test/test-extension.mjs';
import { renderMarkdown } from '../src/lib/render-md.js';
import { basename } from '../src/lib/sink-downloads.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'tmp', 'store');
const W = 1280;
const H = 800;
const SITE = 'https://careers.acme.example';

const WHY = 'Because ACME ships to the desert overnight, and I have field-tested more of your catalog than anyone alive.\n\nThe anvils are, frankly, superb.';
const now = new Date();
const daysAgo = n => new Date(now.getTime() - n * 86400000 - 3600000 * (n % 5)).toISOString();

// The record shown in screenshot 2, and first in the popup.
const featured = {
  schema: 1,
  id: '7d3f2c1e-9b4a-4e8f-a1d2-5c6b7e8f9a0b',
  status: 'submitted',
  trigger: 'click+submit',
  startedAt: daysAgo(0),
  capturedAt: daysAgo(0),
  page: { url: `${SITE}/jobs/4012/senior-anvil-engineer/apply`, title: 'Senior Anvil Engineer - ACME Corporation', frameUrl: '', origin: SITE },
  context: { company: 'ACME Corporation', role: 'Senior Anvil Engineer' },
  preset: null,
  fields: [
    { label: 'Full name', name: 'name', type: 'text', value: 'Wile E. Coyote', display: 'Wile E. Coyote', step: 1 },
    { label: 'Earliest start date', name: 'start', type: 'date', value: '2026-12-01', display: '2026-12-01', step: 1 },
    { label: 'Willing to relocate?', name: 'relocate', type: 'radio', value: 'yes', display: 'Yes', step: 1 },
    { label: 'Why ACME?', name: 'why', type: 'textarea', value: WHY, display: WHY, step: 1 },
  ],
  files: [{ label: 'Resume/CV', name: 'wile-e-coyote-resume.pdf', size: 49357, type: 'application/pdf', sha256: 'a24112e3b0c4f1d8e9a7c6b5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5' }],
  redacted: { secret: 0, eeo: 2 },
  evidence: [],
  sink: null,
};

const others = [
  ['Rocket Skate Fitter', 'submitted', 2],
  ['Portable Hole Installer', 'submitted', 6],
  ['Magnet Technician', 'draft', 9],
  ['Dehydrated Boulder Specialist', 'submitted', 13],
  ['Tunnel Painter', 'submitted', 21],
].map(([role, status, ago], i) => ({
  ...featured,
  id: `store-${i}`,
  status,
  capturedAt: daysAgo(ago),
  startedAt: daysAgo(ago),
  context: { company: 'ACME Corporation', role },
}));

const saved = r => (r.status === 'submitted'
  ? { ...r, sink: { md: `/carbon-copy/${basename(r)}.md`, json: `/carbon-copy/${basename(r)}.json`, at: r.capturedAt } }
  : r);

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dataUrl = buf => `data:image/png;base64,${buf.toString('base64')}`;

const FRAME_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
  body { background: #e9ebf3; font: 16px/1.4 system-ui, -apple-system, sans-serif; color: #1d1d1f; }
  .caption { height: 72px; display: flex; align-items: center; padding: 0 48px; font-size: 26px; font-weight: 600; letter-spacing: -0.01em; }
  .caption span { color: #3949ab; }
  .stage { position: relative; height: ${H - 72}px; padding: 0 48px; }
  .shadow { box-shadow: 0 12px 40px rgba(31, 35, 51, 0.18), 0 2px 8px rgba(31, 35, 51, 0.08); border-radius: 10px; overflow: hidden; }
`;

// --------------------------------------------------------------- pages

// A plain employer application page, ACME's own. Not dressed as any real
// applicant tracking system.
const FORM_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, sans-serif; color: #1d1d1f; background: #fff; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 14px 28px; border-bottom: 1px solid #e3e3e6; font-weight: 700; }
  .logo { width: 26px; height: 26px; border-radius: 6px; background: #b3261e; color: #fff; display: grid; place-items: center; font-size: 15px; }
  main { padding: 22px 28px; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  .sub { color: #6e6e73; margin: 0 0 18px; }
  label, .q { display: block; font-weight: 600; margin: 14px 0 5px; }
  input[type=text], input[type=email], input[type=date], textarea { width: 100%; padding: 8px 10px; font: inherit; border: 1px solid #c7c7cc; border-radius: 6px; }
  textarea { height: 92px; resize: none; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .radios { display: flex; gap: 18px; font-weight: 400; }
  .radios label { font-weight: 400; margin: 0; display: flex; gap: 6px; align-items: center; }
  .file { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px dashed #c7c7cc; border-radius: 6px; }
  .file b { font-weight: 500; }
  .file span { color: #6e6e73; }
  button { margin-top: 18px; padding: 10px 22px; font: inherit; font-weight: 600; border: 0; border-radius: 6px; background: #b3261e; color: #fff; }
</style></head><body>
  <div class="bar"><div class="logo">A</div>ACME Corporation Careers</div>
  <main>
    <h1>Senior Anvil Engineer</h1>
    <p class="sub">Desert Southwest, on site. Cliffside delivery experience preferred.</p>
    <label>Full name</label><input type="text" value="Wile E. Coyote">
    <div class="row">
      <div><label>Earliest start date</label><input type="text" value="12/01/2026"></div>
      <div><span class="q">Willing to relocate?</span>
        <div class="radios"><label><input type="radio" name="r" checked> Yes</label><label><input type="radio" name="r"> No</label></div></div>
    </div>
    <label>Why ACME?</label>
    <textarea>${esc(WHY)}</textarea>
    <span class="q">Resume/CV</span>
    <div class="file"><b>wile-e-coyote-resume.pdf</b><span>48.2 KB</span></div>
    <button>Submit application</button>
  </main>
</body></html>`;

function highlight(md) {
  let fm = 0;
  return md.split('\n').map(line => {
    const t = esc(line);
    if (line === '---') { fm++; return `<span class="dim">${t}</span>`; }
    if (fm === 1) return t.replace(/^([a-z]+):/, '<span class="key">$1</span>:').replace(/(&quot;.*&quot;)$/, '<span class="str">$1</span>');
    if (line.startsWith('# ')) return `<span class="h1">${t}</span>`;
    if (line.startsWith('## ')) return `<span class="h2">${t}</span>`;
    if (line.startsWith('- ') || line.startsWith('  sha256')) return t.replace(/`([^`]+)`/g, '<span class="code">`$1`</span>');
    if (line.startsWith('Recorded by')) return `<span class="dim">${t}</span>`;
    return t;
  }).join('\n');
}

const MD_PAGE = md => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${FRAME_CSS}
  .win { position: absolute; left: 48px; right: 48px; top: 0; bottom: 20px; background: #fbfbfd; display: flex; flex-direction: column; }
  .tab { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #f0f1f5; border-bottom: 1px solid #e3e3e6; font-size: 13px; color: #6e6e73; }
  .dots { display: flex; gap: 6px; margin-right: 10px; } .dots i { width: 11px; height: 11px; border-radius: 50%; background: #d1d1d6; display: block; }
  pre { margin: 0; padding: 12px 22px; font: 12.5px/16.5px ui-monospace, "SF Mono", Menlo, monospace; white-space: pre-wrap; color: #2c2c2e; }
  .dim { color: #a1a1a6; } .key { color: #3949ab; } .str { color: #1f7a3a; }
  .h1 { font-weight: 700; color: #1d1d1f; } .h2 { font-weight: 700; color: #3949ab; } .code { color: #a15c00; }
</style></head><body>
  <div class="caption">Each submission becomes a&nbsp;<span>Markdown file</span>&nbsp;you can read, plus JSON for scripts.</div>
  <div class="stage"><div class="win shadow">
    <div class="tab"><div class="dots"><i></i><i></i><i></i></div>Downloads/carbon-copy/${esc(basename(featured))}.md</div>
    <pre>${highlight(md.trimEnd())}</pre>
  </div></div>
</body></html>`;

const COMPOSITE = (form, popup) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${FRAME_CSS}
  .form { position: absolute; left: 48px; top: 0; width: 820px; }
  .form img, .popup img { display: block; }
  .popup { position: absolute; right: 48px; top: 28px; width: 340px; }
</style></head><body>
  <div class="caption">Apply as usual.&nbsp;<span>Carbon Copy keeps what you sent.</span></div>
  <div class="stage">
    <div class="form shadow"><img src="${form}" width="820"></div>
    <div class="popup shadow"><img src="${popup}" width="340"></div>
  </div>
</body></html>`;

// --------------------------------------------------------------- run

await mkdir(OUT, { recursive: true });
const work = await realpath(await mkdtemp(join(tmpdir(), 'carbon-copy-store-')));
const extDir = await buildTestExtension(join(work, 'extension'));
const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

try {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/popup/popup.html`);
  await ext.evaluate(async rows => {
    await chrome.storage.local.set({ settings: { consentedAt: new Date().toISOString() } });
    const store = await import('/src/lib/store.js');
    for (const r of rows) await store.put(r);
  }, [featured, ...others].map(saved));
  await ext.close();

  // 1. The application, and the popup open on it.
  const form = await context.newPage();
  await form.setViewportSize({ width: 820, height: 620 });
  await form.setContent(FORM_PAGE);
  const formShot = await form.screenshot();
  await form.close();

  const popup = await context.newPage();
  await popup.addInitScript(site => {
    // The popup asks which tab it is open on, and whether that site was
    // added with "Record this site". Opened as a tab of its own, the
    // honest answer is "itself", so it is told about the application tab.
    chrome.tabs.query = async () => [{ id: 1, url: `${site}/jobs/4012/senior-anvil-engineer/apply` }];
    chrome.permissions.getAll = async () => ({ origins: [`${site}/*`], permissions: [] });
  }, SITE);
  await popup.setViewportSize({ width: 340, height: 600 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForSelector('#records li');
  await popup.waitForFunction(() => document.getElementById('site-state').textContent === 'recording');
  const popupShot = await popup.locator('body').screenshot();
  await popup.close();

  const page = await context.newPage();
  await page.setContent(COMPOSITE(dataUrl(formShot), dataUrl(popupShot)));
  await page.screenshot({ path: join(OUT, '1-application.png') });

  // 2. The Markdown file.
  await page.setContent(MD_PAGE(renderMarkdown(featured)));
  await page.screenshot({ path: join(OUT, '2-markdown.png') });
  await page.close();

  // 3. The welcome page, as it opens at install.
  const welcome = await context.newPage();
  await welcome.goto(`chrome-extension://${extId}/welcome/welcome.html`);
  await welcome.evaluate(() => { document.getElementById('start').hidden = false; document.getElementById('started').hidden = true; });
  await welcome.screenshot({ path: join(OUT, '3-welcome.png') });
  await welcome.close();

  console.log(`Wrote ${OUT}/{1-application,2-markdown,3-welcome}.png (${W}x${H})`);
} finally {
  await context.close();
  await rm(work, { recursive: true, force: true });
}
