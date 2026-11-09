/**
 * What a page downloaded is kept on this device (IndexedDB — megabytes, not
 * localStorage's few), asked for on 2026-11-09: the next visit shows it at
 * once, and the fresh copy comes in behind it and replaces it.
 *
 *   cachedGet('/brokers', { onSaved: (data) => show(data) })  → the fresh data
 *
 * Kept per PC address (a phone can belong to another office's PC). Anything a
 * page cannot read back (no IndexedDB, private mode) just downloads as before.
 */
import api from '../services/api'

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

const keyOf = (url, params) => `${api.defaults.baseURL || location.origin}|${url}|${params ? JSON.stringify(params) : ''}`

export async function saved(url, params) {
  const d = await db()
  if (!d) return undefined
  return new Promise((resolve) => {
    try {
      const r = d.transaction(STORE).objectStore(STORE).get(keyOf(url, params))
      r.onsuccess = () => resolve(r.result?.data)
      r.onerror = () => resolve(undefined)
    } catch { resolve(undefined) }
  })
}

export async function keep(url, params, data) {
  const d = await db()
  if (!d) return
  try { d.transaction(STORE, 'readwrite').objectStore(STORE).put({ data, at: Date.now() }, keyOf(url, params)) } catch {}
}

/**
 * The saved copy (to onSaved, at once, when there is one), then the fresh one
 * from the PC (returned, and kept for next time).
 */
export async function cachedGet(url, { params, onSaved } = {}) {
  const fresh = api.get(url, params ? { params } : undefined).then(r => { keep(url, params, r.data); return r.data })
  if (onSaved) {
    const old = await saved(url, params)
    if (old !== undefined) { try { onSaved(old) } catch {} }
  }
  return fresh
}
