/** Private, short-lived local drafts for an order form, including selected file blobs. */
const DB_NAME = 'counter-drop-drafts'
const STORE_NAME = 'orders'
const KEEP_MS = 14 * 24 * 60 * 60 * 1000

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'))
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open draft storage'))
  })
}

function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const request = run(tx.objectStore(STORE_NAME))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Draft storage failed'))
    tx.oncomplete = () => db.close()
    tx.onerror = () => reject(tx.error ?? new Error('Draft storage failed'))
    tx.onabort = () => reject(tx.error ?? new Error('Draft storage aborted'))
  }))
}

export async function loadOrderDraft<T>(key: string): Promise<T | null> {
  const value = await transact<{ savedAt: number; data: T } | undefined>('readonly', (s) => s.get(key))
  if (!value) return null
  if (Date.now() - value.savedAt > KEEP_MS) {
    await clearOrderDraft(key)
    return null
  }
  return value.data
}

export function saveOrderDraft<T>(key: string, data: T): Promise<void> {
  return transact<IDBValidKey>('readwrite', (s) => s.put({ savedAt: Date.now(), data }, key)).then(() => undefined)
}

export function clearOrderDraft(key: string): Promise<void> {
  return transact<undefined>('readwrite', (s) => s.delete(key)).then(() => undefined)
}
