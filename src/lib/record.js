// The canonical record. Every other format (Markdown, JSON export) renders
// this; nothing else is a source of truth. Bump SCHEMA on any change a
// reader of an old .json file would trip over.

import { extractContext } from '../presets/jobs.js';

export const SCHEMA = 1;
export const STATUS = Object.freeze({ DRAFT: 'draft', SUBMITTED: 'submitted' });

// Bounds on what one record can hold. No real application comes near them;
// they exist so a page cannot bloat the store or the files (a field holding
// megabytes, ten thousand fields). A clipped field says so.
export const LIMITS = Object.freeze({ fields: 500, files: 100, chars: 100_000, label: 500 });

function clip(v, max = LIMITS.chars, cut = () => {}) {
  if (typeof v === 'string' && v.length > max) { cut(); return v.slice(0, max); }
  if (Array.isArray(v)) {
    if (v.length > LIMITS.fields) cut();
    return v.slice(0, LIMITS.fields).map(x => clip(x, max, cut));
  }
  return v;
}

function clipField(f) {
  let clipped = false;
  const cut = () => { clipped = true; };
  const out = {
    label: clip(f.label, LIMITS.label, cut),
    name: clip(f.name ?? null, LIMITS.label, cut),
    type: clip(f.type, LIMITS.label),
    value: clip(f.value, LIMITS.chars, cut),
    display: clip(f.display, LIMITS.chars, cut),
    step: f.step ?? 1,
  };
  if (clipped) out.clipped = true;
  return out;
}

// snapshot: what the content script sent (see src/content/capture.js)
// prior:    the existing record for this session, if any
export function buildRecord({ snapshot, status, trigger, prior = null }) {
  const page = {
    url: snapshot.page.url,
    title: snapshot.page.title || '',
    frameUrl: snapshot.page.frameUrl,
    origin: snapshot.page.origin,
  };
  const ctx = extractContext(page.url, snapshot.meta || {}, page.frameUrl);
  return {
    schema: SCHEMA,
    id: prior?.id || crypto.randomUUID(),
    status,
    trigger,
    startedAt: prior?.startedAt || snapshot.takenAt,
    capturedAt: snapshot.takenAt,
    page,
    context: { company: ctx.company, role: ctx.role },
    preset: ctx.preset,
    fields: snapshot.fields.slice(0, LIMITS.fields).map(clipField),
    files: snapshot.files.slice(0, LIMITS.files).map(f => ({
      label: clip(f.label, LIMITS.label),
      name: clip(f.name, LIMITS.label),
      size: f.size,
      type: clip(f.type, LIMITS.label),
      sha256: f.sha256,
    })),
    redacted: snapshot.redacted || { secret: 0, eeo: 0 },
    evidence: [],
    sink: prior?.sink || null,
  };
}

// A record whose files are on disk where they belong, so the browser copy is
// not the only one. Clear in the popup removes these and nothing else:
// drafts never reach disk, and a failed or misplaced save has no file in
// ~/Downloads/carbon-copy/.
export function isSafelySaved(record) {
  const s = record.sink;
  return record.status === STATUS.SUBMITTED && !!s?.md && !!s?.json && !s.error && !s.warning;
}

const fieldKey = f => `${f.type}:${f.name || f.label}`;

// Stitch steps: a multi-step flow that swaps the DOM (Workday) only shows
// the current step's fields, so a later snapshot would drop the earlier
// steps. Fields from an earlier step that the new snapshot lacks are kept.
// Same-step fields are not: a question that vanished from the current step
// (a conditional one, after the answer above it changed) was not sent.
export function mergeSteps(prior, next) {
  const current = Math.max(1, ...next.fields.map(f => f.step ?? 1));
  const have = new Set(next.fields.map(fieldKey));
  const kept = prior.fields.filter(f => (f.step ?? 1) < current && !have.has(fieldKey(f)));
  // Files need no stitching: the content script reports every file chosen
  // in the page's lifetime, including inputs a later step removed.
  return { ...next, fields: [...kept, ...next.fields] };
}
