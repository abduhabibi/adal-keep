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
  // One sign-in for the agency (services/tasheerSession.js): signed in = its inner pages (/auth/…).
  { key: 'tasheer', name: 'Tasheer', host: /(^|\.)tasheer\.com$/, start: 'https://agents.tasheer.com/AgentTasheer/', out: /^(?!.*\/auth\/)/i },
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
      // Musaned's front page looks the same signed in or not: its own menu says so.
      let inNow = signedInAt(site, p.url())
      if (inNow && site.key === 'musaned') {
        const st = await Promise.race([import('./musanedWorkflow.js').then(w => w.snapshotState(p)).catch(() => null), new Promise(r => setTimeout(() => r(null), 8000))])
        inNow = !!(st && (st.hasDashboardNav || st.hasHrPoolPage) && !st.hasPassword)
      }
      // LMIS's public home (a Login button, nothing to log out of) is not signed in.
      if (inNow && site.key === 'lmis') {
        const pub = await Promise.race([p.evaluate(() => { const pub = (() => { const t = [...document.querySelectorAll('a, button')].map(e => (e.innerText || '').trim()); return t.some(x => /^(log ?in|sign ?in)$/i.test(x)) && !t.some(x => /log ?out|sign ?out|ውጣ/i.test(x)) })(); return pub }).catch(() => false), new Promise(r => setTimeout(() => r(false), 8000))])
        if (pub) inNow = false
      }
      if (inNow) seen[site.key].signedIn = true
      // Musaned's "Access Denied" (/403, a page opened before the agency was
      // chosen): back to its front page and the agency's own card again.
      if (site.key === 'musaned' && /\/403\b/.test(p.url()) && !p.__adalBorrowed && !running.has(Number(p.__adalRunId))) {
        try {
          await p.goto('https://tawtheeq.musaned.com.sa/', { waitUntil: 'domcontentloaded', timeout: 60000 })
          await new Promise(r => setTimeout(r, 3000))
          const acct = await db('musaned_accounts').orderBy('is_default', 'desc').orderBy('id').first().catch(() => null)
          const w = await import('./musanedWorkflow.js')
          const st = await w.snapshotState(p).catch(() => null)
          const ctx = { db, account_id: acct?.id, musaned_username: acct?.username, musaned_name: acct?.name }
          if (st?.hasAgencyPicker) { await w.stepClickAgencyCard(p, ctx).catch(() => {}); await w.stepClickGoToDashboard(p, ctx).catch(() => {}) }
          else if (st?.hasGoToDashboard) await w.stepClickGoToDashboard(p, ctx).catch(() => {})
          console.log('[sessions] Musaned was on "Access Denied" — back to the agency dashboard')
        } catch {}
        continue
      }
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
  const { holderOf } = await import('./tasheerSession.js')
  const holder = db ? await holderOf(db).catch(() => null) : null
  return SITES.map(s => ({ key: s.key, name: s.name, ...(kept[s.key] || { tabs: 0, signedIn: false }), ...(s.key === 'tasheer' ? { holder, shared: true } : {}) }))
}

/** A window on that site, to sign in (its tab is then kept signed in all day). */
export async function openSite(key, database = null) {
  if (database) db = database
  const site = SITES.find(s => s.key === key)
  if (!site) throw new Error('Unknown site')
  const page = await openForPerson()
  await page.goto(site.start, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.bringToFront().catch(() => {})
  // Musaned: Adal Keep signs in by itself (the saved account and its authenticator code), then the tab goes out of sight.
  if (key === 'musaned' && db) {
    const acct = await db('musaned_accounts').orderBy('is_default', 'desc').orderBy('id').first('id').catch(() => null)
    if (acct) {
      const { musanedSignIn } = await import('./transition.js')
      musanedSignIn(db, page, acct.id, (step) => console.log('[sessions] Musaned:', step), () => {})
        .then(async () => {
          // Out of sight only once it is really signed in (a picture code is a person's to type).
          const st = await import('./musanedWorkflow.js').then(w => w.snapshotState(page)).catch(() => null)
          if (st?.hasDashboardNav || st?.hasHrPoolPage) { const { sendAway } = await import('./browser.js'); await sendAway(page).catch(() => {}) }
          keepAlive().catch(() => {})
        })
        .catch(e => console.warn('[sessions] Musaned sign-in:', e.message))
      return { ok: true, auto: true }
    }
  }
  // Enjaz (visa): its company sign-in, in English, the saved account filled — the person types the picture's numbers.
  if (key === 'mofa' && db) {
    const acct = await db('visa_accounts').orderBy('is_default', 'desc').orderBy('id').first().catch(() => null)
    if (acct?.username && acct?.password) {
      const v = await import('./mofaVisa.js')
      const { toEnglish } = await import('./tabManager.js')
      ;(async () => {
        await page.goto(v.VISA_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
        await new Promise(r => setTimeout(r, 2500))
        await toEnglish(page, {}).catch(() => {})
        for (let i = 0; i < 20; i++) {
          if (await v.fillVisaLogin(page, { visa_username: acct.username, visa_password: acct.password }).catch(() => 'no-form') === 'filled') break
          await new Promise(r => setTimeout(r, 1500))
        }
        console.log('[sessions] Enjaz: the sign-in is filled — the person types the numbers and presses Login')
      })().catch(e => console.warn('[sessions] Enjaz sign-in:', e.message))
      return { ok: true, auto: true }
    }
  }
  // LMIS: its own sign-in (the saved account, Sign In pressed) — the person types the SMS code in the window.
  if (key === 'lmis' && db) {
    const acct = await db('lmis_accounts').orderBy('is_default', 'desc').orderBy('id').first().catch(() => null)
    if (acct && (acct.login_value || acct.phone) && acct.password) {
      const { stepLogin } = await import('./lmisWorkflow.js')
      const ctx = {
        login_value: acct.login_value || acct.phone, login_password: acct.password, account_name: acct.name, account_id: acct.id,
        profileName: 'Morning sign-in', onLog: (level, msg) => console.log('[sessions] LMIS:', msg), notify: async () => {},
      }
      // Straight to its sign-in page (its home page is public and only looks signed in).
      await page.goto('https://lmis.gov.et/auth', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
      stepLogin(page, ctx).then(() => keepAlive().catch(() => {})).catch(e => console.warn('[sessions] LMIS sign-in:', e.message))
      return { ok: true, auto: true }
    }
  }
  return { ok: true }
}
