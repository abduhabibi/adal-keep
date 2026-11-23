/**
 * siteApi.js — the portals' own data calls, used instead of clicking
 * (asked on 2026-11-23: "make the robots API-first"). Two parts:
 *
 *  1. Learned calls. While a robot does a step by clicking, the call the page
 *     itself makes for it (e.g. Musaned's HR Pool search by passport) is
 *     caught and kept as a template ("…passportNumber={q}…"). The next time
 *     the robot makes that call itself, inside the signed-in tab (the site's
 *     own sign-in), and clicks only when there is none or it fails.
 *     Reading only (GET): nothing on a portal is changed through a learned call.
 *
 *  2. Calls seen. Every data call (XHR/fetch) a robot tab makes is noted —
 *     its site, method and address with the numbers taken out, never the
 *     answers, headers or bodies — so the calls of every portal can be
 *     looked at and made API-first from what the real pages do
 *     (data/site-calls.json).
 *
 * ADAL_API_FIRST=0 turns the learned calls off (back to clicking everywhere).
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { lookup, remember, forget } from './robotCache.js'

export const apiFirst = () => process.env.ADAL_API_FIRST !== '0'

// ── 1. learned calls ─────────────────────────────────────────────────────────
/**
 * Catch, while `fn` runs, the page's GET to `base` whose address has `needle`
 * in it, and keep it as `key` with the needle as {q}. Returns fn's result.
 */
export async function learnWhile(page, db, { key, base, needle }, fn) {
  const want = String(needle || '')
  let seen = null
  const on = (req) => {
    try {
      const u = req.url()
      if (seen || req.method() !== 'GET' || !u.startsWith(base) || !want) return
      const at = u.indexOf(encodeURIComponent(want)) >= 0 ? encodeURIComponent(want) : u.includes(want) ? want : ''
      if (at) seen = u.slice(base.length).split(at).join('{q}')
    } catch {}
  }
  page.on('request', on)
  try { return await fn() } finally {
    page.off('request', on)
    if (seen) await remember(db, key, { url: seen }, { days: 90 })
  }
}

/** The learned address for `q`, or null. */
export async function learned(db, key, q) {
  if (!apiFirst()) return null
  const t = (await lookup(db, key))?.url
  return t ? t.split('{q}').join(encodeURIComponent(String(q))) : null
}

export const unlearn = (db, key) => forget(db, key)

// ── 2. calls seen ────────────────────────────────────────────────────────────
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'site-calls.json')
const calls = new Map()   // "METHOD host/path" → { n, last }
let dirty = false, timer = null
/** An address without what changes from girl to girl (numbers, ids, the query's values). */
export function shapeOf(method, url) {
  try {
    const u = new URL(url)
    const p = u.pathname.replace(/\/[0-9a-f-]{6,}(?=\/|$)/gi, '/:id').replace(/\/\d+(?=\/|$)/g, '/:n')
    const q = [...u.searchParams.keys()].sort().join('&')
    return `${String(method).toUpperCase()} ${u.host}${p}${q ? '?' + q : ''}`
  } catch { return '' }
}
/** A robot tab's data call (tabManager.js): noted, written out at most every 30 s. */
export function noteCall(method, url) {
  const k = shapeOf(method, url)
  if (!k) return
  const c = calls.get(k) || { n: 0 }
  c.n++; c.last = new Date().toISOString()
  calls.set(k, c)
  dirty = true
  if (!timer) {
    timer = setTimeout(() => { timer = null; flush() }, 30000)
    timer.unref?.()
  }
}
function flush() {
  if (!dirty) return
  dirty = false
  try {
    let old = {}
    try { old = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch {}
    for (const [k, v] of calls) old[k] = { n: (old[k]?.n || 0) + v.n, last: v.last }
    calls.clear()
    const keep = Object.entries(old).sort((a, b) => String(b[1].last).localeCompare(String(a[1].last))).slice(0, 2000)
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(keep), null, 1))
  } catch (e) { console.warn('[siteApi] calls not written:', e.message) }
}
