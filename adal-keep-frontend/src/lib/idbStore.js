/**
 * A small store on this device (IndexedDB: megabytes, unlike localStorage):
 * what the pages downloaded, kept for the next visit. Anything that cannot be
 * stored (private mode, no IndexedDB) is simply not kept.
 */
const DB = 'adal-keep-cache', STORE = 'answers'
let opening = null
const db = () => opening ||= new Promise((resolve) => {
  try {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => resolve(null)
  } catch { resolve(null) }
})

export async function idbGet(key) {
  const d = await db()
  if (!d) return undefined
  return new Promise((resolve) => {
    try {
      const r = d.transaction(STORE).objectStore(STORE).get(key)
      r.onsuccess = () => resolve(r.result?.data)
      r.onerror = () => resolve(undefined)
    } catch { resolve(undefined) }
  })
}

// What was last written under each key (its length and a hash): a page that
// asks every few seconds gets the same answer most times, and writing it to
// the disk again each time kept a slow PC's hard disk busy for nothing.
const written = new Map()
function signature(data) {
  let s
  try { s = JSON.stringify(data) } catch { return null }
  if (typeof s !== 'string') return null
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return `${s.length}:${h >>> 0}`
}

export async function idbPut(key, data) {
  const sig = signature(data)
  if (sig && written.get(key) === sig) return
  const d = await db()
  if (!d) return
  // Noted when the write starts (not when it ends): an older answer asked to be
  // written again while a newer one is still being written is not skipped.
  if (sig) written.set(key, sig); else written.delete(key)
  try {
    const tx = d.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ data, at: Date.now() }, key)
    tx.onerror = tx.onabort = () => { if (written.get(key) === sig) written.delete(key) }
  } catch { written.delete(key) }
}

/** The key of one answer: the PC it came from, the address and its parameters. */
export const answerKey = (base, url, params) => `${base || location.origin}|${url}|${params && Object.keys(params).length ? JSON.stringify(params) : ''}`
