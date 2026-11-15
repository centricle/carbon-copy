// Pure-function tests: presets, rendering, filenames, step stitching.
//   node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MATCHES, extractContext, matchesPattern, isPresetUrl } from '../src/presets/jobs.js';
import { renderMarkdown, heading } from '../src/lib/render-md.js';
import { basename, slug, landedWhereAsked } from '../src/lib/sink-downloads.js';
import { mergeSteps, isSafelySaved } from '../src/lib/record.js';
import { isCovered } from '../src/lib/coverage.js';

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
  assert.ok(md.includes('1 sensitive field (passwords, card numbers, SSN) never recorded'));
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
