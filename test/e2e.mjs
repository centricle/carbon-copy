// End-to-end: load the extension in Playwright's Chromium, fill and submit
// every fixture, then check the stored records and the files on disk.
//
//   node test/e2e.mjs [--headed] [--keep] [--only=<case>]
//
// Headless by default (Chromium's new headless mode loads extensions).
// --keep leaves the temp profile and downloads in place and prints the path.

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { serve } from './serve.mjs';
import { buildTestExtension } from './test-extension.mjs';

const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const KEEP = args.includes('--keep');
const ONLY = args.find(a => a.startsWith('--only='))?.slice(7);

// Values that must never appear in a record or a file.
const SECRETS = {
  password: 'acme-hunter2-password',
  card: '4111111111111111',
  ssn: '078-05-1120',
  csrf: 'hidden-token-never-recorded',
};
const RESUME = Buffer.from('%PDF-1.4\n% Wile E. Coyote, Super Genius. Resume.\n%%EOF\n');
const RESUME_SHA = createHash('sha256').update(RESUME).digest('hex');
const WHY = 'Because ACME ships to the desert overnight.\n\nAnd the anvils are, frankly, superb.';

const work = await realpath(await mkdtemp(join(tmpdir(), 'carbon-copy-e2e-'))); // /var -> /private/var on macOS
const extDir = await buildTestExtension(join(work, 'extension'));
const downloads = join(work, 'downloads');
const server = await serve(0);
const port = server.address().port;
const base = `http://localhost:${port}`;

// Downloads take two settings to land in the temp dir under their real names:
// - Playwright's own download handling saves every file under a GUID name,
//   so it is switched back to "allow" over CDP after launch.
// - "allow" then uses the profile's download directory (it ignores the
//   downloadPath passed with it), which defaults to the real ~/Downloads.
//   The throwaway profile's Preferences point it at the temp dir.
// Learned the hard way: with only the CDP call, a run wrote into ~/Downloads.
const profile = join(work, 'profile');
await mkdir(join(profile, 'Default'), { recursive: true });
await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
}));

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !HEADED,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

{
  const p = await context.newPage();
  const cdp = await context.newCDPSession(p);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await p.close();
}

const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const ext = await context.newPage();
await ext.goto(`chrome-extension://${extId}/popup/popup.html`);

// Guard: prove a download lands in the temp dir before any case runs. If
// it lands anywhere else, delete it and stop.
{
  const probe = await ext.evaluate(async () => {
    const id = await chrome.downloads.download({ url: 'data:text/plain,probe', filename: 'carbon-copy-e2e-probe.txt', saveAs: false });
    for (let i = 0; i < 50; i++) {
      const [item] = await chrome.downloads.search({ id });
      if (item.state !== 'in_progress') return { id, filename: item.filename, state: item.state };
      await new Promise(r => setTimeout(r, 100));
    }
    return { id, filename: null, state: 'timeout' };
  });
  if (!probe.filename || !probe.filename.startsWith(downloads)) {
    await ext.evaluate(id => chrome.downloads.removeFile(id).catch(() => {}), probe.id);
    await context.close();
    server.close();
    console.error(`ABORT: test download went to ${probe.filename} (${probe.state}), not ${downloads}. Removed it.`);
    process.exit(2);
  }
  await rm(probe.filename);
}

const records = () => ext.evaluate(async () => (await import('/src/lib/store.js')).list());
const setSettings = s => ext.evaluate(v => chrome.storage.local.set({ settings: v }), s);

async function waitFor(pick, what, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const hit = pick(await records());
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const submittedFor = (path, by = 'url') => waitFor(
  rs => rs.find(r => r.status === 'submitted' && r.page[by].includes(path) && (r.sink?.md || r.sink?.error)),
  `submitted record for ${path}`,
);

const byLabel = rec => Object.fromEntries(rec.fields.map(f => [f.label, f]));

async function assertOnDisk(rec) {
  assert.ok(rec.sink && !rec.sink.error, `sink failed: ${rec.sink?.error}`);
  assert.equal(rec.sink.warning, undefined, rec.sink.warning);
  assert.ok(rec.sink.md.startsWith(join(downloads, 'carbon-copy')), `md outside downloads dir: ${rec.sink.md}`);
  const md = await readFile(rec.sink.md, 'utf8');
  const json = JSON.parse(await readFile(rec.sink.json, 'utf8'));
  assert.equal(json.id, rec.id);
  assert.equal(json.schema, 1);
  assert.match(md, /^---\ncaptured: "/);
  assert.match(md, new RegExp(`status: "submitted"`));
  for (const s of Object.values(SECRETS)) assert.ok(!md.includes(s), `secret in markdown: ${s}`);
  return md;
}

function assertNoSecrets(rec) {
  const blob = JSON.stringify(rec);
  for (const [k, s] of Object.entries(SECRETS)) assert.ok(!blob.includes(s), `${k} leaked into record`);
}

// ------------------------------------------------------------------ cases

const cases = {
  async 'native-form'(page) {
    await page.goto(`${base}/fixtures/native-form.html`);
    await page.fill('#first_name', 'Wile E.');
    await page.fill('#email', 'wile@carnivorous-vulgaris.example');
    await page.fill('#phone', '555-0100');
    await page.fill('#site', 'https://carnivorous-vulgaris.example');
    await page.fill('#years', '12');
    await page.fill('#start', '2026-12-01');
    await page.selectOption('#auth', 'citizen');
    await page.selectOption('#locations', ['mesa', 'remote']);
    await page.check('input[name="relocate"][value="yes"]');
    await page.check('input[name="shifts"][value="day"]');
    await page.check('input[name="shifts"][value="night"]');
    await page.check('#privacy');
    await page.setInputFiles('#resume', { name: 'wile-e-coyote-resume.pdf', mimeType: 'application/pdf', buffer: RESUME });
    await page.fill('#pw', SECRETS.password);
    await page.fill('#cc', SECRETS.card);
    await page.fill('#ssn', SECRETS.ssn);
    await page.selectOption('#gender', 'm');

    // "Why ACME?" is required and still empty: native validation stops the
    // submit, so this click must not produce a submitted record.
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2500);
    const early = (await records()).find(r => r.page.url.includes('native-form') && r.status === 'submitted');
    assert.equal(early, undefined, 'a submit blocked by validation was recorded as submitted');

    await page.fill('#why', WHY);
    await Promise.all([page.waitForURL('**/submit'), page.click('button[type="submit"]')]);
    const rec = await submittedFor('native-form');
    const f = byLabel(rec);

    assert.equal(f['First name'].display, 'Wile E.');
    assert.equal(f['Email'].display, 'wile@carnivorous-vulgaris.example');
    assert.equal(f['Phone'].display, '555-0100');
    assert.equal(f['Years of anvil experience'].display, '12');
    assert.equal(f['Earliest start date'].display, '2026-12-01');
    assert.equal(f['Why ACME?'].display, WHY);
    assert.deepEqual([f['Work authorization'].display, f['Work authorization'].value], ['US citizen', 'citizen']);
    assert.deepEqual(f['Locations'].value, ['mesa', 'remote']);
    assert.equal(f['Locations'].display, 'Mesa, AZ, Remote');
    assert.deepEqual([f['Willing to relocate?'].display, f['Willing to relocate?'].value], ['Yes', 'yes']);
    assert.equal(f['Preferred shifts'].display, 'Day shift, Night shift');
    assert.equal(f['I agree to the privacy policy'].value, true);

    assert.equal(f['Gender'], undefined, 'EEO field recorded while the toggle is off');
    assert.deepEqual(rec.redacted, { secret: 3, eeo: 1 });
    assert.ok(!rec.fields.some(x => x.name === 'website_hp'), 'honeypot recorded');
    assertNoSecrets(rec);

    assert.equal(rec.files.length, 1);
    assert.deepEqual(
      { label: rec.files[0].label, name: rec.files[0].name, size: rec.files[0].size, sha256: rec.files[0].sha256 },
      { label: 'Resume/CV', name: 'wile-e-coyote-resume.pdf', size: RESUME.length, sha256: RESUME_SHA },
    );
    assert.match(rec.trigger, /^click/);
    assert.deepEqual(rec.context, { company: 'ACME Corporation', role: 'Senior Anvil Engineer' });

    const md = await assertOnDisk(rec);
    assert.match(basename(rec.sink.md), /^\d{4}-\d{2}-\d{2}-acme-corporation-senior-anvil-engineer\.md$/);
    assert.ok(md.includes(`## Why ACME?\n\n${WHY}\n`), 'markdown answer');
    assert.ok(md.includes(RESUME_SHA), 'markdown file hash');
  },

  async 'eeo-toggle'(page) {
    await setSettings({ captureEEO: true });
    try {
      await page.goto(`${base}/fixtures/native-form.html?eeo`);
      await page.fill('#first_name', 'Wile E.');
      await page.fill('#why', 'EEO pass.');
      await page.selectOption('#gender', 'm');
      await Promise.all([page.waitForURL('**/submit'), page.click('button[type="submit"]')]);
      const rec = await submittedFor('native-form.html?eeo');
      assert.equal(byLabel(rec)['Gender']?.display, 'Male');
      assert.equal(rec.redacted.eeo, 0);
      assertNoSecrets(rec);
      await assertOnDisk(rec);
    } finally {
      await setSettings({ captureEEO: false });
    }
  },

  async 'spa-fetch'(page) {
    await page.goto(`${base}/fixtures/spa-fetch.html`);
    await page.fill('#name', 'Wile E. Coyote');
    await page.fill('#rate', '150');
    await page.fill('#pitch', 'XLR-8 skates, calibrated to within a canyon.');
    await page.click('#go');
    await page.waitForSelector('#done');
    const rec = await submittedFor('spa-fetch');
    const f = byLabel(rec);
    assert.equal(f['Full name'].display, 'Wile E. Coyote');
    assert.equal(f['Hourly rate (USD)'].display, '150');
    assert.equal(f['Tell us about a calibration you are proud of'].display, 'XLR-8 skates, calibrated to within a canyon.');
    assert.equal(rec.trigger, 'click');
    await assertOnDisk(rec);
  },

  // An upload widget that clears its input, then a second application in
  // the same page. The first record keeps the file; the "Apply to another
  // job" click and the second application must not inherit it.
  async 'spa-upload'(page) {
    await page.goto(`${base}/fixtures/spa-upload.html`);
    await page.fill('#name', 'Wile E. Coyote');
    await page.setInputFiles('#resume', { name: 'wile-e-coyote-resume.pdf', mimeType: 'application/pdf', buffer: RESUME });
    await page.waitForSelector('#uploaded:has-text("Uploaded")');
    assert.equal(await page.$eval('#resume', el => el.files.length), 0, 'widget should have cleared the input');
    await page.click('#go');
    await page.waitForSelector('#done');
    const first = await submittedFor('spa-upload');
    assert.deepEqual(first.files.map(f => [f.label, f.name, f.sha256]), [['Resume', 'wile-e-coyote-resume.pdf', RESUME_SHA]]);

    await page.click('#more');
    await page.fill('#name', 'Wile E. Coyote, Genius');
    await page.click('#go');
    await page.waitForSelector('#done');
    const second = await waitFor(
      rs => rs.find(r => r.id !== first.id && r.page.url.includes('spa-upload') && r.status === 'submitted' && r.sink),
      'second submitted record',
    );
    assert.equal(byLabel(second)['Full name'].display, 'Wile E. Coyote, Genius');
    assert.deepEqual(second.files, [], 'second application inherited the first one\'s file');
    await page.waitForTimeout(500);
    const all = (await records()).filter(r => r.page.url.includes('spa-upload'));
    assert.deepEqual(all.map(r => r.fields.length).sort(), [1, 1], `phantom record: ${JSON.stringify(all.map(r => [r.status, r.fields.length, r.files.length]))}`);
    await assertOnDisk(first);
    await assertOnDisk(second);
  },

  async 'clear-on-click'(page) {
    await page.goto(`${base}/fixtures/clear-on-click.html`);
    await page.fill('#name', 'Wile E. Coyote');
    await page.fill('#depth', '36');
    await page.fill('#story', 'It was painted on a rock.');
    await page.click('#go');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Received.');
    const rec = await submittedFor('clear-on-click');
    const f = byLabel(rec);
    assert.equal(f['Full name'].display, 'Wile E. Coyote', 'click snapshot lost to a form that clears on click');
    assert.equal(f['Deepest hole installed (feet)'].display, '36');
    assert.equal(f['Describe a hole that went wrong'].display, 'It was painted on a rock.');
    assert.equal(rec.trigger, 'click+submit');
    await assertOnDisk(rec);
  },

  async 'iframe-embed'(page) {
    await page.goto(`${base}/fixtures/iframe-embed.html`);
    const frame = page.frameLocator('#embed');
    await frame.locator('#first_name').fill('Wile E.');
    await frame.locator('#cover').fill('Just add water.');
    await frame.locator('button[type="submit"]').click();
    const rec = await submittedFor('127.0.0.1', 'frameUrl');
    assert.equal(rec.page.origin, `http://127.0.0.1:${port}`);
    assert.ok(rec.page.url.startsWith(`http://localhost:${port}`), `page.url should be the embedding page, got ${rec.page.url}`);
    assert.equal(byLabel(rec)['Cover letter'].display, 'Just add water.');
    assert.deepEqual(rec.context, { company: 'ACME Corporation', role: 'Dehydrated Boulder Specialist' });
    await assertOnDisk(rec);
  },

  async 'multistep'(page) {
    await page.goto(`${base}/fixtures/multistep.html`);
    await page.fill('#legal_name', 'Wile E. Coyote');
    await page.fill('#contact_email', 'wile@carnivorous-vulgaris.example');
    await page.click('#next'); // immediately: the draft must flush before the DOM swaps
    await page.fill('#quakes', '7');
    await page.fill('#note', 'Not for consumption by canines. Noted.');
    await page.click('#next');
    await page.fill('#day_rate', '875');
    await page.fill('#available', 'Monday');
    await page.click('#submit');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Application received.');
    const rec = await submittedFor('multistep');
    assert.deepEqual(
      rec.fields.map(x => [x.label, x.display, x.step]),
      [
        ['Legal name', 'Wile E. Coyote', 1],
        ['Contact email', 'wile@carnivorous-vulgaris.example', 1],
        ['Earthquakes survived', '7', 2],
        ['Anything else we should know', 'Not for consumption by canines. Noted.', 2],
        ['Day rate (USD)', '875', 3],
        ['Available from', 'Monday', 3],
      ],
    );
    const md = await assertOnDisk(rec);
    assert.ok(md.includes('*Step 2*'), 'markdown step markers');
  },

  async 'richtext'(page) {
    await page.goto(`${base}/fixtures/richtext.html`);
    await page.click('.editor[contenteditable]');
    await page.keyboard.type('Line one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Line two');
    await page.frameLocator('#frame-editor').locator('body').click();
    await page.keyboard.type('Tunnels are just paint.');
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Sent.');
    const rec = await submittedFor('richtext');
    const f = byLabel(rec);
    assert.match(f['Cover letter'].display, /^Line one\n+Line two$/);
    assert.equal(f['Cover letter'].type, 'richtext');
    assert.equal(f['Describe your best tunnel'].display, 'Tunnels are just paint.');
    await assertOnDisk(rec);
  },

  async 'labels'(page) {
    await page.goto(`${base}/fixtures/labels.html`);
    await page.fill('#p1', 'v1');
    await page.selectOption('select[name="p2"]', 'a');
    await page.fill('input[name="p3"]', 'v3');
    await page.fill('input[name="p4"]', 'v4');
    await page.check('input[name="p5"][value="north"]');
    await page.fill('textarea[name="cards[q6]"]', 'v6');
    await page.selectOption('select[name="p6b"]', '1');
    await page.fill('input[name="p7"]', 'v7');
    await page.fill('input[name="name_only"]', 'v8');
    await page.fill('#p9', 'v9');
    await page.fill('textarea[name="question_48213"]', 'v10');
    await Promise.all([page.waitForURL('**/submit'), page.click('button[type="submit"]')]);
    const rec = await submittedFor('labels');
    assert.deepEqual(
      rec.fields.map(x => [x.label, x.display]),
      [
        ['Label for', 'v1'],
        ['Wrapping label', 'Option A'],
        ['Labeled by', 'v3'],
        ['Aria label', 'v4'],
        ['Legend group', 'North pole'],
        ['Container question', 'v6'],
        ['Label without for', 'Yes'],
        ['Placeholder only', 'v7'],
        ['name_only', 'v8'],
        ['Starred', 'v9'],
        ['Help button between', 'v10'],
      ],
    );
    await assertOnDisk(rec);
  },

  async 'draft-stays-in-browser'(page) {
    const before = await readdir(join(downloads, 'carbon-copy')).catch(() => []);
    await page.goto(`${base}/fixtures/spa-fetch.html?draft`);
    await page.fill('#name', 'Ralph Wolf');
    const rec = await waitFor(
      rs => rs.find(r => r.page.url.includes('spa-fetch.html?draft') && r.status === 'draft'),
      'draft record',
    );
    assert.equal(byLabel(rec)['Full name'].display, 'Ralph Wolf');
    assert.equal(rec.sink, null);
    await page.waitForTimeout(1000);
    const after = await readdir(join(downloads, 'carbon-copy')).catch(() => []);
    assert.deepEqual(after, before, 'a draft was written to disk');
  },

  async 'popup'(page) {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`chrome-extension://${extId}/popup/popup.html`);
    await page.waitForSelector('#records li');
    const titles = await page.locator('#records li .title').allTextContents();
    assert.ok(titles.length > 0);
    assert.ok(titles.some(t => t.includes('at ACME Corporation')), `popup titles: ${titles.join(' | ')}`);
    assert.deepEqual(errors, []);
  },

  // Runs last: it swaps the download folder for a symlink. Chrome never
  // writes through one. Seen so far, depending on circumstances: it saves
  // "download.md" at the top of the download folder and reports success
  // (symlink present at browser start), or it cancels with USER_CANCELED
  // (symlink created mid-session). Either way the record must say the
  // files are not where they should be.
  async 'symlink-warning'() {
    const dir = join(downloads, 'carbon-copy');
    const real = join(downloads, 'carbon-copy-real');
    const elsewhere = join(work, 'elsewhere');
    await rename(dir, real);
    await mkdir(elsewhere);
    await symlink(elsewhere, dir);
    try {
      const [r] = (await records()).filter(x => x.status === 'submitted');
      const res = await ext.evaluate(id => chrome.runtime.sendMessage({ type: 'cc:redownload', id }), r.id);
      assert.ok(res.ok, res.error);
      const s = res.record.sink;
      assert.deepEqual(await readdir(elsewhere), [], 'Chrome wrote through the symlink');
      assert.match(s.warning || s.error || '', /symlink/, JSON.stringify(s));
      if (s.md) await rm(s.md, { force: true });
      if (s.json) await rm(s.json, { force: true });
    } finally {
      await rm(dir);
      await rename(real, dir);
    }
  },

  // Last of all: it deletes records. By now the store holds saved
  // submissions, the draft from 'draft-stays-in-browser', and the record
  // 'symlink-warning' left with a failed save. Only the saved ones may go.
  async 'popup-clear'(page) {
    const files = await readdir(join(downloads, 'carbon-copy'));
    const before = await records();
    const isSaved = r => r.status === 'submitted' && r.sink?.md && r.sink?.json && !r.sink.error && !r.sink.warning;
    const saved = before.filter(isSaved);
    const keep = before.filter(r => !isSaved(r)).map(r => r.id).sort();
    assert.ok(saved.length > 0 && keep.length >= 2, `fixture state: ${saved.length} saved, ${keep.length} unsaved`);

    await page.goto(`chrome-extension://${extId}/popup/popup.html`);
    await page.waitForSelector('#clear:not([hidden])');
    await page.click('#clear');
    // The first click reads the store before it relabels, so wait for it.
    await page.waitForFunction(t => document.getElementById('clear').textContent === t, `Clear ${saved.length} saved?`);
    assert.equal((await records()).length, before.length, 'first click must not delete');
    await page.click('#clear');
    await page.waitForFunction(() => document.getElementById('msg').textContent.startsWith('Cleared'));

    assert.deepEqual((await records()).map(r => r.id).sort(), keep, 'kept exactly the records with no file on disk');
    assert.equal(await page.locator('#records li').count(), keep.length);
    assert.ok(await page.isHidden('#clear'), 'Clear still offered with nothing saved left to clear');
    assert.match(await page.textContent('#msg'), new RegExp(`Kept ${keep.length} not saved to disk`));
    assert.deepEqual(await readdir(join(downloads, 'carbon-copy')), files, 'clearing touched files on disk');
  },
};

// ------------------------------------------------------------------ run

let failed = 0;
for (const [name, fn] of Object.entries(cases)) {
  if (ONLY && name !== ONLY) continue;
  const page = await context.newPage();
  const t = Date.now();
  try {
    await fn(page);
    console.log(`PASS  ${name}  (${Date.now() - t}ms)`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(err.stack || err).split('\n').slice(0, 6).join('\n      ')}`);
  } finally {
    await page.close();
  }
}

if (!ONLY || ONLY === 'native-form') {
  const files = await readdir(join(downloads, 'carbon-copy')).catch(() => []);
  console.log(`\n${files.length} files in ${join(downloads, 'carbon-copy')}`);
}

await context.close();
server.close();
if (KEEP) console.log(`kept: ${work}`);
else await rm(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
