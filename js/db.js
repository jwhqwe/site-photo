// IndexedDB storage. Everything (drawings, photos, records) stays on this phone.
const NAME = 'fieldphoto';
const VERSION = 1;
let dbp = null;

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('floors')) db.createObjectStore('floors', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('day', 'day');
        s.createIndex('floor', 'floor');
        s.createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains('registers')) db.createObjectStore('registers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('regItems')) {
        const s = db.createObjectStore('regItems', { keyPath: 'id' });
        s.createIndex('reg', 'reg');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function done(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}
async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(name, key) { return done((await store(name)).get(key)); }
export async function put(name, value) { return done((await store(name, 'readwrite')).put(value)); }
export async function del(name, key) { return done((await store(name, 'readwrite')).delete(key)); }
export async function all(name) { return done((await store(name)).getAll()); }
export async function clear(name) { return done((await store(name, 'readwrite')).clear()); }
export async function byIndex(name, index, value) { return done((await store(name)).index(index).getAll(value)); }

export async function putMany(name, values) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const v of values) s.put(v);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

export async function kvGet(k, def = null) {
  const r = await get('kv', k);
  return r ? r.v : def;
}
export async function kvSet(k, v) { return put('kv', { k, v }); }

// photo/video + thumbnail + record in one go
export async function saveItem(item, blob, thumb) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(['items', 'files', 'thumbs'], 'readwrite');
    tx.objectStore('items').put(item);
    if (blob) tx.objectStore('files').put({ id: item.id, blob });
    if (thumb) tx.objectStore('thumbs').put({ id: item.id, blob: thumb });
    tx.oncomplete = () => res(item);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('저장 공간이 부족할 수 있어요'));
  });
}
export async function deleteItem(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(['items', 'files', 'thumbs'], 'readwrite');
    tx.objectStore('items').delete(id);
    tx.objectStore('files').delete(id);
    tx.objectStore('thumbs').delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

export async function persist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) { /* not supported */ }
  return false;
}
export async function estimate() {
  try { if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate(); } catch (e) { /* ignore */ }
  return null;
}
