// At most one submission written to disk per tab and site at a time. A page
// that submits in a loop (a bug, or a script forcing it) would otherwise
// fill ~/Downloads/carbon-copy with copies. A submission refused here is not
// lost: it stays a draft of its record, in the browser, where Save files in
// the popup can still write it.
//
// Keyed by tab + origin, not the session key: the session key includes the
// path, and a page can change its path with history.pushState as often as
// it likes.

export const SUBMIT_INTERVAL_MS = 5000;
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

// What was sent, as one hash: the answers and the files, not the page or
// the timestamps.
export async function fingerprint(record) {
  const body = JSON.stringify([
    record.fields.map(f => [f.label, f.name, f.value]),
    record.files.map(f => [f.label, f.name, f.size, f.sha256]),
  ]);
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// check(key, print) returns null when the submission may go to disk (and
// remembers it), or why not: 'too-soon' after another one from the same
// tab and site, 'duplicate' for the same answers again.
export function createSubmitGate({ interval = SUBMIT_INTERVAL_MS, duplicateWindow = DUPLICATE_WINDOW_MS, now = Date.now } = {}) {
  const last = new Map(); // key -> { at, print }
  return function check(key, print) {
    const t = now();
    for (const [k, v] of last) if (t - v.at >= duplicateWindow) last.delete(k);
    const prev = last.get(key);
    if (prev && t - prev.at < interval) return 'too-soon';
    if (prev && prev.print === print) return 'duplicate';
    last.set(key, { at: t, print });
    return null;
  };
}
