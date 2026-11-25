/**
 * The small pictures of the documents (a girl's photo, full body photo, passport),
 * kept on this device: shown at once, with no wheel and no request, the next time.
 *
 *   in memory      this window saw it: drawn with the page
 *   on this device its own small store (IndexedDB): a few milliseconds
 *   else           asked from the PC once, then kept
 *
 * A picture's key is its file's number and size: a new upload is a new number, so a
 * kept one is never an old one. Only small ones are kept (a whole photo sent while its
 * small copy is being made is shown, and asked again next time).
 * Cleared when this PC is cut off or logs out of the main PC (clearPics).
 * Off: "photos" in the off switch — each tile loads by itself, as before.
 */
import { off } from './offSwitch'

const DB = 'adal-keep-pics', STORE = 'pics', KEEP = 600, BIG = 150 * 1024
export const picsOn = () => typeof indexedDB !== 'undefined' && !off('photos') && !window.__ADAL_CLOUD && !(import.meta.env.VITE_PHONE === '1' || import.meta.env.VITE_ADMIN === '1' || import.meta.env.VITE_DEMO === '1')

let opening = null
const db = () => opening ||= new Promise((ok) => {
  try {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); opening = null }; ok(r.result) }
    r.onerror = r.onblocked = () => ok(null)
  } catch { ok(null) }
})
const todo = (r) => new Promise((ok) => { r.onsuccess = () => ok(r.result); r.onerror = () => ok(undefined) })

const shown = new Map()   // key → its address in this window (newest last)
function show(key, blob) {
  if (shown.has(key)) return shown.get(key)
  const url = URL.createObjectURL(blob)
  shown.set(key, url)
  if (shown.size > 300) { const [k, u] = shown.entries().next().value; shown.delete(k); setTimeout(() => URL.revokeObjectURL(u), 60000) }
  return url
}

export const picKey = (f) => f?.id ? `f${f.id}-${f.size || 0}` : null
/** Already in this window: its address, at once (or null). */
export const picNow = (key) => key && shown.get(key) || null

const going = new Map()
/** The picture's address in this window. Throws { state: 'away' | 'quiet' | 'missing' | 'broken' }. */
export function pic(key, url) {
  if (shown.has(key)) return Promise.resolve(shown.get(key))
  if (going.has(key)) return going.get(key)
  const p = (async () => {
    const d = await db()
    let old
    try { old = d && await todo(d.transaction(STORE).objectStore(STORE).get(key)) } catch {}
    if (old?.blob) return show(key, old.blob)
    const headers = {}
    try { const k = localStorage.getItem('adal_pc_key'); if (k) headers['X-Adal-PC'] = k } catch {}
    let r
    try { r = await fetch(url, { headers, priority: 'high', credentials: 'same-origin', signal: AbortSignal.timeout(20000) }) } catch { throw Object.assign(new Error('no answer'), { state: 'quiet' }) }
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { state: r.headers.get('X-Adal-Pending') === '1' ? 'away' : r.status === 404 ? 'missing' : r.status >= 500 || r.status === 401 ? 'quiet' : 'broken' })
    const blob = await r.blob()
    if (d && blob.size < BIG && /^image\//.test(blob.type)) { try { d.transaction(STORE, 'readwrite').objectStore(STORE).put({ blob, at: Date.now() }, key); tidy(d) } catch {} }
    return show(key, blob)
  })().finally(() => going.delete(key))
  going.set(key, p)
  p.catch(() => {})
  return p
}

/** One that could not be drawn: forgotten, asked again. */
export async function dropPic(key) {
  shown.delete(key)
  const d = await db()
  try { d?.transaction(STORE, 'readwrite').objectStore(STORE).delete(key) } catch {}
}

// The oldest go (looked at once in 50 new ones).
let put = 0
async function tidy(d) {
  if (++put % 50) return
  try {
    const keys = await todo(d.transaction(STORE).objectStore(STORE).getAllKeys())
    if (!(keys?.length > KEEP)) return
    const all = []
    const s = d.transaction(STORE).objectStore(STORE)
    for (const k of keys) all.push([k, (await todo(s.get(k)))?.at || 0])
    const w = d.transaction(STORE, 'readwrite').objectStore(STORE)
    for (const [k] of all.sort((a, b) => a[1] - b[1]).slice(0, keys.length - KEEP)) w.delete(k)
  } catch {}
}

/** Her pictures fetched ahead (the girls opened last): opening her shows them at once. */
export function picsAhead(fields) {
  if (!picsOn()) return
  for (const f of fields || []) {
    if (!['Photo', 'Full Body Photo', 'Passport'].includes(f?.name)) continue
    const file = tileFile(f)
    if (/^image\//.test(file?.mimetype || '')) pic(picKey(file), `/api/files/${file.id}/thumbnail`).catch(() => {})
  }
}
/** The file a field's tile shows: the newest photo, else the first file. */
export function tileFile(field) {
  const files = field?.files || []
  if (!files.length || !['Photo', 'Full Body Photo'].includes(field.name)) return files[0]
  const im = files.filter(f => /^image\//.test(f?.mimetype || ''))
  return im.reduce((a, b) => (b.id > a.id ? b : a), im[0] || files[0])
}

/** Cut off by the main PC, or logged out of it: nothing of the agency stays here. */
export async function clearPics() {
  shown.clear()
  try { (await db())?.close() } catch {}
  opening = null
  try { indexedDB.deleteDatabase(DB) } catch {}
}
