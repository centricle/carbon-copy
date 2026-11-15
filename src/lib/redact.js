// Redaction rules, shared by the content script.
//
// A classic script, not a module: content scripts cannot be modules, so this
// sets one global that src/content/capture.js reads. It is loaded first in
// every injection (manifest, registerContentScripts, executeScript).
//
// Everything here runs inside the page's frame, before anything is sent to
// the service worker. A redacted value never leaves the page, so it is never
// in IndexedDB, never in a download, never in a log.

globalThis.CarbonCopyRedact = globalThis.CarbonCopyRedact || (() => {
  // Labels that name a secret. Matched against the resolved question label
  // and the field's name/id, case-insensitively.
  const SECRET_LABEL = new RegExp([
    '\\bssn\\b',
    'social\\s*security',
    'social\\s*insurance',
    '\\bsin\\s*(number|no)\\b',
    'card\\s*(number|no\\b|#)',
    'credit\\s*card',
    'debit\\s*card',
    '\\bcc\\s*(number|num|no)\\b',
    '\\bcvv2?\\b',
    '\\bcvc2?\\b',
    '\\bcv2\\b',
    'card\\s*security\\s*code',
    'card\\s*verification',
  ].join('|'), 'i');

  // name/id attributes that name a secret, for fields with no useful label.
  const SECRET_NAME = /(^|[_\-.[\]])(ssn|cvv2?|cvc2?|cardnumber|card_number|card-number|ccnum|cc_number)($|[_\-.[\]])/i;

  // EEO self-identification. Off by default: the record is about what you
  // chose to say about your work, and these answers are kept out of a file
  // that might get pasted somewhere. The popup toggle turns them on.
  const EEO_LABEL = /\b(gender|sex|race|racial|ethnicity|ethnic|hispanic|latin[aox]|veteran|disability|disabled|sexual\s+orientation|transgender|lgbtq?)\b/i;
  const EEO_CONTAINER = /eeo|demographic|self[-_]?id|voluntary[-_]?disclosure/i;

  function autocompleteTokens(el) {
    return (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  // Returns a reason string if the field must never be captured, else null.
  function secretReason(el, label) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return 'password';
    for (const t of autocompleteTokens(el)) {
      if (t.startsWith('cc-')) return 'autocomplete-cc';
      if (t === 'one-time-code') return 'autocomplete-otp';
      if (t.endsWith('-password')) return 'autocomplete-password';
    }
    if (label && SECRET_LABEL.test(label)) return 'label';
    const ident = `${el.getAttribute('name') || ''} ${el.id || ''}`;
    if (SECRET_NAME.test(ident)) return 'name';
    return null;
  }

  function isEEO(el, label) {
    if (label && EEO_LABEL.test(label)) return true;
    for (let a = el.parentElement, depth = 0; a && depth < 8; a = a.parentElement, depth++) {
      const ident = `${a.id || ''} ${typeof a.className === 'string' ? a.className : ''}`;
      if (EEO_CONTAINER.test(ident)) return true;
    }
    return false;
  }

  return { secretReason, isEEO, SECRET_LABEL, EEO_LABEL };
})();
