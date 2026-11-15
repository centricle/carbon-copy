// Service worker: turns snapshots into records, keys them to a session,
// stores every one, and writes the submitted ones to disk.

import { buildRecord, mergeSteps, STATUS } from '../lib/record.js';
import * as store from '../lib/store.js';
import { writeRecord, writeExport } from '../lib/sink-downloads.js';
import { isCovered, concreteOrigins } from '../lib/coverage.js';
import { createSubmitGate, fingerprint } from '../lib/throttle.js';

// If the page vanishes mid-submit (a native form navigating away), the
// content script never gets to say whether the submit went through. Leaving
// the page right after clicking Submit is the strongest sign it did.
const PENDING_TIMEOUT_MS = 3000;
const OPTIONAL_SCRIPT_ID = 'cc-optional-sites';
const WELCOME_URL = chrome.runtime.getURL('welcome/welcome.html');
const CONTENT_JS = ['src/lib/redact.js', 'src/content/capture.js'];

// ------------------------------------------------------------- sessions

// session key -> record id. In storage.session so a service worker restart
// mid-application does not split one application into two records; cleared
// with the browser session, which is the right lifetime for "this tab".
let sessions = null;
async function loadSessions() {
  if (!sessions) sessions = (await chrome.storage.session.get('sessions')).sessions || {};
  return sessions;
}
async function saveSessions() {
  await chrome.storage.session.set({ sessions });
}

function sessionKey(sender) {
  let path = '';
  try { path = new URL(sender.url).pathname; } catch { /* none */ }
  return `${sender.tab?.id ?? 'x'}|${sender.origin || ''}|${path}`;
}

const pending = new Map(); // submitId -> { key, recordId, trigger, timer }

// ------------------------------------------------------------- records

async function upsert(key, snapshot, status, trigger) {
  await loadSessions();
  const priorId = sessions[key];
  let prior = priorId ? await store.get(priorId) : null;
  if (prior && prior.status === STATUS.SUBMITTED) prior = null; // that one is done; start fresh
  let record = buildRecord({ snapshot, status, trigger, prior });
  if (prior) record = mergeSteps(prior, record);
  await store.put(record);
  sessions[key] = record.id;
  await saveSessions();
  return record;
}

// In memory: a service worker restart forgets it, which only ever lets one
// more submission through.
const submitGate = createSubmitGate();
const gateKey = key => String(key).split('|').slice(0, 2).join('|'); // tab|origin

async function markSubmitted(recordId, trigger, key) {
  const record = await store.get(recordId);
  if (!record) return null;
  const refused = submitGate(gateKey(key), await fingerprint(record));
  if (refused) {
    console.info(`[carbon-copy] kept as a draft (${refused}): ${record.page.origin}`);
    return record;
  }
  record.status = STATUS.SUBMITTED;
  record.trigger = trigger;
  await store.put(record);
  await loadSessions();
  if (key && sessions[key] === recordId) {
    delete sessions[key];
    await saveSessions();
  }
  return sink(record);
}

async function sink(record) {
  try {
    record.sink = await writeRecord(record);
  } catch (err) {
    let error = String(err.message || err);
    // USER_CANCELED with no user in sight: a declined "Save as" prompt (Chrome
    // set to ask where to save each file), or a symlinked folder Chrome
    // refused to write through.
    if (error.includes('USER_CANCELED')) {
      error += `. Chrome may be set to ask where to save each file, or ~/Downloads/carbon-copy may be a symlink (Chrome will not write through one).`;
    }
    record.sink = { error, at: new Date().toISOString() };
  }
  await store.put(record);
  return record;
}

// ------------------------------------------------------------- messages

async function handle(msg, sender) {
  switch (msg?.type) {
    case 'cc:snapshot': {
      // "Stop recording this site" cannot unload a script already running
      // in an open tab, so its snapshots stop here instead. Anything that
      // is not a frame on a covered site (an extension page, say) too.
      if (!(await isCovered(sender.url, STATIC_MATCHES, isGranted))) return null;
      // Nothing is recorded, not even a draft, until "Start recording" on
      // the welcome page. Read per snapshot, so it holds across restarts.
      if (!(await hasConsent())) return null;
      const key = sessionKey(sender);
      if (msg.status === 'draft') return upsert(key, msg.snapshot, STATUS.DRAFT, msg.trigger);
      if (msg.status === 'submitted') {
        const record = await upsert(key, msg.snapshot, STATUS.DRAFT, msg.trigger);
        return markSubmitted(record.id, msg.trigger, key);
      }
      if (msg.status === 'pending') {
        // Stored as a draft until the content script resolves it.
        const record = await upsert(key, msg.snapshot, STATUS.DRAFT, msg.trigger);
        const timer = setTimeout(() => {
          enqueue(async () => {
            if (!pending.delete(msg.submitId)) return;
            await markSubmitted(record.id, `${msg.trigger}+unload`, key);
          });
        }, PENDING_TIMEOUT_MS);
        pending.set(msg.submitId, { key, recordId: record.id, trigger: msg.trigger, timer });
        return record;
      }
      return null;
    }
    case 'cc:resolve': {
      const p = pending.get(msg.submitId);
      if (!p) return null;
      clearTimeout(p.timer);
      pending.delete(msg.submitId);
      if (msg.status === 'submitted') return markSubmitted(p.recordId, msg.trigger || p.trigger, p.key);
      return store.get(p.recordId); // validation stopped it: stays a draft
    }
    case 'cc:redownload': {
      const record = await store.get(msg.id);
      return record ? sink(record) : null;
    }
    case 'cc:export':
      return { path: await writeExport(await store.list()) };
    default:
      return undefined;
  }
}

async function hasConsent() {
  const { settings } = await chrome.storage.local.get('settings');
  return !!settings?.consentedAt;
}

// One at a time: two snapshots for the same session must not interleave
// their read-modify-write of the record.
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn);
  chain = run.catch(err => console.error('[carbon-copy]', err));
  return run;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type?.startsWith('cc:')) return false;
  enqueue(() => handle(msg, sender)).then(
    r => sendResponse({ ok: true, record: r ?? null }),
    err => sendResponse({ ok: false, error: String(err.message || err) }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  enqueue(async () => {
    await loadSessions();
    let changed = false;
    for (const k of Object.keys(sessions)) if (k.startsWith(`${tabId}|`)) { delete sessions[k]; changed = true; }
    if (changed) await saveSessions();
  });
});

// ------------------------------------------------------------- "Record this site"

// Sites outside the preset get a content script only after the user grants
// that origin from the popup. Registration lives here, not in the popup,
// because the permission prompt can close the popup before its promise
// resolves.
// The manifest's own matches, not the preset list: the test build adds
// localhost, and that must not be re-registered as an "added" site.
const STATIC_MATCHES = chrome.runtime.getManifest().content_scripts.flatMap(c => c.matches);

// Sites added with "Record this site", and nothing broader: a wildcard grant
// (Chrome's "On all sites") is ignored here and in isGranted, so it can
// neither register the content script everywhere nor make every site count
// as covered.
const addedSites = origins => concreteOrigins(origins).filter(o => !STATIC_MATCHES.includes(o));

// An exact grant of the site's pattern, not permissions.contains(), which
// a wildcard grant would satisfy for every site.
async function isGranted(pattern) {
  const { origins = [] } = await chrome.permissions.getAll();
  return concreteOrigins(origins).includes(pattern);
}

async function reconcileOptionalSites() {
  const { origins = [] } = await chrome.permissions.getAll();
  const extra = addedSites(origins);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [OPTIONAL_SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [OPTIONAL_SCRIPT_ID] });
  if (!extra.length) return [];
  await chrome.scripting.registerContentScripts([{
    id: OPTIONAL_SCRIPT_ID,
    matches: extra,
    js: CONTENT_JS,
    allFrames: true,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  }]);
  return extra;
}

// Pages already open on a newly granted site get the script now, without
// a reload. capture.js guards against a second injection.
async function injectOpenTabs(origins) {
  if (!origins.length) return;
  const tabs = await chrome.tabs.query({ url: origins });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: CONTENT_JS })
      .catch(() => { /* tab closed or not scriptable */ });
  }
}

chrome.permissions.onAdded.addListener(({ origins = [] }) => {
  enqueue(async () => {
    await reconcileOptionalSites();
    await injectOpenTabs(addedSites(origins));
  });
});
chrome.permissions.onRemoved.addListener(() => enqueue(reconcileOptionalSites));
// The welcome page opens on install, and on an update while consent is
// still missing: an install from before the consent gate existed records
// nothing until someone clicks Start recording, so it must say so.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  enqueue(async () => {
    await reconcileOptionalSites();
    if (reason === 'install' || (reason === 'update' && !(await hasConsent()))) {
      await chrome.tabs.create({ url: WELCOME_URL });
    }
  });
});
