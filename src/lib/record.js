// The canonical record. Every other format (Markdown, JSON export) renders
// this; nothing else is a source of truth. Bump SCHEMA on any change a
// reader of an old .json file would trip over.

import { extractContext } from '../presets/jobs.js';

export const SCHEMA = 1;
export const STATUS = Object.freeze({ DRAFT: 'draft', SUBMITTED: 'submitted' });

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
    fields: snapshot.fields.map(f => ({
      label: f.label,
      name: f.name ?? null,
      type: f.type,
      value: f.value,
      display: f.display,
      step: f.step ?? 1,
    })),
    files: snapshot.files.map(f => ({
      label: f.label,
      name: f.name,
      size: f.size,
      type: f.type,
      sha256: f.sha256,
    })),
    redacted: snapshot.redacted || { secret: 0, eeo: 0 },
    evidence: [],
    sink: prior?.sink || null,
  };
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
