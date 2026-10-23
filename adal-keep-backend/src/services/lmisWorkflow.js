/**
 * lmisWorkflow.js — Police Certificate workflow for LMIS.
 *
 * v5 — handles the loading spinner, the "SYSTEM ALERT" modal, and waits
 *      up to 60s for the police-certificate page to become ready.
 *
 * v6 — dispatcher: routes between police_certificate and contract_import_labour
 *      workflows. Both share the LMIS login step; the rest differ.
 *
 * v7 — adds musaned_login as a third workflow.
 *
 * v8 — police certificate flow: search → find worker → Add → upload
 *      slip/passport/photo → notify human to click "Submit Request".
 *
 * v9 — stepSearchAndFindWorker rewritten.
 *
 * v10 — worker-card detection switched to "exact Add button exists".
 *
 * v11 — document uploads rewritten (per-section handlers, date normalizer).
 *
 * v12 — Photo upload waits for inner "Upload Photo" modal and clicks its
 *       own Submit.
 *
 * v13 — uploadPaymentSlip targets hidden file input directly.
 *
 * v14 — Slip upload rewritten for Payment Instructions → Upload form →
 *       file → Add. Adds convertToPdf.
 *
 * v15 — Transaction falls back to labor_id when order_id missing.
 *       closeAllModals escalated.
 *
 * v16 — setFieldInModal rewritten (climb from matched element itself).
 *
 * v17 — uploadPassport rewritten: multi-attempt file attach (scoped →
 *       dropzone-click → newest), waits for file to render before Submit,
 *       throws if attach fails. Adds clickDropzoneInModal and
 *       waitForFileAttached helpers. Enforces 2MB size limit.
 *       uploadFileInModal ancestor check now scans up to 5000 chars of
 *       textContent instead of 400.
 *
 * v18 — exports log, closePopups, dumpPageState, waitForAnyText, clickByText
 *       so lmisContractWorkflow.js can reuse them. Adds an `lmis` dispatcher
 *       branch that lazily loads runLmisWorkflow (falling back to
 *       runContractWorkflow) from ./lmisContractWorkflow.js. Removes the
 *       dead contract_import_labour branch and its lazy loader.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { runMusanedWorkflow } from './musanedWorkflow.js'
import { expectFile } from './tabManager.js'
import { lookAtPage, lookUnavailableReason } from './jevClassifier.js'


const LMIS_BASE = 'https://lmis.gov.et'
const POLICE_URL = 'https://lmis.gov.et/new-agency/police-certificate'
const DEFAULT_TIMEOUT = 60000
const PAGE_READY_TIMEOUT = 240000
const STEP_GOTO_TIMEOUT = 240000
// LMIS sign-in is slow (52-70s seen). Overridable from .env.
const LOGIN_WAIT_MS = Number(process.env.LMIS_LOGIN_WAIT_MS || 180000)
const LOGIN_STATE_WAIT_MS = Number(process.env.LMIS_LOGIN_STATE_WAIT_MS || 90000)
const STEP_LOG_PREFIX = '[lmis]'
const DEBUG_DIR = path.join(os.homedir(), '.adal-lmis-debug')

// LMIS file-size limits as shown in each modal
const SLIP_MAX_MB = 5
const PASSPORT_MAX_MB = 2
const PHOTO_MAX_MB = 2

if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true })

// ============================================================================
// HELPERS
// ============================================================================

export function log(ctx, msg, level = 'info') {
  // Cooperative cancellation, as in musanedWorkflow.js: the cancel endpoint
  // flips this run's flag and the next step log unwinds the workflow.
  if (ctx && typeof ctx.isCancelled === 'function' && ctx.isCancelled()) {
    const e = new Error('Cancelled by user')
    e.cancelled = true
    throw e
  }
  const line = `${STEP_LOG_PREFIX} run=${ctx.runId} profile=${ctx.profileId} :: ${msg}`
  console.log(line)
  if (ctx.onLog) ctx.onLog(level, msg)
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

export async function waitForAnyText(page, needles, timeoutMs = DEFAULT_TIMEOUT) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const body = await page.evaluate(() => document.body?.innerText || '')
      if (needles.some(n => body.includes(n))) return true
    } catch {}
    await sleep(400)
  }
  throw new Error(`Timeout waiting for text: ${needles.join(' | ')}`)
}

/**
 * LMIS opens a big "SYSTEM ALERT — Attention" box (the Version 3 notice) over
 * the police page. Close it with its ✕ (a real mouse click), Escape as a
 * fallback. Returns true when an alert was found.
 */
export async function closeSystemAlert(page, ctx) {
  const target = await page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll('body *'))
      .find(e => e.children.length === 0 && /^\s*SYSTEM ALERT\s*$/i.test(e.textContent || ''))
    if (!hit) return null
    let m = hit
    for (let i = 0; i < 8 && m; i++) {
      const r = m.getBoundingClientRect()
      if (r.width > 400 && r.height > 300) break
      m = m.parentElement
    }
    if (!m) return null
    const r = m.getBoundingClientRect()
    const cs = getComputedStyle(m)
    if (r.width < 50 || cs.display === 'none' || cs.visibility === 'hidden') return null
    // the close control sits in the top-right corner of the box
    const c = Array.from(m.querySelectorAll('button, [role="button"], svg, a, span, i'))
      .find(x => {
        const b = x.getBoundingClientRect()
        return b.width > 4 && b.width < 80 && b.height > 4 && b.height < 80 &&
          b.left > r.left + r.width * 0.75 && b.top < r.top + r.height * 0.2
      })
    const b = c ? c.getBoundingClientRect() : null
    return { x: b ? b.left + b.width / 2 : r.right - 48, y: b ? b.top + b.height / 2 : r.top + 48 }
  }).catch(() => null)
  if (!target) return false
  await page.mouse.click(target.x, target.y).catch(() => {})
  await sleep(700)
  const still = await page.evaluate(() => /SYSTEM ALERT/i.test(document.body?.innerText || '')).catch(() => false)
  if (still) { await page.keyboard.press('Escape').catch(() => {}); await sleep(500) }
  if (ctx) log(ctx, still ? 'closed the LMIS "Attention" alert (Escape)' : 'closed the LMIS "Attention" alert')
  return true
}

/**
 * Is the "No Bank Account Found" popup really ON SCREEN, on top of the page?
 * Its text is also in the page while it is hidden, and a text match stopped
 * runs that LMIS was in fact letting through.
 */
export async function bankPopupBlocking(page) {
  return await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('body *'))
      .filter(e => e.children.length <= 3 && /No Bank Account Found/i.test(e.textContent || ''))
    for (const el of els) {
      if (!el.getClientRects().length) continue // display:none on it or an ancestor
      const r = el.getBoundingClientRect()
      if (r.width < 5 || r.height < 5) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      const x = Math.min(innerWidth - 1, Math.max(0, r.left + Math.min(r.width, 40) / 2))
      const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2))
      const top = document.elementFromPoint(x, y)
      if (top && (el.contains(top) || top.contains(el))) return true
    }
    return false
  }).catch(() => false)
}

export async function closePopups(page, ctx = null) {
  await closeSystemAlert(page, ctx).catch(() => {})
  const n = await page.evaluate(() => {
    let count = 0
    const tried = new Set()

    const alertHeaders = Array.from(document.querySelectorAll('*')).filter(el => {
      const t = (el.textContent || '').slice(0, 20)
      return t.includes('SYSTEM ALERT') || t.includes('Attention')
    })
    for (const hdr of alertHeaders) {
      let modal = hdr
      for (let i = 0; i < 6 && modal; i++) {
        const r = modal.getBoundingClientRect()
        if (r.width > 200 && r.height > 200) break
        modal = modal.parentElement
      }
      if (!modal) continue
      const btns = Array.from(modal.querySelectorAll('button'))
      for (const b of btns) {
        const txt = (b.textContent || '').trim()
        const r = b.getBoundingClientRect()
        if (txt.length === 0 && r.width > 5 && r.height > 5 && r.top < 200) {
          if (tried.has(b)) continue
          tried.add(b)
          try { b.click(); count++ } catch {}
        }
      }
      for (const b of btns.slice(0, 3)) {
        if (tried.has(b)) continue
        tried.add(b)
        const r = b.getBoundingClientRect()
        if (r.top < 200 && r.width > 5 && r.height > 5) {
          try { b.click(); count++ } catch {}
        }
      }
    }

    const closeSelectors = [
      '[aria-label="Close"]', '[aria-label="close"]',
      '[aria-label="Dismiss"]', 'button[title="Close"]',
      '.modal-close', '[class*="close-btn"]', '[class*="closeBtn"]',
    ]
    for (const sel of closeSelectors) {
      document.querySelectorAll(sel).forEach(el => {
        if (tried.has(el)) return
        tried.add(el)
        const r = el.getBoundingClientRect()
        if (r.width > 5 && r.height > 5) { try { el.click(); count++ } catch {} }
      })
    }

    const closeWords = ['close', 'dismiss', 'got it', 'skip', '✕', '×', '✖']
    document.querySelectorAll('button, [role="button"]').forEach(el => {
      if (tried.has(el)) return
      const t = (el.textContent || '').trim().toLowerCase()
      if (closeWords.includes(t) && t.length <= 10) {
        tried.add(el)
        const r = el.getBoundingClientRect()
        if (r.width > 5 && r.height > 5) { try { el.click(); count++ } catch {} }
      }
    })

    return count
  })
  if (n > 0) {
    if (ctx) log(ctx, `closed ${n} popup(s)`)
    await settle(page, { maxMs: 1500 })
  }
  return n
}

/**
 * Continue as soon as the page is ready instead of sleeping a fixed time:
 * resolves once nothing in the page has changed for `quietMs` and no spinner
 * is showing — at most `maxMs`.
 */
export async function settle(page, { quietMs = 250, maxMs = 5000 } = {}) {
  const inPage = page.evaluate((quietMs, maxMs) => new Promise(resolve => {
    const t0 = performance.now()
    let last = t0
    const obs = new MutationObserver(() => { last = performance.now() })
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    const spinning = () => Array.from(document.querySelectorAll('[class*="spin" i],[class*="loading" i],[aria-busy="true"]'))
      .some(el => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== 'hidden' })
    const tick = () => {
      const now = performance.now()
      if (now - t0 > maxMs || (now - last >= quietMs && !spinning())) { obs.disconnect(); resolve() } else setTimeout(tick, 50)
    }
    setTimeout(tick, 50)
  }), quietMs, maxMs).catch(() => {})       // page navigated away: fine, carry on
  await Promise.race([inPage, sleep(maxMs + 1000)])
}

/** True once no window with this title is on screen (within `timeoutMs`). */
async function waitModalGone(page, title, timeoutMs) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const open = await page.evaluate((t) => Array.from(document.querySelectorAll('*')).some(el => {
      const r = el.getBoundingClientRect()
      return r.width >= 250 && r.height >= 150 && (el.textContent || '').slice(0, 400).includes(t)
    }), title).catch(() => true)
    if (!open) return true
    await sleep(250)
  }
  return false
}

export async function clickByText(page, label, opts = {}) {
  const { timeout = 20000, exact = false } = opts
  const deadline = Date.now() + timeout
  const lc = label.toLowerCase()

  while (Date.now() < deadline) {
    const result = await page.evaluate(({ lc, exact }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
      const matches = []
      let node
      while ((node = walker.nextNode())) {
        const txt = (node.textContent || '').trim()
        if (!txt) continue
        const match = exact ? txt.toLowerCase() === lc : txt.toLowerCase().includes(lc)
        if (!match) continue
        const parent = node.parentElement
        if (!parent) continue
        const r = parent.getBoundingClientRect()
        if (r.width < 5 || r.height < 5) continue
        matches.push({ el: parent, area: r.width * r.height })
      }
      if (matches.length === 0) return { ok: false }
      matches.sort((a, b) => a.area - b.area)
      const start = matches[0].el
      let cur = start
      let depth = 0
      while (cur && depth < 8) {
        const tag = cur.tagName
        const role = cur.getAttribute('role')
        const hasOnclick = typeof cur.onclick === 'function'
        const isCursorPointer = window.getComputedStyle(cur).cursor === 'pointer'
        const isLink = tag === 'A' && cur.href
        const isButton = tag === 'BUTTON'
        const isRoleButton = role === 'button' || role === 'link' || role === 'menuitem'
        if (isLink || isButton || isRoleButton || hasOnclick || isCursorPointer) {
          try {
            cur.scrollIntoView({ block: 'center', behavior: 'instant' })
            cur.click()
            return { ok: true, via: 'ancestor', tag: cur.tagName }
          } catch {}
        }
        cur = cur.parentElement
        depth++
      }
      try {
        start.scrollIntoView({ block: 'center', behavior: 'instant' })
        start.click()
        return { ok: true, via: 'self', tag: start.tagName }
      } catch (e) { return { ok: false, error: e.message } }
    }, { lc, exact })

    if (result.ok) return result
    await sleep(400)
  }
  return { ok: false, error: 'timeout' }
}

async function fillByLabel(page, label, value) {
  const lc = label.toLowerCase()
  const inputs = await page.$$('input:not([type="hidden"]), textarea')
  for (const inp of inputs) {
    const meta = await page.evaluate(el => ({
      placeholder: (el.placeholder || '').toLowerCase(),
      aria: (el.getAttribute('aria-label') || '').toLowerCase(),
      name: (el.name || '').toLowerCase(),
      id: (el.id || '').toLowerCase(),
    }), inp)
    if (meta.placeholder.includes(lc) || meta.aria.includes(lc) || meta.name.includes(lc) || meta.id.includes(lc)) {
      await inp.click({ clickCount: 3 })
      await inp.type(String(value), { delay: 30 })
      return true
    }
  }
  const labelHandle = await page.evaluateHandle((lc) => {
    const labels = Array.from(document.querySelectorAll('label'))
    const found = labels.find(l => (l.textContent || '').toLowerCase().includes(lc))
    if (!found) return null
    const forId = found.getAttribute('for')
    if (forId) return document.getElementById(forId)
    return found.querySelector('input, textarea')
  }, lc)
  const el = labelHandle.asElement()
  if (el) {
    await el.click({ clickCount: 3 })
    await el.type(String(value), { delay: 30 })
    return true
  }
  return false
}

export async function dumpPageState(page, ctx, stepName) {
  try {
    const url = page.url()
    log(ctx, `FAIL at "${stepName}" — URL: ${url}`, 'error')
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 800))
    log(ctx, `body preview: ${bodyText.replace(/\n/g, ' | ').slice(0, 500)}`, 'error')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const shotPath = path.join(DEBUG_DIR, `fail-${ctx.profileId}-${stepName}-${stamp}.png`)
    try {
      await page.screenshot({ path: shotPath, fullPage: false })
      log(ctx, `screenshot: ${shotPath}`, 'error')
    } catch (e) { log(ctx, `screenshot failed: ${e.message}`, 'error') }
  } catch (e) {
    console.error('[lmis] dumpPageState failed:', e.message)
  }
}

// ============================================================================
// STEPS
// ============================================================================

export async function stepLogin(page, ctx) {
  // Log in first, always. Never trust the address bar: LMIS shows the police
  // page's address for a moment before it sends a signed-out tab to login.
  // Signed in only when LMIS takes the tab off /auth and no login form shows.
  log(ctx, 'opening the LMIS login page')
  try {
    await page.goto(`${LMIS_BASE}/auth`, { waitUntil: 'domcontentloaded', timeout: 240000 })
  } catch (e) {
    log(ctx, `navigation threw: ${e.message}`, 'warn')
  }

  log(ctx, `checking login state (up to ${LOGIN_STATE_WAIT_MS / 1000}s)`)
  const deadline = Date.now() + LOGIN_STATE_WAIT_MS
  let reloadAt = Date.now() + 20000
  let offAuthSince = 0
  let state = 'unknown'

  while (Date.now() < deadline) {
    const hasPw = await page.$('input[type="password"]').catch(() => null)
    if (hasPw) { state = 'login-form'; break }
    const url = page.url()
    const onAuth = url.includes('/auth') || url.includes('/login')
    if (!onAuth && url.startsWith(LMIS_BASE)) {
      // Off the login page with no form for 3s: LMIS itself says signed in.
      if (!offAuthSince) offAuthSince = Date.now()
      if (Date.now() - offAuthSince > 3000) { state = 'already-logged-in'; break }
    } else {
      offAuthSince = 0
    }
    // Still blank after 20s: LMIS is slow, load the login page again.
    if (Date.now() > reloadAt) {
      reloadAt = Date.now() + 20000
      log(ctx, 'login page still blank — loading it again', 'warn')
      await page.goto(`${LMIS_BASE}/auth`, { waitUntil: 'domcontentloaded', timeout: 240000 })
        .catch(e => log(ctx, `login navigation threw: ${e.message}`, 'warn'))
    }
    await sleep(500)
  }

  if (state === 'already-logged-in') {
    log(ctx, `already logged in (LMIS opened ${page.url()}) — skipping form fill`)
    await settle(page)
    await closePopups(page, ctx)
    return
  }

  if (state !== 'login-form') {
    log(ctx, 'no login form and no dashboard — dumping state', 'warn')
    const url = page.url()
    const body = await page.evaluate(() => (document.body?.innerText || '').slice(0, 300))
    log(ctx, `url=${url} body=${body.replace(/\n/g, ' | ')}`, 'warn')
    throw new Error('Could not determine login state')
  }

  log(ctx, 'login form present, filling')

  let ok = await fillByLabel(page, 'username', ctx.login_value)
  if (!ok) ok = await fillByLabel(page, 'phone', ctx.login_value)
  if (!ok) ok = await fillByLabel(page, 'email', ctx.login_value)
  if (!ok) {
    const first = await page.$('input[type="text"], input[type="email"], input[type="tel"]')
    if (first) {
      await first.click({ clickCount: 3 })
      await first.type(ctx.login_value, { delay: 30 })
      ok = true
    }
  }
  if (!ok) throw new Error('No username input found')

  const pw = await page.$('input[type="password"]')
  if (!pw) throw new Error('Password input vanished mid-fill')
  await pw.click({ clickCount: 3 })
  await pw.type(ctx.login_password, { delay: 30 })

  log(ctx, 'clicking Sign In')
  const clickRes = await clickByText(page, 'Sign In', { timeout: 15000 })
  if (!clickRes.ok) {
    const submit = await page.$('button[type="submit"]')
    if (submit) await submit.click()
    else throw new Error('Sign In button not found')
  }

  // LMIS can take more than a minute to sign in. Waiting only 60s made runs
  // carry on from the login page and fail with "Session lost".
  log(ctx, `waiting for LMIS to finish signing in (up to ${LOGIN_WAIT_MS / 1000}s — LMIS is often slow)`)
  const t0 = Date.now()
  let lastNote = t0
  let lastClick = t0
  let reclicks = 0
  let signedIn = false
  while (Date.now() - t0 < LOGIN_WAIT_MS) {
    const url = page.url()
    if (!url.includes('/auth') && !url.includes('/login')) { signedIn = true; break }
    // Sign In did nothing for 20s: click it again (refill if LMIS cleared the form).
    if (Date.now() - lastClick > 20000 && reclicks < 5) {
      reclicks++
      lastClick = Date.now()
      const pwEl = await page.$('input[type="password"]').catch(() => null)
      const pwVal = pwEl ? await pwEl.evaluate(n => n.value).catch(() => '') : ''
      if (pwEl && !pwVal) {
        log(ctx, '  the login form was cleared — filling it again', 'warn')
        let ok = await fillByLabel(page, 'username', ctx.login_value)
        if (!ok) ok = await fillByLabel(page, 'phone', ctx.login_value)
        await pwEl.click({ clickCount: 3 }).catch(() => {})
        await pwEl.type(ctx.login_password, { delay: 30 }).catch(() => {})
      }
      log(ctx, `  Sign In did not respond — clicking it again (${reclicks}/5)`, 'warn')
      const again = await clickByText(page, 'Sign In', { timeout: 5000 }).catch(() => ({ ok: false }))
      if (!again?.ok) {
        const submit = await page.$('button[type="submit"]').catch(() => null)
        if (submit) await submit.click().catch(() => {})
      }
    }
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
    // A wrong password will not fix itself by waiting: stop at once.
    const refused = text.match(/[^\n]*(invalid (phone|password|credential)|incorrect (phone|password)|wrong (phone|password))[^\n]*/i)
    if (refused) throw new Error(`LMIS refused the login: ${refused[0].trim().slice(0, 120)}`)
    if (Date.now() - lastNote > 15000) {
      log(ctx, `  still signing in... ${Math.round((Date.now() - t0) / 1000)}s`)
      lastNote = Date.now()
    }
    await sleep(500)
  }
  if (!signedIn) {
    throw new Error(`LMIS did not finish signing in within ${LOGIN_WAIT_MS / 1000}s (the site is slow) — will retry`)
  }

  log(ctx, `post-login URL: ${page.url()} (after ${Math.round((Date.now() - t0) / 1000)}s)`)
  await settle(page)
  await closePopups(page, ctx)
  log(ctx, 'logged in')
}

export async function stepDirectNavigate(page, ctx) {
  // Never through the dashboard menus: the police page's own address.
  if (!page.url().includes('police-certificate')) {
    log(ctx, `navigating to ${POLICE_URL}`)
    try {
      await page.goto(POLICE_URL, { waitUntil: 'domcontentloaded', timeout: STEP_GOTO_TIMEOUT })
    } catch (e) {
      log(ctx, `navigation threw: ${e.message}`, 'warn')
    }
  }

  log(ctx, `waiting for police certificate page (up to ${PAGE_READY_TIMEOUT / 1000}s)`)
  const start = Date.now()
  let lastLogAt = 0
  let ready = false
  let reloggedIn = false
  let bankSince = 0
  let lastLoad = Date.now()

  while (Date.now() - start < PAGE_READY_TIMEOUT) {
    const elapsed = Math.round((Date.now() - start) / 1000)
    const url = page.url()

    // The portal's own error page: waiting or retrying only logs in again and again.
    const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
    // The Version 3 "Attention" alert covers the page: close it.
    if (/SYSTEM ALERT/i.test(pageText)) await closeSystemAlert(page, ctx)
    // "No Bank Account Found": stop only when it is really on screen, on top,
    // for a full minute. Its text is in the page even while it is hidden.
    if (/No Bank Account Found/i.test(pageText) && await bankPopupBlocking(page)) {
      if (!bankSince) { bankSince = Date.now(); log(ctx, '"No Bank Account Found" popup is on screen — waiting to see if it goes away', 'warn') }
      if (Date.now() - bankSince > 60000) {
        log(ctx, 'LMIS blocks the police page: "No Bank Account Found" — the agency must submit its bank account to LMIS (Kazanchis office)', 'error')
        throw new Error('LMIS blocks this agency: "No Bank Account Found". The agency must submit its bank account to LMIS at the Kazanchis office. Not retried.')
      }
    } else if (bankSince) {
      log(ctx, '"No Bank Account Found" popup is gone — continuing')
      bankSince = 0
    }
    const portalError = /Something Went Wrong/i.test(pageText)
    if (portalError) {
      log(ctx, 'LMIS shows "Something Went Wrong" on the police page — stopping (portal error, not retried)', 'error')
      throw new Error('LMIS portal error: the police certificate page shows "Something Went Wrong". Try again later.')
    }

    if (url.includes('/auth') || url.includes('/login')) {
      // Slow LMIS sometimes drops the session right after signing in. Sign in
      // again once, in this same tab, before giving up.
      if (!reloggedIn) {
        reloggedIn = true
        log(ctx, `redirected to login at ${elapsed}s — signing in again`, 'warn')
        await stepLogin(page, ctx)
        if (!page.url().includes('police-certificate')) {
          await page.goto(POLICE_URL, { waitUntil: 'domcontentloaded', timeout: STEP_GOTO_TIMEOUT })
            .catch(e => log(ctx, `navigation threw: ${e.message}`, 'warn'))
        }
        lastLoad = Date.now()
        continue
      }
      log(ctx, `redirected to login again at ${elapsed}s — session lost`, 'error')
      throw new Error('Session lost — LMIS redirected to login twice')
    }

    if (Date.now() - lastLogAt > 5000) {
      log(ctx, `still waiting... ${elapsed}s, url=${url}`)
      lastLogAt = Date.now()
    }

    const dismissed = await closePopups(page, null)

    if (url.includes('police-certificate')) {
      const markers = await page.evaluate(() => {
        const body = document.body?.innerText || ''
        const btns = Array.from(document.querySelectorAll('button'))
          .map(b => (b.textContent || '').trim())
          .filter(Boolean)
        return {
          hasTitle: body.includes('Police Certificate'),
          hasAddNew: btns.some(t => /add new/i.test(t)),
          hasTrack: body.includes('Request and track'),
          buttonCount: btns.length,
        }
      })

      if (markers.hasTitle && (markers.hasAddNew || markers.hasTrack)) {
        ready = true
        log(ctx, `✓ page ready at ${elapsed}s (buttons=${markers.buttonCount} dismissed=${dismissed})`)
        break
      }
    }

    // LMIS sometimes leaves the page blank: load it again every 45s.
    if (Date.now() - lastLoad > 45000) {
      lastLoad = Date.now()
      log(ctx, `police page still not shown at ${elapsed}s — loading it again`, 'warn')
      await page.goto(POLICE_URL, { waitUntil: 'domcontentloaded', timeout: STEP_GOTO_TIMEOUT })
        .catch(e => log(ctx, `navigation threw: ${e.message}`, 'warn'))
      continue
    }

    await sleep(1000)
  }

  if (!ready) {
    const url = page.url()
    log(ctx, `timed out after ${PAGE_READY_TIMEOUT / 1000}s — url=${url}`, 'error')
    const preview = await page.evaluate(() => (document.body?.innerText || '').slice(0, 400))
    log(ctx, `body: ${preview.replace(/\n/g, ' | ')}`, 'error')
    throw new Error('Police certificate page never became ready')
  }

  await settle(page)
  await closePopups(page, ctx)
}

export async function stepAddNew(page, ctx) {
  log(ctx, 'clicking Add New')
  let res = await clickByText(page, 'Add New', { timeout: 20000 })
  if (!res.ok) {
    log(ctx, 'text match failed — scanning buttons for "add"')
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      const target = btns.find(b => {
        const t = (b.textContent || '').trim().toLowerCase()
        return t.startsWith('add') && t.length < 25
      })
      if (target) { target.click(); return true }
      return false
    })
    if (!clicked) throw new Error('Add New button not found')
    res = { ok: true, via: 'scan' }
  }
  log(ctx, `Add New clicked (${res.via || 'text'})`)

  log(ctx, 'waiting for Add Police Certificate Request modal')
  await waitForAnyText(
    page,
    ['Add Police Certificate Request', 'Labor Information', 'Search labor id', 'Submit Request'],
    120000
  )
  log(ctx, 'modal is up')
  await settle(page)
  await closePopups(page, ctx)
}

export async function stepSearchAndFindWorker(page, ctx) {
  const laborId = String(ctx.labor_id || '').trim()
  if (!laborId) throw new Error('labor_id is empty')

  log(ctx, `searching for labor ID "${laborId}"`)

  const handleRef = await page.evaluateHandle(() => {
    const all = Array.from(document.querySelectorAll('*'))
    const title = all.find(el => (el.textContent || '').trim() === 'Add Police Certificate Request')
    if (!title) return null

    let container = title.parentElement
    for (let d = 0; d < 6 && container; d++) {
      const r = container.getBoundingClientRect()
      if (r.width >= 400 && r.width <= 1100 && r.height >= 200 && r.height <= 1000) break
      container = container.parentElement
    }
    if (!container) return null

    const inputs = Array.from(container.querySelectorAll('input'))
    const exact = inputs.find(i => /^search\s+labor\s+id$/i.test((i.placeholder || '').trim()))
    if (exact) return exact
    const loose = inputs.find(i => {
      const ph = (i.placeholder || '').trim()
      if (!/labor/i.test(ph)) return false
      if (/^search\s+by/i.test(ph)) return false
      return true
    })
    if (loose) return loose
    return inputs.find(i => {
      const r = i.getBoundingClientRect()
      return r.width > 50 && r.height > 10
    }) || null
  })

  const input = handleRef.asElement()
  if (!input) {
    await ctx.notify(
      `❌ ${ctx.profileName}: modal search input not found`,
      'Could not locate the labor ID input inside the police certificate modal.'
    )
    throw new Error('Modal input not found')
  }

  const meta = await page.evaluate(node => ({
    placeholder: node.placeholder || '',
    value: node.value || '',
  }), input)
  log(ctx, `picked input: placeholder="${meta.placeholder}"`)

  await input.evaluate(el => el.focus())
  await input.click({ clickCount: 3 })
  await page.keyboard.press('Backspace')
  await sleep(150)

  await input.type(laborId, { delay: 60 })

  let valueNow = ''
  for (let i = 0; i < 12; i++) {
    valueNow = await page.evaluate(node => node.value, input)
    if (valueNow === laborId) break
    await sleep(150)
  }
  log(ctx, `input value after typing: ${JSON.stringify(valueNow)}`)

  if (valueNow !== laborId) {
    log(ctx, 'value mismatch — retrying with native setter', 'warn')
    await page.evaluate((node, val) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(node, val)
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
      node.dispatchEvent(new Event('blur', { bubbles: true }))
    }, input, laborId)
    valueNow = await page.evaluate(node => node.value, input)
    log(ctx, `retry value: ${JSON.stringify(valueNow)}`)
    if (valueNow !== laborId) {
      await ctx.notify(
        `❌ ${ctx.profileName}: could not fill labor ID`,
        `Input stayed "${valueNow}" instead of "${laborId}".`
      )
      throw new Error('Labor ID did not land in modal input')
    }
  }

  log(ctx, 'clicking Search in the modal')
  const clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'))
    const title = all.find(el => (el.textContent || '').trim() === 'Add Police Certificate Request')
    if (!title) return false
    let container = title.parentElement
    for (let d = 0; d < 6 && container; d++) {
      const r = container.getBoundingClientRect()
      if (r.width >= 400 && r.width <= 1100 && r.height >= 200 && r.height <= 1000) break
      container = container.parentElement
    }
    if (!container) return false
    const btn = Array.from(container.querySelectorAll('button'))
      .find(b => /^search$/i.test((b.textContent || '').trim()))
    if (btn) { btn.click(); return true }
    return false
  })
  if (!clicked) {
    log(ctx, 'Search button not found in modal — pressing Enter', 'warn')
    await input.press('Enter')
  }

  log(ctx, 'waiting for worker card (up to 30s)')
  const deadline = Date.now() + 30000
  let cardFound = false

  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const body = document.body?.innerText || ''
      const codeNotFound = body.includes('Code Not Found') || body.includes('Incorrect Code')
      const addButtons = Array.from(document.querySelectorAll('button'))
        .filter(b => {
          const t = (b.textContent || '').trim()
          if (!/^add$/i.test(t)) return false
          const r = b.getBoundingClientRect()
          return r.width > 5 && r.height > 5 && r.top > 0 && r.top < window.innerHeight
        })
      return {
        codeNotFound,
        hasAddButton: addButtons.length > 0,
        addCount: addButtons.length,
      }
    })

    if (state.codeNotFound) {
      await ctx.notify(
        `❌ ${ctx.profileName}: LMIS says "Code Not Found"`,
        `Labor ID "${laborId}" was rejected by LMIS. Please check the ID.`
      )
      throw new Error('Code Not Found')
    }
    if (state.hasAddButton) {
      cardFound = true
      log(ctx, `✓ worker card appeared (${state.addCount} Add button(s) on page)`)
      break
    }
    await sleep(500)
  }

  if (!cardFound) {
    await ctx.notify(
      `❌ ${ctx.profileName}: worker card never appeared`,
      `Search for "${laborId}" returned no worker.`
    )
    throw new Error('Worker card not found')
  }

  log(ctx, 'clicking Add on the worker card')

  const firstAddBox = await page.evaluate((lid) => {
    const btns = Array.from(document.querySelectorAll('button'))
      .filter(b => /^add$/i.test((b.textContent || '').trim()))
    if (!btns.length) return null
    const withId = btns.find(b => {
      let cur = b
      for (let d = 0; d < 8 && cur; d++) {
        if ((cur.textContent || '').includes(lid)) return true
        cur = cur.parentElement
      }
      return false
    })
    const target = withId || btns[0]
    const r = target.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, laborId)

  if (firstAddBox) {
    await page.mouse.move(firstAddBox.x, firstAddBox.y)
    await sleep(400)
  }

  const addClicked = await page.evaluate((lid) => {
    const btns = Array.from(document.querySelectorAll('button'))
      .filter(b => /^add$/i.test((b.textContent || '').trim()))
    if (!btns.length) return false
    const scoped = btns.find(b => {
      let cur = b
      for (let d = 0; d < 8 && cur; d++) {
        if ((cur.textContent || '').includes(lid)) return true
        cur = cur.parentElement
      }
      return false
    })
    const target = scoped || btns[0]
    target.click()
    return true
  }, laborId)

  if (!addClicked) {
    await ctx.notify(`❌ ${ctx.profileName}: Add button not found on worker card`, 'The card appeared but Add could not be clicked.')
    throw new Error('Add button click failed')
  }

  log(ctx, 'Add clicked — waiting for upload slots')

  await settle(page)
  await closePopups(page, ctx)

  const sectionsDeadline = Date.now() + 15000
  let sections = { slip: false, passport: false, photo: false }
  while (Date.now() < sectionsDeadline) {
    sections = await page.evaluate(() => {
      const body = document.body?.innerText || ''
      return {
        slip: body.includes('Payment Slip') || body.includes('Upload Payment Receipt'),
        passport: /\bPassport\b/.test(body) && body.includes('Required'),
        photo: /\bPhoto\b/.test(body) && body.includes('Required'),
      }
    })
    if (sections.passport && sections.photo) break
    await sleep(500)
  }

  log(ctx, `sections visible: slip=${sections.slip} passport=${sections.passport} photo=${sections.photo}`)

  if (!sections.passport || !sections.photo) {
    log(ctx, 'upload sections did not fully appear', 'warn')
  }
}

// ============================================================================
// POLICE CERTIFICATE — DOCUMENT UPLOADS
// ============================================================================

export async function stepUploadDocuments(page, ctx) {
  log(ctx, '▶ starting document uploads')
  ctx.__sectionOk = {}
  for (const [i, sec] of FORM_SECTIONS.entries()) {
    log(ctx, `[${i + 1}/${FORM_SECTIONS.length}] ${sec.label}`)
    await runSection(page, ctx, sec)
  }
  log(ctx, '▶ uploads done — checking the form')
}

/** Upload one section; remember whether it went through. */
async function runSection(page, ctx, sec) {
  // The row as it looked before: an upload that took effect changes it.
  const before = await readPoliceForm(page).catch(() => null)
  ctx.__rowBefore = { ...(ctx.__rowBefore || {}), [sec.key]: before?.rows?.[sec.key]?.text }
  try {
    await sec.redo(page, ctx)
    ;(ctx.__sectionOk ||= {})[sec.key] = true
  } catch (e) {
    if (e.cancelled) throw e
    ;(ctx.__sectionOk ||= {})[sec.key] = false
    ctx.__sectionWhy = { ...(ctx.__sectionWhy || {}), [sec.key]: e.message }
    log(ctx, `✗ ${sec.label}: ${e.message}`, 'warn')
  }
  await settle(page)
  await closePopups(page, ctx)
}

// ---------- PAYMENT SLIP ----------
async function uploadPaymentSlip(page, ctx) {
  if (!ctx.slipPath || !fs.existsSync(ctx.slipPath)) {
    throw new Error('Profile is missing the payment slip file')
  }

  let slipPath = ctx.slipPath
  if (!/\.pdf$/i.test(slipPath)) {
    log(ctx, 'converting slip to PDF (LMIS requires PDF)')
    const converted = await convertToPdf(slipPath)
    if (!converted) throw new Error('Payment slip: could not turn it into a PDF')
    slipPath = converted
  }
  const sizeMb = fs.statSync(slipPath).size / 1024 / 1024
  if (sizeMb > SLIP_MAX_MB) {
    throw new Error(`Payment slip is ${sizeMb.toFixed(1)} MB — LMIS allows ${SLIP_MAX_MB} MB`)
  }

  log(ctx, 'uploading payment slip')

  // The slip window is still open from an earlier try: carry on in it
  // (clicking Upload behind it would do nothing).
  if (await modalOpen(page, SLIP_WINDOW)) {
    log(ctx, 'the Upload Payment Slip window is already open — finishing it')
  } else {
    await openSlipWindow(page, ctx)
  }

  const reasonFilled = await setFieldInModal(page, 'Upload Police Certificate Payment Slip', {
    placeholderIncludes: ['labor is going', 'reason'],
    labelIncludes: ['Reason'],
    value: 'WORK',
  })
  log(ctx, reasonFilled ? '✓ Reason = WORK' : '⚠ Reason field not found', reasonFilled ? 'info' : 'warn')

  const txn = (ctx.profile && ctx.profile.order_id) || ctx.labor_id || ''
  if (txn) {
    const txnFilled = await setFieldInModal(page, 'Upload Police Certificate Payment Slip', {
      placeholderIncludes: ['transaction', 'order'],
      labelIncludes: ['Transaction Number', 'Transaction'],
      value: txn,
    })
    log(ctx, txnFilled ? `✓ Transaction = "${txn}"` : '⚠ Transaction field not found', txnFilled ? 'info' : 'warn')
    if (!txnFilled) {
      await sleep(300)
      const retry = await setFieldInModal(page, 'Upload Police Certificate Payment Slip', {
        placeholderIncludes: ['transaction'],
        labelIncludes: ['Transaction'],
        value: txn,
      })
      log(ctx, retry ? `✓ Transaction = "${txn}" (retry)` : '⚠ Transaction retry failed', retry ? 'info' : 'warn')
    }
  } else {
    log(ctx, 'no order_id and no labor_id — Transaction field left empty', 'warn')
  }

  // A slip LMIS already holds in this window is not sent twice.
  if (await uploadState(page, SLIP_WINDOW) === 'complete') {
    log(ctx, '✓ slip already uploaded in this window')
  } else {
    const uploaded = await attachFileToModal(page, SLIP_WINDOW, slipPath, ctx, 'slip')
    log(ctx, uploaded ? '✓ slip PDF attached' : '⚠ slip file upload failed', uploaded ? 'info' : 'warn')
    if (!uploaded) throw new Error('Payment slip: the file never showed in the slip window')
  }

  // Add only counts once LMIS has finished the upload; LMIS closes the window
  // itself when it has the slip.
  if (!(await finishUploadWindow(page, ctx, SLIP_WINDOW, /^add$/i, 'Payment slip Add'))) {
    throw new Error('Payment slip: the slip window stayed open after Add — the slip was not saved')
  }
  log(ctx, '✓ slip modal submitted (Add clicked, window closed)')
  await settle(page)
}

const SLIP_WINDOW = 'Upload Police Certificate Payment Slip'

/** Upload → Payment Instructions → "I Understand" → the slip window. */
async function openSlipWindow(page, ctx) {
  const clickedUpload = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
      .filter(b => /^upload$/i.test((b.textContent || '').trim()))
    const withSlip = btns.find(b => {
      let cur = b
      for (let d = 0; d < 10 && cur; d++) {
        if ((cur.textContent || '').includes('Payment Slip')) return true
        cur = cur.parentElement
      }
      return false
    })
    const target = withSlip || btns[0]
    if (target) { target.click(); return true }
    return false
  })
  if (!clickedUpload) throw new Error('Payment slip: Upload button not found')
  log(ctx, 'clicked Upload — waiting for Payment Instructions modal')

  const instrOpened = await waitForModal(page, 'Payment Instructions', 15000)
  if (!instrOpened) throw new Error('Payment slip: Payment Instructions window never appeared')
  log(ctx, 'Payment Instructions modal open')
  await settle(page)

  const understood = await clickButtonInModal(page, 'Payment Instructions', /understand|continue/i)
  if (!understood) throw new Error('Payment slip: "I Understand" button not found')
  log(ctx, '✓ clicked "I Understand — Continue"')

  const formOpened = await waitForModal(page, SLIP_WINDOW, 15000)
  if (!formOpened) throw new Error('Payment slip: upload window never appeared')
  log(ctx, 'Upload Payment Slip modal open')
  await settle(page)
}

/**
 * The file LMIS receives in the passport field: a PDF of at most 2 MB.
 * A stored PDF is used as it is. An image is turned into a PDF (re-encoded and
 * shrunk until it fits). Stored files are never changed.
 */
async function passportUploadFile(srcPath) {
  const limit = PASSPORT_MAX_MB * 1024 * 1024
  const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1)
  if (/\.pdf$/i.test(srcPath)) {
    if (fs.statSync(srcPath).size <= limit) return srcPath
    throw new Error(`Passport PDF is ${mb(srcPath)} MB and LMIS allows ${PASSPORT_MAX_MB} MB. Upload a smaller PDF.`)
  }
  const sharp = (await import('sharp')).default
  const imageToPdf = (await import('image-to-pdf')).default
  for (const width of [2000, 1600, 1200, 1000]) {
    const jpg = path.join(os.tmpdir(), `lmis-passport-${Date.now()}-${width}.jpg`)
    const pdf = jpg.replace(/\.jpg$/, '.pdf')
    await sharp(srcPath).rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 }).toFile(jpg)
    await new Promise((resolve, reject) => {
      imageToPdf([jpg]).pipe(fs.createWriteStream(pdf)).on('finish', resolve).on('error', reject)
    })
    try { fs.unlinkSync(jpg) } catch {}
    if (fs.statSync(pdf).size <= limit) return pdf
    try { fs.unlinkSync(pdf) } catch {}
  }
  throw new Error(`Passport could not be made into a PDF under ${PASSPORT_MAX_MB} MB. Upload a smaller scan.`)
}

/** The photo LMIS receives: at most 2 MB (a large photo is re-encoded smaller). */
async function photoUploadFile(srcPath) {
  if (fs.statSync(srcPath).size <= PHOTO_MAX_MB * 1024 * 1024) return srcPath
  const sharp = (await import('sharp')).default
  for (const width of [1600, 1200, 900]) {
    const out = path.join(os.tmpdir(), `lmis-photo-${Date.now()}-${width}.jpg`)
    await sharp(srcPath).rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(out)
    if (fs.statSync(out).size <= PHOTO_MAX_MB * 1024 * 1024) return out
    try { fs.unlinkSync(out) } catch {}
  }
  throw new Error(`Photo could not be made smaller than ${PHOTO_MAX_MB} MB`)
}

// ---------- PASSPORT ----------
async function uploadPassport(page, ctx) {
  if (!ctx.passportPath || !fs.existsSync(ctx.passportPath)) {
    throw new Error('Passport file is missing on the profile — the request would have no passport')
  }

  // The passport field takes a PDF of at most 2 MB (see passportUploadFile).
  const pPath = await passportUploadFile(ctx.passportPath)
  if (pPath !== ctx.passportPath) log(ctx, `passport sent as PDF: ${path.basename(pPath)}`)

  log(ctx, 'opening Passport modal')
  const opened1 = await clickSectionAdd(page, 'Passport')
  if (!opened1) throw new Error('Passport: the Add button was not found on the LMIS form')

  const opened = await waitForModal(page, 'Upload Passport Document', 20000)
  if (!opened) throw new Error('Passport: the upload modal never appeared on the LMIS form')
  log(ctx, 'Passport modal open')
  await settle(page)

  const profile = ctx.profile || {}
  const issueDate = normalizeDate(profile.passport_issue_date)
  const dob = normalizeDate(profile.date_of_birth)

  // ---- Fill fields ----
  const destination = profile.destination_country || 'Kuwait'
  const destOk = await setReactSelect(page, 'Upload Passport Document', 'Destination Country', destination)
  log(ctx, destOk ? `✓ Destination Country = ${destination}` : `⚠ Destination Country "${destination}" did not stick`, destOk ? 'info' : 'warn')

  const numFilled = await setFieldInModal(page, 'Upload Passport Document', {
    placeholderIncludes: ['EP', 'passport'],
    labelIncludes: ['Passport Number'],
    value: profile.passport_number || ''
  })
  log(ctx, numFilled ? `✓ Passport Number = "${profile.passport_number}"` : '⚠ Passport Number field not found', numFilled ? 'info' : 'warn')

  if (issueDate) {
    const dateFilled = await setDateFieldByIndex(page, 'Upload Passport Document', 0, issueDate)
    log(ctx, dateFilled ? `✓ Passport Issue Date = "${issueDate}"` : '⚠ Passport Issue Date not found', dateFilled ? 'info' : 'warn')
  }

  const placeFilled = await setFieldInModal(page, 'Upload Passport Document', {
    labelIncludes: ['Passport Issued Place', 'Issued Place', 'Place of Issue'],
    value: 'Ethiopia'
  })
  log(ctx, placeFilled ? '✓ Passport Issued Place = Ethiopia' : '⚠ Passport Issued Place field not found', placeFilled ? 'info' : 'warn')

  const pob = profile.place_of_birth || ''
  if (pob) {
    const pobFilled = await setFieldInModal(page, 'Upload Passport Document', {
      labelIncludes: ['Place Of Birth', 'Place of Birth'],
      value: pob
    })
    log(ctx, pobFilled ? `✓ Place Of Birth = "${pob}"` : '⚠ Place Of Birth field not found', pobFilled ? 'info' : 'warn')
  } else {
    log(ctx, 'place_of_birth empty on profile — leaving field blank', 'warn')
  }

  if (dob) {
    const dobFilled = await setDateFieldByIndex(page, 'Upload Passport Document', 1, dob)
    log(ctx, dobFilled ? `✓ Date Of Birth = "${dob}"` : '⚠ Date Of Birth not found', dobFilled ? 'info' : 'warn')
  }

  // ---- Attach the passport file ----
  log(ctx, 'attaching passport file...')
  const uploaded = await attachFileToModal(page, 'Upload Passport Document', pPath, ctx, 'passport')
  if (!uploaded) {
    await ctx.notify(
      `❌ ${ctx.profileName}: passport file could not be attached`,
      'The passport did not show in the Upload Passport Document window. Submit was skipped so no empty upload is sent.'
    )
    throw new Error('Passport file upload failed — the file never showed in the passport window')
  }

  // ---- Click Submit ----
  const submitted = await finishUploadWindow(page, ctx, 'Upload Passport Document', /^submit$/i, 'Passport Submit')
  if (!submitted) throw new Error('Passport: the window stayed open after Submit')
  log(ctx, 'Passport modal submitted')

  await settle(page)
  await closePopups(page, ctx)
}

// ---------- PHOTO ----------
async function uploadPhoto(page, ctx) {
  if (!ctx.photoPath || !fs.existsSync(ctx.photoPath)) throw new Error('Profile is missing the photo file')
  const photoPath = await photoUploadFile(ctx.photoPath)
  if (photoPath !== ctx.photoPath) log(ctx, `photo made smaller for LMIS: ${path.basename(photoPath)}`)

  log(ctx, 'opening Photo instructions modal')
  const clickedAdd = await clickSectionAdd(page, 'Photo')
  if (!clickedAdd) throw new Error('Photo: Add button not found')

  const instructionsOpened = await waitForModal(page, 'Labor Passport Photo Upload Instructions', 20000)
  if (!instructionsOpened) throw new Error('Photo: instructions window never appeared')
  log(ctx, 'instructions modal open')
  await settle(page)

  const agreed = await clickButtonInModal(page, 'Labor Passport Photo Upload Instructions', /i agree/i)
  if (!agreed) throw new Error('Photo: "I Agree" button not found')
  log(ctx, '✓ clicked "I Agree, Continue"')

  const uploadOpened = await waitForModal(page, 'Upload Photo', 15000)
  if (!uploadOpened) throw new Error('Photo: Upload Photo window never appeared')
  log(ctx, 'Upload Photo modal open')
  await settle(page)

  const uploaded = await attachFileToModal(page, 'Upload Photo', photoPath, ctx, 'photo')
  if (!uploaded) throw new Error('Photo: the file never showed in the Upload Photo window')

  // Submit only counts once LMIS has stored the photo (it can take a while).
  const closed = await finishUploadWindow(page, ctx, 'Upload Photo', /^(submit|upload|save|confirm|done)\b/i, 'Photo Submit')
  if (!closed) throw new Error('Photo: the Upload Photo window stayed open after Submit')
  log(ctx, '✓ Upload Photo modal submitted')

  await settle(page)
  await closePopups(page, ctx)
}

// ============================================================================
// HELPERS
// ============================================================================

function normalizeDate(input) {
  if (!input) return ''
  const s = String(input).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const MONTHS = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',
                   JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' }
  let m = s.toUpperCase().match(/^(\d{1,2})\s+([A-Z]{3})\s+(\d{2,4})$/)
  if (m) {
    const d = String(parseInt(m[1], 10)).padStart(2, '0')
    const mo = MONTHS[m[2]]
    let y = m[3]
    if (y.length === 2) y = parseInt(y, 10) > 50 ? '19' + y : '20' + y
    return `${y}-${mo}-${d}`
  }
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/)
  if (m) {
    const d = String(parseInt(m[1], 10)).padStart(2, '0')
    const mo = String(parseInt(m[2], 10)).padStart(2, '0')
    return `${m[3]}-${mo}-${d}`
  }
  return ''
}

async function waitForModal(page, titleSubstring, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await page.evaluate((t) => {
      const all = Array.from(document.querySelectorAll('*'))
      return all.some(el => {
        const r = el.getBoundingClientRect()
        if (r.width < 250 || r.height < 150) return false
        return (el.textContent || '').slice(0, 400).includes(t)
      })
    }, titleSubstring)
    if (found) return true
    await sleep(400)
  }
  return false
}

async function clickSectionAdd(page, sectionText) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    const clicked = await page.evaluate((text) => {
      const all = Array.from(document.querySelectorAll('*'))
      const headers = all.filter(el => {
        const t = (el.textContent || '').trim()
        return (t === text || t.startsWith(text + ' ') || t === text + '✓') && el.children.length <= 2
      })
      for (const h of headers) {
        let cur = h
        for (let d = 0; d < 8 && cur; d++) {
          const add = Array.from(cur.querySelectorAll('button'))
            .find(b => /^add$/i.test((b.textContent || '').trim()))
          if (add) {
            const r = add.getBoundingClientRect()
            if (r.width > 5 && r.height > 5 && r.top > 0) { add.click(); return true }
          }
          cur = cur.parentElement
        }
      }
      return false
    }, sectionText)
    if (clicked) return true
    await sleep(600)
  }
  return false
}

async function convertToPdf(srcPath) {
  try {
    const pdfPath = srcPath.replace(/\.[^.]+$/, '') + `_${Date.now()}.pdf`
    const imageToPdf = (await import('image-to-pdf')).default
    await new Promise((resolve, reject) => {
      imageToPdf([srcPath])
        .pipe(fs.createWriteStream(pdfPath))
        .on('finish', resolve)
        .on('error', reject)
    })
    return fs.existsSync(pdfPath) ? pdfPath : null
  } catch (e) {
    console.warn('[lmis] PDF conversion failed:', e.message)
    return null
  }
}

/**
 * Click the first ENABLED button in the modal whose text matches. Returns
 * { clicked, buttons } where buttons lists what the modal offers (for the log
 * when nothing matched).
 */
async function clickEnabledButtonInModal(page, modalTitle, labelRegex) {
  return await page.evaluate(({ modalTitle, src }) => {
    const re = new RegExp(src, 'i')
    let modal = null
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150) continue
      if ((el.textContent || '').slice(0, 400).includes(modalTitle)) modal = el // keep the innermost match
    }
    if (!modal) return { clicked: false, buttons: [] }
    // The window's own buttons first; footer buttons can sit next to the
    // body, so one level up only when the window has no such button.
    const all = (el) => Array.from(el.querySelectorAll('button, [role="button"], input[type="submit"]'))
    const named = (b) => re.test((b.textContent || b.value || '').trim())
    let btns = all(modal)
    if (!btns.some(named) && modal.parentElement) btns = all(modal.parentElement)
    const buttons = btns.map(b => ({ text: (b.textContent || b.value || '').trim().slice(0, 30), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true' }))
    const target = btns.find(b => named(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true')
    if (target) { target.click(); return { clicked: true, buttons } }
    return { clicked: false, buttons }
  }, { modalTitle, src: labelRegex.source }).catch(() => ({ clicked: false, buttons: [] }))
}

/**
 * Click a modal's button and, if the modal is still open after a while,
 * click it again (LMIS is slow and sometimes ignores a click). Returns true
 * once the modal has closed. `alreadyClicked` = the first click was done.
 */
async function clickUntilModalCloses(page, modalTitle, labelRegex, ctx, label, alreadyClicked = false) {
  const isOpen = () => modalOpen(page, modalTitle)
  for (let tryNo = 1; tryNo <= 4; tryNo++) {
    if (tryNo > 1 || !alreadyClicked) {
      const r = await clickEnabledButtonInModal(page, modalTitle, labelRegex)
      if (tryNo > 1) log(ctx, `  ${label}: window still open — clicking again (${tryNo}/4)${r.clicked ? '' : ' (button not clickable yet)'}`, 'warn')
    }
    const t0 = Date.now()
    while (Date.now() - t0 < 10000) {
      if (!(await isOpen())) return true
      await sleep(500)
    }
  }
  return !(await isOpen())
}

/** True while a window with this title is on screen. */
async function modalOpen(page, title) {
  return page.evaluate((t) => Array.from(document.querySelectorAll('*')).some(el => {
    const r = el.getBoundingClientRect()
    return r.width >= 250 && r.height >= 150 && (el.textContent || '').slice(0, 400).includes(t)
  }), title).catch(() => false)
}

/**
 * The upload inside one window (read from that window only, never the form
 * behind it): 'complete' · 'uploading' · 'error' · 'idle' (no upload shown) ·
 * 'gone' (the window is closed).
 */
async function uploadState(page, title) {
  return page.evaluate((title) => {
    let modal = null, area = Infinity
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150) continue
      if ((el.textContent || '').slice(0, 400).includes(title) && r.width * r.height < area) { modal = el; area = r.width * r.height }
    }
    if (!modal) return 'gone'
    const text = (modal.textContent || '').toLowerCase()
    if (text.includes('error during upload')) return 'error'
    if (text.includes('upload complete') || text.includes('tap to undo')) return 'complete'
    if (/uploading|tap to cancel|\d+\s*%/.test(text)) return 'uploading'
    return 'idle'
  }, title).catch(() => 'idle')
}

/**
 * Press a window's Add/Submit only after LMIS has finished the upload in it —
 * LMIS ignores the button while the file is still going up — and press it
 * again until the window closes. Returns true once the window is closed.
 */
async function finishUploadWindow(page, ctx, title, buttonRe, label) {
  const end = Date.now() + 120000
  let state = 'idle', idleSince = 0
  while (Date.now() < end) {
    state = await uploadState(page, title)
    if (state === 'complete' || state === 'gone') break
    if (state === 'idle') { idleSince ||= Date.now(); if (Date.now() - idleSince > 2000) break } else idleSince = 0
    await sleep(400)
  }
  if (state === 'gone') return true
  log(ctx, state === 'complete' ? `  ${label}: LMIS shows Upload Complete`
    : `  ${label}: upload state "${state}" after waiting — pressing the button anyway`, state === 'complete' || state === 'idle' ? 'info' : 'warn')
  let first = { clicked: false, buttons: [] }
  for (const stop = Date.now() + 30000; Date.now() < stop;) {
    first = await clickEnabledButtonInModal(page, title, buttonRe)
    if (first.clicked) break
    await sleep(500)
  }
  if (!first.clicked) {
    log(ctx, `  ${label}: the button never became clickable (buttons: ${JSON.stringify(first.buttons).slice(0, 120)})`, 'warn')
    return false
  }
  log(ctx, `  ${label}: pressed`)
  return clickUntilModalCloses(page, title, buttonRe, ctx, label, true)
}

async function clickButtonInModal(page, modalTitle, labelRegex) {
  return await page.evaluate(({ modalTitle, src }) => {
    const re = new RegExp(src, 'i')
    const all = Array.from(document.querySelectorAll('*'))
    let modal = null
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150) continue
      if ((el.textContent || '').slice(0, 400).includes(modalTitle)) { modal = el; break }
    }
    if (!modal) return false
    const target = Array.from(modal.querySelectorAll('button'))
      .find(b => re.test((b.textContent || '').trim()))
    if (target) { target.click(); return true }
    return false
  }, { modalTitle, src: labelRegex.source })
}

async function setReactSelect(page, modalTitle, labelText, value) {
  if (!value) return
  const opened = await page.evaluate(({ modalTitle, labelText }) => {
    const all = Array.from(document.querySelectorAll('*'))
    let modal = null
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150) continue
      if ((el.textContent || '').slice(0, 400).includes(modalTitle)) { modal = el; break }
    }
    if (!modal) return false
    const labels = Array.from(modal.querySelectorAll('*'))
      .filter(el => {
        const t = (el.textContent || '').trim()
        return (t === labelText || t.startsWith(labelText)) && el.children.length <= 2
      })
    for (const label of labels) {
      let cur = label
      for (let d = 0; d < 6 && cur; d++) {
        const control = cur.querySelector('[class*="control"], [class*="select__control"], [role="combobox"]')
        if (control) {
          const r = control.getBoundingClientRect()
          if (r.width > 30 && r.height > 15) {
            const inp = control.querySelector('input') || control
            inp.focus(); inp.click(); return true
          }
        }
        cur = cur.parentElement
      }
    }
    return false
  }, { modalTitle, labelText })

  if (!opened) return false
  // The option list comes from LMIS and can be slow: wait longer each try and
  // check that the value really stuck.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(500)
    await page.keyboard.down('Control').catch(() => {})
    await page.keyboard.press('KeyA').catch(() => {})
    await page.keyboard.up('Control').catch(() => {})
    await page.keyboard.press('Backspace').catch(() => {})
    await page.keyboard.type(String(value), { delay: 60 })
    await sleep(1500 * attempt)
    await page.keyboard.press('Enter')
    await sleep(600)
    const shown = await page.evaluate(({ modalTitle, labelText, value }) => {
      let modal = null, area = Infinity
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.width < 250 || r.height < 150) continue
        if ((el.textContent || '').slice(0, 400).includes(modalTitle) && r.width * r.height < area) { modal = el; area = r.width * r.height }
      }
      if (!modal) return false
      const label = Array.from(modal.querySelectorAll('*')).find(el => (el.textContent || '').trim().startsWith(labelText) && el.children.length <= 2)
      for (let c = label, d = 0; c && d < 6; d++, c = c.parentElement) {
        const ctl = c.querySelector('[class*="control"], [role="combobox"]')
        if (ctl) return (ctl.textContent || '').toLowerCase().includes(String(value).toLowerCase())
      }
      return false
    }, { modalTitle, labelText, value }).catch(() => false)
    if (shown) return true
    // reopen the select for the next try
    await page.evaluate(({ modalTitle, labelText }) => {
      const label = Array.from(document.querySelectorAll('*')).find(el => (el.textContent || '').trim().startsWith(labelText) && el.children.length <= 2)
      for (let c = label, d = 0; c && d < 6; d++, c = c.parentElement) {
        const ctl = c.querySelector('[class*="control"], [role="combobox"]')
        if (ctl) { const i = ctl.querySelector('input') || ctl; i.focus(); i.click(); return }
      }
    }, { modalTitle, labelText }).catch(() => {})
  }
  return false
}

async function setFieldInModal(page, modalTitle, { placeholderIncludes, labelIncludes, value }) {
  if (!value) return false
  return await page.evaluate(({ modalTitle, phInc, lblInc, val }) => {
    const all = Array.from(document.querySelectorAll('*'))
    let modal = null
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150) continue
      if ((el.textContent || '').slice(0, 400).includes(modalTitle)) { modal = el; break }
    }
    if (!modal) return false

    const inputs = Array.from(modal.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea'))
    let target = null

    if (!target && phInc) {
      target = inputs.find(i => phInc.some(p => (i.placeholder || '').toLowerCase().includes(p.toLowerCase())))
    }

    if (!target && lblInc) {
      for (const labelText of lblInc) {
        const candidates = Array.from(modal.querySelectorAll('*'))
          .filter(el => {
            const t = (el.textContent || '').trim()
            if (!t.startsWith(labelText)) return false
            const rest = t.slice(labelText.length).trim()
            return !rest || /^[*:•✓\s]+$/.test(rest)
          })
          .sort((a, b) => (a.textContent || '').trim().length - (b.textContent || '').trim().length)

        for (const label of candidates) {
          const forId = label.getAttribute && label.getAttribute('for')
          if (forId) {
            const esc = (window.CSS && CSS.escape) ? CSS.escape(forId) : forId.replace(/([^\w-])/g, '\\$1')
            const linked = modal.querySelector('#' + esc)
            if (linked && linked.tagName === 'INPUT' && linked.type !== 'hidden' && linked.type !== 'file') {
              target = linked; break
            }
            if (linked && linked.tagName === 'TEXTAREA') { target = linked; break }
          }

          let cur = label
          for (let d = 0; d < 6 && cur; d++) {
            const inp = cur.querySelector('input:not([type="hidden"]):not([type="file"]), textarea')
            if (inp) { target = inp; break }
            cur = cur.parentElement
          }
          if (target) break
        }
        if (target) break
      }
    }

    if (!target) return false

    const proto = target.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(target, String(val))
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))
    target.dispatchEvent(new Event('blur', { bubbles: true }))
    return true
  }, { modalTitle, phInc: placeholderIncludes, lblInc: labelIncludes, val: value })
}

async function setDateFieldByIndex(page, modalTitle, index, isoDate) {
  return await page.evaluate(({ modalTitle, index, value }) => {
    const all = Array.from(document.querySelectorAll('*'))
    let modal = null
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150) continue
      if ((el.textContent || '').slice(0, 400).includes(modalTitle)) { modal = el; break }
    }
    if (!modal) return false
    const dates = Array.from(modal.querySelectorAll('input[type="date"], input[placeholder*="mm/dd"]'))
    const target = dates[index]
    if (!target) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(target, String(value))
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))
    target.dispatchEvent(new Event('blur', { bubbles: true }))
    return true
  }, { modalTitle, index, value: isoDate })
}

/**
 * Upload a file into the file input inside the currently open modal.
 * v17: ancestor check now scans up to 5000 chars of textContent (was 400),
 *      so it works for inputs buried deep inside Ant Design dropzones.
 */
/**
 * Attach a file the way a person does: click "Browse" in the modal — with
 * Puppeteer catching the file chooser, so no system "open file" dialog ever
 * appears — and hand the file over. Works even when the dropzone only
 * creates its <input type=file> on click.
 */
async function attachFileViaChooser(page, modalTitle, filePath, ctx) {
  if (!filePath || !fs.existsSync(filePath)) return false
  const pt = await page.evaluate((title) => {
    let modal = null, area = Infinity
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150) continue
      if ((el.textContent || '').slice(0, 400).includes(title) && r.width * r.height < area) { modal = el; area = r.width * r.height }
    }
    if (!modal) return null
    const el = Array.from(modal.querySelectorAll('*'))
      .filter(e => { const t = (e.textContent || '').trim(); return /^browse$/i.test(t) || (/drag\s*&\s*drop/i.test(t) && t.length < 80) })
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0]
    if (!el) return null
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, modalTitle).catch(() => null)
  if (!pt) { log(ctx, '  no Browse / dropzone in the modal', 'warn'); return false }
  // The run tab catches every file dialog (tabManager), so clicking Browse
  // never opens the system "Open file" window: the file goes straight in.
  const handed = expectFile(page, filePath, 10000)
  await page.mouse.click(pt.x, pt.y).catch(() => {})
  const ok = await handed
  if (!ok) log(ctx, '  Browse did not ask for a file', 'warn')
  return ok
}

/**
 * Attach `filePath` to the modal and make sure the modal shows it. Tries the
 * file chooser first, then the modal's own file input. Never touches inputs
 * outside the modal.
 */
export async function attachFileToModal(page, modalTitle, filePath, ctx, label) {
  // Click Browse again when the file did not show — LMIS sometimes ignores
  // the first click.
  for (let tryNo = 1; tryNo <= 3; tryNo++) {
    if (tryNo > 1) log(ctx, `  ${label}: did not attach — clicking again (${tryNo}/3)`, 'warn')
    if (await attachOnce(page, modalTitle, filePath, ctx, label)) return true
    await sleep(1500)
  }
  return false
}

async function attachOnce(page, modalTitle, filePath, ctx, label) {
  // The window's own file input first: nothing is clicked, nothing can pop up.
  for (const [how, attach] of [
    ['file input inside the modal', () => uploadFileInModal(page, modalTitle, filePath)],
    ['Browse', () => attachFileViaChooser(page, modalTitle, filePath, ctx)],
  ]) {
    const ok = await attach()
    log(ctx, `  ${label}: ${how} ${ok ? '✓' : '✗'}`)
    if (!ok) continue
    // LMIS is slow to show the file: give it time before trying the next way.
    if (await waitForFileAttached(page, modalTitle, filePath, 20000)) {
      log(ctx, `✓ ${label} is shown in the modal`)
      return true
    }
    log(ctx, `  ${label}: not shown in the modal after 20s`, 'warn')
  }
  return false
}

async function uploadFileInModal(page, modalTitle, filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false
  const handles = await page.$$('input[type="file"]')
  if (handles.length === 0) return false

  for (const h of handles) {
    const inModal = await page.evaluate((node, modalTitle) => {
      let cur = node
      for (let d = 0; d < 15 && cur; d++) {
        const t = cur.textContent || ''
        // Scan up to 5000 chars — enough to include the modal title even
        // for the outer modal wrapper.
        if (t.length < 5000 && t.includes(modalTitle)) return true
        cur = cur.parentElement
      }
      return false
    }, h, modalTitle)

    if (inModal) {
      try { await h.uploadFile(filePath); return true } catch {}
    }
  }
  return false
}

/**
 * Wait for a file to appear as attached inside a modal — checks for the
 * file's basename or an upload-complete indicator in the modal body.
 */
async function waitForFileAttached(page, modalTitle, filePath, timeoutMs) {
  if (!filePath) return false
  const base = path.basename(filePath).toLowerCase()
  // Use a short unique slice of the filename in case LMIS truncates it
  const needle = base.slice(0, Math.min(20, base.length))

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const attached = await page.evaluate(({ title, needle }) => {
      // The modal itself (smallest box with the title), not the page behind
      // it: the Slip section's "Upload Complete" used to count as attached.
      let modal = null, area = Infinity
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.width < 250 || r.height < 150) continue
        if ((el.textContent || '').slice(0, 400).includes(title) && r.width * r.height < area) { modal = el; area = r.width * r.height }
      }
      if (!modal) return false
      const text = (modal.textContent || '').toLowerCase()
      // A red "Error During Upload": press its retry button and keep waiting.
      if (text.includes('error during upload')) {
        const retry = modal.querySelector('.filepond--action-retry-item-processing, [class*="retry" i]')
        if (retry) retry.click()
        return 'retry'
      }
      // Wrong type / too big will not fix itself.
      if (/invalid type|too large|exceeds/.test(text)) return 'rejected'
      return text.includes(needle) ||
             text.includes('upload complete') ||
             text.includes('tap to undo')
    }, { title: modalTitle, needle })
    if (attached === 'rejected') return false
    if (attached === true) return true
    await sleep(attached === 'retry' ? 2000 : 400)
  }
  return false
}

// ============================================================================
// FINAL CHECK — the person only ever gets a complete form
// ============================================================================

const FORM_SECTIONS = [
  { key: 'slip',     name: 'Payment Slip', label: 'payment slip', file: 'slipPath',
    modals: ['Payment Instructions', 'Upload Police Certificate Payment Slip'], button: /^add$/i, redo: (p, c) => uploadPaymentSlip(p, c) },
  { key: 'passport', name: 'Passport',     label: 'passport',     file: 'passportPath',
    modals: ['Upload Passport Document'], button: /^submit$/i, redo: (p, c) => uploadPassport(p, c) },
  { key: 'photo',    name: 'Photo',        label: 'photo',        file: 'photoPath',
    modals: ['Labor Passport Photo Upload Instructions', 'Upload Photo'], button: /^(submit|upload|save|confirm|done)\b/i, redo: (p, c) => uploadPhoto(p, c) },
]
const UPLOAD_MODAL_TITLES = FORM_SECTIONS.flatMap(s => s.modals)

/** What the form shows right now, read from the page itself. */
export async function readPoliceForm(page) {
  return page.evaluate((sections, modalTitles) => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const exact = (t) => Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p,strong,b,label'))
      .filter(el => (el.textContent || '').trim() === t && el.children.length <= 2 && visible(el))
    const body = document.body?.innerText || ''
    const rows = {}
    for (const s of sections) {
      const head = Array.from(document.querySelectorAll('*')).find(el => {
        const t = (el.textContent || '').trim()
        return (t === s.name || t === s.name + '✓') && el.children.length <= 2 && visible(el)
      })
      if (!head) { rows[s.key] = { state: 'unknown' }; continue }
      // The row: the largest box around the heading that is still one row high.
      let row = head
      for (let cur = head.parentElement; cur && cur.getBoundingClientRect().height < 160; cur = cur.parentElement) row = cur
      const text = (row.innerText || '').replace(/\s+/g, ' ').trim()
      const startBtn = Array.from(row.querySelectorAll('button')).some(b => /^(add|upload)$/i.test((b.textContent || '').trim()) && visible(b))
      const required = /required/i.test(text)
      rows[s.key] = { state: required && startBtn ? 'missing' : 'done', text: text.slice(0, 120) }
    }
    return {
      requestOpen: exact('Add Police Certificate Request').length > 0 || body.includes('Add Police Certificate Request'),
      openModals: modalTitles.filter(t => exact(t).length > 0),
      uploadError: /error during upload|invalid type/i.test(body),
      rows,
    }
  }, FORM_SECTIONS.map(s => ({ key: s.key, name: s.name })), UPLOAD_MODAL_TITLES)
}

/** Close one upload window with its own ✕ (Escape only as a last resort). */
async function closeUploadModal(page, title, ctx) {
  const clicked = await page.evaluate((title) => {
    const head = Array.from(document.querySelectorAll('*'))
      .find(el => (el.textContent || '').trim() === title && el.children.length <= 2 && el.getBoundingClientRect().width > 0)
    if (!head) return 'gone'
    let box = head
    while (box && (box.getBoundingClientRect().width < 250 || box.getBoundingClientRect().height < 150)) box = box.parentElement
    if (!box) return false
    const top = box.getBoundingClientRect().top
    const x = Array.from(box.querySelectorAll('button,[role=button],[aria-label]')).find(b => {
      const r = b.getBoundingClientRect()
      const t = (b.textContent || '').trim()
      return r.width > 0 && r.top - top < 90 && (t.length <= 2 || /close/i.test(b.getAttribute('aria-label') || ''))
    })
    if (!x) return false
    x.click()
    return true
  }, title).catch(() => false)
  if (clicked === 'gone') return
  await settle(page, { maxMs: 2000 })
  if (!clicked || await modalOpen(page, title)) {
    await page.keyboard.press('Escape').catch(() => {})
    await waitModalGone(page, title, 3000)
  }
  if (await modalOpen(page, title)) log(ctx, `  could not close the leftover "${title}" window`, 'warn')
  else log(ctx, `  closed the leftover "${title}" window`)
}

/**
 * Before the form is handed to a person: check every section — in the page
 * and, when JEV is available, on a screenshot — and redo what is missing.
 * Throws (the run is retried) rather than hand over a half-filled form.
 */
export async function stepVerifyForm(page, ctx) {
  const reasons = {}
  let missing = []
  for (let pass = 1; pass <= 3; pass++) {
    await settle(page)
    const form = await readPoliceForm(page)
    if (!form.requestOpen) throw new Error('The Add Police Certificate Request form closed before it was complete — will retry')

    let seen = null
    const shot = await page.screenshot({ type: 'png' }).catch(() => null)
    if (shot) {
      seen = await lookAtPage(shot, {
        slip: 'Is the "Payment Slip" item of this form completed (uploaded / green), not still required?',
        passport: 'Is the "Passport" item of this form completed (uploaded / green), not still required?',
        photo: 'Is the "Photo" item of this form completed (uploaded / green), not still required?',
        left: 'Is anything on this form still empty, marked "Required", showing a red error, or is an upload window still open?',
      })
      if (!seen && !ctx.__jevWhy) {
        ctx.__jevWhy = lookUnavailableReason() || 'JEV did not answer'
        log(ctx, `JEV could not look at the form (${ctx.__jevWhy}) — checking it by reading the page only`, 'warn')
      }
    }

    missing = []
    for (const sec of FORM_SECTIONS) {
      let dom = form.rows[sec.key]?.state || 'unknown'
      // "Required" still printed, but the row changed after our upload went
      // through: LMIS just keeps the word — the section is in.
      if (dom === 'missing' && ctx.__sectionOk?.[sec.key] === true &&
          ctx.__rowBefore?.[sec.key] && form.rows[sec.key].text !== ctx.__rowBefore[sec.key]) dom = 'done'
      const jev = seen ? seen[sec.key] : null
      let gone =
        (dom === 'missing' && !(jev !== null && jev >= 0.9)) || // page says missing (JEV can overrule only when sure)
        (dom === 'done' && jev !== null && jev <= 0.1) ||       // JEV sure it is not done
        (dom === 'unknown' && jev !== null && jev < 0.5)
      if (sec.modals.some(t => form.openModals.includes(t))) gone = true // its window was left open
      if (ctx.__sectionOk?.[sec.key] === false) gone = true             // its upload did not go through
      if (gone) missing.push(sec)
    }
    log(ctx, `check ${pass}/3: ${FORM_SECTIONS.map(s => `${s.key}=${form.rows[s.key]?.state}${seen ? `/jev ${seen[s.key] ?? '-'}` : ''}`).join(' ')}` +
      `${form.openModals.length ? ` open windows: ${form.openModals.join(', ')}` : ''}${form.uploadError ? ' (an upload error is shown)' : ''}` +
      `${seen?.left != null ? ` jev-left=${seen.left}` : ''}`)

    if (!missing.length) {
      if (seen?.left != null && seen.left >= 0.9) {
        log(ctx, 'JEV still sees something unfinished on the form, but every section checks out — telling the person to look', 'warn')
        ctx.__jevDoubt = true
      }
      log(ctx, '✓ form complete — slip, passport and photo are all in')
      return
    }
    if (pass === 3) break

    for (const sec of missing) {
      // Its upload window is still open with the file in it: press its
      // button again rather than throw the upload away.
      const last = sec.modals[sec.modals.length - 1]
      if (form.openModals.includes(last) && await uploadState(page, last) === 'complete') {
        log(ctx, `↻ ${sec.label}: its window is still open with the file uploaded — finishing it`, 'warn')
        if (await finishUploadWindow(page, ctx, last, sec.button, sec.name)) {
          ;(ctx.__sectionOk ||= {})[sec.key] = true
          continue
        }
      }
      for (const t of sec.modals) if (await modalOpen(page, t)) await closeUploadModal(page, t, ctx)
      const file = ctx[sec.file]
      if (!file || !fs.existsSync(file)) { reasons[sec.key] = `Profile is missing the ${sec.label} file`; continue }
      log(ctx, `↻ ${sec.label} is not in the form — doing it again`, 'warn')
      await runSection(page, ctx, sec)
      if (ctx.__sectionOk[sec.key] === false) reasons[sec.key] = ctx.__sectionWhy?.[sec.key]
    }
    // Only missing files left: checking again cannot help.
    if (missing.every(s => /^Profile is missing/.test(reasons[s.key] || ''))) break
  }

  const list = missing.map(s => reasons[s.key] || `${s.label} did not stick on LMIS`)
  throw new Error(`LMIS form not complete: ${list.join('; ')}`)
}

export async function stepNotifyHumanSubmit(page, ctx) {
  log(ctx, '🖐 reached final step — human must click "Submit Request"', 'warn')
  await ctx.notify(
    `✅ ${ctx.profileName}: police certificate ready for final submit`,
    `Labor ID ${ctx.labor_id} — slip, passport and photo uploaded and checked. ` +
    (ctx.__jevDoubt ? 'JEV thinks something may still be off — look closely. ' : '') +
    (ctx.__jevWhy ? `JEV did not check this form (${ctx.__jevWhy}) — look it over before you submit. ` : '') +
    `Open the LMIS tab and click "Submit Request" yourself.`,
    'info'
  )
}

// ============================================================================
// RUNNER
// ============================================================================

export async function runFullWorkflow(page, ctx) {
  page.__ctx = ctx
  const workflowId = ctx.workflowId || 'police_certificate'
  const t0 = Date.now()

  // Wafid medical booking: fills the form and waits for a person to save.
  if (String(workflowId).startsWith('wafid')) {
    try {
      const { runWafidBooking } = await import('./wafidWorkflow.js')
      return await runWafidBooking(page, ctx)
    } catch (e) {
      if (e?.cancelled) throw e
      const secs = Math.round((Date.now() - t0) / 1000)
      log(ctx, `wafid booking failed after ${secs}s: ${e.message}`, 'error')
      return { ok: false, step: 'wafid', error: e.message, seconds: secs }
    }
  }

  // Every Musaned workflow (musaned_add_candidate, musaned_login) runs the
  // Musaned runner. Matching only one id sent Musaned jobs into the LMIS login.
  if (String(workflowId).startsWith('musaned')) {
    try {
      return await runMusanedWorkflow(page, ctx)
    } catch (e) {
      const secs = Math.round((Date.now() - t0) / 1000)
      log(ctx, `musaned workflow failed after ${secs}s: ${e.message}`, 'error')
      await dumpPageState(page, ctx, 'musaned')
      return { ok: false, step: 'musaned', error: e.message, seconds: secs }
    }
  }

  // No point opening LMIS when the form cannot be finished.
  const noFile = FORM_SECTIONS.filter(sec => !ctx[sec.file] || !fs.existsSync(ctx[sec.file]))
  if (noFile.length) {
    const error = `Profile is missing the ${noFile.map(sec => sec.label).join(', ')} file${noFile.length > 1 ? 's' : ''}`
    log(ctx, error, 'error')
    return { ok: false, step: 'preflight', error, seconds: 0 }
  }

  try {
    await stepLogin(page, ctx)
  } catch (e) {
    log(ctx, `login failed: ${e.message}`, 'error')
    await dumpPageState(page, ctx, 'login')
    return { ok: false, step: 'login', error: e.message, seconds: Math.round((Date.now() - t0) / 1000) }
  }

  const plan = [
    ['direct-navigate',  stepDirectNavigate],
    ['add-new',          stepAddNew],
    ['search-worker',    stepSearchAndFindWorker],
    ['upload-documents', stepUploadDocuments],
    ['verify-form',      stepVerifyForm],
    ['notify-human',     stepNotifyHumanSubmit],
  ]

  for (const [name, fn] of plan) {
    try {
      await fn(page, ctx)
    } catch (e) {
      const secs = Math.round((Date.now() - t0) / 1000)
      log(ctx, `step "${name}" failed after ${secs}s: ${e.message}`, 'error')
      await dumpPageState(page, ctx, name)
      return { ok: false, error: e.message, step: name, seconds: secs }
    }
  }

  const secs = Math.round((Date.now() - t0) / 1000)
  log(ctx, `police certificate workflow completed in ${secs}s`)
  return { ok: true, seconds: secs }
}