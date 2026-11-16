// Content script: reads the form you are filling in, and snapshots it the
// moment you submit.
//
// Why the DOM and not the network: question text exists only in the page.
// A POST body says `question_48213: "yes"`; the page says "Are you willing to
// relocate?". The request body becomes supporting evidence in phase 2.
//
// Classic script (content scripts cannot be modules). Loads after
// src/lib/redact.js, which sets globalThis.CarbonCopyRedact.

(() => {
  if (globalThis.__carbonCopy) return; // static match + executeScript can both inject
  globalThis.__carbonCopy = true;

  const R = globalThis.CarbonCopyRedact;
  const DRAFT_DELAY_MS = 1500;
  // A click on a form's own submit button is confirmed by the submit event
  // that follows it. No submit event in this window means native validation
  // or a page script stopped it, so the snapshot stays a draft.
  const NATIVE_SUBMIT_WINDOW_MS = 1000;
  // A formless submit button (SPA) has no event to wait for. After this long,
  // a field marked aria-invalid means validation failed; anything else counts.
  const SPA_SETTLE_MS = 1200;
  const SUBMIT_TEXT = /\b(submit|apply|send)\b/i;
  const MAX_HASH_BYTES = 50 * 1024 * 1024;

  const FIELD_SEL = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
  const CONTROL_SEL = 'input, select, textarea, button, [contenteditable]:not([contenteditable="false"]), script, style, template, noscript';
  const SUBMIT_CONTROL_SEL = 'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]';
  const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'search']);
  // Captcha response fields: a token the widget wrote, never an answer.
  const CAPTCHA_SEL = '[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]';

  // Replaced on every change, never merged into: Resume deletes pausedUntil,
  // and a merge would keep the old value and the page paused.
  const DEFAULTS = { captureEEO: false };
  let settings = { ...DEFAULTS };
  let settingsLoaded = false;
  chrome.storage.local.get('settings').then(v => {
    settings = { ...DEFAULTS, ...(v.settings || {}) };
    settingsLoaded = true;
    if (paused()) pausedAllAlong();
  }).catch(() => { settingsLoaded = true; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
  });

  // Paused from the popup: this page is ignored until the time is up. No
  // edits counted, no files remembered, nothing sent. Checked against the
  // clock on every event, so the pause ends on time with no message. The
  // service worker drops anything that arrives anyway. Same rule as
  // isPaused in src/lib/pause.js, which a classic script cannot import.
  const paused = () => Number(settings.pausedUntil) > Date.now();

  // ---------------------------------------------------------------- text

  const squash = s => String(s || '').replace(/\s+/g, ' ').trim();

  function cleanLabel(s) {
    let t = squash(s);
    for (let i = 0; i < 3; i++) t = t.replace(/\s*(\*|\(required\)|:|：)\s*$/i, '');
    return t.slice(0, 500);
  }

  // Copies of page nodes are made in a document with no browsing context.
  // Cloned into the page's own document, an <img> in a label starts loading
  // (a request the page can see, which tells it Carbon Copy is installed),
  // and a custom element runs page code in its constructor. Here, neither.
  const inert = document.implementation.createHTMLDocument('');
  const inertCopy = node => inert.importNode(node, true);

  // Text of a node with the form controls inside it removed, so a wrapping
  // <label> does not pick up a <select>'s option list.
  function textOf(node) {
    if (!node) return '';
    const c = inertCopy(node);
    if (c.querySelectorAll) c.querySelectorAll(CONTROL_SEL).forEach(n => n.remove());
    return squash(c.textContent);
  }

  function byIds(doc, ids) {
    return squash(String(ids || '').split(/\s+/).filter(Boolean)
      .map(id => textOf(doc.getElementById(id))).join(' '));
  }

  function ariaLabeledBy(el) {
    return cleanLabel(byIds(el.ownerDocument, el.getAttribute('aria-labelledby')));
  }

  // A field a person answers. Hidden inputs and buttons are not: ATS markup
  // puts a hidden question id or a "?" help button between a question and
  // its field, and neither one is the previous question.
  const isAnswerable = el => !(el.tagName === 'INPUT' && SKIP_INPUT_TYPES.has(typeOf(el)));
  const holdsField = node => (node.matches(FIELD_SEL) && isAnswerable(node))
    || [...node.querySelectorAll(FIELD_SEL)].some(isAnswerable);
  // Siblings that are never question text: skipped, not stopped at.
  const NOT_TEXT_SEL = 'input, button, [role="button"], script, style, template, noscript';

  // The question text nearest *before* a field: walk up from the field and
  // check each level's earlier siblings. A sibling holding its own field is
  // the previous question, so the walk stops there instead of borrowing that
  // question's text. So does a block too long to be a question (the job
  // description above the form), checked before it is cloned.
  function precedingText(el, root, maxDepth = 5) {
    let node = el;
    for (let depth = 0; node && node !== root && depth < maxDepth; depth++, node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (holdsField(sib)) return '';
        if (sib.matches(NOT_TEXT_SEL)) continue;
        if ((sib.textContent || '').length > 1500) return '';
        const t = cleanLabel(textOf(sib));
        if (t) return t.slice(0, 300);
      }
    }
    return '';
  }

  // ---------------------------------------------------------------- labels

  // Resolution order (plan): label[for], wrapping <label>, aria-labelledby,
  // aria-label, fieldset legend, nearest question text, placeholder, name.
  function labelFor(el, root) {
    const doc = el.ownerDocument;
    if (el.id) {
      const l = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = l && cleanLabel(textOf(l));
      if (t) return t;
    }
    const wrap = el.closest('label');
    const wt = wrap && cleanLabel(textOf(wrap));
    if (wt) return wt;
    const lb = ariaLabeledBy(el);
    if (lb) return lb;
    const al = cleanLabel(el.getAttribute('aria-label'));
    if (al) return al;
    const legend = el.closest('fieldset')?.querySelector(':scope > legend');
    const lg = legend && cleanLabel(textOf(legend));
    if (lg) return lg;
    const pt = precedingText(el, root);
    if (pt) return pt;
    const ph = cleanLabel(el.getAttribute('placeholder'));
    if (ph) return ph;
    return el.getAttribute('name') || el.id || `(unlabeled ${typeOf(el)})`;
  }

  // The label of one option in a radio or checkbox group: "Yes", "Remote".
  function optionLabel(el) {
    for (const l of el.labels || []) {
      const t = cleanLabel(textOf(l));
      if (t) return t;
    }
    const lb = ariaLabeledBy(el);
    if (lb) return lb;
    const al = cleanLabel(el.getAttribute('aria-label'));
    if (al) return al;
    const next = el.nextSibling;
    const nt = next && cleanLabel(next.nodeType === 3 ? next.textContent : textOf(next));
    return nt || el.value;
  }

  function commonAncestor(nodes) {
    let a = nodes[0].parentElement;
    while (a && !nodes.every(n => a.contains(n))) a = a.parentElement;
    return a;
  }

  // The question a radio/checkbox group answers.
  function groupLabel(members, root) {
    const first = members[0];
    const group = first.closest('[role="radiogroup"], [role="group"], fieldset');
    if (group) {
      const lb = ariaLabeledBy(group);
      if (lb) return lb;
      const al = cleanLabel(group.getAttribute('aria-label'));
      if (al) return al;
      const legend = group.tagName === 'FIELDSET' && group.querySelector(':scope > legend');
      const lg = legend && cleanLabel(textOf(legend));
      if (lg) return lg;
    }
    const anchor = members.length > 1 ? commonAncestor(members) : (first.closest('label') || first);
    const pt = anchor && precedingText(anchor, root);
    if (pt) return pt;
    return first.getAttribute('name') || '(unlabeled group)';
  }

  // ---------------------------------------------------------------- fields

  function typeOf(el) {
    if (el.tagName === 'TEXTAREA') return 'textarea';
    if (el.tagName === 'SELECT') return el.multiple ? 'select-multiple' : 'select';
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (el.getAttribute('role') === 'combobox' && t === 'text') return 'combobox';
      return t;
    }
    if (el.tagName === 'IFRAME' || el.isContentEditable) return 'richtext';
    return el.tagName.toLowerCase();
  }

  function isField(el) {
    if (!(el instanceof Element)) return false;
    if (el.matches('input') && SKIP_INPUT_TYPES.has(typeOf(el))) return false;
    return el.matches(FIELD_SEL) || !!el.closest('[contenteditable]:not([contenteditable="false"])');
  }

  // Rich-text editors that live in a same-origin iframe (TinyMCE, CKEditor 4).
  function editableFrames(root) {
    const out = [];
    for (const f of root.querySelectorAll('iframe')) {
      try {
        const d = f.contentDocument;
        if (d && d.body && (d.body.isContentEditable || d.designMode === 'on')) out.push(f);
      } catch { /* cross-origin: its own content script covers it */ }
    }
    return out;
  }

  function discover(root) {
    const set = new Set(root.querySelectorAll(FIELD_SEL));
    if (root.tagName === 'FORM') for (const el of root.elements) if (el.matches(FIELD_SEL)) set.add(el);
    const els = [...set].filter(el => {
      if (el.matches('[contenteditable]')) return !el.parentElement?.isContentEditable; // editing host only
      if (el.tagName === 'INPUT' && SKIP_INPUT_TYPES.has(typeOf(el))) return false;
      if (el.closest('[role="search"]') || el.matches(CAPTCHA_SEL)) return false;
      return !el.disabled;
    });
    // Document order, so the record reads top to bottom like the form.
    els.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return els.concat(editableFrames(root));
  }

  // react-select and friends: the typed input empties once an option is
  // chosen, and the choice is rendered as text beside it.
  function comboboxDisplay(el) {
    let c = el.parentElement;
    for (let i = 0; c && i < 5; i++, c = c.parentElement) {
      if (/control|container/i.test(typeof c.className === 'string' ? c.className : '')) {
        const clone = inertCopy(c);
        clone.querySelectorAll(`${CONTROL_SEL}, [class*="placeholder"], [class*="indicator"], [aria-live]`).forEach(n => n.remove());
        return squash(clone.textContent);
      }
    }
    return '';
  }

  function valueOf(el, type) {
    if (type === 'richtext') {
      const host = el.tagName === 'IFRAME' ? el.contentDocument.body : el;
      const t = host.innerText.replace(/\n+$/, '');
      return { value: t, display: t };
    }
    if (type === 'select') {
      const opt = el.selectedOptions[0];
      return { value: el.value, display: el.value === '' || !opt ? '' : squash(opt.text) };
    }
    if (type === 'select-multiple') {
      const opts = [...el.selectedOptions];
      return { value: opts.map(o => o.value), display: opts.map(o => squash(o.text)).join(', ') };
    }
    if (type === 'combobox' && !el.value) {
      const shown = comboboxDisplay(el);
      return { value: shown, display: shown };
    }
    return { value: el.value, display: el.value };
  }

  function isRendered(el) {
    return el.getClientRects().length > 0;
  }

  function fieldKey(f) {
    return `${f.type}:${f.name || f.label}`;
  }

  // ---------------------------------------------------------------- files

  const hashes = new WeakMap(); // File -> Promise<hex|null>
  const seenFiles = new Map(); // field key -> [{ label, file }]

  function hashFile(file) {
    if (!hashes.has(file)) {
      const p = (!crypto.subtle || file.size > MAX_HASH_BYTES)
        ? Promise.resolve(null)
        : file.arrayBuffer()
          .then(b => crypto.subtle.digest('SHA-256', b))
          .then(d => [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''))
          .catch(() => null);
      hashes.set(file, p);
    }
    return hashes.get(file);
  }

  const fileKey = (input, label) => `file:${input.getAttribute('name') || input.id || label}`;

  // The same never-record and EEO rules as any other field, by the label of
  // the input or drop zone the file went into. A file name can say as much
  // as an answer ("ssn-card-scan.png").
  function fileAllowed(el, label) {
    return !R.secretReason(el, label) && (settings.captureEEO || !R.isEEO(el, label));
  }

  // ATS upload widgets often send the file the moment it is chosen and then
  // clear the input, so a file is remembered when it is picked, not only
  // when the form is submitted.
  function rememberFiles(key, label, files) {
    const list = [...files].map(file => ({ label, file }));
    if (!list.length) return;
    list.forEach(f => hashFile(f.file));
    seenFiles.set(key, list);
  }

  // ---------------------------------------------------------------- edits

  // Fields that got an input or change event since the page opened or the
  // last submission. A value nobody edited (a default the page selected, a
  // captcha token a script wrote) does not make a form filled in, and a
  // hidden one is not kept.
  //
  // Synthetic (untrusted) events count. Autofill extensions fill forms with
  // them, and those answers are as much what you sent as typed ones. A page
  // priming its own fields on load mostly does it before this script
  // attaches at document_idle. (navigator.userActivation was tried as a
  // gate and dropped: Playwright pages report hasBeenActive from the start,
  // so it could not be tested.)
  let edited = new WeakSet();

  function editingHost(el) {
    let h = el;
    while (h.parentElement?.isContentEditable) h = h.parentElement;
    return h;
  }

  const editTarget = el => (el.isContentEditable ? editingHost(el) : el);

  function markEdited(el) {
    const t = editTarget(el);
    edited.add(t);
    touchedWhilePaused.delete(t);
    // A new choice in a radio group replaces the whole answer, including a
    // choice made while paused in another of its buttons.
    if (t.type === 'radio' && t.name) {
      const scope = t.form || t.ownerDocument;
      scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(t.name)}"]`).forEach(m => touchedWhilePaused.delete(m));
    }
    if (!settingsLoaded) earlyEdits.push(t);
  }

  // ---------------------------------------------------------------- pause

  // Fields edited during a pause stay out of every snapshot until they are
  // edited again after it. A snapshot reads every visible field, edited or
  // not, so without this an answer typed while paused would be recorded
  // the next time anything else on the page was. Not reset by a
  // submission: the value is still in the field. (A rich-text editor in its
  // own iframe is out of reach here, as it is for `edited`.)
  //
  // Field -> its value when last edited while paused. The value is kept
  // because a text field's change event fires on blur: typing done while
  // paused reports its change after Resume, the moment focus moves on.
  const touchedWhilePaused = new WeakMap();
  const rawValue = el => (el.isContentEditable ? el.innerText
    : (el.type === 'checkbox' || el.type === 'radio') ? el.checked
      : el.value);
  const stillPausedValue = t => touchedWhilePaused.has(t) && touchedWhilePaused.get(t) === rawValue(t);

  // Edits in the first moments, before settings have loaded, when this page
  // cannot yet know it is paused. An autofill extension filling the form on
  // load does exactly this. If the settings turn out to say paused, those
  // edits were made while paused.
  const earlyEdits = [];
  function pausedAllAlong() {
    for (const t of earlyEdits.splice(0)) {
      edited.delete(t);
      touchedWhilePaused.set(t, rawValue(t));
    }
    seenFiles.clear();
    clearTimeout(draftTimer);
    draftTimer = null;
  }

  function editedWhilePaused(t) {
    if (t.matches('input[type="file"]')) {
      // Whatever was remembered for this input is no longer what it holds.
      seenFiles.delete(fileKey(t, labelFor(t, scopeOf(t))));
    }
    if (isField(t)) {
      const h = editTarget(t);
      touchedWhilePaused.set(h, rawValue(h));
    }
  }

  // A submission while paused is not recorded, but it still ends that
  // application, as a recorded one would: the next one on this page starts
  // clean, back at step 1. The service worker may still hold that
  // application's draft for this tab and path; the next snapshot replaces
  // its fields wholesale (mergeSteps keeps only steps before the current).
  function submittedWhilePaused() {
    clearTimeout(draftTimer);
    draftTimer = null;
    resetAfterSubmit();
  }

  // ---------------------------------------------------------------- snapshot

  let step = 1;
  let stepKeys = new Set();

  // Multi-step flows that swap the DOM (Workday) show a set of fields with
  // nothing in common with the last set. That is a new step. Stitching the
  // steps into one record happens in the service worker.
  function assignSteps(fields) {
    const keys = fields.map(fieldKey);
    if (stepKeys.size && keys.length && !keys.some(k => stepKeys.has(k))) {
      step += 1;
      stepKeys = new Set();
    }
    keys.forEach(k => stepKeys.add(k));
    fields.forEach(f => { f.step = step; });
  }

  // Synchronous on purpose: this runs inside the click handler, before an SPA
  // gets the chance to clear the form. Hashing comes after, in finish().
  function collect(root) {
    const fields = [];
    const files = [];
    const redacted = { secret: 0, eeo: 0 };
    const seenGroups = new Set();
    let userFilled = false; // some answer here is one a person (or their autofill) gave
    const note = (els, display) => {
      if (display !== '' && display != null && els.some(x => edited.has(x))) userFilled = true;
    };

    // Counted, so the record says an answer is missing and why. The key is
    // added only when it happens, so records made without a pause keep
    // their usual shape.
    const leftOut = () => { redacted.paused = (redacted.paused || 0) + 1; };
    const allow = (el, label) => {
      if (R.secretReason(el, label)) { redacted.secret++; return false; }
      if (!settings.captureEEO && R.isEEO(el, label)) { redacted.eeo++; return false; }
      return true;
    };

    for (const el of discover(root)) {
      const type = typeOf(el);
      const name = el.getAttribute('name') || el.id || null;

      if (type === 'radio' || type === 'checkbox') {
        const members = el.name
          ? [...root.querySelectorAll(`input[type="${type}"][name="${CSS.escape(el.name)}"]`)]
          : [el];
        if (type === 'radio' || members.length > 1) {
          const gk = `${type}:${el.name || Math.random()}`;
          if (seenGroups.has(gk)) continue;
          seenGroups.add(gk);
          const label = groupLabel(members, root);
          if (!allow(el, label)) continue;
          const checked = members.filter(m => m.checked);
          const value = type === 'radio' ? (checked[0]?.value ?? null) : checked.map(m => m.value);
          const display = checked.map(optionLabel).join(', ');
          if (members.some(m => touchedWhilePaused.has(m))) { if (display !== '') leftOut(); continue; }
          note(members, display);
          fields.push({ label, name, type: type === 'radio' ? 'radio' : 'checkbox-group', value, display });
          continue;
        }
        // A lone checkbox ("I agree", "Send me job alerts") never makes a
        // form filled in on its own: its display is always Yes or No.
        const label = labelFor(el, root);
        if (!allow(el, label)) continue;
        if (touchedWhilePaused.has(el)) { leftOut(); continue; }
        fields.push({ label, name, type: 'checkbox', value: el.checked, display: el.checked ? 'Yes' : 'No' });
        continue;
      }

      if (type === 'file') {
        const label = labelFor(el, root);
        // Rejected now (the EEO toggle may have changed since): forget
        // anything remembered for this input too.
        if (!allow(el, label)) { seenFiles.delete(fileKey(el, label)); continue; }
        if (touchedWhilePaused.has(el)) { if (el.files?.length) leftOut(); continue; }
        if (el.files && el.files.length) rememberFiles(fileKey(el, label), label, el.files);
        continue;
      }

      const label = el.tagName === 'IFRAME'
        ? (cleanLabel(el.getAttribute('title')) || cleanLabel(el.getAttribute('aria-label')) || precedingText(el, root) || '(rich text)')
        : labelFor(el, root);
      if (!allow(el, label)) continue;
      const { value, display } = valueOf(el, type);
      // An iframe editor's typing happens in its own document, out of sight
      // of the listeners here, so any text in it counts as edited.
      const isEdited = el.tagName === 'IFRAME' || edited.has(el);
      // Not on screen and empty: a honeypot, or a step not reached yet. Not
      // on screen and filled by the page (a captcha token): skip it too.
      // Filled by you and hidden since: an earlier step of a single-page
      // form. Keep that.
      if (!isRendered(el) && el.tagName !== 'IFRAME' && (display === '' || !isEdited)) continue;
      // A card number, SSN or IBAN typed into a field whose label gave no
      // warning. Never sent on, and never counts as filling in the form.
      if (R.secretValue(el, label, value) || (display !== value && R.secretValue(el, label, display))) {
        redacted.secret++;
        continue;
      }
      if (touchedWhilePaused.has(el)) { if (display !== '') leftOut(); continue; }
      if (isEdited && display !== '') userFilled = true;
      fields.push({ label, name, type, value, display });
    }

    // Every file chosen since the page opened or the last submission went
    // through, latest per input: inputs an upload widget cleared, inputs a
    // later step removed, and files dropped onto a drop zone without ever
    // touching an <input>.
    for (const list of seenFiles.values()) list.forEach(f => files.push(f));

    assignSteps(fields);
    return { fields, files: dedupeFiles(files), redacted, userFilled, takenAt: new Date().toISOString() };
  }

  // Once a submission is confirmed, whatever happens next in this page is a
  // new application (an SPA's "Apply to another job"): no files from the
  // last one, and back to step 1. Runs after the snapshot was collected,
  // which holds its own references to the files.
  function resetAfterSubmit() {
    seenFiles.clear();
    edited = new WeakSet();
    step = 1;
    stepKeys = new Set();
  }

  function dedupeFiles(list) {
    const seen = new Set();
    return list.filter(({ file }) => {
      const k = `${file.name}|${file.size}|${file.lastModified}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function pageInfo() {
    const top = window === window.top;
    const anc = location.ancestorOrigins;
    const meta = n => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.content || null;
    const h1 = [...document.querySelectorAll('h1')].find(isRendered);
    return {
      page: {
        url: top ? location.href : (document.referrer || (anc && anc.length ? anc[anc.length - 1] : location.href)),
        title: document.title,
        frameUrl: location.href,
        origin: location.origin,
      },
      meta: {
        title: document.title || null,
        ogTitle: meta('og:title'),
        ogSiteName: meta('og:site_name'),
        h1: h1 ? squash(h1.innerText) : null,
      },
    };
  }

  // Nothing a person entered: an untouched form, or "Apply" on a posting
  // before the form exists. Never a record.
  function isEmpty(snap) {
    return !snap.userFilled && snap.files.length === 0;
  }

  // The async half: hash the files, attach page info. Plain data out.
  async function finish({ userFilled, ...snap }) {
    const files = await Promise.all(snap.files.map(async ({ label, file }) => ({
      label,
      name: file.name,
      size: file.size,
      type: file.type || null,
      sha256: await hashFile(file),
    })));
    return { ...snap, files, ...pageInfo() };
  }

  // ---------------------------------------------------------------- messaging

  // Messages must reach the service worker in the order they were raised
  // (a submit's "resolve" must never overtake its snapshot), but hashing is
  // async, so every send goes through one queue.
  let queue = Promise.resolve();
  function enqueue(build) {
    queue = queue.then(async () => {
      const msg = await build();
      if (msg) chrome.runtime.sendMessage(msg).catch(() => {}); // extension reloaded, page outlived it
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- triggers

  let draftTimer = null;
  let draftRoot = null;
  let pending = null; // { id, at, form, root, timer }

  const scopeOf = el => el.closest('form') || document;

  function sendDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    if (paused()) return; // a draft still debouncing when the pause began
    const root = draftRoot && draftRoot.isConnected ? draftRoot : document;
    const snap = collect(root);
    if (isEmpty(snap)) return;
    enqueue(async () => ({ type: 'cc:snapshot', status: 'draft', trigger: 'input', snapshot: await finish(snap) }));
  }

  function onEdit(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (paused()) { editedWhilePaused(t); return; }
    if (e.type === 'change' && t.matches('input[type="file"]')) {
      const label = labelFor(t, scopeOf(t));
      if (fileAllowed(t, label)) rememberFiles(fileKey(t, label), label, t.files || []);
      else seenFiles.delete(fileKey(t, label));
    }
    if (!isField(t)) return;
    // The paused answer committing itself late, not a new one. (A file
    // input's change is never late: it fires when the file is chosen.)
    if (!t.matches('input[type="file"]') && stillPausedValue(editTarget(t))) return;
    markEdited(t);
    draftRoot = scopeOf(t);
    clearTimeout(draftTimer);
    draftTimer = setTimeout(sendDraft, DRAFT_DELAY_MS);
  }

  // Only a real drop. A page can build a DataTransfer holding any File it
  // likes, and the record would then claim you sent it. (A file *input*'s
  // change event is not held to this: autofill extensions attach resumes
  // with a synthetic one, and collect() reads input.files directly anyway.)
  function onDrop(e) {
    if (!e.isTrusted) return;
    const files = e.dataTransfer?.files;
    if (!files || !files.length || !(e.target instanceof Element)) return;
    if (e.target.matches('input[type="file"]')) return; // its change event covers it
    const label = precedingText(e.target, document) || cleanLabel(textOf(e.target)).slice(0, 80) || 'Dropped file';
    // Dropped while paused: not recorded, and an earlier file remembered
    // for this zone is no longer the one it holds.
    if (paused()) { seenFiles.delete(`drop:${label}`); return; }
    // Judged by the zone's own label and the section it sits in. Not by a
    // nearby file input: from a zone, the nearest one is as likely to be
    // the previous question's.
    if (!fileAllowed(e.target, label)) return;
    rememberFiles(`drop:${label}`, label, files);
  }

  function isSubmitControl(ctl) {
    if (ctl.disabled || ctl.getAttribute('aria-disabled') === 'true') return false;
    if ((ctl.tagName === 'BUTTON' || ctl.tagName === 'INPUT') && ctl.type === 'submit' && ctl.form) return true;
    const text = squash(ctl.innerText || ctl.value || ctl.getAttribute('aria-label'));
    return text.length > 0 && text.length < 60 && SUBMIT_TEXT.test(text);
  }

  // Formless SPA: the smallest ancestor of the button that holds a field.
  function fieldScope(ctl) {
    for (let a = ctl.parentElement; a; a = a.parentElement) if (a.querySelector(FIELD_SEL)) return a;
    return document;
  }

  function onClick(e) {
    const ctl = e.target instanceof Element && e.target.closest(SUBMIT_CONTROL_SEL);
    if (!ctl) return;
    if (paused()) {
      if (e.isTrusted && isSubmitControl(ctl)) submittedWhilePaused();
      return;
    }
    if (!isSubmitControl(ctl)) {
      // "Next" in a multi-step flow can replace the step's fields in its own
      // click handler. Capture runs first, so flush the debouncing draft now
      // while those fields still exist.
      if (draftTimer) sendDraft();
      return;
    }
    // A script calling .click() on Submit is not you submitting. If it
    // really submits a form, the submit event that follows still counts.
    if (!e.isTrusted) return;
    const form = (ctl.type === 'submit' && ctl.form) || null;
    startPending(form || ctl.closest('form') || fieldScope(ctl), form, 'click');
  }

  function startPending(root, form, trigger) {
    if (pending && Date.now() - pending.at < 1500) return; // double click
    const snap = collect(root);
    if (isEmpty(snap)) return; // "Apply" on the posting, before the form exists
    clearTimeout(draftTimer);
    draftTimer = null;
    const id = crypto.randomUUID();
    pending = { id, at: Date.now(), form, root };
    enqueue(async () => ({ type: 'cc:snapshot', status: 'pending', trigger, submitId: id, snapshot: await finish(snap) }));
    pending.timer = setTimeout(() => {
      if (!pending || pending.id !== id) return;
      const failed = form ? true : !!(root.isConnected && root.querySelector('[aria-invalid="true"]'));
      enqueue(() => ({ type: 'cc:resolve', submitId: id, status: failed ? 'draft' : 'submitted' }));
      if (!failed) resetAfterSubmit();
      pending = null;
    }, form ? NATIVE_SUBMIT_WINDOW_MS : SPA_SETTLE_MS);
  }

  function onSubmit(e) {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (pending && pending.form === form) {
      clearTimeout(pending.timer);
      const id = pending.id;
      enqueue(() => ({ type: 'cc:resolve', submitId: id, status: 'submitted', trigger: 'click+submit' }));
      resetAfterSubmit();
      pending = { ...pending, form: null, timer: null }; // keep `at` for the double-click guard
      return;
    }
    if (pending && Date.now() - pending.at < 1500) return; // already resolved by the click path
    // Submitted without a click on a submit button: Enter in a lone field,
    // or form.requestSubmit() from a script. Both are trusted events. A
    // dispatched `new Event('submit')` is not, and submits nothing.
    if (!e.isTrusted) return;
    if (paused()) { submittedWhilePaused(); return; }
    const snap = collect(form);
    if (isEmpty(snap)) return;
    clearTimeout(draftTimer);
    draftTimer = null;
    enqueue(async () => ({ type: 'cc:snapshot', status: 'submitted', trigger: 'submit', snapshot: await finish(snap) }));
    resetAfterSubmit();
  }

  // Leaving with a draft still debouncing: write it now.
  function onHide() {
    if (draftTimer) sendDraft();
  }

  // Capture phase on window: runs before any handler the page registered,
  // including React's root listener.
  addEventListener('input', onEdit, true);
  addEventListener('change', onEdit, true);
  addEventListener('drop', onDrop, true);
  addEventListener('click', onClick, true);
  addEventListener('submit', onSubmit, true);
  addEventListener('pagehide', onHide, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) onHide(); }, true);
})();
