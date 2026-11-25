/**
 * instantScreen.js — which Musaned screen this is, read off the page itself first.
 *
 * 2026-11-25, Main: JEV was asked first and answered after 19-25 s, so a 30-s wait for the dashboard held one or two
 * looks; the run paused at the agency list although the dashboard was there.
 *  - A screen with an unmistakable mark (Musaned's menu, "please select the establishment", the password box, the
 *    code box) is told at once. In doubt it is not told: a sign-in error, a mixed page, Arabic.
 *  - JEV only for the rest: once for a page that stays the same, 4 s at most, the page looked at meanwhile; a late
 *    answer counts only while the page is still the same. "Dashboard" is never believed over a password or code box,
 *    the sign-in site or the agency list.
 *  - waitScreen: ends when the page changes; says what it waits for; longer on a slow line; the agency's card clicked
 *    once more when it is still there.
 * ADAL_INSTANT_SCREEN=0: as before. Any error: as before.
 */
export const instantOn = () => process.env.ADAL_INSTANT_SCREEN !== '0'
export const JEV_MS = 4000, LOOK_EVERY = 300
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const within = (p, ms, v = null) => { let t; return Promise.race([Promise.resolve(p).catch(() => v), new Promise(r => { t = setTimeout(() => r(v), ms) })]).finally(() => clearTimeout(t)) }

/** Runs in the page: only what can be seen. */
export function LOOK_IN_PAGE() {
  const seen = (e) => { if (!e || !e.getClientRects().length) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0 }
  const any = (q) => [...document.querySelectorAll(q)].some(seen)
  const body = document.body ? document.body.innerText || '' : ''
  const NAV = /^(organizations|hr pool|employment requests|worker transfer|latest requests|latest candidates|dashboard)$/
  const nav = new Set()
  for (const e of document.querySelectorAll('a, button, span, li, div, h1, h2, h3, h4, h5, [role="menuitem"]')) {
    if (e.childElementCount > 2) continue
    const t = (e.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
    if (t.length <= 20 && NAV.test(t) && seen(e)) nav.add(t)
  }
  return {
    host: location.hostname, path: location.pathname, hash: location.hash.slice(0, 40),
    password: any('input[type="password"]'), user: any('#username, input[name="username"], input[autocomplete="username"], input[type="email"]'),
    code: any('input[name="otp"], input[autocomplete="one-time-code"], input[name="totp"]'),
    captcha: any('.g-recaptcha, iframe[src*="recaptcha"], .h-captcha, iframe[src*="hcaptcha"]'),
    picker: /please\s+select\s+the\s+establishment/i.test(body),
    goTo: /go\s+to\s+dashboard/i.test(body), denied: /access\s+denied/i.test(body) || /\/403\b/.test(location.pathname),
    error: /invalid\s+(username|password|code|otp|re-?captcha)|incorrect|account\s+is\s+disabled|timed?\s*out|expired/i.test(body),
    nav: nav.size,
  }
}
export const lookNow = (page, ms = 2500) => within(page.evaluate(LOOK_IN_PAGE), ms)

const MUSANED = /(^|\.)musaned\.com\.sa$/i, SIGN_IN = /(^|\.)wahid\.sa$/i
/** The screen when it is beyond doubt, else ''. Pure. */
export function sure(l) {
  if (!l) return ''
  if (SIGN_IN.test(l.host)) {
    if (l.error) return ''
    if (l.code && !l.password) return 'otp'
    if (l.password && l.user && !l.code) return l.captcha ? 'captcha' : 'login-form'
    return ''
  }
  if (!MUSANED.test(l.host) || l.password || l.code || l.captcha || l.denied || /state=|code=|session_state=/.test(l.hash)) return ''
  if (l.picker) return l.nav >= 2 ? '' : 'agency-picker'
  if (l.nav >= 2 && !l.goTo && !/^\/(login|auth)\b/.test(l.path)) return 'dashboard'
  return ''
}

const asked = new WeakMap()     // page → { key, at, answer, done }
const said = new WeakMap()
const same = new WeakMap()      // page → { key, since }: how long it has looked like this
const keyOf = (s) => [String(s.url).split('#')[0], s.bodySnippet, s.hasLoginError, s.hasCaptcha, s.hasOtp, s.hasPassword, s.hasAgencyPicker, s.hasDashboardNav].join('|')

/** A "dashboard" that cannot be one. */
function believable(r, s, l) {
  if (!r?.screen || r.screen === 'unknown') return false
  if (r.screen !== 'dashboard') return true
  return !(s.onKeycloak || s.hasPassword || s.hasOtp || s.hasAgencyPicker || l?.denied || (s.hasGoToDashboard && !(l?.nav > 0)))
}

/** → { screen, source }. snapshot/review/fallback: the workflow's own. */
export async function screenOf(page, { snapshot, review, fallback, log = () => {}, jevMs = JEV_MS }) {
  const tell = (r) => { const t = `${r.screen} (${r.source})`; if (said.get(page) !== t) { said.set(page, t); log(`screen -> ${t}`) } return r }
  const look = await lookNow(page)
  const now = sure(look)
  if (now) return tell({ screen: now, source: 'page' })
  const state = await snapshot(page)
  if (!state) return { screen: 'unknown', source: 'snapshot-failed' }
  const key = keyOf(state)
  let a = asked.get(page)
  if (!a || (a.key !== key && (a.done || Date.now() - a.at > 30000))) {
    a = { key, at: Date.now(), answer: null, done: false }
    asked.set(page, a)
    const mine = a
    Promise.resolve().then(() => review(state)).then(r => { mine.answer = r }, (e) => { log(`Jev: ${e.message}`) }).finally(() => { mine.done = true })
  }
  // Its answer, 4 s at most for a page that looks like this; the page is looked at meanwhile.
  if (same.get(page)?.key !== key) same.set(page, { key, since: Date.now() })
  const { since } = same.get(page)
  while (!(a.key === key && a.done) && Date.now() - since < jevMs) {
    await sleep(Math.min(LOOK_EVERY, Math.max(10, jevMs - (Date.now() - since))))
    const s = sure(await lookNow(page))
    if (s) return tell({ screen: s, source: 'page' })
  }
  if (a.key === key && a.done && believable(a.answer, state, look)) return tell(a.answer)
  const fb = fallback(state)
  if (fb && believable(fb, state, look)) return tell(fb)
  if (fb?.screen === 'dashboard' && state.hasGoToDashboard && !state.onKeycloak && !state.hasPassword && !state.hasAgencyPicker) return tell({ screen: 'landing', source: 'fallback' })
  return { screen: 'unknown', source: a.done ? 'none' : 'jev is slow' }
}

/** Its tab or its browser is gone (a PC switched off): nothing to wait for (lostBrowser.js knows these words). */
export function stillThere(page) {
  let gone = false
  try { gone = page.isClosed?.() === true || page.browser?.()?.connected === false } catch { gone = true }
  if (gone) throw new Error('Target closed: the robot\'s tab or its browser is gone')
}

const WORDS = { 'agency-picker': 'the list of agencies is still shown', unknown: 'its page is still loading', landing: 'its front page is shown' }
/**
 * Until a screen that says how it stands. again(): clicks the card once more (only when it is still there, 10 s after
 * the first click). slowMs: how long while the page is loading or the list is still shown (a slow line).
 */
export async function waitScreen(page, ctx, timeoutMs, { classify, log = () => {}, again = null, slowMs = 0, againMs = 10000, everyMs = LOOK_EVERY } = {}) {
  const t0 = Date.now()
  let last = 'unknown', clicked = false, spoke = t0
  for (;;) {
    if (ctx?.isCancelled?.()) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
    stillThere(page)
    const { screen } = await classify(page, ctx)
    if (screen !== last) { log(`waiting — screen: ${screen}`); last = screen }
    if (['dashboard', 'captcha', 'otp', 'login-error', 'login-form'].includes(screen)) return screen
    const ms = Date.now() - t0
    if (again && !clicked && screen === 'agency-picker' && ms >= againMs) {
      clicked = true
      log(`the list of agencies is still shown after ${Math.round(ms / 1000)} s — ${await again().catch(() => false) ? 'its card clicked once more' : 'its card is not there now'}`)
    }
    if (ms >= Math.max(timeoutMs, slowMs)) return last
    if (Date.now() - spoke >= 15000) { spoke = Date.now(); log(`waiting for Musaned's dashboard (${Math.round(ms / 1000)} s of ${Math.round(Math.max(timeoutMs, slowMs) / 1000)}): ${WORDS[screen] || screen}`) }
    await sleep(everyMs)
  }
}
