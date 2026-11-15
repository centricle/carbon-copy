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
import { SUBMIT_INTERVAL_MS } from '../src/lib/throttle.js';

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
// Merged into the stored settings, never replacing them: consentedAt lives there too.
const setSettings = s => ext.evaluate(async v => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, ...v } });
}, s);
const WELCOME = `chrome-extension://${extId}/welcome/welcome.html`;

// Every case but 'consent' runs as if the welcome page's Start recording
// had been clicked.
await setSettings({ consentedAt: new Date().toISOString() });

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

// A real (trusted) file drop, through the browser's input pipeline rather
// than a script-built DataTransfer. The file is written under the temp dir.
async function dropFile(page, selector, name) {
  const path = join(work, name);
  await writeFile(path, RESUME);
  const box = await page.locator(selector).boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const data = { items: [], files: [path], dragOperationsMask: 1 };
  const cdp = await page.context().newCDPSession(page);
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, ...at, data });
  await cdp.detach();
}

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

  // A form that is not empty before anyone types: a default select, a
  // page-written hidden token, a captcha that fires an input event.
  async 'defaults'(page) {
    await page.goto(`${base}/fixtures/defaults.html`);
    await page.waitForFunction(() => document.body.dataset.primed === '2');
    await page.click('#apply');
    await page.waitForTimeout(2500);
    const summary = rs => JSON.stringify(rs.map(r => [r.status, r.trigger, r.fields.map(f => `${f.label}=${f.display}`)]));
    const early = (await records()).filter(r => r.page.url.includes('defaults.html'));
    assert.equal(early.length, 0, `"Apply" on an untouched form made a record: ${summary(early)}`);

    await page.fill('#nm', 'Wile E. Coyote');
    await Promise.all([page.waitForURL('**/submit'), page.click('button[type="submit"]')]);
    const rec = await submittedFor('defaults.html');
    assert.deepEqual(rec.fields.map(f => [f.label, f.display]), [['Country', 'United States'], ['Full name', 'Wile E. Coyote']]);
    const blob = JSON.stringify(rec);
    assert.ok(!blob.includes('RECAPTCHA-TOKEN-VALUE'), 'captcha token recorded');
    assert.ok(!blob.includes('PAGE-WRITTEN-FINGERPRINT'), 'page-written hidden value recorded');
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

    const t0 = Date.now();
    await page.click('#more');
    await page.fill('#name', 'Wile E. Coyote, Genius');
    // A person takes longer than the submit gate's interval to fill in a
    // second application; this test does not, so it waits the gap out.
    await page.waitForTimeout(Math.max(0, SUBMIT_INTERVAL_MS - (Date.now() - t0)));
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

  // The redaction and EEO rules apply to files too, picked or dropped.
  async 'uploads'(page) {
    await page.goto(`${base}/fixtures/uploads.html`);
    await page.fill('#name', 'Wile E. Coyote');
    const pdf = name => ({ name, mimeType: 'application/pdf', buffer: RESUME });
    await page.setInputFiles('#resume', pdf('wile-e-coyote-resume.pdf'));
    await page.setInputFiles('#ssncard', { name: 'ssn-card-scan.png', mimeType: 'image/png', buffer: Buffer.from('not a real card') });
    await page.setInputFiles('#dis', pdf('disability-letter.pdf'));
    await dropFile(page, '#portfolio-drop', 'acme-portfolio.pdf');
    await dropFile(page, '#vet-drop', 'dd-214.pdf');
    await page.waitForSelector('#vet-drop:has-text("Attached")');
    await Promise.all([page.waitForURL('**/submit'), page.click('button[type="submit"]')]);
    const rec = await submittedFor('uploads.html');
    assert.deepEqual(rec.files.map(f => [f.label, f.name]).sort(), [['Portfolio', 'acme-portfolio.pdf'], ['Resume', 'wile-e-coyote-resume.pdf']]);
    const blob = JSON.stringify(rec);
    for (const name of ['ssn-card-scan', 'disability-letter', 'dd-214']) assert.ok(!blob.includes(name), `${name} recorded`);
    assert.deepEqual(rec.redacted, { secret: 1, eeo: 1 });
    await assertOnDisk(rec);
  },

  // Bank, tax, ID and birth-date answers, by label and by value, next to
  // decoys that look alike. Checked in the files on disk, not the record.
  async 'sensitive'(page) {
    const secrets = {
      '#bank': '000123456789', '#routing': '011000015', '#iban': 'GB82 WEST 1234 5698 7654 32',
      '#ein': '98-7654321', '#dob': '1949-09-17', '#passport': 'C03005988', '#license': 'D123-4567-8901',
      '#ref': '219-09-9999', '#other': '4012 8888 8888 1881', '#memo': 'DE89 3704 0044 0532 0130 00',
    };
    const decoys = {
      '#name': 'Wile E. Coyote', '#tel': '612 345 678', '#phone': '600 100 200', '#zip': '85001-1234',
      '#swift': '6', '#order': '1234567890123',
      '#cover': 'Invoice 5555 5555 5555 4444 arrived crushed. Frankly, again.',
    };
    await page.goto(`${base}/fixtures/sensitive.html`);
    for (const [sel, v] of Object.entries({ ...secrets, ...decoys })) await page.fill(sel, v);
    await page.selectOption('#bmonth', '9');
    await page.check('input[name="has_passport"][value="yes"]');
    await Promise.all([page.waitForURL('**/submit'), page.click('button[type="submit"]')]);
    const rec = await submittedFor('sensitive.html');
    await assertOnDisk(rec);

    const onDisk = (await readFile(rec.sink.md, 'utf8')) + (await readFile(rec.sink.json, 'utf8'));
    for (const v of [...Object.values(secrets), 'September']) {
      for (const form of new Set([v, v.replace(/[\s-]/g, '')])) assert.ok(!onDisk.includes(form), `secret on disk: ${form}`);
    }
    for (const v of Object.values(decoys)) assert.ok(onDisk.includes(JSON.stringify(v).slice(1, -1)), `decoy missing: ${v}`);
    assert.equal(rec.fields.map(f => f.label).join(' | '), [
      'Full name', 'Contact', 'Phone', 'ZIP code', 'Years with Swift?', 'Last ACME order number',
      'Do you have a valid passport?', 'Cover letter',
    ].join(' | '));
    assert.equal(byLabel(rec)['Do you have a valid passport?'].display, 'Yes');
    assert.equal(rec.redacted.secret, 11);
  },

  // Page scripts that try to make records nobody submitted: a forged drop,
  // a scripted click on Send, a synthetic submit event, then a
  // requestSubmit() loop (trusted events, so only the SW gate stops it).
  async 'flood'(page) {
    const ours = async () => (await records()).filter(r => r.page.url.includes('flood.html'));
    const onDisk = async () => (await readdir(join(downloads, 'carbon-copy'))).filter(n => n.includes('desert-signage-painter'));
    await page.goto(`${base}/fixtures/flood.html`);
    await page.fill('#name', 'Wile E. Coyote');
    await page.fill('#note', 'Is the Road Runner in?');
    await page.evaluate(() => { forgeDrop(); forgeClick(); forgeSubmitEvent(); });
    await page.waitForTimeout(2500);
    assert.deepEqual((await ours()).filter(r => r.status === 'submitted').map(r => r.trigger), [], 'a scripted click or submit event made a submission');

    await page.evaluate(() => flood(10));
    const rec = await submittedFor('flood.html');
    await page.waitForTimeout(1500);
    const all = await ours();
    assert.equal(all.filter(r => r.status === 'submitted').length, 1, `submissions: ${all.map(r => r.status).join(', ')}`);
    assert.ok(!JSON.stringify(all).includes('forged-portfolio'), 'forged drop recorded');
    assert.equal((await onDisk()).length, 2, 'files on disk from the flood');
    await assertOnDisk(rec);
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

  // Nothing is recorded before Start recording on the welcome page, which
  // opened on its own at install.
  async 'consent'(page) {
    assert.ok(context.pages().some(p => p.url() === WELCOME), 'welcome page did not open on install');
    const fill = async q => {
      await page.goto(`${base}/fixtures/spa-fetch.html?${q}`);
      await page.fill('#name', 'Wile E. Coyote');
      await page.fill('#pitch', `Consent check, ${q}.`);
    };
    const ours = async q => (await records()).filter(r => r.page.url.includes(`spa-fetch.html?${q}`));
    const list = () => readdir(join(downloads, 'carbon-copy')).catch(() => []);
    const before = await list();
    const saved = await ext.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    await ext.evaluate(s => chrome.storage.local.set({ settings: { ...s, consentedAt: undefined } }), saved);
    try {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
      await popup.waitForFunction(() => document.getElementById('site-state').textContent === 'not recording yet');
      assert.equal(await popup.textContent('#site-toggle'), 'Set up and start recording');
      await popup.close();

      await fill('before');
      await page.click('#go');
      await page.waitForSelector('#done');
      await page.waitForTimeout(2500);
      assert.deepEqual(await ours('before'), [], 'recorded before consent');
      assert.deepEqual(await list(), before, 'files written before consent');

      const welcome = await context.newPage();
      await welcome.goto(WELCOME);
      await welcome.click('#start');
      await welcome.waitForSelector('#started:not([hidden])');
      assert.ok(await welcome.isHidden('#start'));
      await welcome.close();

      await fill('after');
      await page.click('#go');
      await page.waitForSelector('#done');
      const rec = await submittedFor('spa-fetch.html?after');
      await assertOnDisk(rec);
    } finally {
      await setSettings({ consentedAt: saved.consentedAt });
    }
  },

  // The SW stores snapshots only from frames on a covered site. "Stop
  // recording this site" relies on it (the script in an open tab keeps
  // running), and so does any sender that is not a page at all. The
  // fixture server is http, so this cannot grant and revoke a real site;
  // the unit test covers that transition in isCovered.
  async 'uncovered-sender'() {
    const snapshot = {
      fields: [{ label: 'Full name', name: 'n', type: 'text', value: 'Road Runner', display: 'Road Runner', step: 1 }],
      files: [], redacted: { secret: 0, eeo: 0 }, takenAt: new Date().toISOString(),
      page: { url: 'https://uncovered.example/apply', title: 'Uncovered', frameUrl: 'https://uncovered.example/apply', origin: 'https://uncovered.example' },
      meta: {},
    };
    const before = (await records()).length;
    const res = await ext.evaluate(s => chrome.runtime.sendMessage({ type: 'cc:snapshot', status: 'submitted', trigger: 'submit', snapshot: s }), snapshot);
    assert.ok(res.ok, res.error);
    assert.equal(res.record, null, 'snapshot from an uncovered sender was stored');
    assert.equal((await records()).length, before);
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
