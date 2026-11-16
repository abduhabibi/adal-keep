/**
 * Sign in once in the morning, good for the whole day (asked on 2026-11-10).
 *
 * Every 4 minutes each site's signed-in tab gets a sign of life, out of sight:
 * a mouse move and a key (what a site's "you were idle" timer listens to) and
 * its own page asked for again in the background — never brought to the
 * front, never a tab a robot is working in, never a page with something typed
 * in it. Every 20 minutes a quiet tab is reloaded too (a site that keeps its
 * sign-in only while its pages load) — never LMIS: there two of its own menu
 * links are clicked in turn instead (asked on 2026-11-15). The robots then find the site signed in
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

// Never a link that does something: out, delete, pay, a new form.
const RISKY = /log ?out|sign ?out|ውጣ|delete|remove|cancel|pay|submit|create|add|new\b|apply|print|download|ሰርዝ/i

/**
 * Which two LMIS menu links to click: one away from this page, then the one
 * back to it (else a second menu page). links: [{ path, text, menu }].
 */
export function pickLmisLinks(links, here) {
  const ok = links.filter(l => l.path && !/\/(auth|login)/i.test(l.path) && !RISKY.test(l.text || '') && !RISKY.test(l.path.replace(/^\/new-agency/, '')))
  const away = ok.filter(l => l.path !== here).sort((a, b) => (b.menu ? 1 : 0) - (a.menu ? 1 : 0))
  if (!away.length) return []
  const back = ok.find(l => l.path === here) || away.find(l => l.path !== away[0].path)
  return back ? [away[0], back] : [away[0]]
}

/**
 * LMIS's sign of life: two of its own menu links clicked in turn, inside the
 * app (its router, no page load), out of sight. False when no link was found
 * or the tab left the app (the mouse/key nudge was still given).
 */
async function clickBackAndForth(p) {
  const inTime = (x, ms = 8000) => Promise.race([x, new Promise(r => setTimeout(() => r(null), ms))])
  const links = await inTime(p.evaluate(() => {
    const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    return [...document.querySelectorAll('a[href]')].filter(a => seen(a) && a.host === location.host && a.target !== '_blank' && !/^javascript:/i.test(a.getAttribute('href') || ''))
      .map(a => ({ path: a.pathname, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 60), menu: !!a.closest('nav, aside, [class*="sidebar" i], [class*="menu" i], [role="menu"]') }))
  }).catch(() => null))
  let here = ''
  try { here = new URL(p.url()).pathname } catch { return false }
  const pick = pickLmisLinks(links || [], here)
  if (!pick.length) return false
  // No run takes the tab while it is clicked through (tabManager.findFreeTab skips a borrowed tab).
  p.__adalBorrowed = true
  try {
    for (const l of pick) {
      const clicked = await inTime(p.evaluate((path) => {
        const a = [...document.querySelectorAll('a[href]')].find(x => x.pathname === path && x.host === location.host && x.getBoundingClientRect().width > 0)
        a?.click()
        return !!a
      }, l.path).catch(() => false))
      if (!clicked) return false
      await new Promise(r => setTimeout(r, 4000))
      try { if (/\/(auth|login)/i.test(new URL(p.url()).pathname)) return false } catch { return false }
    }
    return true
  } finally { p.__adalBorrowed = false }
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
        // LMIS: back and forth between two of its own menu pages, never a reload
        // (a reload of its app can lose the sign-in, and a new one costs an SMS code) (asked on 2026-11-15).
        if (site.key === 'lmis') {
          if (typed === false && !(await clickBackAndForth(p)) && !signedInAt(site, p.url())) seen[site.key].signedIn = false
          continue
        }
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
  // Insurance is not in the morning sign-in: its robot signs in by itself (FetaP's reCAPTCHA needs nobody).
  return SITES.filter(s => s.key !== 'insurance').map(s => ({ key: s.key, name: s.name, ...(kept[s.key] || { tabs: 0, signedIn: false }), ...(s.key === 'tasheer' ? { holder, shared: true } : {}) }))
}

/** A window on that site, to sign in (its tab is then kept signed in all day). */
export async function openSite(key, database = null, { accountId = null } = {}) {
  if (database) db = database
  // The account the person chose (Morning sign-in asks when there are several), else the default one.
  const accountOf = (table, cols) => {
    const q = db(table)
    return (accountId ? q.where('id', Number(accountId)) : q.orderBy('is_default', 'desc').orderBy('id')).first(...(cols ? [cols] : [])).catch(() => null)
  }
  const site = SITES.find(s => s.key === key)
  if (!site) throw new Error('Unknown site')
  const page = await openForPerson()
  await page.goto(site.start, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.bringToFront().catch(() => {})
  // Musaned: Adal Keep signs in by itself (the saved account and its authenticator code), then the tab goes out of sight.
  if (key === 'musaned' && db) {
    const acct = await accountOf('musaned_accounts', 'id')
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
    const acct = await accountOf('visa_accounts')
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
  // Insurance (FetaP): its own sign-in with the chosen account (already signed in: nothing to do).
  if (key === 'insurance' && db) {
    const acct = await accountOf('insurance_accounts')
    if (acct?.username && acct?.password) {
      const { insuranceSignIn } = await import('./insuranceCertificate.js')
      const ctx = { insurance_username: acct.username, insurance_password: acct.password, insurance_name: acct.name, profileName: 'Morning sign-in', onLog: (l, m) => console.log('[sessions] Insurance:', m), notify: async () => {} }
      insuranceSignIn(page, ctx).then(() => keepAlive().catch(() => {})).catch(e => console.warn('[sessions] Insurance sign-in:', e.message))
      return { ok: true, auto: true }
    }
  }
  // LMIS: its own sign-in (the saved account, Sign In pressed) — the person types the SMS code in the window.
  if (key === 'lmis' && db) {
    const acct = await accountOf('lmis_accounts')
    if (acct && (acct.login_value || acct.phone) && acct.password) {
      const { stepLogin } = await import('./lmisWorkflow.js')
      const ctx = {
        login_value: acct.login_value || acct.phone, login_password: acct.password, account_name: acct.name, account_id: acct.id,
        profileName: 'Morning sign-in', onLog: (level, msg) => console.log('[sessions] LMIS:', msg), notify: async () => {},
      }
      // Straight to its sign-in page (its home page is public and only looks signed in).
      await page.goto('https://lmis.gov.et/auth', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {})
      // Signed in: the window goes out of sight, so a robot's task can carry on in this very tab (asked on 2026-11-15).
      stepLogin(page, ctx).then(async () => {
        if (!/\/(auth|login)/i.test(page.url())) { const { sendAway } = await import('./browser.js'); await sendAway(page).catch(() => {}) }
        keepAlive().catch(() => {})
      }).catch(e => console.warn('[sessions] LMIS sign-in:', e.message))
      return { ok: true, auto: true }
    }
  }
  return { ok: true }
}
