import * as store from '../src/lib/store.js';
import { heading } from '../src/lib/render-md.js';
import { isSafelySaved } from '../src/lib/record.js';
import { MATCHES, matchesPattern } from '../src/presets/jobs.js';
import { concreteOrigins } from '../src/lib/coverage.js';

const $ = id => document.getElementById(id);

// What the content script actually matches, read from the running manifest
// rather than the preset list: the test build adds localhost here.
const STATIC_MATCHES = chrome.runtime.getManifest().content_scripts.flatMap(c => c.matches);
const say = text => { $('msg').textContent = text; };

// ------------------------------------------------------------- this site

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function renderSite() {
  const tab = await activeTab();
  let u = null;
  try { u = new URL(tab?.url || ''); } catch { /* no access, or a browser page */ }
  const host = $('site-host');
  const state = $('site-state');
  const btn = $('site-toggle');
  btn.hidden = true;
  state.className = 'state';

  if (!u || !/^https?:$/.test(u.protocol)) {
    host.textContent = 'This page';
    state.textContent = 'not a website';
    return;
  }
  host.textContent = u.hostname;
  const match = STATIC_MATCHES.find(p => matchesPattern(p, u.href));
  if (match) {
    state.textContent = MATCHES.includes(match) ? 'recording (job sites)' : 'recording (test build)';
    state.classList.add('on');
    return;
  }
  if (u.protocol !== 'https:') {
    state.textContent = 'https sites only';
    return;
  }
  const origin = `https://${u.hostname}/*`;
  // An exact grant, as the service worker counts it. A wildcard grant
  // (Chrome's "On all sites") would satisfy permissions.contains() for any
  // site, and Carbon Copy records on none of them through it.
  const concrete = async () => concreteOrigins((await chrome.permissions.getAll()).origins).includes(origin);
  const granted = await concrete();
  state.textContent = granted ? 'recording' : 'not recording';
  state.classList.toggle('on', granted);
  btn.hidden = false;
  btn.textContent = granted ? 'Stop recording this site' : 'Record this site';
  btn.onclick = async () => {
    // The service worker registers the content script on permissions.onAdded,
    // because this prompt can close the popup before the promise settles.
    const ok = granted
      ? await chrome.permissions.remove({ origins: [origin] })
      : await chrome.permissions.request({ origins: [origin] });
    if (ok && !granted) {
      // A request can succeed without leaving an exact grant, when a
      // wildcard grant already covered it. That records nothing.
      say(await concrete()
        ? 'Recording. Fields you fill in on this site from now on are kept.'
        : 'Chrome\'s site access for Carbon Copy is set to "On all sites", which it does not record through. Set it to "On specific sites" in chrome://extensions, then try again.');
    }
    renderSite();
  };
}

// ------------------------------------------------------------- records

function when(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function badge(record) {
  if (record.sink?.error) return ['not saved', 'error'];
  if (record.sink?.warning) return ['saved elsewhere', 'error'];
  if (record.status === 'submitted') return ['submitted', 'submitted'];
  return ['draft', 'draft'];
}

async function send(msg) {
  const res = await chrome.runtime.sendMessage(msg);
  if (!res?.ok) throw new Error(res?.error || 'no response');
  return res;
}

async function renderRecords() {
  const rows = await store.list({ limit: 20 });
  const list = $('records');
  list.replaceChildren();
  $('empty').hidden = rows.length > 0;
  $('clear').hidden = !(await store.list()).some(isSafelySaved);
  const tpl = $('row');
  for (const r of rows) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.querySelector('.title').textContent = heading(r);
    li.querySelector('.title').title = r.page.url;
    li.querySelector('.when').textContent = when(r.capturedAt);
    const [text, cls] = badge(r);
    const b = li.querySelector('.badge');
    b.textContent = text;
    b.classList.add(cls);
    if (r.sink?.error || r.sink?.warning) b.title = r.sink.error || `${r.sink.warning}\n${r.sink.md}`;
    li.querySelector('.save').onclick = async () => {
      try {
        const { record } = await send({ type: 'cc:redownload', id: r.id });
        const s = record?.sink;
        say(s?.warning ? `${s.warning} Saved as ${s.md}` : s?.md ? `Saved ${s.md}` : `Not saved: ${s?.error || 'unknown error'}`);
      } catch (err) {
        say(`Not saved: ${err.message}`);
      }
      renderRecords();
    };
    list.append(li);
  }
}

// Clears saved submissions from the list. Their files stay in Downloads, and
// anything that exists only in the browser (drafts, failed saves) stays
// listed. Two clicks: the first arms it and says how many, the second
// (within a few seconds) deletes.
function setupClear() {
  const btn = $('clear');
  let timer = null;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const disarm = () => {
    clearTimeout(timer);
    btn.classList.remove('armed');
    btn.textContent = 'Clear';
  };
  btn.onclick = async () => {
    const all = await store.list();
    const saved = all.filter(isSafelySaved);
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = `Clear ${saved.length} saved?`;
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    await store.removeMany(saved.map(r => r.id));
    const kept = all.length - saved.length;
    say(`Cleared ${plural(saved.length, 'saved record')}; the files stay in Downloads.`
      + (kept ? ` Kept ${kept} not saved to disk (drafts or failed saves).` : ''));
    renderRecords();
  };
}

// ------------------------------------------------------------- settings

async function renderSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  $('eeo').checked = !!settings.captureEEO;
  $('eeo').onchange = async e => {
    const { settings: cur = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...cur, captureEEO: e.target.checked } });
    say(e.target.checked ? 'EEO answers will be recorded from now on.' : 'EEO answers will be skipped.');
  };
  $('export').onclick = async () => {
    try {
      const { record } = await send({ type: 'cc:export' });
      say(`Exported to ${record.path}`);
    } catch (err) {
      say(`Export failed: ${err.message}`);
    }
  };
}

renderSite();
renderRecords();
renderSettings();
setupClear();
