// Pure-function tests: presets, rendering, filenames, step stitching.
//   node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MATCHES, extractContext, matchesPattern, isPresetUrl } from '../src/presets/jobs.js';
import { renderMarkdown, heading } from '../src/lib/render-md.js';
import { basename, slug, landedWhereAsked } from '../src/lib/sink-downloads.js';
import { mergeSteps, isSafelySaved, buildRecord, LIMITS } from '../src/lib/record.js';
import { createSubmitGate, fingerprint } from '../src/lib/throttle.js';
import { isCovered, concreteOrigins } from '../src/lib/coverage.js';

// redact.js is a classic script for the content script: it sets a global.
await import('../src/lib/redact.js');
const R = globalThis.CarbonCopyRedact;

// Just enough of an element for redact.js: attributes, tag, no ancestors
// unless a legend is given.
function el({ tag = 'INPUT', legend = null, ...attrs } = {}) {
  return {
    tagName: tag,
    id: attrs.id || '',
    getAttribute: k => attrs[k] ?? null,
    parentElement: null,
    closest: () => legend && { tagName: 'FIELDSET', getAttribute: () => null, querySelector: () => ({ textContent: legend }) },
  };
}

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('preset MATCHES equals the manifest content_scripts matches', () => {
  assert.deepEqual(manifest.content_scripts[0].matches, MATCHES);
});

test('matchesPattern', () => {
  assert.ok(matchesPattern('https://*.greenhouse.io/*', 'https://boards.greenhouse.io/acme/jobs/1'));
  assert.ok(matchesPattern('https://*.greenhouse.io/*', 'https://greenhouse.io/'));
  assert.ok(!matchesPattern('https://*.greenhouse.io/*', 'https://evilgreenhouse.io/'));
  assert.ok(!matchesPattern('https://jobs.lever.co/*', 'http://jobs.lever.co/acme'));
  assert.ok(matchesPattern('http://localhost/*', 'http://localhost:7072/fixtures/multistep.html'), 'any port');
  assert.ok(isPresetUrl('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/x'));
  assert.ok(!isPresetUrl('https://acme.example/careers'));
});

test('extractContext: Greenhouse board and embed', () => {
  assert.deepEqual(
    extractContext('https://boards.greenhouse.io/acme/jobs/123', { ogTitle: 'Job Application for Anvil Engineer at ACME Corporation' }),
    { company: 'ACME Corporation', role: 'Anvil Engineer', preset: 'jobs' },
  );
  const embed = extractContext('https://acme.example/careers', { h1: 'Anvil Engineer' },
    'https://boards.greenhouse.io/embed/job_app?for=acme&token=123');
  assert.equal(embed.company, 'acme');
  assert.equal(embed.role, 'Anvil Engineer');
});

test('extractContext: Lever, Ashby, Workday, SmartRecruiters', () => {
  assert.deepEqual(
    extractContext('https://jobs.lever.co/acme/abc-123/apply', { ogTitle: 'ACME Corporation - Rocket Skate Fitter' }),
    { company: 'ACME Corporation', role: 'Rocket Skate Fitter', preset: 'jobs' },
  );
  assert.equal(extractContext('https://jobs.ashbyhq.com/acme/uuid/application', { h1: 'Magnet Tech' }).company, 'acme');
  assert.equal(extractContext('https://acme.wd5.myworkdayjobs.com/en-US/External/job/x').company, 'acme');
  assert.deepEqual(
    extractContext('https://jobs.smartrecruiters.com/ACME/7438-anvil-engineer'),
    { company: 'ACME', role: 'anvil engineer', preset: 'jobs' },
  );
});

test('extractContext: fallback to site name, then host', () => {
  assert.deepEqual(
    extractContext('https://www.acme.example/apply', { ogSiteName: 'ACME Corporation', h1: 'Tunnel Painter' }),
    { company: 'ACME Corporation', role: 'Tunnel Painter', preset: null },
  );
  assert.equal(extractContext('https://www.acme.example/apply', { title: 'Apply' }).company, 'acme.example');
});

const record = {
  schema: 1,
  id: 'r1',
  status: 'submitted',
  trigger: 'click+submit',
  capturedAt: '2026-11-15T22:30:00.000Z',
  page: { url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'Apply "now"', frameUrl: 'x', origin: 'x' },
  context: { company: 'ACME Corporation', role: 'Anvil Engineer' },
  fields: [
    { label: 'First name', type: 'text', value: 'Wile E.', display: 'Wile E.', step: 1 },
    { label: 'Anything else?', type: 'textarea', value: '', display: '', step: 1 },
  ],
  files: [{ label: 'Resume/CV', name: 'resume.pdf', size: 2048, type: 'application/pdf', sha256: 'ab'.repeat(32) }],
  redacted: { secret: 1, eeo: 4 },
  evidence: [],
  sink: null,
};

test('renderMarkdown', () => {
  const md = renderMarkdown(record);
  assert.ok(md.startsWith('---\ncaptured: "2026-11-15T22:30:00.000Z"\nstatus: "submitted"\n'));
  assert.ok(md.includes('title: "Apply \\"now\\""'), 'YAML-quoted title');
  assert.ok(md.includes('# Anvil Engineer at ACME Corporation\n'));
  assert.ok(md.includes('## First name\n\nWile E.\n'));
  assert.ok(md.includes('## Anything else?\n\n_(blank)_\n'));
  assert.ok(md.includes('- **Resume/CV**: `resume.pdf`, 2.0 KB, application/pdf'));
  assert.ok(md.includes('1 sensitive field (passwords, card, bank and ID numbers, date of birth) never recorded'));
  assert.ok(md.includes('4 EEO self-ID fields skipped'));
  assert.ok(!md.includes('*Step'), 'no step markers for a one-step form');
  assert.equal(heading({ ...record, context: {} }), 'Apply "now"');
});

test('slug and basename', () => {
  assert.equal(slug('Café Société: Anvils & Co.'), 'cafe-societe-anvils-co');
  assert.match(basename(record), /^2026-11-1[56]-acme-corporation-anvil-engineer$/);
  assert.match(basename({ ...record, context: {} }), /-boards-greenhouse-io-apply-now$/);
});

test('landedWhereAsked: POSIX and Windows paths, uniquified names, symlink fallout', () => {
  const asked = 'carbon-copy/2026-11-15-acme-corporation-anvil-engineer.md';
  assert.ok(landedWhereAsked('/Users/wile/Downloads/carbon-copy/2026-11-15-acme-corporation-anvil-engineer.md', asked));
  assert.ok(landedWhereAsked('C:\\Users\\wile\\Downloads\\carbon-copy\\2026-11-15-acme-corporation-anvil-engineer.md', asked));
  assert.ok(landedWhereAsked('C:\\Users\\wile\\Downloads\\carbon-copy\\2026-11-15-acme-corporation-anvil-engineer (1).md', asked));
  assert.ok(!landedWhereAsked('/Users/wile/Downloads/download.md', asked), 'symlinked folder: Chrome saves download.md at the top');
  assert.ok(!landedWhereAsked('C:\\Users\\wile\\Downloads\\download.md', asked));
  assert.ok(!landedWhereAsked('', asked));
});

test('isCovered: manifest matches, granted sites, nothing else', async () => {
  const granted = new Set(['https://acme.example/*']);
  const contains = async p => granted.has(p);
  assert.ok(await isCovered('https://boards.greenhouse.io/acme/jobs/1', MATCHES, contains));
  assert.ok(await isCovered('https://acme.example/careers/apply', MATCHES, contains));
  assert.ok(await isCovered('https://acme.example:8443/apply', MATCHES, contains), 'port ignored, like the grant');
  granted.delete('https://acme.example/*'); // Stop recording this site
  assert.ok(!(await isCovered('https://acme.example/careers/apply', MATCHES, contains)));
  assert.ok(!(await isCovered('chrome-extension://abc/popup/popup.html', MATCHES, async () => true)));
  assert.ok(!(await isCovered('about:blank', MATCHES, async () => true)));
  assert.ok(!(await isCovered(undefined, MATCHES, async () => true)));
});

test('concreteOrigins: a wildcard grant is not a site', () => {
  assert.deepEqual(
    concreteOrigins(['https://*/*', '<all_urls>', '*://*/*', 'http://*/*', 'https://*.com/*',
      'https://acme.example/*', 'https://*.acme.example/*']),
    ['https://acme.example/*', 'https://*.acme.example/*'],
  );
  assert.deepEqual(concreteOrigins(undefined), []);
});

test('secretReason: bank, tax, ID and birth-date labels and names', () => {
  const secret = [
    ['Bank account number'], ['Account #'], ['Routing number'], ['ABA routing number'], ['IBAN'],
    ['SWIFT/BIC code'], ['BIC'], ['Sort code'], ['Tax ID'], ['Taxpayer identification number'],
    ['Employer Identification Number'], ['TIN'], ['Federal EIN'], ['ITIN'], ['Date of birth'],
    ['Birth date'], ['Birthday'], ['DOB'], ['Passport number'], ['Driver’s license'],
    ['Driving licence number'], ['National Insurance number'], ['National ID'],
  ];
  for (const [label] of secret) assert.ok(R.secretReason(el(), label), `kept: ${label}`);
  for (const name of ['routingNumber', 'applicant[dob]', 'bank_account', 'iban', 'tax-id', 'dateOfBirth', 'passport_no'])
    assert.ok(R.secretReason(el({ name }), 'Field'), `kept name: ${name}`);
  assert.ok(R.secretReason(el({ id: 'ssn' }), 'Field'), 'id checked, not only name');
  for (const id of ['swift', 'routing']) assert.equal(R.secretReason(el({ id }), 'Years with it?'), null, `bare id ${id}`);
  assert.ok(R.secretReason(el({ autocomplete: 'bday-year' }), 'Year'));
  assert.ok(R.secretReason(el({ tag: 'SELECT', legend: 'Date of birth' }), 'Month'), 'DOB split into selects');

  const kept = [
    'Years with Swift?', 'ABA therapy experience', 'Geben Sie ein Beispiel', 'Tin can design portfolio',
    'Network routing experience', 'Your Account Manager', 'Birthplace of the company?',
  ];
  for (const label of kept) assert.equal(R.secretReason(el(), label), null, `dropped: ${label}`);
  // Identity documents count on free text only.
  assert.equal(R.secretReason(el({ type: 'radio', name: 'passport' }), 'Do you have a valid passport?'), null);
  assert.equal(R.secretReason(el({ tag: 'SELECT' }), 'Do you hold a driver\'s license?'), null);
  assert.ok(R.secretReason(el({ tag: 'TEXTAREA' }), 'Passport'));
});

test('secretValue: card, SSN, routing and IBAN values, not decoys', () => {
  const plain = el({ type: 'text' });
  for (const v of ['4111 1111 1111 1111', '4012-8888-8888-1881', '078-05-1120', '011000015', 'GB82 WEST 1234 5698 7654 32', ' DE89370400440532013000 '])
    assert.ok(R.secretValue(plain, 'Anything else?', v), `kept: ${v}`);
  assert.equal(R.secretValue(el({ type: 'tel' }), 'Contact', '612 345 678'), null, 'tel field');
  assert.equal(R.secretValue(plain, 'Phone', '612 345 678'), null, 'phone label');
  assert.equal(R.secretValue(plain, 'ZIP code', '85001-1234'), null, 'ZIP+4');
  assert.equal(R.secretValue(el({ autocomplete: 'postal-code' }), 'Code', '850011234'), null);
  assert.equal(R.secretValue(plain, 'Years with Swift?', '6'), null);
  assert.equal(R.secretValue(plain, 'Order number', '1234567890123'), null, '13 digits failing Luhn');
  assert.equal(R.secretValue(plain, 'IBAN-ish', 'GB82 WEST 1234 5698 7654 33'), null, 'bad IBAN checksum');
  assert.equal(R.secretValue(el({ tag: 'TEXTAREA' }), 'Cover letter',
    'I have shipped 4111 1111 1111 1111 anvils and 078-05-1120 rockets.'), null, 'prose that mentions a number');
  assert.equal(R.secretValue(plain, 'Rate', ['011000015']), null, 'arrays are not checked');
});

test('submit gate: one per tab and site per interval, no repeats', async () => {
  let t = 0;
  const gate = createSubmitGate({ interval: 5000, duplicateWindow: 600000, now: () => t });
  const a = await fingerprint(record);
  const b = await fingerprint({ ...record, fields: [{ ...record.fields[0], value: 'Wile E. II' }] });
  assert.notEqual(a, b);
  assert.equal(gate('1|https://acme.example', a), null);
  t = 1000;
  assert.equal(gate('1|https://acme.example', b), 'too-soon');
  assert.equal(gate('2|https://acme.example', b), null, 'another tab is not throttled');
  t = 6000;
  assert.equal(gate('1|https://acme.example', a), 'duplicate');
  assert.equal(gate('1|https://acme.example', b), null);
  t = 6000 + 600000;
  assert.equal(gate('1|https://acme.example', b), null, 'a repeat after the window goes through');
});

test('buildRecord clips oversized fields and says so', () => {
  const big = 'x'.repeat(LIMITS.chars + 10);
  const snapshot = {
    takenAt: record.capturedAt,
    page: record.page,
    fields: [
      { label: 'Huge', name: 'h', type: 'textarea', value: big, display: big },
      { label: 'Fine', name: 'f', type: 'text', value: 'ok', display: 'ok' },
      ...Array.from({ length: LIMITS.fields }, (_, i) => ({ label: `F${i}`, type: 'text', value: '', display: '' })),
    ],
    files: [],
  };
  const r = buildRecord({ snapshot, status: 'draft', trigger: 'input' });
  assert.equal(r.fields.length, LIMITS.fields);
  assert.equal(r.fields[0].value.length, LIMITS.chars);
  assert.equal(r.fields[0].clipped, true);
  assert.equal('clipped' in r.fields[1], false);
});

test('isSafelySaved: only submissions with both files where they belong', () => {
  const ok = { md: '/d/carbon-copy/a.md', json: '/d/carbon-copy/a.json' };
  assert.ok(isSafelySaved({ status: 'submitted', sink: ok }));
  assert.ok(!isSafelySaved({ status: 'draft', sink: null }));
  assert.ok(!isSafelySaved({ status: 'draft', sink: ok }), 'a re-saved draft is still a draft');
  assert.ok(!isSafelySaved({ status: 'submitted', sink: null }), 'sink still running');
  assert.ok(!isSafelySaved({ status: 'submitted', sink: { error: 'USER_CANCELED' } }));
  assert.ok(!isSafelySaved({ status: 'submitted', sink: { ...ok, warning: 'symlink' } }));
});

test('mergeSteps keeps earlier steps, drops vanished same-step fields', () => {
  const prior = { fields: [
    { label: 'Name', name: 'name', type: 'text', display: 'W', step: 1 },
    { label: 'Conditional', name: 'cond', type: 'text', display: 'x', step: 2 },
    { label: 'Years', name: 'years', type: 'text', display: '7', step: 2 },
  ], files: [] };
  const next = { fields: [{ label: 'Years', name: 'years', type: 'text', display: '8', step: 2 }], files: [] };
  assert.deepEqual(mergeSteps(prior, next).fields.map(f => [f.name, f.display]), [['name', 'W'], ['years', '8']]);
});
