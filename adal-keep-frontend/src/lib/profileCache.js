/**
 * One girl's page kept on this device (asked on 2026-11-19: "nothing waits on
 * the network twice for the same thing"): her details, her documents, her CVs
 * and her CV check, in memory and in IndexedDB (lib/idbStore.js). Opening her
 * again shows what was kept at once; the fresh answers come in behind it
 * (stale-while-revalidate). A profile is fetched ahead when the pointer rests
 * on her card, and the last ones opened are fetched ahead when the list opens.
 * Her edit form never uses this (it always reads her from the PC).
 */
import api from '../services/api'
import { idbGet, idbPut, answerKey } from './idbStore'
import { picsOn, picsAhead } from './pics'

const mem = new Map()                 // key -> data
const fetchedAt = new Map()           // profile id -> time of the last fetch ahead
const RECENT = 'adal-recent-profiles'
const FRESH_MS = 30000

export const parts = (id) => ({
  profile: `/profiles/${id}`,
  fields: `/profiles/${id}/fields`,
  cvs: `/cv/generated?profile_id=${id}`,
  readiness: `/cv/profile-readiness/${id}`,
})
const keyOf = (path) => answerKey(api.defaults.baseURL, path)

/** What is kept of her right now in memory (no waiting), or undefined. */
export function keptNow(path) { return mem.get(keyOf(path)) }

/** What is kept of her on this device (memory first, then IndexedDB). */
export async function kept(path) {
  const k = keyOf(path)
  if (mem.has(k)) return mem.get(k)
  const v = await idbGet(k).catch(() => undefined)
  if (v !== undefined) mem.set(k, v)
  return v
}

/** A fresh answer about her: kept for next time. */
export function keep(path, data) {
  if (data === undefined || data === null) return
  const k = keyOf(path)
  mem.set(k, data)
  if (mem.size > 400) mem.delete(mem.keys().next().value)
  idbPut(k, data).catch(() => {})
}

/** She was opened: the list's "recent" (fetched ahead next time). */
export function noteOpened(id) {
  try {
    const l = JSON.parse(localStorage.getItem(RECENT) || '[]').filter(x => String(x) !== String(id))
    l.unshift(String(id))
    localStorage.setItem(RECENT, JSON.stringify(l.slice(0, 12)))
  } catch {}
}
export function recentIds() { try { return JSON.parse(localStorage.getItem(RECENT) || '[]') } catch { return [] } }

// Her pictures into the browser's cache (the thumbnails the page shows first).
function warmPictures(fields) {
  if (picsOn()) return picsAhead(Array.isArray(fields) ? fields : [])
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!/photo|passport/i.test(f?.name || '')) continue
    const file = (f.files || [])[0]
    if (file?.id && /^image\//.test(file.mimetype || 'image/')) { const i = new Image(); i.decoding = 'async'; i.src = `/api/files/${file.id}/thumbnail` }
  }
}

/** Fetch her ahead (her card is pointed at, or she was opened lately). Once per 30 s. */
export function prefetchProfile(id) {
  if (!id || String(id).startsWith('-')) return
  if (Date.now() - (fetchedAt.get(String(id)) || 0) < FRESH_MS) return
  fetchedAt.set(String(id), Date.now())
  const p = parts(id)
  const get = (path) => api.get(path, { adalNoCache: true }).then(r => { keep(path, r.data); return r.data })
  get(p.profile).catch(() => fetchedAt.delete(String(id)))
  get(p.fields).then(warmPictures).catch(() => {})
}

/** The last profiles opened, fetched ahead a moment after the list opens (quietly, two at a time). */
export function prefetchRecent(limit = 6) {
  const ids = recentIds().slice(0, limit)
  let i = 0
  const next = () => { if (i < ids.length) { prefetchProfile(ids[i++]); setTimeout(next, 400) } }
  setTimeout(next, 1500)
}
