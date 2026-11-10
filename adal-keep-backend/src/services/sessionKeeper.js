/**
 * Sign in once in the morning, good for the whole day (asked on 2026-11-10).
 *
 * Every 4 minutes each site's signed-in tab gets a sign of life, out of sight:
 * a mouse move and a key (what a site's "you were idle" timer listens to) and
 * its own page asked for again in the background — never brought to the
 * front, never a tab a robot is working in, never a page with something typed
 * in it. Every 20 minutes a quiet tab is reloaded too (a site that keeps its
 * sign-in only while its pages load). The robots then find the site signed in
 * and go straight to work there (tabManager.borrowSignIn / findFreeTab).
 *
 * GET  /api/sessions             each site: signed in or not, its tabs, last kept
 * POST /api/sessions/:key/open   a window on that site to sign in
 */
import { getBrowser, openForPerson } from './browser.js'
import { hostOf } from './tabManager.js'

export const SITES = [
  { key: 'musaned', name: 'Musaned', host: /(^|\.)musaned\.com\.sa$/, start: 'https://tawtheeq.musaned.com.sa/', out: /\/(login|auth)\b|sso\.|wahid\.sa/i },
  { key: 'mofa', name: 'Enjaz (visa)', host: /(^|\.)visa\.mofa\.gov\.sa$/, start: 'https://visa.mofa.gov.sa/', out: /\/account\/login/i },
  { key: 'insurance', name: 'Insurance', host: /(^|\.)niscofetap\.com$/, start: 'https://agency.niscofetap.com/', out: /login|sign-?in|auth/i },
  { key: 'lmis', name: 'LMIS', host: /(^|\.)lmis\.gov\.et$/, start: 'https://lmis.gov.et/', out: /\/(auth|login)/i },
]
const EVERY_MS = 4 * 60000, RELOAD_MS = 20 * 60000
export const kept = {}   // site key → { at, tabs, signedIn, error }
let timer = null, busy = false, db = null

const siteOf = (url) => { try { const h = hostOf(url); return SITES.find(s => s.host.test(h)) || null } catch { return null } }
const signedInAt = (site, url) => { try { return !site.out.test(new URL(url).pathname + new URL(url).hostname) } catch { return false } }

async function runningTabs() {
  const ids = new Set((await db('automation_queue').where('status', 'running').select('id').catch(() => [])).map(r => Number(r.id)))
  return ids
}

/** One round: every site tab that is signed in gets its sign of life. */
export async function keepAlive() {
  if (busy) return kept
  busy = true
  try {
    const browser = await getBrowser().catch(() => null)
    if (!browser) return kept
    const running = await runningTabs()
    const pages = await browser.pages().catch(() => [])
    const seen = Object.fromEntries(SITES.map(s => [s.key, { tabs: 0, signedIn: false }]))
    for (const p of pages) {
      if (p.isClosed?.()) continue
      const site = siteOf(p.url())
      if (!site) continue
      seen[site.key].tabs++
      const inNow = signedInAt(site, p.url())
      if (inNow) seen[site.key].signedIn = true
      // Never a tab a robot is working in, nor one a person is typing in.
      if (!inNow || p.__adalBorrowed || running.has(Number(p.__adalRunId))) continue
      try {
        const typed = await Promise.race([p.evaluate(async () => {
          const typed = [...document.querySelectorAll('input, textarea')].some(e => !['hidden', 'password', 'checkbox', 'radio', 'file', 'submit', 'button'].includes(e.type) && e.value && e.value !== e.defaultValue)
          // What an idle timer listens to — a person moving the mouse and pressing a key.
          const x = 40 + Math.floor(Math.random() * 200), y = 40 + Math.floor(Math.random() * 200)
          for (const t of ['mousemove', 'mousedown', 'mouseup']) document.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: y }))
          document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }))
          document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }))
          window.dispatchEvent(new Event('scroll'))
          // Its own page, asked for again in the background: the site's sign-in stays fresh.
          try { await fetch(location.href, { credentials: 'include', cache: 'no-store' }) } catch {}
          return typed
        }), new Promise(r => setTimeout(() => r(null), 15000))])
        // Now and then a quiet tab loads again (sites that keep the sign-in only while pages load).
        if (typed === false && Date.now() - (p.__adalReloaded || 0) > RELOAD_MS) {
          p.__adalReloaded = Date.now()
          await p.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
          if (!signedInAt(site, p.url())) seen[site.key].signedIn = false
        }
      } catch {}
    }
    const at = new Date().toISOString()
    for (const s of SITES) kept[s.key] = { ...seen[s.key], at }
    return kept
  } finally { busy = false }
}

export function startSessionKeeper(database) {
  db = database
  if (timer) return
  setTimeout(() => keepAlive().catch(() => {}), 60000)
  timer = setInterval(() => keepAlive().catch(e => console.warn('[sessions]', e.message)), EVERY_MS)
  timer.unref?.()
}

/** Each site, for the "Morning sign-in" list. */
export async function sessionsNow() {
  await keepAlive().catch(() => {})
  return SITES.map(s => ({ key: s.key, name: s.name, ...(kept[s.key] || { tabs: 0, signedIn: false }) }))
}

/** A window on that site, to sign in (its tab is then kept signed in all day). */
export async function openSite(key) {
  const site = SITES.find(s => s.key === key)
  if (!site) throw new Error('Unknown site')
  const page = await openForPerson()
  await page.goto(site.start, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.bringToFront().catch(() => {})
  return { ok: true }
}
