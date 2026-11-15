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
  // Labels that name a secret, on any kind of field. Matched against the
  // resolved question label (and the legend of the group around the field),
  // case-insensitively.
  const SECRET_LABEL = new RegExp([
    '\\bssn\\b',
    'social\\s*security',
    'social\\s*insurance',
    '\\bsin\\s*(number|no)\\b',
    // Payment cards
    'card\\s*(number|no\\b|#)',
    'credit\\s*card',
    'debit\\s*card',
    '\\bcc\\s*(number|num|no)\\b',
    '\\bcvv2?\\b',
    '\\bcvc2?\\b',
    '\\bcv2\\b',
    'card\\s*security\\s*code',
    'card\\s*verification',
    // Bank details. Not bare "Swift" (the language) or "ABA" (behavior
    // analysis, a job field of its own).
    'bank\\s*account',
    '\\baccount\\s*(number|no\\b|#)',
    'routing\\s*(number|no\\b|#|code)',
    '\\baba\\s*(routing|number|no\\b|#)',
    'transit\\s*number',
    '\\biban\\b',
    '\\bswift\\s*(/\\s*bic|code|number)',
    '\\bbic\\b',
    'sort\\s*code',
    // Tax identifiers
    'tax(payer)?\\s*(id\\b|identification|number|no\\b)',
    'employer\\s*identification',
    // Date of birth
    'date\\s*of\\s*birth',
    'birth\\s*date',
    'birthdate',
    'birthday',
    '\\bdob\\b',
  ].join('|'), 'i');

  // Upper case only: "ein" is German for "a", "tin" is a metal.
  const SECRET_LABEL_CASED = /\b(TIN|EIN|ITIN)\b/;

  // Identity documents, on free-text fields only. "Do you have a valid
  // passport?" as a yes/no question is an answer worth keeping; the number
  // typed into a passport field is not.
  const ID_LABEL = /passport|driv(er|ing)['’]?s?\s*licen[cs]e|national\s*(id\b|identity|identification|insurance)|government[\s-]*(issued\s*)?id\b/i;

  // name/id attributes that name a secret, for fields with no useful label.
  // Stricter than the labels: an id of "swift" or "routing" is as likely to
  // belong to a question about the language or about networks.
  const delimited = words => new RegExp(`(^|[\\s_\\-.[\\]])(${words.join('|')})($|[\\s_\\-.[\\]])`, 'i');
  const SECRET_NAME = delimited([
    'ssn', 'cvv2?', 'cvc2?', 'card[_-]?number', 'ccnum', 'cc[_-]?number',
    'bank[_-]?account([_-]?(number|num|no))?', 'account[_-]?(number|num|no)',
    'routing[_-]?(number|num|no)', 'aba[_-]?routing', 'iban', 'swift[_-]?(code|bic)', 'bic', 'sort[_-]?code',
    'tin', 'ein', 'itin', 'tax(payer)?[_-]?id',
    'dob', 'birth[_-]?date', 'date[_-]?of[_-]?birth', 'birthday',
  ]);
  const ID_NAME = delimited([
    'passport([_-]?(number|num|no))?', 'driv(er|ing)s?[_-]?licen[cs]e([_-]?(number|num|no))?', 'national[_-]?id',
  ]);

  // Fields whose values are long digit strings for innocent reasons, exempt
  // from the value checks below: a 9-digit phone number, a ZIP+4.
  const DIGITS_OK_LABEL = /phone|mobile|\bcell\b|\btel\b|whats\s*app|\bfax\b|\bzip\b|postal|post\s*code|postcode/i;

  // EEO self-identification. Off by default: the record is about what you
  // chose to say about your work, and these answers are kept out of a file
  // that might get pasted somewhere. The popup toggle turns them on.
  const EEO_LABEL = /\b(gender|sex|race|racial|ethnicity|ethnic|hispanic|latin[aox]|veteran|disability|disabled|sexual\s+orientation|transgender|lgbtq?)\b/i;
  const EEO_CONTAINER = /eeo|demographic|self[-_]?id|voluntary[-_]?disclosure/i;

  function autocompleteTokens(el) {
    return (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean);
  }

  const typeAttr = el => (el.getAttribute('type') || '').toLowerCase();
  const idents = el => [el.getAttribute('name') || '', el.id || ''];

  // A field with a fixed set of answers: radio, checkbox, select.
  function isChoice(el) {
    const type = typeAttr(el);
    return el.tagName === 'SELECT' || type === 'radio' || type === 'checkbox';
  }

  // The legend of the group a field sits in, for a date of birth split into
  // Month, Day and Year fields that are each labeled only that.
  function groupText(el) {
    const g = el.closest?.('fieldset, [role="group"]');
    if (!g) return '';
    const al = g.getAttribute('aria-label');
    if (al) return al;
    const legend = g.tagName === 'FIELDSET' ? g.querySelector(':scope > legend') : null;
    return legend ? legend.textContent || '' : '';
  }

  const namesSecret = text => !!text && (SECRET_LABEL.test(text) || SECRET_LABEL_CASED.test(text));

  // Returns a reason string if the field must never be captured, else null.
  // Judged by what the field is: its type, autocomplete, label and name.
  function secretReason(el, label) {
    const type = typeAttr(el);
    if (type === 'password') return 'password';
    for (const t of autocompleteTokens(el)) {
      if (t.startsWith('cc-')) return 'autocomplete-cc';
      if (t === 'one-time-code') return 'autocomplete-otp';
      if (t.endsWith('-password')) return 'autocomplete-password';
      if (t.startsWith('bday')) return 'autocomplete-bday';
    }
    if (namesSecret(label) || namesSecret(groupText(el))) return 'label';
    if (idents(el).some(v => SECRET_NAME.test(v))) return 'name';
    if (!isChoice(el)) {
      if (label && ID_LABEL.test(label)) return 'label-id';
      if (idents(el).some(v => ID_NAME.test(v))) return 'name-id';
    }
    return null;
  }

  function luhn(digits) {
    let sum = 0;
    for (let i = digits.length - 1, alt = false; i >= 0; i--, alt = !alt) {
      let n = digits.charCodeAt(i) - 48;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0;
  }

  // ISO 13616: move the first four characters to the end, letters to
  // numbers (A=10 ... Z=35), and the result mod 97 must be 1.
  function isIban(s) {
    const v = s.replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
    let m = 0;
    for (const ch of v.slice(4) + v.slice(0, 4)) {
      const n = ch >= 'A' ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
      m = (m * (n > 9 ? 100 : 10) + n) % 97;
    }
    return m === 1;
  }

  // Returns a reason string if a value is itself a secret, whatever the
  // field is called: a card number or an SSN typed into "Anything else?".
  // Only the whole value counts, and only when it is nothing but digits,
  // spaces and dashes (or IBAN-shaped), so prose that mentions a number is
  // kept. Phone and postal-code fields are exempt.
  function secretValue(el, label, value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (!v || v.length > 64) return null;
    if (typeAttr(el) === 'tel') return null;
    if (autocompleteTokens(el).some(t => t.startsWith('tel') || t === 'postal-code')) return null;
    if (DIGITS_OK_LABEL.test(label || '') || idents(el).some(x => DIGITS_OK_LABEL.test(x))) return null;
    if (/^[\d\s-]+$/.test(v)) {
      const d = v.replace(/\D/g, '');
      if (d.length >= 13 && d.length <= 19 && luhn(d)) return 'value-card';
      if (d.length === 9) return 'value-nine-digits'; // SSN, routing number, many national IDs
      return null;
    }
    if (/^[A-Za-z]{2}\d{2}[A-Za-z0-9 ]+$/.test(v) && isIban(v)) return 'value-iban';
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

  return { secretReason, secretValue, isEEO, SECRET_LABEL, EEO_LABEL };
})();
