/**
 * robotCheck.js — "I'm not a robot" is a person's tick, never Adal Keep's
 * (asked on 2026-11-19; Adal Keep never solves or gets round it).
 *
 * Adal Keep fills the name and password, shows the tab to the person (the
 * live view), waits, and as soon as the box is ticked (its token is in the
 * page, or the checkbox says checked) presses the sign-in button itself.
 *
 *   robotCheck(page)          → { present, ticked }
 *   waitForTick(page, opts)   → 'submitted' | 'left' | 'timeout'
 *   labelTab(page, label)     → the tab's title starts with "[label] "
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Runs in the page: a robot check on it, and its answer (the token).
const inPage = () => {
  const present = !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha"], textarea[name="g-recaptcha-response"], .h-captcha, iframe[src*="hcaptcha"], .cf-turnstile, iframe[src*="turnstile"]')
  const token = [...document.querySelectorAll('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]')]
    .some(t => (t.value || '').length > 20)
  return { present, token }
}

/** Is there an "I'm not a robot" on the page, and is it ticked? */
export async function robotCheck(page) {
  const top = await page.evaluate(inPage).catch(() => null)
  if (!top) return { present: false, ticked: false }
  let box = false
  // The checkbox itself lives in Google's frame (another site): its aria-checked.
  for (const f of (typeof page.frames === 'function' ? page.frames() : [])) {
    let url = ''
    try { url = f.url() } catch { continue }
    if (!/\/recaptcha\/(api2|enterprise)\/anchor/.test(url)) continue
    box = await f.evaluate(() => document.querySelector('#recaptcha-anchor')?.getAttribute('aria-checked') === 'true').catch(() => false)
    if (box) break
  }
  return { present: top.present || box, ticked: top.token || box, token: top.token }
}

/** A sign-in page's own error, in words (Keycloak's line under the form), or ''. */
export const SIGN_IN_ERROR = () => {
  const el = document.querySelector('#input-error, .kc-feedback-text, #kc-error-message, .alert-error, .alert-danger, .pf-c-alert__title, p.err')
  const t = (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim()
  return t.slice(0, 200)
}
/** What a sign-in error means: 'expired' (start again), 'tick' (the tick was refused), 'account' (name or password), or ''. */
export function signInErrorKind(text) {
  const t = String(text || '')
  if (/timed? ?out|start from the beginning|session (has )?expired|expired|انتهت/i.test(t)) return 'expired'
  if (/invalid ?re-?captcha|recaptcha|robot/i.test(t)) return 'tick'
  if (/invalid (username|user|email)|password|credentials|كلمة المرور/i.test(t)) return 'account'
  return t ? 'other' : ''
}

/**
 * Waits for the person's tick, then presses the button. opts:
 *   onForm()   → true while the sign-in form is still up
 *   submit()   → presses the sign-in button
 *   refill()   → fills again what the site cleared (optional)
 *   restart()  → the sign-in loaded fresh and filled again (optional): after "Your login attempt timed out" or a
 *                refused tick, and when a person opens a form that has waited over freshMs (wahid.sa's sign-in
 *                expires in about 2–3 minutes: a tick on it was lost, 2026-11-24 live)
 *   again(why) → the person is told once to tick again (optional)
 *   isCancelled(), timeoutMs, freshMs (60 s), log(msg)
 * Returns 'submitted' (ticked, pressed, the form went away), 'left' (the form went away by itself: the person
 * pressed it) or 'timeout'. A refused name or password throws (nothing more is tried).
 */
export async function waitForTick(page, { onForm, submit, refill = null, restart = null, again = null, isCancelled = null, timeoutMs = 10 * 60000, freshMs = 60000, log = () => {}, pollMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  let pressed = false, formSince = Date.now(), lastLook = page.__adalLookedAt || 0, errAt = 0
  const readError = () => page.evaluate(SIGN_IN_ERROR).catch(() => '')
  const startAgain = async (why, tell) => {
    if (!restart) return false
    log(why)
    await restart().catch(e => log(`the sign-in could not be loaded again: ${e.message}`))
    formSince = Date.now(); pressed = false
    if (tell) await again?.(why)
    return true
  }
  while (Date.now() < deadline) {
    if (isCancelled?.()) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
    // Its tab or its browser is gone (closed, crashed): nothing to wait for (the run goes back in line).
    let gone = false
    try { gone = page.isClosed?.() || page.browser?.()?.connected === false } catch { gone = true }
    if (gone) { log('the tab is gone (its browser closed) — not waiting for the tick'); return 'timeout' }
    if (!(await onForm().catch(() => true))) return pressed ? 'submitted' : 'left'
    // A person opens the tab (after nobody looked for 15 s) and the form has waited long: fresh first, so the
    // tick goes onto a sign-in that is still alive. Never right after a click of theirs.
    // (Adal Robots' own window: the person's mouse coming over the page is the look.)
    if (process.env.ADAL_ROBOT_PROCESS === '1' && process.env.ADAL_ROBOTS_WINDOW === '1') {
      const moved = await page.evaluate(() => { if (!window.__adalW) { window.__adalW = 1; addEventListener('mousemove', (e) => { if (e.isTrusted) window.__adalMovedAt = Date.now() }, true) } return window.__adalMovedAt || 0 }).catch(() => 0)
      if (moved > (page.__adalLookedAt || 0)) page.__adalLookedAt = moved
    }
    const look = page.__adalLookedAt || 0
    if (look !== lastLook) {
      const opened = look - lastLook > 15000
      lastLook = look
      if (opened && Date.now() - formSince > freshMs && !(Date.now() - (page.__adalInputAt || 0) < 30000) && !(await robotCheck(page)).ticked) {
        await startAgain(`the sign-in waited ${Math.round((Date.now() - formSince) / 1000)} s — loaded fresh for the tick (Musaned's sign-in expires)`, false)
        continue
      }
    }
    // The page says it timed out by itself (every 5 s): started again at once.
    if (Date.now() - errAt > 5000) {
      errAt = Date.now()
      const err = await readError()
      if (signInErrorKind(err) === 'expired' && await startAgain(`Musaned's sign-in timed out ("${err}") — started again: name and password filled, tick once more`, true)) continue
    }
    const rc = await robotCheck(page)
    if (rc.ticked) {
      // The box says ticked a moment before its token is in the page.
      for (let i = 0; i < 10 && !rc.token; i++) { await sleep(200); rc.token = (await robotCheck(page)).token }
      log('✓ "I\'m not a robot" ticked — pressing Sign in')
      if (refill) await refill().catch(() => {})
      await submit().catch(() => {})
      pressed = true
      // The page goes on to the next step (the code); a wrong or expired tick
      // leaves the form up again: what the page says is read and acted on.
      for (const end = Date.now() + 20000; Date.now() < end;) {
        await sleep(400)
        if (!(await onForm().catch(() => true))) return 'submitted'
        if (!(await robotCheck(page)).ticked) break
      }
      if (await onForm().catch(() => true)) {
        const err = await readError()
        const kind = signInErrorKind(err)
        if (kind === 'account') throw Object.assign(new Error(`Musaned refused the name or password ("${err}"): check this account in Settings → Musaned. Nothing more was tried.`), { signInRefused: true })
        if (kind === 'expired' && await startAgain(`Musaned's sign-in timed out ("${err}") — started again: name and password filled, tick once more`, true)) continue
        if (kind === 'tick' && await startAgain(`Musaned did not take the tick ("${err}") — the sign-in loaded fresh: tick once more`, true)) continue
        log(err ? `still on the sign-in form after Sign in — Musaned says: "${err}" — waiting for a new tick` : 'still on the sign-in form after Sign in — waiting for a new tick')
      }
      continue
    }
    await sleep(pollMs)
  }
  return 'timeout'
}

/**
 * Which account a tab is: its title starts with "[name] " (also after its
 * pages change), so two accounts' tabs on one site are told apart.
 */
export async function labelTab(page, label) {
  label = String(label || '').trim()
  if (!page || !label || page.__adalLabel === label) return
  page.__adalLabel = label
  const put = (l) => {
    window.__adalLabel = l
    if (window !== window.top) return
    // Compared as the browser gives the title back (spaces collapsed, trimmed): on a page with no title,
    // "[nuzla] " came back as "[nuzla]", was set again, woke the observer, … for ever — the tab's page froze
    // at 100 % of a core and every robot call to it timed out (2026-11-23, this PC).
    const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim()
    const mark = () => {
      const t = document.title || ''
      const want = norm(`[${window.__adalLabel}] ` + t.replace(/^\[[^\]]*\]\s*/, ''))
      if (norm(t) !== want) document.title = want
    }
    const go = () => {
      mark()
      const head = document.head || document.documentElement
      if (head && !window.__adalLabelObs) { window.__adalLabelObs = new MutationObserver(mark); window.__adalLabelObs.observe(head, { subtree: true, childList: true, characterData: true }) }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go()
  }
  try {
    if (page.__adalLabelScript) await page.removeScriptToEvaluateOnNewDocument?.(page.__adalLabelScript).catch(() => {})
    const s = await page.evaluateOnNewDocument?.(put, label)
    page.__adalLabelScript = s?.identifier
    await page.evaluate(put, label)
  } catch {}
}

/** The name of a portal account (for its tab's label). */
export async function accountLabel(db, peer, accountId) {
  const table = { musaned: 'musaned_accounts', lmis: 'lmis_accounts', mofa: 'visa_accounts', insurance: 'insurance_accounts', tasheer: 'tasheer_accounts' }[peer]
  if (!db || !table) return ''
  const q = db(table)
  const row = await (accountId ? q.where('id', Number(accountId)) : q.orderBy('is_default', 'desc').orderBy('id')).first().catch(() => null)
  return String(row?.name || row?.username || row?.login_value || '').trim()
}
