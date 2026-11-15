// The only storage backend: IndexedDB, shared by the service worker and the
// popup (same extension origin). Keep the interface this small; it is what
// makes swapping the backend cheap.

const DB = 'carbon-copy';
const STORE = 'records';

let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('capturedAt', 'capturedAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    // A transaction can abort with no error event first: running out of
    // quota does that (there is no unlimitedStorage permission). Without
    // this the promise never settles, and the service worker's one-at-a-time
    // queue stalls behind it.
    t.onabort = () => reject(t.error || new DOMException('Transaction aborted', 'AbortError'));
  });
}

export const put = record => tx('readwrite', s => s.put(record)).then(() => record);
export const get = id => tx('readonly', s => s.get(id));
export const remove = id => tx('readwrite', s => s.delete(id));

// One transaction for many deletes, so a partial clear cannot happen.
export const removeMany = ids => tx('readwrite', s => { ids.forEach(id => s.delete(id)); return null; });

// Newest first. limit 0 = everything.
export async function list({ limit = 0, status = null } = {}) {
  const all = await tx('readonly', s => s.index('capturedAt').getAll());
  const rows = all.reverse().filter(r => !status || r.status === status);
  return limit ? rows.slice(0, limit) : rows;
}
