// Disk sink: write a record as .md + .json under ~/Downloads/carbon-copy/
// via chrome.downloads. No native host.
//
// The bodies go out as blob: URLs made in an offscreen document, because a
// service worker has no URL.createObjectURL. Not as data: URLs: Chrome keeps
// every download's URL in its history, and a data: URL there would hold the
// whole record. A revoked blob: URL holds nothing, so the entries can stay in
// Chrome's download list, where its folder button opens ~/Downloads/carbon-copy/.

import { renderMarkdown } from './render-md.js';

export const DIR = 'carbon-copy';

export function slug(s, max = 60) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

// Local calendar date: a file for an application sent at 10pm belongs to
// that day, not tomorrow's UTC date.
export function localDate(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// <YYYY-MM-DD>-<company-or-host>-<role-or-title>
export function basename(record) {
  let host = '';
  try { host = new URL(record.page.url).hostname.replace(/^www\./, ''); } catch { /* none */ }
  const who = slug(record.context?.company, 40) || slug(host, 40) || 'unknown';
  const what = slug(record.context?.role || record.page.title) || 'form';
  return `${localDate(record.capturedAt)}-${who}-${what}`;
}

const OFFSCREEN = 'src/offscreen/blobs.html';
let opening = null;
let closing = null;
let users = 0;

async function openOffscreen() {
  await closing;
  const open = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN)],
  });
  if (open.length) return;
  opening ??= chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ['BLOBS'],
    justification: 'Saves records through chrome.downloads as blob: URLs, so download history never holds their contents.',
  }).finally(() => { opening = null; });
  await opening;
}

// Runs fn with the offscreen document open; the last writer out closes it.
// A writer arriving while it closes waits for the close, then reopens it.
async function withBlobs(fn) {
  users++;
  try {
    await openOffscreen();
    return await fn();
  } finally {
    if (--users === 0) {
      closing = chrome.offscreen.closeDocument().catch(() => {}).finally(() => { closing = null; });
    }
  }
}

const offscreen = msg => chrome.runtime.sendMessage({ target: 'cc-offscreen', ...msg });

// Resolves with the final DownloadItem once the file is on disk.
function settle(id, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const done = item => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      if (item.state === 'complete') resolve(item);
      else reject(new Error(`download ${id} ${item.state}: ${item.error || 'unknown'}`));
    };
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (item && item.state !== 'in_progress') done(item);
    };
    const onChanged = delta => { if (delta.id === id && delta.state) check(); };
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      reject(new Error(`download ${id} still in progress after ${timeoutMs}ms`));
    }, timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);
    check();
  });
}

// Chrome can save a file somewhere other than asked without failing the
// download. Verified case: when ~/Downloads/carbon-copy is a symlink, Chrome
// refuses to write through it and saves "download.md" at the top of the
// download folder instead. Name and folder both gone, state "complete".
// DownloadItem.filename is a native path, so on Windows it uses backslashes.
export function landedWhereAsked(actual, requested) {
  const path = String(actual || '').replace(/\\/g, '/');
  const want = requested.split('/').pop().replace(/\.[^.]+$/, '');
  return path.includes(`/${DIR}/`) && path.split('/').pop().startsWith(want);
}

// Call inside withBlobs. The entry stays in Chrome's download list whether
// the save worked or not; it names the file and holds none of its contents.
async function writeOne(filename, body, mime) {
  const made = await offscreen({ type: 'blob', body, mime: `${mime};charset=utf-8` });
  if (!made?.url) throw new Error('offscreen document made no blob: URL');
  try {
    const id = await chrome.downloads.download({
      url: made.url,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    try {
      const item = await settle(id);
      return { path: item.filename, ok: landedWhereAsked(item.filename, filename) };
    } catch (err) {
      // Stuck or interrupted: stop it, so no partial file is left behind.
      await chrome.downloads.cancel(id).catch(() => {});
      throw err;
    }
  } finally {
    await offscreen({ type: 'revoke', url: made.url }).catch(() => {});
  }
}

// What goes into a file: the record without `sink`, which holds absolute
// paths (and so the OS username) of where earlier copies were saved. A file
// someone shares should not carry that.
export const fileCopy = ({ sink, ...rest }) => rest;

// Returns { md, json, at, warning? }: absolute paths as Chrome reports them.
export async function writeRecord(record) {
  const base = `${DIR}/${basename(record)}`;
  const [md, json] = await withBlobs(async () => [
    await writeOne(`${base}.md`, renderMarkdown(record), 'text/markdown'),
    await writeOne(`${base}.json`, JSON.stringify(fileCopy(record), null, 2) + '\n', 'application/json'),
  ]);
  const out = { md: md.path, json: json.path, at: new Date().toISOString() };
  if (!md.ok || !json.ok) {
    out.warning = `Chrome saved these files somewhere other than ~/Downloads/${DIR}/. Is that folder a symlink? Chrome will not write through one.`;
  }
  return out;
}

export async function writeExport(records) {
  const name = `${DIR}/export-${localDate(new Date().toISOString())}.json`;
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), records: records.map(fileCopy) }, null, 2) + '\n';
  return (await withBlobs(() => writeOne(name, body, 'application/json'))).path;
}
