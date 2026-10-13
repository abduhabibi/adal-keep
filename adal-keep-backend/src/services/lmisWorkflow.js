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
 *       file → Add. Adds convertToPdf and closeAllModals.
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


const LMIS_BASE = 'https://lmis.gov.et'
const POLICE_URL = 'https://lmis.gov.et/new-agency/police-certificate'
const DEFAULT_TIMEOUT = 60000
const PAGE_READY_TIMEOUT = 240000
const STEP_GOTO_TIMEOUT = 240000
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
  const line = `${STEP_LOG_PREFIX} lane=${ctx.laneId} profile=${ctx.profileId} :: ${msg}`
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

export async function closePopups(page, ctx = null) {
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
  if (n > 0 && ctx) log(ctx, `closed ${n} popup(s)`)
  await sleep(300)
  return n
}

async function isLoading(page) {
  return await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
      .filter(b => {
        const r = b.getBoundingClientRect()
        return r.width > 5 && r.height > 5
      })
    return btns.length === 0
  })
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

async function uploadByKeyword(page, keyword, filePath, fallbackIndex = null) {
  if (!filePath || !fs.existsSync(filePath)) return false
  const handles = await page.$$('input[type="file"]')
  for (const handle of handles) {
    const meta = await page.evaluate(el => ({
      name: el.name || '', id: el.id || '', accept: el.accept || '', cls: el.className || '',
    }), handle)
    const hay = `${meta.name} ${meta.id} ${meta.accept} ${meta.cls}`.toLowerCase()
    if (hay.includes(keyword.toLowerCase())) {
      try { await handle.uploadFile(filePath); return true } catch {}
    }
  }
  if (fallbackIndex !== null && handles[fallbackIndex]) {
    try { await handles[fallbackIndex].uploadFile(filePath); return true } catch {}
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
  log(ctx, 'opening login page')
  try {
    await page.goto(`${LMIS_BASE}/auth`, { waitUntil: 'domcontentloaded', timeout: 240000 })
  } catch (e) {
    log(ctx, `login navigation threw: ${e.message}`, 'warn')
  }

  log(ctx, 'checking login state (up to 30s)')
  const deadline = Date.now() + 30000
  let state = 'unknown'

  while (Date.now() < deadline) {
    const url = page.url()
    if (url.includes('/personal-dashboard') || url.includes('/new-agency')) {
      state = 'already-logged-in'
      break
    }
    const hasPw = await page.$('input[type="password"]').catch(() => null)
    if (hasPw) {
      state = 'login-form'
      break
    }
    await sleep(500)
  }

  if (state === 'already-logged-in') {
    log(ctx, 'already logged in — skipping form fill')
    await sleep(1500)
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

  log(ctx, 'waiting for URL to change away from /auth (up to 60s)')
  const urlDeadline = Date.now() + 60000
  while (Date.now() < urlDeadline) {
    const url = page.url()
    if (!url.includes('/auth') && !url.includes('/login')) break
    await sleep(500)
  }

  log(ctx, `post-login URL: ${page.url()}`)
  await sleep(2000)
  await closePopups(page, ctx)
  log(ctx, 'logged in')
}

/**
 * The portal shows a blank page when the police URL is opened cold (recent runs
 * stalled there). A person reaches the page through the dashboard menu, so the
 * job does the same: Organizations -> EOW -> Police Certificate. The menu is
 * logged, so the real labels can be checked from the run log.
 */
async function openPoliceFromDashboard(page, ctx) {
  if (!page.url().includes('/personal-dashboard')) return false
  await page.waitForFunction(() => (document.body?.innerText || '').length > 200, { timeout: 20000 }).catch(() => {})

  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('a,button,[role=menuitem],li,span,div'))
    .map(el => (el.textContent || '').trim()).filter(t => t && t.length < 50))
  log(ctx, `dashboard menu: ${[...new Set(menu)].slice(0, 60).join(' | ')}`)

  const clickMenu = (source) => page.evaluate((src) => {
    const rx = new RegExp(src, 'i')
    const els = Array.from(document.querySelectorAll('a,button,[role=menuitem],li,span,div'))
      .filter(el => el.tagName === 'A' || el.tagName === 'BUTTON' || el.children.length === 0)
    const hit = els.find(el => rx.test((el.textContent || '').trim()) && (el.textContent || '').trim().length < 50)
    if (!hit) return false
    hit.click()
    return true
  }, source)

  if (await clickMenu('^organi[sz]ations?$')) { log(ctx, 'menu: Organizations'); await sleep(1500) }
  if (await clickMenu('^EOW$')) { log(ctx, 'menu: EOW'); await sleep(1500) }
  if (!(await clickMenu('police'))) { log(ctx, 'menu: no Police Certificate item found, using direct URL', 'warn'); return false }
  log(ctx, 'menu: Police Certificate')

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (page.url().includes('police-certificate')) return true
    await sleep(500)
  }
  return page.url().includes('police-certificate')
}

export async function stepDirectNavigate(page, ctx) {
  const viaMenu = await openPoliceFromDashboard(page, ctx).catch(e => {
    log(ctx, `menu route failed: ${e.message}`, 'warn')
    return false
  })
  if (!viaMenu) {
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

  while (Date.now() - start < PAGE_READY_TIMEOUT) {
    const elapsed = Math.round((Date.now() - start) / 1000)
    const url = page.url()

    // The portal's own error page: waiting or retrying only logs in again and again.
    const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '')
    // LMIS blocks the whole police page until the agency's bank account is on file.
    if (/No Bank Account Found/i.test(pageText)) {
      log(ctx, 'LMIS blocks the police page: "No Bank Account Found" — the agency must submit its bank account to LMIS (Kazanchis office)', 'error')
      throw new Error('LMIS blocks this agency: "No Bank Account Found". The agency must submit its bank account to LMIS at the Kazanchis office. Not retried.')
    }
    const portalError = /Something Went Wrong/i.test(pageText)
    if (portalError) {
      log(ctx, 'LMIS shows "Something Went Wrong" on the police page — stopping (portal error, not retried)', 'error')
      throw new Error('LMIS portal error: the police certificate page shows "Something Went Wrong". Try again later.')
    }

    if (url.includes('/auth') || url.includes('/login')) {
      log(ctx, `redirected to login at ${elapsed}s — session lost`, 'error')
      throw new Error('Session lost — LMIS redirected to login')
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

    await sleep(1000)
  }

  if (!ready) {
    const url = page.url()
    log(ctx, `timed out after ${PAGE_READY_TIMEOUT / 1000}s — url=${url}`, 'error')
    const preview = await page.evaluate(() => (document.body?.innerText || '').slice(0, 400))
    log(ctx, `body: ${preview.replace(/\n/g, ' | ')}`, 'error')
    throw new Error('Police certificate page never became ready')
  }

  await sleep(500)
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
  await sleep(800)
  await closePopups(page, ctx)
}

export async function stepFillLaborIdAndNext(page, ctx) {
  log(ctx, `filling Labor ID: "${ctx.labor_id}"`)

  let inp = await page.$('input[placeholder*="labor" i]')
  if (!inp) inp = await page.$('input[placeholder*="search" i]')
  if (!inp) {
    const inputs = await page.$$('input[type="text"], input:not([type])')
    for (const i of inputs) {
      const visible = await page.evaluate(el => {
        const r = el.getBoundingClientRect()
        return r.width > 20 && r.height > 10 && r.top >= 0 && r.top < window.innerHeight
      }, i)
      if (visible) { inp = i; break }
    }
  }
  if (!inp) {
    await ctx.notify(
      `❌ ${ctx.profileName}: Labor ID input missing`,
      'Add New modal opened but no search input was found.'
    )
    throw new Error('Labor ID input not found')
  }

  await inp.click({ clickCount: 3 })
  await inp.type(String(ctx.labor_id), { delay: 40 })
  log(ctx, 'labor id typed')
  await sleep(500)

  log(ctx, 'clicking Search')
  let sr = await clickByText(page, 'Search', { timeout: 8000, exact: true })
  if (!sr.ok) {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      const target = btns.find(b => (b.textContent || '').trim().toLowerCase() === 'search')
      if (target) { target.click(); return true }
      return false
    })
    if (!clicked) {
      log(ctx, 'Search button not found — pressing Enter instead', 'warn')
      await page.keyboard.press('Enter')
    }
  }
  log(ctx, 'Search clicked')

  log(ctx, 'waiting for search result (up to 30s)')
  const deadline = Date.now() + 30000
  let resultFound = false
  let emptyMarkers = 0

  while (Date.now() < deadline) {
    const state = await page.evaluate((laborId) => {
      const body = document.body?.innerText || ''
      const stillEmpty = body.includes('Search And Select A Labor To Continue')
      const noData = body.includes('No data') || body.includes('No result') || body.includes('not found')
      const hasLabor = body.includes(laborId)
      return { stillEmpty, noData, hasLabor }
    }, ctx.labor_id)

    if (state.hasLabor && !state.stillEmpty) { resultFound = true; break }
    if (state.noData) { emptyMarkers++; if (emptyMarkers >= 3) break }
    await sleep(500)
  }

  if (!resultFound) {
    log(ctx, `no result for labor ID "${ctx.labor_id}"`, 'error')
    await ctx.notify(
      `❌ ${ctx.profileName}: Labor ID not found`,
      `LMIS returned no worker for Labor ID "${ctx.labor_id}". Check the ID and try again.`
    )
    throw new Error('Labor ID not found in LMIS')
  }

  log(ctx, `✓ result found for "${ctx.labor_id}"`)

  const selected = await page.evaluate((laborId) => {
    const all = Array.from(document.querySelectorAll('div, li, tr, article, [role="button"]'))
    const candidates = all.filter(e => {
      const t = e.textContent || ''
      const r = e.getBoundingClientRect()
      return r.width > 200 && r.height > 40 && r.top > 0 && r.top < window.innerHeight && t.includes(laborId)
    })
    if (candidates.length === 0) return false
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      return (ra.width * ra.height) - (rb.width * rb.height)
    })
    candidates[0].click()
    return true
  }, ctx.labor_id)

  if (!selected) {
    log(ctx, 'could not click the result card — trying any clickable inside the modal', 'warn')
    await clickByText(page, ctx.labor_id, { timeout: 5000 })
  }
  await sleep(1500)

  log(ctx, 'looking for Next button')
  let nextRes = await clickByText(page, 'Next', { timeout: 8000, exact: true })
  if (nextRes.ok) {
    log(ctx, 'Next clicked')
    await sleep(1500)
  } else {
    log(ctx, 'no Next button — the modal may go straight to agreement', 'warn')
  }
  await closePopups(page, ctx)

  log(ctx, 'checking for agreement checkbox')
  const checkboxState = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .filter(cb => {
        const r = cb.getBoundingClientRect()
        return r.width > 3 && r.height > 3 && r.top >= 0 && r.top < window.innerHeight
      })
    let clicked = 0
    for (const cb of boxes) {
      if (!cb.checked) { cb.click(); clicked++ }
    }
    return { found: boxes.length, clicked }
  })
  log(ctx, `checkbox scan: found=${checkboxState.found} clicked=${checkboxState.clicked}`)

  if (checkboxState.found === 0) {
    const agreeClick = await clickByText(page, 'I agree', { timeout: 3000 })
    if (!agreeClick.ok) await clickByText(page, 'agree', { timeout: 3000 })
  }
  await sleep(800)

  log(ctx, 'looking for Continue / Confirm')
  const continueCandidates = ['Continue', 'Confirm', 'Proceed', 'Next', 'Submit']
  let advance = null
  for (const label of continueCandidates) {
    const r = await clickByText(page, label, { timeout: 3000 })
    if (r.ok) { advance = label; break }
  }
  if (advance) {
    log(ctx, `clicked "${advance}"`)
    await sleep(2500)
  } else {
    log(ctx, 'no advance button — proceeding to uploads anyway', 'warn')
  }

  await closePopups(page, ctx)
  log(ctx, 'labor ID flow complete — ready for uploads')
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
    await page.evaluate(({ node, val }) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(node, val)
      node.dispatchEvent(new Event('input', { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
      node.dispatchEvent(new Event('blur', { bubbles: true }))
    }, { node: input, val: laborId })
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

  await sleep(400)

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

  await sleep(2500)
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

  log(ctx, '[1/3] payment slip')
  await uploadPaymentSlip(page, ctx)
  await sleep(1200)
  await closePopups(page, ctx)

  log(ctx, '[2/3] passport')
  await uploadPassport(page, ctx)
  await sleep(1200)
  await closePopups(page, ctx)

  log(ctx, '[3/3] photo')
  await uploadPhoto(page, ctx)
  await sleep(1200)
  await closePopups(page, ctx)

  log(ctx, '▶ all uploads done — human must click Submit Request')
}

// ---------- PAYMENT SLIP ----------
async function uploadPaymentSlip(page, ctx) {
  if (!ctx.slipPath || !fs.existsSync(ctx.slipPath)) {
    log(ctx, 'slip file not on profile — skipping', 'warn')
    return
  }

  let slipPath = ctx.slipPath
  if (!/\.pdf$/i.test(slipPath)) {
    log(ctx, 'converting slip to PDF (LMIS requires PDF)')
    const converted = await convertToPdf(slipPath)
    if (!converted) {
      log(ctx, 'could not convert slip to PDF — aborting', 'warn')
      return
    }
    slipPath = converted
  }
  const sizeMb = fs.statSync(slipPath).size / 1024 / 1024
  if (sizeMb > SLIP_MAX_MB) {
    log(ctx, `slip is ${sizeMb.toFixed(1)}MB — over LMIS ${SLIP_MAX_MB}MB limit`, 'warn')
    return
  }

  log(ctx, 'uploading payment slip')

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
  if (!clickedUpload) { log(ctx, 'Upload button not found on slip row', 'warn'); return }
  log(ctx, 'clicked Upload — waiting for Payment Instructions modal')

  const instrOpened = await waitForModal(page, 'Payment Instructions', 15000)
  if (!instrOpened) { log(ctx, 'Payment Instructions modal never appeared', 'warn'); return }
  log(ctx, 'Payment Instructions modal open')
  await sleep(600)

  const understood = await clickButtonInModal(page, 'Payment Instructions', /understand|continue/i)
  if (!understood) { log(ctx, 'I Understand button not found', 'warn'); return }
  log(ctx, '✓ clicked "I Understand — Continue"')
  await sleep(1500)

  const formOpened = await waitForModal(page, 'Upload Police Certificate Payment Slip', 15000)
  if (!formOpened) { log(ctx, 'Upload Payment Slip modal never appeared', 'warn'); return }
  log(ctx, 'Upload Payment Slip modal open')
  await sleep(600)

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

  let uploaded = await uploadFileInModal(page, 'Upload Police Certificate Payment Slip', slipPath)
  if (!uploaded) uploaded = await uploadFileToNewestInput(page, slipPath)
  log(ctx, uploaded ? '✓ slip PDF attached' : '⚠ slip file upload failed', uploaded ? 'info' : 'warn')

  await waitForUploadComplete(page, 15000, ctx, 'slip')

  // The Add button appears once LMIS finishes the upload; give it several tries.
  let added = false
  for (let attempt = 0; attempt < 8 && !added; attempt++) {
    added = await clickButtonInModal(page, 'Upload Police Certificate Payment Slip', /^add$/i)
    if (!added) await sleep(2000)
  }
  log(ctx, added ? '✓ slip modal submitted (Add clicked)' : '⚠ Add button not found after 8 tries', added ? 'info' : 'warn')
  if (!added) throw new Error('Payment slip: the Add button never appeared, so the slip was not submitted')

  await sleep(2000)
  await closeAllModals(page, ctx)
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
  await sleep(800)

  const profile = ctx.profile || {}
  const issueDate = normalizeDate(profile.passport_issue_date)
  const dob = normalizeDate(profile.date_of_birth)

  // ---- Fill fields ----
  await setReactSelect(page, 'Upload Passport Document', 'Destination Country',
                       profile.destination_country || 'Kuwait')

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

  await sleep(500)

  // ---- Attach the passport file (multi-attempt) ----
  log(ctx, 'attaching passport file...')

  let uploaded = false

  // Attempt 1: scoped to the modal by ancestor text
  uploaded = await uploadFileInModal(page, 'Upload Passport Document', pPath)
  log(ctx, `  attempt 1 (scoped to modal): ${uploaded ? '✓ success' : '✗ failed'}`)

  // Attempt 2: click the dropzone to reveal / focus the input, then retry
  if (!uploaded) {
    log(ctx, '  retrying after clicking dropzone', 'warn')
    const clickedDz = await clickDropzoneInModal(page, 'Upload Passport Document')
    log(ctx, `  dropzone click: ${clickedDz ? '✓' : '✗'}`)
    await sleep(700)
    uploaded = await uploadFileInModal(page, 'Upload Passport Document', pPath)
    log(ctx, `  attempt 2 (after dropzone): ${uploaded ? '✓ success' : '✗ failed'}`)
  }

  // Attempt 3: newest file input on the page
  if (!uploaded) {
    log(ctx, '  falling back to newest input on page', 'warn')
    uploaded = await uploadFileToNewestInput(page, pPath)
    log(ctx, `  attempt 3 (newest input): ${uploaded ? '✓ success' : '✗ failed'}`)
  }

  if (!uploaded) {
    await ctx.notify(
      `❌ ${ctx.profileName}: passport file could not be attached`,
      'All three upload strategies failed. Submit was skipped to avoid an empty upload.'
    )
    throw new Error('Passport file upload failed — no input responded')
  }

  log(ctx, '✓ passport file attached — waiting for it to render')

  // ---- Wait for the file to render in the dropzone ----
  const rendered = await waitForFileAttached(page, 'Upload Passport Document', pPath, 10000)
  log(ctx, rendered ? '✓ file visible in dropzone' : '⚠ file did not render — proceeding anyway', rendered ? 'info' : 'warn')

  await sleep(800)

  // ---- Click Submit ----
  const submitted = await clickButtonInModal(page, 'Upload Passport Document', /^submit$/i)
  log(ctx, submitted ? 'Passport modal submitted' : 'Passport modal Submit not found', submitted ? 'info' : 'warn')

  await sleep(2500)
  await closePopups(page, ctx)
}

// ---------- PHOTO ----------
async function uploadPhoto(page, ctx) {
  if (!ctx.photoPath || !fs.existsSync(ctx.photoPath)) {
    log(ctx, 'photo file missing on profile — skipping', 'warn')
    return
  }

  const photoMb = fs.statSync(ctx.photoPath).size / 1024 / 1024
  if (photoMb > PHOTO_MAX_MB) {
    log(ctx, `photo file is ${photoMb.toFixed(2)}MB — over LMIS ${PHOTO_MAX_MB}MB limit`, 'warn')
    await ctx.notify(
      `❌ ${ctx.profileName}: photo file too large`,
      `File is ${photoMb.toFixed(1)}MB, LMIS max is ${PHOTO_MAX_MB}MB.`
    )
    return
  }

  log(ctx, 'opening Photo instructions modal')
  const clickedAdd = await clickSectionAdd(page, 'Photo')
  if (!clickedAdd) { log(ctx, 'Photo Add button not found', 'warn'); return }

  const instructionsOpened = await waitForModal(page, 'Labor Passport Photo Upload Instructions', 20000)
  if (!instructionsOpened) { log(ctx, 'instructions modal never appeared', 'warn'); return }
  log(ctx, 'instructions modal open')
  await sleep(800)

  const agreed = await clickButtonInModal(page, 'Labor Passport Photo Upload Instructions', /i agree/i)
  if (!agreed) { log(ctx, 'I Agree button not found', 'warn'); return }
  log(ctx, '✓ clicked "I Agree, Continue"')

  const uploadOpened = await waitForModal(page, 'Upload Photo', 15000)
  if (!uploadOpened) { log(ctx, 'Upload Photo modal did not appear', 'warn'); return }
  log(ctx, 'Upload Photo modal open')
  await sleep(800)

  // Multi-attempt attach
  let uploaded = await uploadFileInModal(page, 'Upload Photo', ctx.photoPath)
  if (!uploaded) {
    log(ctx, 'scoped upload failed — clicking dropzone to reveal input', 'warn')
    await clickDropzoneInModal(page, 'Upload Photo')
    await sleep(700)
    uploaded = await uploadFileInModal(page, 'Upload Photo', ctx.photoPath)
  }
  if (!uploaded) uploaded = await uploadFileToNewestInput(page, ctx.photoPath)
  log(ctx, uploaded ? '✓ photo file attached' : '⚠ photo upload failed', uploaded ? 'info' : 'warn')

  if (uploaded) {
    const rendered = await waitForFileAttached(page, 'Upload Photo', ctx.photoPath, 10000)
    log(ctx, rendered ? '✓ photo visible in dropzone' : '⚠ photo did not render', rendered ? 'info' : 'warn')
  }

  const uploadedDeadline = Date.now() + 20000
  let uploadComplete = false
  while (Date.now() < uploadedDeadline) {
    const done = await page.evaluate(() => {
      const body = document.body?.innerText || ''
      return body.includes('Upload Complete') || body.includes('Tap To Undo')
    })
    if (done) { uploadComplete = true; break }
    await sleep(400)
  }
  log(ctx, uploadComplete ? 'Upload Complete indicator seen' : 'Upload Complete indicator never appeared', uploadComplete ? 'info' : 'warn')

  log(ctx, 'clicking Submit inside Upload Photo modal')
  const submitted = await clickButtonInModal(page, 'Upload Photo', /^submit$/i)
  if (submitted) {
    log(ctx, '✓ Upload Photo modal submitted')
  } else {
    log(ctx, 'Upload Photo Submit button not found — human will click it', 'warn')
  }

  await sleep(2000)
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

async function closeAllModals(page, ctx) {
  try { await page.keyboard.press('Escape') } catch {}
  await sleep(300)
  try { await page.keyboard.press('Escape') } catch {}
  await sleep(400)

  await page.evaluate(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-label]'))
      .filter(b => {
        const r = b.getBoundingClientRect()
        if (r.width < 5 || r.height < 5) return false
        if (r.top > vh * 0.5) return false
        if (r.left < vw * 0.4) return false
        const t = (b.textContent || '').trim()
        const aria = b.getAttribute('aria-label') || ''
        return t.length <= 3 || /close|dismiss/i.test(aria)
      })
    for (const b of candidates) { try { b.click() } catch {} }
  })
  await sleep(500)

  let stillBlocking = await page.evaluate(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    return Array.from(document.querySelectorAll('*')).some(el => {
      const r = el.getBoundingClientRect()
      if (r.width < vw * 0.8 || r.height < vh * 0.8) return false
      const style = window.getComputedStyle(el)
      return style.position === 'fixed' && parseFloat(style.zIndex || 0) > 100
        && style.pointerEvents !== 'none'
    })
  })

  if (stillBlocking) {
    if (ctx) log(ctx, 'overlay still open — clicking outside to dismiss', 'warn')
    try {
      await page.mouse.click(30, 200)
    } catch {}
    await sleep(500)
    stillBlocking = await page.evaluate(() => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      return Array.from(document.querySelectorAll('*')).some(el => {
        const r = el.getBoundingClientRect()
        if (r.width < vw * 0.8 || r.height < vh * 0.8) return false
        const style = window.getComputedStyle(el)
        return style.position === 'fixed' && parseFloat(style.zIndex || 0) > 100
          && style.pointerEvents !== 'none'
      })
    })
  }

  if (stillBlocking && ctx) log(ctx, 'overlay still open after all dismiss attempts', 'warn')
  else if (ctx) log(ctx, 'all modals closed', 'info')
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

async function findFileInputNear(page, containerText, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const handles = await page.$$('input[type="file"]')
    for (const h of handles) {
      const match = await page.evaluate(({ node, needle }) => {
        let cur = node
        for (let d = 0; d < 12 && cur; d++) {
          const t = (cur.textContent || '')
          if (t.includes(needle)) return true
          cur = cur.parentElement
        }
        return false
      }, { node: h, needle: containerText })
      if (match) return h
    }
    await sleep(500)
  }
  return null
}

async function waitForUploadComplete(page, timeoutMs, ctx, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => {
      const body = document.body?.innerText || ''
      return body.includes('Upload Complete') || body.includes('Tap To Undo')
    })
    if (done) {
      log(ctx, `✓ ${label} shows Upload Complete`)
      return true
    }
    await sleep(400)
  }
  log(ctx, `${label} Upload Complete indicator did not appear`, 'warn')
  return false
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

  if (!opened) return
  await sleep(500)
  await page.keyboard.type(String(value), { delay: 60 })
  await sleep(900)
  await page.keyboard.press('Enter')
  await sleep(400)
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
async function uploadFileInModal(page, modalTitle, filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false
  const handles = await page.$$('input[type="file"]')
  if (handles.length === 0) return false

  for (const h of handles) {
    const inModal = await page.evaluate(({ node, modalTitle }) => {
      let cur = node
      for (let d = 0; d < 15 && cur; d++) {
        const t = cur.textContent || ''
        // Scan up to 5000 chars — enough to include the modal title even
        // for the outer modal wrapper.
        if (t.length < 5000 && t.includes(modalTitle)) return true
        cur = cur.parentElement
      }
      return false
    }, { node: h, modalTitle })

    if (inModal) {
      try { await h.uploadFile(filePath); return true } catch {}
    }
  }
  return false
}

/**
 * Click the "Drag & Drop Your Files Or Browse" area inside a modal.
 * Sometimes reveals or focuses the hidden file input.
 */
async function clickDropzoneInModal(page, modalTitle) {
  return await page.evaluate((title) => {
    const all = Array.from(document.querySelectorAll('*'))
    let modal = null
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150) continue
      if ((el.textContent || '').slice(0, 400).includes(title)) { modal = el; break }
    }
    if (!modal) return false
    // Find the smallest element whose text contains "Drag & Drop" or "Browse"
    const candidates = Array.from(modal.querySelectorAll('*'))
      .filter(el => {
        const t = (el.textContent || '').trim()
        return /drag\s*&\s*drop|browse/i.test(t) && t.length < 200
      })
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)
    if (candidates.length === 0) return false
    try { candidates[0].click(); return true } catch { return false }
  }, modalTitle)
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
      const all = Array.from(document.querySelectorAll('*'))
      let modal = null
      for (const el of all) {
        const r = el.getBoundingClientRect()
        if (r.width < 250 || r.height < 150) continue
        if ((el.textContent || '').slice(0, 400).includes(title)) { modal = el; break }
      }
      if (!modal) return false
      const text = (modal.textContent || '').toLowerCase()
      return text.includes(needle) ||
             text.includes('upload complete') ||
             text.includes('tap to undo')
    }, { title: modalTitle, needle })
    if (attached) return true
    await sleep(400)
  }
  return false
}

async function uploadFileToNewestInput(page, filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false
  const handles = await page.$$('input[type="file"]')
  if (handles.length === 0) return false
  for (let i = handles.length - 1; i >= Math.max(0, handles.length - 3); i--) {
    try { await handles[i].uploadFile(filePath); return true } catch {}
  }
  return false
}

async function clickDropzoneAndUpload(page, filePath) {
  const clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('*'))
    const dz = all.find(el => {
      const t = (el.textContent || '').trim()
      return /drag\s*&\s*drop|browse/i.test(t) && t.length < 200
    })
    if (dz) { dz.click(); return true }
    return false
  })
  if (!clicked) return false
  await sleep(800)
  return await uploadFileToNewestInput(page, filePath)
}

export async function stepNotifyHumanSubmit(page, ctx) {
  log(ctx, '🖐 reached final step — human must click "Submit Request"', 'warn')
  await ctx.notify(
    `✅ ${ctx.profileName}: police certificate ready for final submit`,
    `Labor ID ${ctx.labor_id} — slip, passport, and photo uploaded. ` +
    `Open the LMIS tab, verify, and click "Submit Request" yourself.`,
    'info'
  )
}

export async function stepUploads(page, ctx) {
  log(ctx, 'scanning for file inputs')

  const inputs = await page.$$('input[type="file"]')
  log(ctx, `found ${inputs.length} file input(s)`)

  const inputsMeta = []
  for (let i = 0; i < inputs.length; i++) {
    const meta = await page.evaluate(el => {
      let context = ''
      let cur = el
      for (let d = 0; d < 6 && cur; d++) {
        const t = (cur.textContent || '').trim()
        if (t && t.length < 120) { context = t; break }
        cur = cur.parentElement
      }
      return {
        name: (el.name || '').toLowerCase(),
        id: (el.id || '').toLowerCase(),
        accept: (el.accept || '').toLowerCase(),
        cls: (el.className || '').toLowerCase(),
        context: context.toLowerCase(),
        visible: (() => {
          const r = el.getBoundingClientRect()
          return r.width > 5 && r.height > 5
        })(),
      }
    }, inputs[i])
    inputsMeta.push({ index: i, ...meta })
    log(ctx, `  input[${i}]: name="${meta.name}" id="${meta.id}" accept="${meta.accept}" ctx="${meta.context.slice(0, 60)}" visible=${meta.visible}`)
  }

  if (inputs.length === 0) {
    log(ctx, 'no file inputs on the page — uploads cannot proceed', 'warn')
    await ctx.notify(
      `⚠️ ${ctx.profileName}: no file upload slots found`,
      'The police certificate form did not show any upload fields after advancing.'
    )
    return
  }

  const pickInput = (keywords, fallbackIndex) => {
    for (const kw of keywords) {
      const hit = inputsMeta.find(m => {
        const hay = `${m.name} ${m.id} ${m.accept} ${m.cls} ${m.context}`
        return hay.includes(kw)
      })
      if (hit) return hit.index
    }
    if (fallbackIndex !== null && inputsMeta[fallbackIndex]) return fallbackIndex
    return null
  }

  const jobs = [
    { label: 'personal photo', path: ctx.photoPath,    keywords: ['photo', 'personal', 'picture', 'portrait'], fallback: 0 },
    { label: 'passport',       path: ctx.passportPath, keywords: ['passport', 'pdf', 'travel'],                 fallback: 1 },
    { label: 'full body',      path: ctx.fullBodyPath, keywords: ['body', 'full', 'fullbody'],                  fallback: 2 },
  ]

  for (const j of jobs) {
    if (!j.path) { log(ctx, `${j.label}: no file to upload`, 'warn'); continue }
    if (!fs.existsSync(j.path)) { log(ctx, `${j.label}: file missing on disk`, 'warn'); continue }

    const idx = pickInput(j.keywords, j.fallback)
    if (idx === null) {
      log(ctx, `${j.label}: no matching input slot`, 'warn')
      await ctx.notify(
        `⚠️ ${ctx.profileName}: ${j.label} could not be uploaded`,
        'No matching file input was found on the LMIS page.'
      )
      continue
    }

    // LMIS rejects files over 2 MB: shrink passport images, stop if that is not possible
    let upPath = j.path
    if (j.label === 'passport') upPath = await passportUploadFile(j.path)
    try {
      await inputs[idx].uploadFile(upPath)
      log(ctx, `✓ uploaded ${j.label} → input[${idx}] (${path.basename(upPath)})`)
    } catch (e) {
      log(ctx, `✗ ${j.label} upload failed: ${e.message}`, 'error')
      await ctx.notify(
        `❌ ${ctx.profileName}: ${j.label} upload failed`,
        e.message
      )
    }
    await sleep(1200)
    await closePopups(page, ctx)
  }

  log(ctx, 'all uploads attempted')

  await sleep(1500)
  const previewCount = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'))
      .filter(i => {
        const r = i.getBoundingClientRect()
        const src = i.src || ''
        return r.width > 40 && r.height > 40 && (src.startsWith('blob:') || src.startsWith('data:'))
      })
    return imgs.length
  })
  log(ctx, `${previewCount} upload preview image(s) detected on the page`)
}

export async function stepHumanConfirm(page, ctx) {
  log(ctx, 'reached human confirmation — pausing for user', 'warn')
  await ctx.notify(
    `✅ ${ctx.profileName}: police certificate ready for your confirmation`,
    `All steps completed for Labor ID ${ctx.labor_id}. Open the browser, verify the form, and click Submit. Then mark this run as Done from the dashboard.`
  )
  return
}

// ============================================================================
// RUNNER
// ============================================================================

export async function runFullWorkflow(page, ctx) {
  page.__ctx = ctx
  const workflowId = ctx.workflowId || 'police_certificate'
  const t0 = Date.now()

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