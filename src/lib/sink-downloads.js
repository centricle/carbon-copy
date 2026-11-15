// Disk sink: write a record as .md + .json under ~/Downloads/carbon-copy/
// via chrome.downloads. No native host, no extra permission beyond
// "downloads". A service worker has no URL.createObjectURL, so the bodies go
// out as data: URLs.

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

function dataUrl(body, mime) {
  return `data:${mime};charset=utf-8,${encodeURIComponent(body)}`;
}

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

async function writeOne(filename, body, mime) {
  const id = await chrome.downloads.download({
    url: dataUrl(body, mime),
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  const item = await settle(id);
  // Clears the entry from chrome://downloads; the file stays on disk.
  await chrome.downloads.erase({ id });
  return { path: item.filename, ok: landedWhereAsked(item.filename, filename) };
}

// Returns { md, json, at, warning? }: absolute paths as Chrome reports them.
export async function writeRecord(record) {
  const base = `${DIR}/${basename(record)}`;
  const md = await writeOne(`${base}.md`, renderMarkdown(record), 'text/markdown');
  const json = await writeOne(`${base}.json`, JSON.stringify(record, null, 2) + '\n', 'application/json');
  const out = { md: md.path, json: json.path, at: new Date().toISOString() };
  if (!md.ok || !json.ok) {
    out.warning = `Chrome saved these files somewhere other than ~/Downloads/${DIR}/. Is that folder a symlink? Chrome will not write through one.`;
  }
  return out;
}

export async function writeExport(records) {
  const name = `${DIR}/export-${localDate(new Date().toISOString())}.json`;
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), records }, null, 2) + '\n';
  return (await writeOne(name, body, 'application/json')).path;
}
