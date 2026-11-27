/**
 * directRead.js — read-only robot jobs read the sites' own data calls in the signed-in tab instead of loading and
 * clicking pages (the owner, 2026-11-26, "option 2"). Only reading: filling, uploads, Save and Submit stay in the page.
 *
 *  - Musaned: the headers its own page sends with each data call (its sign-in, role, organization) are seen as the tab
 *    works and kept on the tab for 10 minutes; a read then needs no page load at all. A refused call (401/403) loads
 *    the page once for fresh ones; a call that fails or changed shape: the click path (the caller's).
 *  - timed(): says which way a read went and how long it took ("[direct] Musaned list: data call 1.2 s").
 * Never copies a sign-in out of the tab. Off: ADAL_DIRECT_READ=0 (the pages and clicks of before).
 */
export const directOn = (env = process.env) => env.ADAL_DIRECT_READ !== '0'
export const HEADERS_MS = 10 * 60e3
const MUSANED_API = 'https://api-tawtheeq.musaned.com.sa'

/** tabManager's request watch: the latest headers Musaned's own page sent with a data call. Never throws. */
export function noteHeaders(page, req) {
  try {
    if (!directOn() || !req.url().startsWith(MUSANED_API)) return
    const h = req.headers()
    if (!h.authorization || !h['app-organization']) return
    page.__adalApiH = { at: Date.now(), h: Object.fromEntries(Object.entries(h).filter(([k]) => /^(authorization|app-|accept-language)/.test(k))) }
  } catch {}
}

/** The tab's own Musaned headers when seen in the last 10 minutes and the tab is still on Musaned, else null. */
export function freshHeaders(page, now = Date.now()) {
  try {
    if (!directOn()) return null
    const k = page.__adalApiH
    if (!k || now - k.at > HEADERS_MS || !/(^|\.)musaned\.com\.sa$/i.test(new URL(page.url()).hostname)) return null
    return k.h
  } catch { return null }
}
export const dropHeaders = (page) => { try { page.__adalApiH = null } catch {} }

/** Runs `fn`, says which way (`how`) and how long; the result as is. */
export async function timed(what, how, fn, log = (m) => console.log(m)) {
  const t0 = Date.now()
  try { return await fn() } finally { try { log(`[direct] ${what}: ${how} ${((Date.now() - t0) / 1000).toFixed(1)} s`) } catch {} }
}
