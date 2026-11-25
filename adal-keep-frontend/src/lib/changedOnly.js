/**
 * The big lists, whole once, then only their changed rows (backend
 * services/changedRows.js): changedGet('/profiles/list') gives the list as ever —
 * the very same object when nothing changed, and the same row objects for every
 * girl who did not, so nothing else is drawn again.
 * Off: "rows" in the off switch.
 */
import api from '../services/api'
import { off } from './offSwitch'

export const LISTS = { '/profiles/list': { id: 'id' }, '/profiles/brief': { id: 'id' }, '/automations/stages': { at: 'profiles', id: 'profile_id' } }
const here = (path) => LISTS[String(path).replace(/^\/api/, '')]

/** The list with what changed put in; null when it does not come out right (asked whole again). */
export function merged(path, body, d) {
  const { at, id } = here(path)
  const old = at ? body?.[at] : body
  if (!Array.isArray(old)) return null
  const set = new Map((d.$set || []).map(r => [r[id], r])), gone = new Set(d.$gone || [])
  const rows = []
  for (const r of old) {
    if (gone.has(r[id])) continue
    if (set.has(r[id])) { rows.push(set.get(r[id])); set.delete(r[id]) } else rows.push(r)
  }
  const all = set.size ? [...set.values(), ...rows] : rows      // (new ones first: the newest girl on top)
  if (all.length !== d.$count) return null
  return at ? { ...body, ...(d.$rest || {}), [at]: all } : all
}

const has = new Map()   // url → { v, body }
export const isList = (url) => !!LISTS[url] && !off('rows') && !window.__ADAL_CLOUD && !(import.meta.env.VITE_PHONE === '1' || import.meta.env.VITE_ADMIN === '1' || import.meta.env.VITE_DEMO === '1')

export async function changedGet(url, config = {}) {
  const mine = has.get(url)
  const ask = (have) => api.get(url, { ...config, adalNoCache: true, headers: { ...config.headers, 'X-Adal-Have': have } })
  let r = await ask(mine?.v || '0')
  if (r.data?.$v) {
    if (!('$set' in r.data)) { if (mine && mine.v === r.data.$v) return mine.body }
    // (asked twice at once: whatever is newest here is what the change is put on only if it is from it)
    const base = has.get(url)
    const body = base && base.v === mine?.v && r.data.$set ? merged(url, base.body, r.data) : base && base.v === r.data.$v ? base.body : null
    if (body) { has.set(url, { v: r.data.$v, body }); return body }
    has.delete(url)
    r = await ask('0')
  }
  const v = r.headers?.['x-adal-v']
  if (v) has.set(url, { v, body: r.data }); else has.delete(url)
  return r.data
}
