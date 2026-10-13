/**
 * lmisWorkflow.js — Police Certificate workflow for LMIS.
 *
 * v23 — Musaned dispatcher collapsed to a single branch.
 *
 *   `musaned_add_candidate` and `musaned_login` now share one dispatch
 *   through runMusanedWorkflow (the login state machine handles both the
 *   login and the add-candidate flow). The previous standalone
 *   `musaned_add_candidate` branch called runMusanedCandidateWorkflow, which
 *   was never imported and crashed at runtime with "not defined".
 *
 *   The `|| workflowId === 'musaned_login'` half is a safety net for any
 *   pending queue rows still carrying the old workflow ID.
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

const SLIP_MAX_MB = 5
const PASSPORT_MAX_MB = 2
const PHOTO_MAX_MB = 2

if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true })

// ============================================================================
// HELPERS
// ============================================================================

function log(ctx, msg, level = 'info') {
  const line = `${STEP_LOG_PREFIX} lane=${ctx.laneId} profile=${ctx.profileId} :: ${msg}`
  console.log(line)
  if (ctx.onLog) ctx.onLog(level, msg)
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitForAnyText(page, needles, timeoutMs = DEFAULT_TIMEOUT) {
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

async function closePopups(page, ctx = null) {
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

async function clickByText(page, label, opts = {}) {
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

async function dumpPageState(page, ctx, stepName) {
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

export async function stepDirectNavigate(page, ctx) {
  log(ctx, `navigating to ${POLICE_URL}`)
  try {
    await page.goto(POLICE_URL, { waitUntil: 'domcontentloaded', timeout: STEP_GOTO_TIMEOUT })
  } catch (e) {
    log(ctx, `navigation threw: ${e.message}`, 'warn')
  }

  log(ctx, `waiting for police certificate page (up to ${PAGE_READY_TIMEOUT / 1000}s)`)
  const start = Date.now()
  let lastLogAt = 0
  let ready = false

  while (Date.now() - start < PAGE_READY_TIMEOUT) {
    const elapsed = Math.round((Date.now() - start) / 1000)
    const url = page.url()

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
  } else {
    log(ctx, 'no order_id and no labor_id — Transaction field left empty', 'warn')
  }

  const uploaded = await attachFileToModal(page, 'Upload Police Certificate Payment Slip', slipPath, ctx)
  log(ctx, uploaded ? '✓ slip PDF sent to input' : '✗ slip file could not be attached', uploaded ? 'info' : 'error')

  log(ctx, 'waiting for Upload Complete signal...')
  const success = await waitForUploadSuccess(page, 'Upload Police Certificate Payment Slip', 45000, ctx)
  if (!success) {
    await ctx.notify(
      `❌ ${ctx.profileName}: slip upload did not complete`,
      'The Upload Complete indicator never appeared after 45s.'
    )
    throw new Error('Slip upload did not show Upload Complete')
  }
  log(ctx, '✓ slip upload confirmed by LMIS — settling 1.5s')
  await sleep(1500)

  const added = await clickButtonInModal(page, 'Upload Police Certificate Payment Slip', /^add$/i)
  log(ctx, added ? '✓ slip modal submitted (Add clicked)' : '⚠ Add button not found', added ? 'info' : 'warn')

  await sleep(2000)
  await closeAllModals(page, ctx)
}

// ---------- PASSPORT ----------
async function uploadPassport(page, ctx) {
  if (!ctx.passportPath || !fs.existsSync(ctx.passportPath)) {
    log(ctx, 'passport file missing on profile — skipping', 'warn')
    return
  }

  const passportMb = fs.statSync(ctx.passportPath).size / 1024 / 1024
  if (passportMb > PASSPORT_MAX_MB) {
    log(ctx, `passport file is ${passportMb.toFixed(2)}MB — over LMIS ${PASSPORT_MAX_MB}MB limit`, 'warn')
    await ctx.notify(
      `❌ ${ctx.profileName}: passport file too large`,
      `File is ${passportMb.toFixed(1)}MB, LMIS max is ${PASSPORT_MAX_MB}MB.`
    )
    return
  }

  log(ctx, 'opening Passport modal')
  const opened1 = await clickSectionAdd(page, 'Passport')
  if (!opened1) { log(ctx, 'Passport Add button not found', 'warn'); return }

  const opened = await waitForModal(page, 'Upload Passport Document', 20000)
  if (!opened) { log(ctx, 'Passport modal never appeared', 'warn'); return }
  log(ctx, 'Passport modal open')
  await sleep(800)

  const profile = ctx.profile || {}
  const issueDate = normalizeDate(profile.passport_issue_date)
  const dob = normalizeDate(profile.date_of_birth)

  await setReactSelect(page, 'Upload Passport Document', 'Destination Country',
                       profile.destination_country || 'Kuwait')

  const numFilled = await setFieldInModal(page, 'Upload Passport Document', {
    placeholderIncludes: ['EP', 'passport'],
    labelIncludes: ['Passport Number'],
    value: profile.passport_number || ''
  })
  log(ctx, numFilled ? `✓ Passport Number = "${profile.passport_number}"` : '⚠ Passport Number not found', numFilled ? 'info' : 'warn')

  if (issueDate) {
    const dateFilled = await setDateFieldByIndex(page, 'Upload Passport Document', 0, issueDate)
    log(ctx, dateFilled ? `✓ Passport Issue Date = "${issueDate}"` : '⚠ Passport Issue Date not found', dateFilled ? 'info' : 'warn')
  }

  const placeFilled = await setFieldInModal(page, 'Upload Passport Document', {
    labelIncludes: ['Passport Issued Place', 'Issued Place', 'Place of Issue'],
    value: 'Ethiopia'
  })
  log(ctx, placeFilled ? '✓ Passport Issued Place = Ethiopia' : '⚠ Passport Issued Place not found', placeFilled ? 'info' : 'warn')

  const pob = profile.place_of_birth || ''
  if (pob) {
    const pobFilled = await setFieldInModal(page, 'Upload Passport Document', {
      labelIncludes: ['Place Of Birth', 'Place of Birth'],
      value: pob
    })
    log(ctx, pobFilled ? `✓ Place Of Birth = "${pob}"` : '⚠ Place Of Birth not found', pobFilled ? 'info' : 'warn')
  }

  if (dob) {
    const dobFilled = await setDateFieldByIndex(page, 'Upload Passport Document', 1, dob)
    log(ctx, dobFilled ? `✓ Date Of Birth = "${dob}"` : '⚠ Date Of Birth not found', dobFilled ? 'info' : 'warn')
  }

  await sleep(500)

  log(ctx, 'attaching passport file...')
  const uploaded = await attachFileToModal(page, 'Upload Passport Document', ctx.passportPath, ctx)
  log(ctx, uploaded ? '✓ passport file sent to input' : '✗ passport file could not be attached', uploaded ? 'info' : 'error')

  if (!uploaded) {
    await ctx.notify(
      `❌ ${ctx.profileName}: passport file could not be attached`,
      'Could not find the dropzone input in the passport modal.'
    )
    throw new Error('Passport file upload failed')
  }

  log(ctx, 'waiting for Upload Complete signal (up to 45s)...')
  const success = await waitForUploadSuccess(page, 'Upload Passport Document', 45000, ctx)
  if (!success) {
    await ctx.notify(
      `❌ ${ctx.profileName}: passport upload did not complete`,
      'The Upload Complete indicator never appeared after 45s.'
    )
    throw new Error('Passport upload did not show Upload Complete')
  }
  log(ctx, '✓ passport upload confirmed by LMIS — settling 1.5s')
  await sleep(1500)

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const shotPath = path.join(DEBUG_DIR, `pre-submit-passport-${ctx.profileId}-${stamp}.png`)
    await page.screenshot({ path: shotPath, fullPage: false })
    log(ctx, `pre-submit screenshot: ${shotPath}`)
  } catch {}

  log(ctx, 'clicking Submit...')
  const submitted = await clickButtonInModal(page, 'Upload Passport Document', /^submit$/i)
  log(ctx, submitted ? '✓ Passport modal Submit clicked' : '⚠ Passport modal Submit not found', submitted ? 'info' : 'warn')

  if (submitted) {
    const closed = await waitForModalGone(page, 'Upload Passport Document', 10000)
    log(ctx, closed ? '✓ Passport modal closed' : '⚠ Passport modal still open after Submit', closed ? 'info' : 'warn')
  }

  await sleep(1500)
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

  const uploaded = await attachFileToModal(page, 'Upload Photo', ctx.photoPath, ctx)
  log(ctx, uploaded ? '✓ photo file sent to input' : '✗ photo file could not be attached', uploaded ? 'info' : 'error')

  if (!uploaded) {
    throw new Error('Photo file upload failed')
  }

  log(ctx, 'waiting for Upload Complete signal (up to 45s)...')
  const success = await waitForUploadSuccess(page, 'Upload Photo', 45000, ctx)
  if (!success) {
    await ctx.notify(
      `❌ ${ctx.profileName}: photo upload did not complete`,
      'The Upload Complete indicator never appeared after 45s.'
    )
    throw new Error('Photo upload did not show Upload Complete')
  }
  log(ctx, '✓ photo upload confirmed by LMIS — settling 1.5s')
  await sleep(1500)

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const shotPath = path.join(DEBUG_DIR, `pre-submit-photo-${ctx.profileId}-${stamp}.png`)
    await page.screenshot({ path: shotPath, fullPage: false })
    log(ctx, `pre-submit screenshot: ${shotPath}`)
  } catch {}

  log(ctx, 'clicking Submit...')
  const submitted = await clickButtonInModal(page, 'Upload Photo', /^submit$/i)
  log(ctx, submitted ? '✓ Upload Photo Submit clicked' : '⚠ Upload Photo Submit not found', submitted ? 'info' : 'warn')

  if (submitted) {
    const closed = await waitForModalGone(page, 'Upload Photo', 10000)
    log(ctx, closed ? '✓ Upload Photo modal closed' : '⚠ Upload Photo modal still open', closed ? 'info' : 'warn')
  }

  await sleep(1500)
  await closePopups(page, ctx)
}

// ============================================================================
// FILE ATTACH
// ============================================================================

async function attachFileToModal(page, modalTitle, filePath, ctx) {
  if (!filePath || !fs.existsSync(filePath)) {
    if (ctx) log(ctx, `  file missing at ${filePath}`, 'error')
    return false
  }

  const handleRef = await page.evaluateHandle((title) => {
    const all = Array.from(document.querySelectorAll('*'))
    let modal = null
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150) continue
      if (r.width > 1400 || r.height > 1200) continue
      if ((el.textContent || '').includes(title)) { modal = el; break }
    }
    if (!modal) return null

    const dzText = Array.from(modal.querySelectorAll('*'))
      .filter(el => {
        const t = (el.textContent || '').trim()
        return t.length < 120 && /drag\s*&\s*drop|browse/i.test(t)
      })
      .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0]

    if (dzText) {
      let cur = dzText
      for (let d = 0; d < 10 && cur && cur !== modal.parentElement; d++) {
        const inp = cur.querySelector('input[type="file"]')
        if (inp) return inp
        cur = cur.parentElement
      }
    }

    return modal.querySelector('input[type="file"]') || null
  }, modalTitle)

  const fileInput = handleRef.asElement()
  if (!fileInput) {
    if (ctx) log(ctx, '  no file input found near dropzone', 'error')
    return false
  }

  const meta = await page.evaluate(node => ({
    id: node.id || '',
    name: node.name || '',
    accept: node.accept || '',
  }), fileInput)
  if (ctx) log(ctx, `  found input: id="${meta.id}" accept="${meta.accept}"`)

  try {
    await fileInput.uploadFile(filePath)
    if (ctx) log(ctx, `  uploadFile → ${path.basename(filePath)} sent`)
    return true
  } catch (e) {
    if (ctx) log(ctx, `  uploadFile threw: ${e.message}`, 'error')
    return false
  }
}

async function waitForUploadSuccess(page, modalTitle, timeoutMs, ctx) {
  const deadline = Date.now() + timeoutMs
  let firstSeenAt = 0
  let lastLogAt = 0

  while (Date.now() < deadline) {
    const state = await page.evaluate(({ title }) => {
      const all = Array.from(document.querySelectorAll('*'))
      let modal = null
      for (const el of all) {
        const r = el.getBoundingClientRect()
        if (r.width < 250 || r.height < 150) continue
        if (r.width > 1400 || r.height > 1200) continue
        if ((el.textContent || '').slice(0, 400).includes(title)) { modal = el; break }
      }
      if (!modal) return { ok: false, reason: 'modal not found' }
      const text = (modal.textContent || '')
      const lower = text.toLowerCase()
      const complete = lower.includes('upload complete') || lower.includes('tap to undo')
      return {
        ok: complete,
        uploading: /uploading|%/.test(text) && !complete,
      }
    }, { title: modalTitle })

    if (state.ok) {
      if (firstSeenAt === 0) {
        firstSeenAt = Date.now()
        if (ctx) log(ctx, '  Upload Complete text seen — confirming stability...')
      } else if (Date.now() - firstSeenAt >= 1000) {
        return true
      }
    } else {
      if (firstSeenAt !== 0) {
        if (ctx) log(ctx, '  Upload Complete text disappeared — resetting wait', 'warn')
        firstSeenAt = 0
      }
      if (ctx && Date.now() - lastLogAt > 5000) {
        lastLogAt = Date.now()
        log(ctx, `  still uploading... (state: ${state.reason || (state.uploading ? 'progress' : 'unknown')})`)
      }
    }
    await sleep(300)
  }

  if (ctx) log(ctx, `  timed out after ${timeoutMs / 1000}s waiting for Upload Complete`, 'error')
  return false
}

async function waitForModalGone(page, modalTitle, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const stillThere = await page.evaluate((title) => {
      const all = Array.from(document.querySelectorAll('*'))
      for (const el of all) {
        const r = el.getBoundingClientRect()
        if (r.width < 250 || r.height < 150) continue
        if (r.width > 1400 || r.height > 1200) continue
        if ((el.textContent || '').slice(0, 400).includes(title)) return true
      }
      return false
    }, modalTitle)
    if (!stillThere) return true
    await sleep(400)
  }
  return false
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

  const stillBlocking = await page.evaluate(() => {
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
    try { await page.mouse.click(30, 200) } catch {}
    await sleep(500)
  } else if (ctx) {
    log(ctx, 'all modals closed', 'info')
  }
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

async function clickButtonInModal(page, modalTitle, labelRegex) {
  return await page.evaluate(({ modalTitle, src }) => {
    const re = new RegExp(src, 'i')
    const all = Array.from(document.querySelectorAll('*'))
    let modal = null
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150) continue
      if (r.width > 1400 || r.height > 1200) continue
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

export async function stepNotifyHumanSubmit(page, ctx) {
  log(ctx, '🖐 reached final step — human must click "Submit Request"', 'warn')
  await ctx.notify(
    `✅ ${ctx.profileName}: police certificate ready for final submit`,
    `Labor ID ${ctx.labor_id} — slip, passport, and photo uploaded. ` +
    `Open the LMIS tab, verify, and click "Submit Request" yourself.`,
    'info'
  )
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

  // ── Musaned workflows: bypass LMIS login entirely ──────────────────────
  // Both musaned_login and musaned_add_candidate route through the same
  // state machine. The `|| workflowId === 'musaned_login'` half is a safety
  // net for any pending queue rows still carrying the old workflow ID.
  if (workflowId === 'musaned_add_candidate' || workflowId === 'musaned_login') {
    try {
      return await runMusanedWorkflow(page, ctx)
    } catch (e) {
      const secs = Math.round((Date.now() - t0) / 1000)
      log(ctx, `musaned workflow failed after ${secs}s: ${e.message}`, 'error')
      await dumpPageState(page, ctx, 'musaned')
      return { ok: false, step: 'musaned', error: e.message, seconds: secs }
    }
  }

  // ── All remaining workflows share the LMIS login ───────────────────────
  try {
    await stepLogin(page, ctx)
  } catch (e) {
    log(ctx, `login failed: ${e.message}`, 'error')
    await dumpPageState(page, ctx, 'login')
    return { ok: false, step: 'login', error: e.message, seconds: Math.round((Date.now() - t0) / 1000) }
  }

  if (workflowId === 'contract_import_labour') {
    return await runContractWorkflow(page, ctx)
  }

  if (workflowId === 'delete_labour') {
    try {
      return await runDeleteWorkflow(page, ctx)
    } catch (e) {
      const secs = Math.round((Date.now() - t0) / 1000)
      log(ctx, `delete workflow failed after ${secs}s: ${e.message}`, 'error')
      await dumpPageState(page, ctx, 'delete')
      return { ok: false, step: 'delete', error: e.message, seconds: secs }
    }
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