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

export async function idbPut(key, data) {
  const d = await db()
  if (!d) return
  try { d.transaction(STORE, 'readwrite').objectStore(STORE).put({ data, at: Date.now() }, key) } catch {}
}

/** The key of one answer: the PC it came from, the address and its parameters. */
export const answerKey = (base, url, params) => `${base || location.origin}|${url}|${params && Object.keys(params).length ? JSON.stringify(params) : ''}`
