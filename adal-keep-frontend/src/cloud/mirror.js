/**
 * The phone's own copy of the agency's text (every answer the pages read:
 * profiles, fields, journeys, tasks …) in the phone's database (IndexedDB),
 * so every page opens at once from the phone itself.
 *
 *   first time   everything (≈ 250 KB compressed), the profile list first
 *   then         only what changed (keep_meta.updated_at), every 20 s while
 *                the app is open, and at once when the PC says what changed
 *                (live link: { t: 'changed', keys })
 *   now and then the answers the PC removed are removed here too
 *
 * Pictures and documents are not copied: they come from Telegram when they
 * are opened, and stay on the phone after (adapter.js, file cache).
 */
const mem = new Map()          // key → { data, at }
let dbP = null, readyP = null, lastAt = '', syncing = null
const listeners = new Set()
const NAME = (agency) => `adal-keep-${agency}`
const LAST = (agency) => `adal-mirror-at-${agency}`

function open(agency) {
  return (dbP ||= new Promise((ok, no) => {
    const r = indexedDB.open(NAME(agency), 1)
    r.onupgradeneeded = () => r.result.createObjectStore('meta')
    r.onsuccess = () => ok(r.result)
    r.onerror = () => no(r.error)
  }))
}
async function store(rows) {
  const db = await dbP
  await new Promise((ok) => {
    const tx = db.transaction('meta', 'readwrite')
    const os = tx.objectStore('meta')
    for (const r of rows) r.del ? os.delete(r.key) : os.put({ data: r.data, at: r.updated_at }, r.key)
    tx.oncomplete = tx.onerror = tx.onabort = () => ok()
  })
}

/** Load the copy into memory (once). */
export function mirrorReady(agency) {
  return (readyP ||= (async () => {
    try {
      const db = await open(agency)
      lastAt = localStorage.getItem(LAST(agency)) || ''
      await new Promise((ok) => {
        const req = db.transaction('meta').objectStore('meta').openCursor()
        req.onsuccess = () => { const c = req.result; if (!c) return ok(); mem.set(c.key, c.value); c.continue() }
        req.onerror = () => ok()
      })
    } catch { dbP = null }
  })())
}

export const mirrorHas = (key) => mem.has(key)
export const mirrorGet = (key) => mem.get(key)?.data
export const mirrorAt = (key) => mem.get(key)?.at
export const mirrorAge = (key) => { const v = mem.get(key); return v ? Date.now() - new Date(v.at).getTime() : Infinity }
export const mirrorSize = () => mem.size
export function onMirror(fn) { listeners.add(fn); return () => listeners.delete(fn) }

/** An answer the PC just gave (live): kept as the newest copy. */
export function mirrorPut(key, data) {
  const at = new Date().toISOString()
  mem.set(key, { data, at })
  if (dbP) store([{ key, data, updated_at: at }]).catch(() => {})
}

function take(rows, agency, move = true) {
  const keep = rows.filter(r => !String(r.key).startsWith('/_'))
  for (const r of keep) mem.set(r.key, { data: r.data, at: r.updated_at })
  if (keep.length) { store(keep).catch(() => {}); listeners.forEach(fn => { try { fn(keep.map(r => r.key)) } catch {} }) }
  if (!move) return
  const newest = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), lastAt)
  if (newest !== lastAt) { lastAt = newest; try { localStorage.setItem(LAST(agency), lastAt) } catch {} }
}

/**
 * Bring the copy up to date: what changed since last time (everything the
 * first time — the profile list first, then the rest in pages).
 * rest(method, path) is the adapter's Supabase call.
 */
export function mirrorSync(rest, agency) {
  return (syncing ||= (async () => {
    try {
      await mirrorReady(agency)
      const sel = 'select=key,data,updated_at'
      if (!lastAt && !mem.has('/profiles')) {
        take(await rest('GET', `/rest/v1/keep_meta?key=in.(/profiles,/brokers,/settings,/dashboard)&${sel}`) || [], agency, false)
      }
      if (!lastAt) {
        // The first time: everything, in pages.
        for (let page = 0; page < 40; page++) {
          const since = lastAt ? `&updated_at=gte.${encodeURIComponent(lastAt)}` : ''
          const rows = await rest('GET', `/rest/v1/keep_meta?${sel}${since}&order=updated_at.asc&limit=150`) || []
          take(rows, agency)
          if (rows.length < 150) break
        }
        return
      }
      // Then: the names and times of what changed lately (a big upload from a
      // slow office line can land minutes after its time), and only those the
      // phone does not have yet.
      const back = new Date(new Date(lastAt).getTime() - 10 * 60000).toISOString()
      const list = await rest('GET', `/rest/v1/keep_meta?select=key,updated_at&updated_at=gte.${encodeURIComponent(back)}&order=updated_at.asc&limit=2000`) || []
      const need = list.filter(r => !String(r.key).startsWith('/_') && mem.get(r.key)?.at !== r.updated_at).map(r => r.key)
      for (let i = 0; i < need.length; i += 40) {
        const q = need.slice(i, i + 40).map(k => `"${String(k).replace(/"/g, '')}"`).join(',')
        take(await rest('GET', `/rest/v1/keep_meta?key=in.(${encodeURIComponent(q)})&${sel}`) || [], agency, false)
      }
      const newest = list.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), lastAt)
      if (newest !== lastAt) { lastAt = newest; try { localStorage.setItem(LAST(agency), lastAt) } catch {} }
    } finally { syncing = null }
  })())
}

/** The PC sent changed answers with their data (live link): kept at once. */
export function mirrorTake(rows, agency) {
  // Not the "last synced" mark: rows that went online before them may still come.
  take(rows || [], agency, false)
}

/** The PC said these answers changed: fetch just those. */
export async function mirrorFetch(rest, agency, keys) {
  const list = keys.filter(k => !String(k).startsWith('/_')).slice(0, 80)
  if (!list.length) return
  const q = list.map(k => `"${String(k).replace(/"/g, '')}"`).join(',')
  take(await rest('GET', `/rest/v1/keep_meta?key=in.(${encodeURIComponent(q)})&select=key,data,updated_at`) || [], agency)
}

/** Every 15 min: answers the PC no longer keeps go here too, and any the phone missed come. */
export async function mirrorPrune(rest, agency) {
  const rows = await rest('GET', '/rest/v1/keep_meta?select=key,updated_at') || []
  const there = new Map(rows.map(r => [r.key, r.updated_at]))
  const gone = [...mem.keys()].filter(k => !there.has(k))
  for (const k of gone) mem.delete(k)
  if (gone.length) store(gone.map(key => ({ key, del: true }))).catch(() => {})
  const need = rows.filter(r => !String(r.key).startsWith('/_') && mem.get(r.key)?.at !== r.updated_at).map(r => r.key)
  for (let i = 0; i < need.length; i += 40) {
    const q = need.slice(i, i + 40).map(k => `"${String(k).replace(/"/g, '')}"`).join(',')
    take(await rest('GET', `/rest/v1/keep_meta?key=in.(${encodeURIComponent(q)})&select=key,data,updated_at`) || [], agency, false)
  }
}
