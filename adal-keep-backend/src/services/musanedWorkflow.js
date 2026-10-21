/**
 * musanedWorkflow.js — Musaned / Tawtheeq → HR Pool → Add Candidate → Pre-check → Details.
 * v16.7 — Photo upload + Passport Issue Date diagnostic + Education retry.
 * v17.1 — diagnoseMusanedPage + viewport crash fix + pre-check try/catch + wired diagnostics.
 * v17.3 — Personal photo: DB-resolved path + modal-aware upload (CONFIRM) + deep disk search.
 * v17.4 — Details: DB fallback for agencyEmail; warn when employeeName missing.
 * v18   — Peer tab detection/reuse (reuse a Musaned tab, never navigate away a
 *         tab on the other portal ⇒ no re-login), paste-style fills instead of
 *         char-by-char typing, and fair-share bandwidth across lane tabs.
 * v19   — Works only in the tab its run owns (worker.js opens it). It never
 *         adopts another tab, so two runs at once cannot meet in one tab.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import {
  reviewMusanedScreen, reviewStageComplete, reviewPreCheckReady,
} from './jev/musanedDecisions.js'
import { pasteText, pasteAndCommit } from './domPaste.js'
import { isPeerUrl, expectFile, disarmFile } from './tabManager.js'
import { musanedMissing, personalPhotoFile } from './musanedPreflight.js'

const MUSANED_ROOT    = 'https://tawtheeq.musaned.com.sa/'
const DASHBOARD_URL   = 'https://tawtheeq.musaned.com.sa/dashboard'
const KEYCLOAK_HOST   = 'accounts.wahid.sa'
const STEP_LOG_PREFIX = '[musaned]'
const DEBUG_DIR       = path.join(os.homedir(), '.adal-lmis-debug')
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true })

const HERE_DIR      = path.dirname(fileURLToPath(import.meta.url))
const PHOTO_MODAL_SELS = '.p-dialog, [role="dialog"], .modal, .p-overlaypanel'
const PHOTO_MODAL_SRC  = 'personal\\s+photo\\s+upload'
const DROPZONE_SRC     = 'click\\s+or\\s+drag\\s+a\\s+personal\\s+photo'

const DEFAULT_TIMEOUT_MS     = 180000
const NAV_TIMEOUT_MS         = 180000
const UPLOAD_PROCESS_MS      = 120000
const MODAL_CLOSED_SETTLE_MS = 2000

function formatMusanedDate(dateStr) {
  if (!dateStr) return ''
  const s = String(dateStr).trim()
  if (/^[A-Za-z]+\s+\d{1,2},\s+\d{4}$/.test(s)) return s
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}
function cleanPhone(phone) { return phone ? String(phone).replace(/^(\+?251|0)/, '').replace(/\D/g, '') : '' }
function log(ctx, msg, level = 'info') {
  // Cooperative cancellation — the cancel endpoint flips this run's flag, and
  // the next step log unwinds the workflow so the agent stops immediately.
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
function applyGlobalTimeouts(page, ctx) {
  try {
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS)
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)
  } catch (e) { log(ctx, `timeout set failed: ${e.message}`, 'warn') }
}

/**
 * Musaned's Bootstrap sets `:root{scroll-behavior:smooth}`, so scrollIntoView()
 * animates. Coordinates measured right after it are where the element WAS,
 * and the mouse click lands on something else (this is why the "Upload
 * personal photo" click never opened its window). Make scrolling instant in
 * this tab, now and on every page Musaned/Keycloak loads.
 */
export async function disableSmoothScroll(page, ctx) {
  const inject = () => {
    const add = () => {
      if (document.getElementById('adal-no-smooth-scroll')) return
      const s = document.createElement('style')
      s.id = 'adal-no-smooth-scroll'
      s.textContent = 'html,:root,body{scroll-behavior:auto !important}'
      ;(document.head || document.documentElement).appendChild(s)
    }
    if (document.documentElement) add()
    else document.addEventListener('DOMContentLoaded', add)
  }
  try {
    if (!page.__adalNoSmoothScroll) {
      await page.evaluateOnNewDocument(inject)
      page.__adalNoSmoothScroll = true
    }
    await page.evaluate(inject)
  } catch (e) { log(ctx, `smooth-scroll override failed: ${e.message}`, 'warn') }
}

async function clickRealistic(page, label, ctx, opts = {}) {
  const handle = await page.evaluateHandle((want) => {
    const re = new RegExp(`^${want}$`, 'i')
    const btns = Array.from(document.querySelectorAll(
      'button, [role="button"], input[type="submit"], input[type="button"]'
    )).filter(b => !b.disabled && re.test((b.textContent || b.value || '').trim()))
    if (!btns.length) return null
    btns.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      return (rb.width * rb.height) - (ra.width * ra.height)
    })
    return btns[0]
  }, label)
  const el = handle.asElement()
  if (!el) return { clicked: false, reason: 'not-in-dom' }
  try { await el.evaluate(b => b.scrollIntoView({ block: 'center', inline: 'center' })) } catch {}
  await sleep(opts.settleMs ?? 40)
  const rect = await el.evaluate(b => {
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  }).catch(() => null)
  if (!rect || rect.w < 5 || rect.h < 5) return { clicked: false, reason: 'zero-size' }
  await page.mouse.move(rect.x, rect.y, { steps: 6 })
  await sleep(40)
  await page.mouse.down(); await sleep(40); await page.mouse.up()
  return { clicked: true }
}

async function scrollModalToBottom(page, ctx) {
  const result = await page.evaluate(() => {
    const scrollEl = (el) => { if (el.scrollHeight - el.clientHeight > 5) el.scrollTop = el.scrollHeight }
    try { window.scrollTo(0, document.body.scrollHeight) } catch {}
    try {
      document.documentElement.scrollTop = document.documentElement.scrollHeight
      document.body.scrollTop = document.body.scrollHeight
    } catch {}
    try {
      document.querySelectorAll('[class*="modal" i], [role="dialog"], main, [class*="content" i], [class*="drawer" i], [style*="overflow"]')
        .forEach(el => { if (el.scrollHeight > el.clientHeight + 5) scrollEl(el) })
    } catch {}
    try {
      let el = document.body
      while (el) { if (el.scrollHeight > el.clientHeight + 10) scrollEl(el); el = el.parentElement }
    } catch {}
    const btn = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .find(el => {
        if (el.disabled) return false
        const t = (el.textContent || el.value || '').trim().toLowerCase()
        return t === 'continue' || t === 'متابعة' || t === 'التالي'
      })
    if (btn) { try { btn.scrollIntoView({ block: 'center', inline: 'center' }) } catch {} }
    const r = btn ? btn.getBoundingClientRect() : null
    return { ok: true, btnFound: !!btn, fullyVisible: r ? (r.top >= 0 && r.bottom <= window.innerHeight && r.width >= 5 && r.height >= 5) : false }
  }).catch(e => ({ ok: false, reason: e.message }))
  if (!result.ok) { log(ctx, `scrollModalToBottom failed: ${result.reason}`, 'warn'); return result }
  log(ctx, `scrolled; CONTINUE btn=${result.btnFound} fullyVisible=${result.fullyVisible}`)
  await sleep(250)
  return result
}

async function dumpPageState(page, ctx, stepName) {
  try {
    const url = page.url()
    log(ctx, `FAIL at "${stepName}" — URL: ${url}`, 'error')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const shotPath = path.join(DEBUG_DIR, `fail-musaned-${ctx.profileId}-${stepName}-${stamp}.png`)
    try { await page.screenshot({ path: shotPath }); log(ctx, `screenshot: ${shotPath}`, 'error') } catch {}
  } catch (e) { console.error('[musaned] dumpPageState failed:', e.message) }
}

/**
 * diagnostic dump — captures everything we can see on the page.
 * Saves HTML + full-page screenshot to ~/.adal-lmis-debug/.
 */
async function diagnoseMusanedPage(page, ctx, tag) {
  try {
    const url = page.url()
    const title = await page.title().catch(() => '')
    log(ctx, `═══ DIAGNOSE[${tag}] ═══`)
    log(ctx, `  URL: ${url}`)
    log(ctx, `  title: ${title}`)

    const snap = await page.evaluate(() => {
      const vis = (el) => {
        if (!el) return false
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) return false
        const cs = getComputedStyle(el)
        return cs.display !== 'none' && cs.visibility !== 'hidden'
      }
      const rect = (el) => {
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
      }
      const txt = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)

      const buttons = Array.from(document.querySelectorAll(
        'button, [role="button"], input[type="submit"], input[type="button"]'
      )).filter(vis).map(b => ({ text: txt(b), disabled: !!b.disabled, rect: rect(b) }))

      const inputs = Array.from(document.querySelectorAll('input, textarea'))
        .filter(i => i.type !== 'hidden')
        .filter(vis)
        .map(i => ({
          type: i.type || 'text',
          id: i.id || '',
          name: i.name || '',
          formctl: i.getAttribute('formcontrolname') || '',
          ph: i.placeholder || '',
          val: (i.value || '').slice(0, 40),
          ro: !!i.readOnly,
          disabled: !!i.disabled,
          rect: rect(i),
        }))

      const labels = Array.from(document.querySelectorAll('label')).filter(vis)
        .map(l => ({ for: l.getAttribute('for') || '', text: txt(l) }))

      const components = {}
      for (const sel of [
        '.ant-form-item', 'app-calendar', 'p-autocomplete', 'p-datepicker',
        'app-form-control-errors', '.p-dialog', '[role="dialog"]',
        '.p-autocomplete-panel', '.p-datepicker-panel',
      ]) components[sel] = document.querySelectorAll(sel).length

      const bodyText = (document.body?.innerText || '').slice(0, 800)
      return { buttons, inputs, labels, components, bodyText }
    })

    log(ctx, `  components: ${JSON.stringify(snap.components)}`)
    log(ctx, `  buttons (${snap.buttons.length}):`)
    for (const b of snap.buttons.slice(0, 15)) {
      log(ctx, `    "${b.text}"${b.disabled ? ' [disabled]' : ''} @ ${b.rect.x},${b.rect.y} ${b.rect.w}x${b.rect.h}`)
    }
    log(ctx, `  inputs (${snap.inputs.length}):`)
    for (const i of snap.inputs.slice(0, 20)) {
      log(ctx, `    type=${i.type} id="${i.id}" formctl="${i.formctl}" ph="${i.ph}" val="${i.val}"${i.ro ? ' [ro]' : ''}${i.disabled ? ' [dis]' : ''} @ ${i.rect.x},${i.rect.y}`)
    }
    log(ctx, `  labels (${snap.labels.length}): ${snap.labels.slice(0, 20).map(l => `"${l.text}"→${l.for || '-'}`).join(', ')}`)
    log(ctx, `  body text: ${snap.bodyText.replace(/\n/g, ' | ').slice(0, 400)}`)

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const htmlPath = path.join(DEBUG_DIR, `diag-${tag}-${ctx.profileId}-${stamp}.html`)
    const shotPath = path.join(DEBUG_DIR, `diag-${tag}-${ctx.profileId}-${stamp}.png`)
    try {
      const html = await page.content()
      fs.writeFileSync(htmlPath, html)
      log(ctx, `  HTML saved: ${htmlPath}`)
    } catch {}
    try {
      await page.screenshot({ path: shotPath, fullPage: true })
      log(ctx, `  screenshot saved: ${shotPath}`)
    } catch {}
    log(ctx, `═══ END DIAGNOSE[${tag}] ═══`)
  } catch (e) {
    log(ctx, `diagnoseMusanedPage failed: ${e.message}`, 'warn')
  }
}

async function fillField(page, input, value, label, ctx) {
  await input.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, val)
    el.dispatchEvent(new Event('input',  { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new Event('blur',   { bubbles: true }))
  }, value)
  let actual = await input.evaluate(el => el.value)
  if (actual === value) { log(ctx, `✓ ${label} filled`); return { ok: true } }
  // Paste-like fill (single input event) instead of slow char-by-char typing.
  actual = await pasteText(page, input, value)
  return { ok: actual === value }
}

async function snapshotState(page) {
  return await page.evaluate(({ keycloakHost }) => {
    const url = location.href
    const body = (document.body?.innerText || '')
    return {
      url, onKeycloak: url.includes(keycloakHost), bodySnippet: body.slice(0, 500),
      hasLoginError: /invalid\s+(username|password)|incorrect\s+username|account\s+is\s+disabled/i.test(body),
      hasCaptcha: !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha"], [class*="captcha"]'),
      hasOtp: !!document.querySelector('input[name="otp"], input[autocomplete="one-time-code"], input[name="totp"]'),
      hasPassword: !!document.querySelector('input[type="password"]'),
      hasUsername: !!document.querySelector('#username, input[name="username"], input[autocomplete="username"], input[type="email"]'),
      hasDashboardNav: /organizations|hr\s*pool|employment\s*requests|worker\s+transfer|latest\s+(requests|candidates)/i.test(body),
      hasGoToDashboard: /go\s+to\s+dashboard/i.test(body),
      hasAgencyPicker: /please\s+select\s+the\s+establishment/i.test(body) ||
        (/welcome\s+back/i.test(body) && /foreign\s+employment\s+agency|superuser/i.test(body)),
      hasHrPoolPage: /hr\s*pool|candidates/i.test(body) && /add\s+new\s+candidate/i.test(body),
    }
  }, { keycloakHost: KEYCLOAK_HOST }).catch(() => null)
}
function fallbackClassify(s) {
  if (!s) return null
  if (s.hasLoginError)   return { screen: 'login-error',   source: 'fallback' }
  if (s.hasCaptcha)      return { screen: 'captcha',       source: 'fallback' }
  if (s.hasOtp)          return { screen: 'otp',           source: 'fallback' }
  if (s.hasAgencyPicker) return { screen: 'agency-picker', source: 'fallback' }
  if (s.hasHrPoolPage)   return { screen: 'dashboard',     source: 'fallback' }
  if (s.hasDashboardNav) return { screen: 'dashboard',     source: 'fallback' }
  if (s.hasGoToDashboard) return { screen: 'landing',      source: 'fallback' }
  if (s.hasPassword && s.hasUsername) return { screen: 'login-form', source: 'fallback' }
  return null
}
async function classifyScreen(page, ctx) {
  const state = await snapshotState(page)
  if (!state) return { screen: 'unknown', source: 'snapshot-failed' }
  let review = null
  try { review = await reviewMusanedScreen(state) }
  catch (e) { log(ctx, `Jev threw: ${e.message}`, 'warn') }
  if (!review || !review.screen || review.screen === 'unknown') {
    const fb = fallbackClassify(state)
    if (fb) { log(ctx, `screen -> ${fb.screen} (${fb.source})`); return fb }
  }
  log(ctx, `screen -> ${review.screen} (${review.source})`)
  return review
}

export async function stepOpenMusaned(page, ctx) {
  // Peer-aware: if this tab is ALREADY on a Musaned host we do NOT navigate to
  // the root — that would wipe an in-progress form and/or force a re-login.
  // We just inspect the current screen and continue.
  const alreadyOnMusaned = isPeerUrl(page.url(), 'musaned')
  if (alreadyOnMusaned) {
    await sleep(500)
    const preState = await snapshotState(page)
    const onKeycloak = page.url().includes(KEYCLOAK_HOST)
    if (!onKeycloak && (preState?.hasAgencyPicker || preState?.hasDashboardNav || preState?.hasGoToDashboard)) {
      log(ctx, '✓ already on Musaned (peer tab) — skipping root navigation')
      return { ok: true, finalUrl: page.url(), onKeycloak: false }
    }
    if (onKeycloak) return { ok: true, finalUrl: page.url(), onKeycloak: true }
    // On a Musaned host but unclassified — fall through to the login-click loop
    // below WITHOUT re-navigating away.
  } else {
    try { await page.goto(MUSANED_ROOT, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }) }
    catch { try { await page.goto(MUSANED_ROOT, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS }) }
      catch { throw new Error('Could not reach tawtheeq.musaned.com.sa') } }
    await sleep(1500)
    const preState = await snapshotState(page)
    if (preState?.hasAgencyPicker || preState?.hasDashboardNav || preState?.hasGoToDashboard) {
      return { ok: true, finalUrl: page.url(), onKeycloak: false }
    }
  }
  const deadline = Date.now() + 20000
  let clickedLogin = false
  while (Date.now() < deadline) {
    if (page.url().includes(KEYCLOAK_HOST)) break
    clickedLogin = await page.evaluate(() => {
      const target = Array.from(document.querySelectorAll('a, button, [role="button"]'))
        .find(el => /^(login|sign\s*in|دخول)$/.test((el.textContent || '').trim().toLowerCase()))
      if (!target) return false
      const r = target.getBoundingClientRect()
      if (r.width < 5 || r.height < 5) return false
      try { target.scrollIntoView({ block: 'center' }); target.click(); return true } catch { return false }
    })
    if (clickedLogin) break
    await sleep(500)
  }
  if (clickedLogin) await sleep(1500)
  const redirectDeadline = Date.now() + 15000
  while (Date.now() < redirectDeadline) {
    if (page.url().includes(KEYCLOAK_HOST)) break
    const s = await snapshotState(page)
    if (s?.hasAgencyPicker || s?.hasDashboardNav || s?.hasGoToDashboard) break
    await sleep(500)
  }
  const finalUrl = page.url()
  if (!finalUrl || finalUrl === 'about:blank') throw new Error('Tab landed on about:blank')
  return { ok: true, finalUrl, onKeycloak: finalUrl.includes(KEYCLOAK_HOST) }
}

export async function stepFillMusanedLogin(page, ctx) {
  const username = String(ctx.musaned_username || '').trim()
  const password = String(ctx.musaned_password || '')
  if (!username || !password) return { filled: false }
  const userInput = await page.waitForSelector(
    '#username, input[name="username"], input[autocomplete="username"], input[type="email"]',
    { timeout: 20000 }
  ).catch(() => null)
  if (!userInput) return { filled: false }
  const hasCaptcha = (await snapshotState(page))?.hasCaptcha || false
  await fillField(page, userInput, username, 'username', ctx)
  const passInput = await page.$('#password, input[name="password"], input[type="password"]')
  if (!passInput) return { filled: false }
  await fillField(page, passInput, password, 'password', ctx)
  if (hasCaptcha) return { filled: true, captcha: true }
  const submitted = await page.evaluate(() => {
    const byId = document.querySelector('#kc-login'); if (byId) { byId.click(); return 'kc-login' }
    const sb = document.querySelector('button[type="submit"], input[type="submit"]'); if (sb) { sb.click(); return 'submit' }
    return null
  })
  if (!submitted) { await passInput.press('Enter'); return { filled: true, via: 'enter' } }
  return { filled: true, via: submitted }
}

export async function stepClickAgencyCard(page, ctx) {
  const agencyHint = String(ctx.profile?.agency_name || ctx.musaned_name || '').trim().toUpperCase()
  const deadline = Date.now() + 20000
  let clicked = false
  while (Date.now() < deadline && !clicked) {
    const found = await page.evaluate((hint) => {
      const collectAll = (root) => {
        const out = []
        const walk = (n) => { if (!n?.querySelectorAll) return; for (const el of n.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
        walk(root); return out
      }
      const all = collectAll(document)
      const txt = (el) => el.textContent || ''
      let candidates = all.filter(el => /FOREIGN\s+EMPLOYMENT\s+AGENCY/i.test(txt(el)) && /\bdetails\b/i.test(txt(el)))
      if (!candidates.length) candidates = all.filter(el => /FOREIGN\s+EMPLOYMENT\s+AGENCY/i.test(txt(el)))
      if (!candidates.length && hint) candidates = all.filter(el => txt(el).toUpperCase().includes(hint))
      if (candidates.length) {
        candidates.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
          return (ra.width * ra.height) - (rb.width * rb.height)
        })
        let clickable = candidates[0]
        for (let d = 0; d < 8 && clickable; d++) {
          const r = clickable.getBoundingClientRect()
          if (r.width >= 300 && r.width <= 1400 && r.height >= 60 && r.height <= 500) break
          clickable = clickable.parentElement
        }
        if (!clickable) clickable = candidates[0]
        try { clickable.scrollIntoView({ block: 'center' }) } catch {}
        const r = clickable.getBoundingClientRect()
        if (r.width >= 100 && r.height >= 30) return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
      return { ok: false }
    }, agencyHint)
    if (found.ok) {
      await page.mouse.move(found.x, found.y)
      await sleep(100); await page.mouse.down(); await sleep(60); await page.mouse.up()
      clicked = true; break
    }
    await sleep(700)
  }
  if (!clicked) throw new Error('Agency card not found')
  return { ok: true }
}

export async function stepClickGoToDashboard(page, ctx) {
  const clicked = await page.evaluate(() => {
    const target = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .find(el => /^go\s+to\s+dashboard$/i.test((el.textContent || '').trim()))
    if (!target) return false
    const r = target.getBoundingClientRect()
    if (r.width < 5 || r.height < 5) return false
    try { target.scrollIntoView({ block: 'center' }); target.click(); return true } catch { return false }
  })
  if (!clicked) {
    try { await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); await sleep(2000); return { ok: true, via: 'direct-nav' } }
    catch (e) { return { ok: false, error: e.message } }
  }
  await sleep(2500)
  return { ok: true }
}

export async function stepClickHrPool(page, ctx) {
  const deadline = Date.now() + 20000
  let clicked = false
  while (Date.now() < deadline && !clicked) {
    clicked = await page.evaluate(() => {
      const byHref = Array.from(document.querySelectorAll('a')).find(a => /\/hr-pool/i.test(a.getAttribute('href') || ''))
      if (byHref) { const r = byHref.getBoundingClientRect(); if (r.width > 5 && r.height > 5) { try { byHref.scrollIntoView({ block: 'center' }); byHref.click(); return true } catch {} } }
      const byText = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"]'))
        .find(el => /^hr\s*pool$/i.test((el.textContent || '').trim()))
      if (byText) { const r = byText.getBoundingClientRect(); if (r.width > 5 && r.height > 5) { try { byText.scrollIntoView({ block: 'center' }); byText.click(); return true } catch {} } }
      return false
    })
    if (!clicked) await sleep(500)
  }
  if (!clicked) throw new Error('HR Pool nav not found')
  const navDeadline = Date.now() + 20000
  while (Date.now() < navDeadline) {
    const ok = await page.evaluate(() => {
      const url = location.href, body = document.body?.innerText || ''
      return /\/hr-pool/i.test(url) || (/candidates/i.test(body) && /add\s+new\s+candidate/i.test(body))
    })
    if (ok) { await sleep(1000); return { ok: true } }
    await sleep(400)
  }
  return { ok: true }
}

export async function stepClickAddNewCandidate(page, ctx) {
  const deadline = Date.now() + 20000
  let clicked = false
  while (Date.now() < deadline && !clicked) {
    clicked = await page.evaluate(() => {
      const target = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .find(el => /add\s+new\s+candidate/i.test((el.textContent || '').trim()))
      if (!target) return false
      const r = target.getBoundingClientRect()
      if (r.width < 5 || r.height < 5) return false
      try { target.scrollIntoView({ block: 'center' }); target.click(); return true } catch { return false }
    })
    if (!clicked) await sleep(500)
  }
  if (!clicked) throw new Error('ADD NEW CANDIDATE not found')
  await sleep(1500)
  return { ok: true }
}

export async function stepFillCandidatePreCheck(page, ctx) {
  log(ctx, 'pre-check starting')
  try {
    const profile = ctx.profile || {}
    const passportNumber = String(profile.passport_number || '').trim()
    const passportPath =
      ctx.passportImagePath || ctx.passportImage_path ||
      ctx.passportPath || ctx.passport_path ||
      profile.passport_path || profile.passportPath || null
    if (!passportNumber) throw new Error('passport_number is empty')
    if (!passportPath || !fs.existsSync(passportPath)) throw new Error('passport file missing')
    applyGlobalTimeouts(page, ctx)
    const idOk = await page.evaluate((val) => {
      const input = Array.from(document.querySelectorAll('input')).find(el => /id\s*number/i.test(el.placeholder || ''))
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, val)
      input.dispatchEvent(new Event('input',  { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.dispatchEvent(new Event('blur',   { bubbles: true }))
      input.focus()
      return input.value === val
    }, passportNumber)
    if (!idOk) throw new Error('ID Number could not be filled')
    await sleep(300)

    let fileInput = (await page.evaluateHandle(() => {
      const modals = Array.from(document.querySelectorAll('*')).filter(el => {
        const r = el.getBoundingClientRect()
        if (r.width < 250 || r.height < 150 || r.width > 1500 || r.height > 1500) return false
        return /candidate\s+pre-check/i.test(el.textContent || '')
      })
      if (!modals.length) return null
      modals.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        return ra.width * ra.height - rb.width * rb.height
      })
      return modals[0].querySelector('input[type="file"]')
    })).asElement()
    if (!fileInput) fileInput = await page.$('input[type="file"]')
    if (!fileInput) throw new Error('Passport file input missing')
    await fileInput.uploadFile(passportPath)

    try {
      await page.waitForFunction(() => {
        const spinners = document.querySelectorAll('.p-progress-spinner, [class*="loading" i], [class*="spinner" i]')
        if (Array.from(spinners).some(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })) return false
        const preview = document.querySelector('img[src^="blob:"], img[src^="data:"]')
        if (preview) return true
        const filled = Array.from(document.querySelectorAll('input')).filter(inp => {
          const r = inp.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && !inp.disabled && inp.type !== 'file' && inp.value && inp.value.trim().length > 2
        })
        if (filled.length >= 4) return true
        const isCont = (el) => {
          const t = (el.textContent || el.value || '').trim().toLowerCase()
          return t === 'continue' || t === 'متابعة' || t === 'التالي'
        }
        return Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
          .filter(isCont).some(b => !b.disabled && b.getBoundingClientRect().width >= 5)
      }, { timeout: UPLOAD_PROCESS_MS, polling: 500 })
    } catch (e) { log(ctx, `⚠ no upload signals — proceeding. (${e.message})`, 'warn') }

    await scrollModalToBottom(page, ctx)
    await sleep(400)
    const isModalClosed = async () => !(await page.evaluate(() => /candidate\s+pre-check/i.test(document.body?.innerText || '')))
    const domClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]'))
        .find(el => {
          if (el.disabled) return false
          const t = (el.textContent || el.value || '').trim().toLowerCase()
          return t === 'continue' || t === 'متابعة' || t === 'التالي' || t.includes('continue')
        })
      if (!btn) return false
      try { btn.scrollIntoView({ block: 'center', inline: 'center' }) } catch {}
      try { btn.click(); return true } catch { return false }
    })
    if (domClicked) { await sleep(MODAL_CLOSED_SETTLE_MS); if (await isModalClosed()) return { ok: true } }
    const res = await clickRealistic(page, 'continue', ctx)
    if (res.clicked) { await sleep(MODAL_CLOSED_SETTLE_MS); if (await isModalClosed()) return { ok: true } }
    // ── viewport-safe fallback (was: page.viewport(), which is null under puppeteer.connect) ──
    const vp = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
      .catch(() => ({ width: 1920, height: 1080 }))
    await page.mouse.move(vp.width - 150, vp.height - 120)
    await page.mouse.down(); await sleep(40); await page.mouse.up()
    await sleep(MODAL_CLOSED_SETTLE_MS)
    return { ok: true }
  } catch (e) {
    log(ctx, `pre-check threw: ${e.message}`, 'error')
    await diagnoseMusanedPage(page, ctx, 'pre-check-error')
    return { ok: false, error: e.message }
  }
}

// ============================================================================
// v16.7 HELPERS
// ============================================================================

async function findLabelEl(page, labelText) {
  const h = await page.evaluateHandle((lbl) => {
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim()
    const target = norm(lbl)
    const labels = Array.from(document.querySelectorAll('label'))
    let m = labels.find(l => norm(l.textContent) === target)
    if (!m) m = labels.find(l => norm(l.textContent).includes(target))
    return m || null
  }, labelText)
  return h.asElement()
}

async function findInputForLabel(page, labelText) {
  const labelEl = await findLabelEl(page, labelText)
  if (!labelEl) return { input: null, labelEl: null, reason: 'label-not-found' }

  const inputHandle = await labelEl.evaluateHandle((label) => {
    const isUsable = (i) => i && !i.disabled &&
      !['radio','checkbox','file','hidden'].includes(i.type)

    const keys = new Set()
    const forId = label.getAttribute('for')
    if (forId) keys.add(forId)

    for (const key of keys) {
      const t = document.getElementById(key)
      if (t) {
        if (t.tagName === 'INPUT' && isUsable(t)) return t
        const inner = t.querySelector('input:not([type=radio]):not([type=checkbox]):not([type=file]):not([type=hidden])')
        if (isUsable(inner)) return inner
      }
    }

    for (const key of keys) {
      const byCtl = document.querySelector(`[formcontrolname="${key}"]`)
      if (byCtl) {
        if (byCtl.tagName === 'INPUT' && isUsable(byCtl)) return byCtl
        const inner = byCtl.querySelector('input:not([type=radio]):not([type=checkbox]):not([type=file]):not([type=hidden])')
        if (isUsable(inner)) return inner
      }
    }

    let el = label.nextElementSibling
    for (let i = 0; i < 6 && el; i++) {
      if (el.tagName === 'INPUT' && isUsable(el)) return el
      const inp = el.querySelector?.('input:not([type=radio]):not([type=checkbox]):not([type=file]):not([type=hidden])')
      if (isUsable(inp)) return inp
      el = el.nextElementSibling
    }

    const parent = label.parentElement
    if (parent) {
      const inp = parent.querySelector('input:not([type=radio]):not([type=checkbox]):not([type=file]):not([type=hidden])')
      if (isUsable(inp)) return inp
    }

    let cur = label.parentElement
    for (let i = 0; i < 8 && cur; i++) {
      const inp = cur.querySelector('p-datepicker input, p-calendar input, .p-datepicker-input, .p-autocomplete-input, input.p-inputtext, input.form-control')
      if (isUsable(inp)) return inp
      cur = cur.parentElement
    }
    return null
  })
  const input = inputHandle.asElement()
  return { input, labelEl, reason: input ? null : 'input-not-found' }
}

async function ensureInView(page, input) {
  const inView = await input.evaluate((n) => {
    const r = n.getBoundingClientRect()
    return r.top >= 60 && r.bottom <= window.innerHeight - 60 && r.width > 0 && r.height > 0
  }).catch(() => false)
  if (!inView) {
    try { await input.evaluate(n => n.scrollIntoView({ block: 'center', behavior: 'instant' })) } catch {}
    await sleep(350)
  }
}

async function ensureFocus(page, input, ctx, label) {
  await ensureInView(page, input)

  try {
    await input.click({ delay: 20 })
    await sleep(250)
    const ok = await input.evaluate(n => document.activeElement === n)
    if (ok) return { focused: true, method: 'click' }
  } catch (e) { log(ctx, `  ${label}: click() failed: ${e.message}`, 'warn') }

  try {
    await input.evaluate(n => { n.focus(); n.click() })
    await sleep(250)
    const ok = await input.evaluate(n => document.activeElement === n)
    if (ok) return { focused: true, method: 'js-focus' }
  } catch {}

  try {
    const box = await input.evaluate(n => {
      const r = n.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    if (box && box.x > 0 && box.y > 0) {
      await page.mouse.click(box.x, box.y, { delay: 30 })
      await sleep(250)
      const ok = await input.evaluate(n => document.activeElement === n)
      if (ok) return { focused: true, method: 'mouse' }
    }
  } catch {}

  const active = await page.evaluate(() => {
    const a = document.activeElement
    if (!a) return null
    return { tag: a.tagName, id: a.id || '', cls: (a.className || '').toString().slice(0, 80), ph: a.placeholder || '' }
  })
  return { focused: false, active }
}

async function setFieldByLabel(page, labelText, value, ctx) {
  if (value === undefined || value === null || value === '') {
    log(ctx, `⚠ ${labelText}: no value — skipped`, 'warn')
    return false
  }
  const v = String(value)
  const { input, reason } = await findInputForLabel(page, labelText)
  if (!input) { log(ctx, `✗ ${labelText}: ${reason}`, 'error'); return false }

  // 1. Focus the field, then paste + commit (ArrowDown → Enter) like a human
  //    so an autocomplete/typeahead actually "saves" the pasted value instead
  //    of reverting it when the field loses focus.
  const f = await ensureFocus(page, input, ctx, labelText)
  if (f.focused) {
    const after = await pasteAndCommit(page, input, v)
    if (after === v) { log(ctx, `✓ ${labelText} = "${v}" (paste+↓⏎/${f.method})`); return true }
  }

  // 2. Fallback: native prototype setter + input/change/blur events.
  const r1 = await input.evaluate((node, val) => {
    const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
    setter.call(node, val)
    node.dispatchEvent(new Event('input',  { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
    try { node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val })) } catch {}
    return { ok: node.value === val, actual: node.value }
  }, v).catch(e => ({ ok: false, error: e.message }))
  if (r1.ok) { log(ctx, `✓ ${labelText} = "${v}" (setter)`); return true }

  const after = await input.evaluate(n => n.value).catch(() => '')
  log(ctx, `✗ ${labelText}: value="${after}"`, 'error')
  return false
}

async function clickRadioByLabel(page, labelText, optionText, ctx) {
  if (!optionText) { log(ctx, `⚠ ${labelText}: no value — skipped`, 'warn'); return false }
  log(ctx, `clicking radio ${labelText} → "${optionText}"`)
  const r = await page.evaluate((lbl, opt) => {
    const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
    const wanted = norm(opt)
    const groupTarget = norm(lbl)
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
    const groupLabel = Array.from(document.querySelectorAll('label, div, span'))
      .find(el => norm(el.textContent) === groupTarget) ||
      Array.from(document.querySelectorAll('label, div, span'))
      .find(el => norm(el.textContent).startsWith(groupTarget))
    const candidates = []
    for (const radio of radios) {
      let ownText = ''
      if (radio.id) { const o = document.querySelector(`label[for="${radio.id}"]`); if (o) ownText = o.textContent || '' }
      if (!ownText) { const w = radio.closest('label'); if (w) ownText = w.textContent || '' }
      if (norm(ownText) === wanted) {
        let dist = Infinity
        if (groupLabel) {
          const gr = groupLabel.getBoundingClientRect(), rr = radio.getBoundingClientRect()
          dist = Math.hypot(gr.left - rr.left, gr.top - rr.top)
        }
        candidates.push({ radio, dist, ownText })
      }
    }
    if (!candidates.length) return { ok: false, reason: 'no-matching-radio' }
    candidates.sort((a, b) => a.dist - b.dist)
    const winner = candidates[0].radio
    if (winner.checked) return { ok: true, already: true }
    winner.click()
    return { ok: true, clicked: true, id: winner.id, text: candidates[0].ownText.trim() }
  }, labelText, optionText)
  if (r.already) { log(ctx, `✓ ${labelText} already "${optionText}"`); return true }
  if (!r.ok) { log(ctx, `✗ ${labelText}: ${r.reason}`, 'warn'); return false }
  await sleep(200)
  log(ctx, `✓ ${labelText} = "${optionText}" (id=${r.id})`)
  return true
}

async function closeAnyPanel(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.p-autocomplete-panel, .p-datepicker-panel, .p-select-overlay, .p-dropdown-panel')
      .forEach(p => { try { p.style.display = 'none' } catch {} })
  }).catch(() => {})
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(250)
}

async function countSkillChips(page) {
  return await page.evaluate(() => {
    const selectors = [
      '.p-autocomplete-token', '.p-chip', '.p-multiselect-token',
      '.p-multiselect-chip', '.p-autocomplete-multiple-container .p-autocomplete-token',
    ]
    for (const sel of selectors) {
      const n = document.querySelectorAll(sel).length
      if (n > 0) return { count: n, selector: sel }
    }
    return { count: 0, selector: 'none' }
  }).catch(() => ({ count: 0, selector: 'error' }))
}

/**
 * v16.7 — Dropdown: type + ArrowDown + Enter, then fallback to real mouse
 * click on the highlighted panel item.
 */
/**
 * Chips of a multi-choice autocomplete (Education level is one): the chosen
 * values show as chips and the typing box empties again, so "the box is
 * empty" does not mean nothing was chosen. Returns null for a single-choice field.
 */
async function chosenChips(page, labelText) {
  return page.evaluate((w) => {
    const norm = (x) => (x || '').toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim()
    const label = Array.from(document.querySelectorAll('label')).find(l => norm(l.textContent) === norm(w))
    const forId = label?.getAttribute('for')
    const host = (forId && (document.getElementById(forId) || document.querySelector(`[formcontrolname="${forId}"]`))) ||
      label?.parentElement?.querySelector('p-autocomplete')
    if (!host?.querySelector('.p-autocomplete-input-multiple, .p-autocomplete-multiple-container')) return null
    return Array.from(host.querySelectorAll('.p-autocomplete-chip-item, .p-autocomplete-token, li.p-autocomplete-chip'))
      .map(ch => (ch.querySelector('.p-chip-label, .p-autocomplete-token-label') || ch).textContent.trim()).filter(Boolean)
  }, labelText).catch(() => null)
}

/** Remove repeated chips of the same value (left by earlier tries). */
async function removeDuplicateChips(page, labelText, optionText) {
  return page.evaluate((w, opt) => {
    const norm = (x) => (x || '').toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim()
    const label = Array.from(document.querySelectorAll('label')).find(l => norm(l.textContent) === norm(w))
    const forId = label?.getAttribute('for')
    const host = (forId && (document.getElementById(forId) || document.querySelector(`[formcontrolname="${forId}"]`))) ||
      label?.parentElement?.querySelector('p-autocomplete')
    const same = Array.from(host?.querySelectorAll('.p-autocomplete-chip-item, .p-autocomplete-token, li.p-autocomplete-chip') || [])
      .filter(ch => norm((ch.querySelector('.p-chip-label, .p-autocomplete-token-label') || ch).textContent) === norm(opt))
    let removed = 0
    for (const ch of same.slice(1)) {
      const x = ch.querySelector('.p-chip-remove-icon, .p-autocomplete-chip-icon, .p-autocomplete-token-icon, [data-pc-section="removeicon"], svg')
      if (x) { x.dispatchEvent(new MouseEvent('click', { bubbles: true })); removed++ }
    }
    return removed
  }, labelText, optionText).catch(() => 0)
}

async function typeAndCommitDropdown(page, labelText, optionText, ctx) {
  if (!optionText) { log(ctx, `⚠ ${labelText}: no value — skipped`, 'warn'); return false }
  log(ctx, `typing dropdown ${labelText} → "${optionText}"`)

  await closeAnyPanel(page)

  // Multi-choice: already chosen → done (choosing again would add it twice).
  const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim()
  const chipsBefore = await chosenChips(page, labelText)
  if (chipsBefore) {
    const have = chipsBefore.filter(c => norm(c) === norm(optionText)).length
    if (have > 1) log(ctx, `  ${labelText}: "${optionText}" was chosen ${have} times — removed ${await removeDuplicateChips(page, labelText, optionText)} extra`)
    if (have >= 1) { log(ctx, `✓ ${labelText} = "${optionText}" (already chosen)`); return true }
  }

  const { input, reason } = await findInputForLabel(page, labelText)
  if (!input) { log(ctx, `✗ ${labelText}: ${reason}`, 'warn'); return false }

  const f = await ensureFocus(page, input, ctx, labelText)
  if (!f.focused) {
    log(ctx, `✗ ${labelText}: could not focus — active=${JSON.stringify(f.active)}`, 'warn')
    return false
  }

  try { await input.click({ clickCount: 3, delay: 20 }) } catch {}
  await page.keyboard.press('Backspace').catch(() => {})
  await sleep(200)

  // Paste-like typing (one input event) → the autocomplete panel filters once.
  try { await pasteText(page, input, String(optionText)) } catch (e) {
    log(ctx, `  ${labelText}: paste failed: ${e.message}`, 'warn')
  }
  await sleep(800)

  let v = await input.evaluate(n => n.value).catch(() => '')
  log(ctx, `  ${labelText}: typed value = "${v}" (focus via ${f.method})`)
  if (!v || !v.trim()) { log(ctx, `✗ ${labelText}: typing didn't land`, 'warn'); return false }

  // Get panel item coordinates
  const panelInfo = await page.evaluate((opt) => {
    const noSpace = (s) => (s || '').replace(/\s+/g, '').toLowerCase()
    const spaced  = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
    const items = Array.from(document.querySelectorAll(
      '.p-autocomplete-item, .p-autocomplete-option, .p-select-option, [role="option"]'
    ))
    if (!items.length) return { ok: false, reason: 'no-items' }
    let m = items.find(o => spaced(o.textContent) === spaced(opt))
    if (!m) m = items.find(o => noSpace(o.textContent) === noSpace(opt))
    if (!m) m = items.find(o => noSpace(o.textContent).includes(noSpace(opt)))
    if (!m) m = items.find(o => (o.textContent || '').trim().length > 0)
    if (!m) return { ok: false, reason: 'no-match' }
    m.scrollIntoView?.({ block: 'nearest' })
    const r = m.getBoundingClientRect()
    return {
      ok: true,
      x: r.left + r.width / 2, y: r.top + r.height / 2,
      text: (m.textContent || '').trim(),
      all: items.map(i => (i.textContent || '').trim()).slice(0, 20),
    }
  }, optionText)

  if (!panelInfo.ok) {
    log(ctx, `  ${labelText}: no panel — Enter to commit`)
    await page.keyboard.press('Enter').catch(() => {})
    await sleep(400)
  } else {
    // Attempt 1: ArrowDown + Enter (PrimeNG's official selection)
    await page.keyboard.press('ArrowDown').catch(() => {})
    await sleep(200)
    await page.keyboard.press('Enter').catch(() => {})
    await sleep(500)

    v = await input.evaluate(n => n.value).catch(() => '')
    const chipped = chipsBefore && (await chosenChips(page, labelText) || []).some(c => norm(c) === norm(optionText))
    if (!chipped && (!v || !v.trim() || chipsBefore)) {
      // Attempt 2: real mouse click at the panel item's coordinates
      log(ctx, `  ${labelText}: ArrowDown+Enter didn't stick, trying mouse click on "${panelInfo.text}"`)
      await page.mouse.click(panelInfo.x, panelInfo.y, { delay: 30 })
      await sleep(500)
      v = await input.evaluate(n => n.value).catch(() => '')
    }
  }

  await closeAnyPanel(page)

  if (chipsBefore) {
    const now = (await chosenChips(page, labelText)) || []
    const n = now.filter(c => norm(c) === norm(optionText)).length
    if (n > 1) await removeDuplicateChips(page, labelText, optionText)
    if (n >= 1) { log(ctx, `✓ ${labelText} = "${optionText}" (chosen)`); return true }
    log(ctx, `✗ ${labelText}: "${optionText}" was not chosen — chips: ${JSON.stringify(now)}`, 'warn')
    return false
  }

  v = await input.evaluate(n => n.value).catch(() => '')
  if (v && v.trim()) {
    log(ctx, `✓ ${labelText} = "${v}"`)
    return true
  }
  log(ctx, `✗ ${labelText}: input empty after commit${panelInfo.all ? ' — items: ' + JSON.stringify(panelInfo.all) : ''}`, 'warn')
  return false
}

/** Focus a labelled field and press Enter in it (commits the value, like a person does). */
async function enterInField(page, labelText, ctx) {
  const { input, reason } = await findInputForLabel(page, labelText)
  if (!input) { log(ctx, `⚠ Enter: ${labelText} — ${reason}`, 'warn'); return false }
  await ensureFocus(page, input, ctx, labelText)
  await page.keyboard.press('Enter').catch(() => {})
  await sleep(300)
  log(ctx, `✓ Enter pressed in ${labelText}`)
  return true
}

/** Labels inside the "Work Experience" section of the form. */
async function workExperienceLabels(page) {
  return await page.evaluate(() => {
    const h = Array.from(document.querySelectorAll('h5, h4, .app-section-title'))
      .find(e => /work\s+experience/i.test(e.textContent || ''))
    if (!h) return []
    const out = []
    let n = h.nextElementSibling
    for (let i = 0; n && i < 6 && !/^H[45]$/.test(n.tagName); i++, n = n.nextElementSibling) {
      n.querySelectorAll('label').forEach(l => out.push((l.textContent || '').replace(/\*/g, '').trim()))
    }
    return out.filter(Boolean)
  }).catch(() => [])
}

/**
 * "Have experience" makes Musaned ask where, and for how long. The exact
 * fields were not on the pages saved so far, so look in the Work Experience
 * section for labels about a country and about years, fill what is there,
 * and log what was found. Returns the labels it filled: { country, years }.
 */
async function fillExperienceDetails(page, { country, years }, ctx) {
  await sleep(800)
  const labels = await workExperienceLabels(page)
  log(ctx, `  Work Experience fields: ${JSON.stringify(labels)}`)
  const used = { country: null, years: null }

  const countryLabel = labels.find(l => /countr|where|destination/i.test(l))
  if (country) {
    if (countryLabel) { await typeAndCommitDropdown(page, countryLabel, country, ctx); used.country = countryLabel }
    else log(ctx, `⚠ experience country "${country}": no country field on the form — please pick it by hand`, 'warn')
  }

  const yearsLabel = labels.find(l => /year/i.test(l))
  if (years) {
    if (yearsLabel) {
      await setFieldByLabel(page, yearsLabel, String(years), ctx)
      const v = (await readFieldValues(page, [yearsLabel]))[yearsLabel]
      if (!v) await typeAndCommitDropdown(page, yearsLabel, String(years), ctx) // it is a dropdown
      used.years = yearsLabel
    } else {
      log(ctx, `⚠ years of experience "${years}": no years field on the form — please fill it by hand`, 'warn')
    }
  }
  return used
}

/**
 * Current value of labelled form fields: '' when empty, null when the label
 * is not on the page (so it is not reported as missing).
 */
async function readFieldValues(page, labels) {
  return await page.evaluate((wanted) => {
    const norm = (x) => (x || '').toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim()
    const out = {}
    for (const w of wanted) {
      const label = Array.from(document.querySelectorAll('label')).find(l => norm(l.textContent) === norm(w))
      if (!label) { out[w] = null; continue }
      const forId = label.getAttribute('for')
      let el = forId ? (document.getElementById(forId) || document.querySelector(`[formcontrolname="${forId}"]`)) : null
      for (let c = label.parentElement, i = 0; !el && c && i < 3; i++, c = c.parentElement) {
        el = c.querySelector('input:not([type="radio"]):not([type="checkbox"]), textarea, .p-select, .p-dropdown')
      }
      if (!el) { out[w] = ''; continue }
      const inp = el.matches('input, textarea') ? el : el.querySelector('.p-autocomplete-input, .p-datepicker-input, input, textarea')
      if (inp && String(inp.value || '').trim()) { out[w] = String(inp.value).trim(); continue }
      // Multi-choice field: the chosen values are chips, the input stays empty.
      const host = el.closest?.('p-autocomplete') || el.querySelector?.('p-autocomplete') || el
      const chips = Array.from(host.querySelectorAll?.('.p-autocomplete-chip-item, .p-autocomplete-token, li.p-autocomplete-chip') || [])
        .map(ch => (ch.querySelector('.p-chip-label, .p-autocomplete-token-label') || ch).textContent.trim()).filter(Boolean)
      if (chips.length) { out[w] = chips.join(', '); continue }
      const shown = el.querySelector('.p-select-label, .p-dropdown-label')
      out[w] = shown && !shown.classList.contains('p-placeholder') ? shown.textContent.trim() : ''
    }
    return out
  }, labels).catch(() => ({}))
}

/** Text of the checked option in a radio group ('' when none is checked). */
async function checkedRadio(page, labelText) {
  return await page.evaluate((w) => {
    const norm = (x) => (x || '').toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim()
    const label = Array.from(document.querySelectorAll('label')).find(l => norm(l.textContent) === norm(w))
    for (let c = label?.parentElement, i = 0; c && i < 4; i++, c = c.parentElement) {
      const r = c.querySelector('input[type="radio"]:checked')
      if (r) {
        const l = r.id ? document.querySelector(`label[for="${r.id}"]`) : null
        return (l?.textContent || r.value || 'checked').trim()
      }
      if (c.querySelectorAll('input[type="radio"]').length) return ''
    }
    return ''
  }, labelText).catch(() => '')
}

/** The skills saved as chips in the Skills field. */
async function skillChipTexts(page) {
  return await page.evaluate(() => {
    const norm = (x) => (x || '').toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim()
    const label = Array.from(document.querySelectorAll('label')).find(l => norm(l.textContent) === 'skills')
    for (let c = label?.parentElement, i = 0; c && i < 4; i++, c = c.parentElement) {
      const chips = c.querySelectorAll('.p-autocomplete-token, .p-chip, .p-multiselect-token, .p-multiselect-chip')
      if (chips.length) {
        return Array.from(chips).map(ch =>
          (ch.querySelector('.p-autocomplete-token-label, .p-chip-label, .p-multiselect-token-label') || ch).textContent.trim())
      }
    }
    return []
  }).catch(() => [])
}

/**
 * Musaned loads some options slowly (Job), and the fill is fast, so a field
 * can end up empty. Re-read everything at the end and refill what is
 * missing, waiting longer each pass. Returns the labels still empty.
 */
async function verifyAndRefill(page, want, ctx) {
  const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim()
  const findMissing = async () => {
    const labels = [...Object.keys(want.dropdowns), ...Object.keys(want.texts), ...Object.keys(want.dates)]
    const vals = await readFieldValues(page, labels)
    const missing = []
    for (const [kind, map] of [['dropdown', want.dropdowns], ['text', want.texts], ['date', want.dates]]) {
      for (const [label, value] of Object.entries(map)) {
        if (value && vals[label] === '') missing.push({ kind, label, value })
      }
    }
    for (const [label, value] of Object.entries(want.radios)) {
      if (value && !(await checkedRadio(page, label))) missing.push({ kind: 'radio', label, value })
    }
    const chips = (await skillChipTexts(page)).map(norm)
    const skills = want.skills.filter(sk => !chips.some(c => c.includes(norm(sk)) || norm(sk).includes(c)))
    return { missing, skills }
  }

  for (let pass = 1; pass <= 3; pass++) {
    const { missing, skills } = await findMissing()
    if (!missing.length && !skills.length) {
      log(ctx, `✓ final check: every field is filled (pass ${pass})`)
      return []
    }
    log(ctx, `final check pass ${pass}: refilling ${[...missing.map(m => m.label), ...skills.map(sk => `skill "${sk}"`)].join(', ')}`, 'warn')
    await sleep(1500 * pass) // give slow option lists time to load
    for (const m of missing) {
      if (m.kind === 'dropdown') await typeAndCommitDropdown(page, m.label, m.value, ctx)
      else if (m.kind === 'text') await setFieldByLabel(page, m.label, m.value, ctx)
      else if (m.kind === 'date') await fillDateByLabel(page, m.label, m.value, ctx)
      else await clickRadioByLabel(page, m.label, m.value, ctx)
      await sleep(500)
    }
    if (skills.length) await fillSkillsByTyping(page, skills, ctx)
  }
  const { missing, skills } = await findMissing()
  const left = [...missing.map(m => m.label), ...skills.map(sk => `skill "${sk}"`)]
  if (left.length) log(ctx, `✗ final check: still empty after 3 passes — ${left.join(', ')}`, 'error')
  else log(ctx, '✓ final check: every field is filled')
  return left
}

async function fillSkillsByTyping(page, skills, ctx) {
  await closeAnyPanel(page)
  await sleep(300)

  const { input, reason } = await findInputForLabel(page, 'Skills')
  if (!input) { log(ctx, `Skills: ${reason}`, 'warn'); return false }

  const f = await ensureFocus(page, input, ctx, 'Skills')
  if (!f.focused) {
    log(ctx, `✗ Skills: could not focus — active=${JSON.stringify(f.active)}`, 'warn')
    return false
  }

  const before = await countSkillChips(page)
  log(ctx, `Skills: starting chip count = ${before.count} (selector: ${before.selector})`)

  for (let idx = 0; idx < skills.length; idx++) {
    const skill = skills[idx]

    // Close any panel from the previous iteration, re-focus
    if (idx > 0) {
      await closeAnyPanel(page)
      await sleep(300)
    }
    const still = await input.evaluate(n => document.activeElement === n).catch(() => false)
    if (!still) {
      const f2 = await ensureFocus(page, input, ctx, 'Skills')
      if (!f2.focused) { log(ctx, `✗ Skills: lost focus before "${skill}"`, 'warn'); break }
    }

    // Paste-like typing (one input event) → faster panel filtering per skill.
    try { await pasteText(page, input, String(skill)) } catch {}
    await sleep(900)

    // Wait for panel items
    const itemsAppeared = await page.waitForFunction(() => {
      const items = document.querySelectorAll(
        '.p-autocomplete-item, .p-autocomplete-option, .p-multiselect-item, [role="option"]'
      )
      return items.length > 0
    }, { timeout: 2500 }).then(() => true).catch(() => false)

    if (!itemsAppeared) {
      log(ctx, `✗ skill: "${skill}" — no panel items`, 'warn')
      continue
    }
    await sleep(300)

    const c0 = await countSkillChips(page)

    // Method A: mouse click the first non-empty matching option
    const optBox = await page.evaluate((s) => {
      const noSpace = (x) => (x || '').replace(/\s+/g, '').toLowerCase()
      const items = Array.from(document.querySelectorAll(
        '.p-autocomplete-item, .p-autocomplete-option, .p-multiselect-item, [role="option"]'
      ))
      let m = items.find(o => noSpace(o.textContent) === noSpace(s))
      if (!m) m = items.find(o => noSpace(o.textContent).includes(noSpace(s)))
      if (!m) m = items.find(o => (o.textContent || '').trim().length > 0)
      if (!m) return null
      m.scrollIntoView?.({ block: 'nearest' })
      const r = m.getBoundingClientRect()
      if (r.width < 3 || r.height < 3) return null
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (m.textContent || '').trim() }
    }, skill)

    // Tab after the skill saves it as a new chip. Enter or a click on the
    // option REPLACED the previous skill (chips stayed at 2 for 6 skills),
    // so they are only a fallback when Tab added nothing.
    await page.keyboard.press('Tab').catch(() => {})
    await sleep(600)
    let c1 = await countSkillChips(page)
    if (c1.count <= c0.count) {
      log(ctx, `  skill "${skill}": Tab added nothing — highlighting the match and pressing Tab again`)
      const f4 = await ensureFocus(page, input, ctx, 'Skills')
      if (f4.focused) {
        try { await pasteText(page, input, String(skill)) } catch {}
        await sleep(900)
        await page.keyboard.press('ArrowDown').catch(() => {})
        await sleep(200)
        await page.keyboard.press('Tab').catch(() => {})
        await sleep(600)
        c1 = await countSkillChips(page)
      }
    }
    if (c1.count <= c0.count && optBox) {
      await page.mouse.click(optBox.x, optBox.y, { delay: 30 })
      await sleep(500)
      await page.keyboard.press('Tab').catch(() => {})
      await sleep(400)
      c1 = await countSkillChips(page)
    }

    log(ctx, c1.count > c0.count
      ? `✓ skill: "${skill}" (chips ${c0.count} → ${c1.count})`
      : `✗ skill: "${skill}" NOT added (chips still ${c1.count})`,
      c1.count > c0.count ? 'info' : 'warn')

    const f3 = await ensureFocus(page, input, ctx, 'Skills')
    if (!f3.focused) { log(ctx, `✗ Skills: could not re-focus after "${skill}"`, 'warn'); break }
  }

  const after = await countSkillChips(page)
  log(ctx, `Skills: final chip count = ${after.count}`)
  await closeAnyPanel(page)
  return after.count > before.count
}

/**
 * v16.7 — Date with DIAGNOSTIC when typing fails.
 * Logs the label HTML, every candidate input, and which one we picked.
 */
/**
 * Musaned's passport dates are ng-bootstrap calendars (<app-calendar> with a
 * read-only input[ngbDatepicker]). Text put into that input shows, but the
 * form never gets the date — Save stays blocked. So the date is picked the
 * way a person does: open the calendar, choose year and month, click the day.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function dateParts(value) {
  const s = String(value || '').trim()
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return { y: +m[1], m: +m[2], d: +m[3] }
  const t = new Date(s)
  return isNaN(t) ? null : { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate() }
}

async function isNgbCalendar(page, labelText) {
  return page.evaluate((w) => {
    const norm = (x) => (x || '').toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim()
    const label = Array.from(document.querySelectorAll('label')).find(l => norm(l.textContent) === norm(w))
    const forId = label?.getAttribute('for')
    const host = (forId && document.querySelector(`app-calendar[formcontrolname="${forId}"]`)) || label?.parentElement?.querySelector('app-calendar')
    if (!host) return null
    const inp = host.querySelector('input')
    return { ngb: !!inp?.hasAttribute('ngbdatepicker'), disabled: !!inp?.disabled, value: inp?.value || '' }
  }, labelText).catch(() => null)
}

async function fillNgbDate(page, labelText, dateValue, ctx) {
  const want = dateParts(dateValue)
  if (!want) { log(ctx, `✗ ${labelText}: cannot read the date "${dateValue}"`, 'warn'); return false }
  let cal = await isNgbCalendar(page, labelText)
  // Expiry opens a moment after the issue date is picked: give it 3 s.
  for (let i = 0; cal?.disabled && i < 6; i++) { await sleep(500); cal = await isNgbCalendar(page, labelText) }
  if (cal?.disabled) { log(ctx, `  ${labelText}: Musaned keeps this date locked (it fills it itself) — left as it is`); return true }

  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.keyboard.press('Escape').catch(() => {})
    // Open the calendar (its icon, else the input).
    const opened = await page.evaluate((w) => {
      const norm = (x) => (x || '').toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim()
      const label = Array.from(document.querySelectorAll('label')).find(l => norm(l.textContent) === norm(w))
      const forId = label?.getAttribute('for')
      const host = (forId && document.querySelector(`app-calendar[formcontrolname="${forId}"]`)) || label?.parentElement?.querySelector('app-calendar')
      if (!host) return false
      host.scrollIntoView({ block: 'center' })
      const icon = host.querySelector('em, i, .fa-calendar, button')
      ;(icon || host.querySelector('input'))?.click()
      return true
    }, labelText).catch(() => false)
    if (!opened) { log(ctx, `✗ ${labelText}: calendar not found`, 'warn'); return false }
    const shown = await page.waitForSelector('ngb-datepicker', { visible: true, timeout: 4000 }).then(() => true, () => false)
    if (!shown) {
      // the icon did nothing: try the input itself
      await page.evaluate((w) => {
        const norm = (x) => (x || '').toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim()
        const label = Array.from(document.querySelectorAll('label')).find(l => norm(l.textContent) === norm(w))
        const forId = label?.getAttribute('for')
        document.querySelector(`app-calendar[formcontrolname="${forId}"] input`)?.click()
      }, labelText).catch(() => {})
      if (!(await page.waitForSelector('ngb-datepicker', { visible: true, timeout: 3000 }).then(() => true, () => false))) {
        log(ctx, `  ${labelText}: the calendar did not open (try ${attempt}/3)`, 'warn'); continue
      }
    }

    // Year and month: the calendar's own selects (else its arrows).
    const nav = await page.evaluate(async ({ y, m }) => {
      const dp = document.querySelector('ngb-datepicker')
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const sels = Array.from(dp.querySelectorAll('select'))
      const yearSel = sels.find(s => /year/i.test(s.title || s.getAttribute('aria-label') || '')) || sels[1]
      const monthSel = sels.find(s => /month/i.test(s.title || s.getAttribute('aria-label') || '')) || sels[0]
      const choose = (sel, v) => {
        const opt = Array.from(sel.options).find(o => Number(o.value) === v || o.textContent.trim() === String(v))
        if (!opt) return false
        sel.value = opt.value
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }
      if (yearSel && monthSel) {
        const okY = choose(yearSel, y); await sleep(150)
        const okM = choose(monthSel, m); await sleep(250)
        return { how: 'selects', okY, okM }
      }
      // Arrows: step until the shown month is the wanted one.
      const months = ['january','february','march','april','may','june','july','august','september','october','november','december']
      for (let i = 0; i < 1500; i++) {
        const title = (dp.querySelector('.ngb-dp-month-name, .ngb-dp-navigation-select, .ngb-dp-header')?.textContent || '').toLowerCase()
        const ty = Number((title.match(/(19|20)\d{2}/) || [])[0]); const tm = months.findIndex(x => title.includes(x)) + 1
        if (ty === y && tm === m) return { how: 'arrows', okY: true, okM: true }
        const back = ty > y || (ty === y && tm > m)
        const btn = dp.querySelector(back ? '.ngb-dp-arrow:not(.right) button, [aria-label*="Previous" i]' : '.ngb-dp-arrow.right button, [aria-label*="Next" i]')
        if (!btn || !ty || !tm) return { how: 'arrows', okY: false, okM: false }
        btn.click(); await sleep(20)
      }
      return { how: 'arrows', okY: false, okM: false }
    }, want).catch(e => ({ how: 'error ' + e.message }))

    // The day: by its label ("Friday, March 6, 2026"), else by its number in this month.
    const clicked = await page.evaluate(({ y, m, d, monthName }) => {
      const dp = document.querySelector('ngb-datepicker')
      const days = Array.from(dp.querySelectorAll('.ngb-dp-day, [ngbdatepickerdayview]'))
      const usable = (el) => !el.classList.contains('disabled') && !el.classList.contains('hidden') &&
        !el.querySelector('.text-muted, .outside') && el.getAttribute('aria-disabled') !== 'true'
      let t = days.find(el => (el.getAttribute('aria-label') || '').includes(`${monthName} ${d}, ${y}`))
      if (!t) t = days.find(el => usable(el) && (el.textContent || '').trim() === String(d))
      if (!t) return false
      ;(t.querySelector('[ngbdatepickerdayview], .btn-light, div') || t).click()
      t.click()
      return true
    }, { ...want, monthName: MONTHS[want.m - 1] }).catch(() => false)
    await sleep(500)

    const after = await isNgbCalendar(page, labelText)
    if (clicked && after?.value) {
      log(ctx, `✓ ${labelText} = "${after.value}" (picked in the calendar: ${nav.how})`)
      await page.keyboard.press('Escape').catch(() => {})
      return true
    }
    log(ctx, `  ${labelText}: calendar pick did not stick (try ${attempt}/3, ${nav.how}, year ${nav.okY}, month ${nav.okM}, day ${clicked})`, 'warn')
  }
  log(ctx, `✗ ${labelText}: could not be picked — please choose it in the calendar by hand`, 'warn')
  return false
}

async function fillDateByLabel(page, labelText, dateValue, ctx) {
  // ng-bootstrap calendar (passport dates): pick it, never type into it.
  if ((await isNgbCalendar(page, labelText))?.ngb) return fillNgbDate(page, labelText, dateValue, ctx)

  if (!dateValue) { log(ctx, `⚠ ${labelText}: no value — skipped`, 'warn'); return false }
  log(ctx, `filling date ${labelText} → "${dateValue}"`)

  await closeAnyPanel(page)

  const { input, reason } = await findInputForLabel(page, labelText)
  if (!input) { log(ctx, `✗ ${labelText}: ${reason}`, 'warn'); return false }

  await ensureInView(page, input)

  // ─── Method 1: temporarily lift readOnly + native setter
  const ro = await input.evaluate(n => n.readOnly).catch(() => false)
  if (ro) {
    log(ctx, `  ${labelText}: input is readOnly — trying native setter with readonly lifted`)
    const r1 = await input.evaluate((node, val) => {
      const prevRo = node.readOnly
      const prevDisabled = node.disabled
      try {
        node.readOnly = false
        node.disabled = false
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(node, val)
        node.dispatchEvent(new Event('input',  { bubbles: true }))
        node.dispatchEvent(new Event('change', { bubbles: true }))
        node.dispatchEvent(new Event('blur',   { bubbles: true }))
        return { ok: node.value === val, actual: node.value }
      } finally {
        node.readOnly = prevRo
        node.disabled = prevDisabled
      }
    }, String(dateValue)).catch(e => ({ ok: false, error: e.message }))

    if (r1.ok) {
      log(ctx, `✓ ${labelText} = "${r1.actual}" (readonly-lifted)`)
      await sleep(400)
      return true
    }
    log(ctx, `  ${labelText}: readonly-lift didn't stick (${r1.error || r1.actual})`, 'warn')
  }

  // ─── Method 2: click calendar icon → panel opens → inner typeable input
  log(ctx, `  ${labelText}: opening calendar via icon`)
  const iconBox = await input.evaluate((node) => {
    const wrapper = node.closest('app-calendar, p-calendar, p-datepicker, .p-calendar, .p-datepicker, .p-inputwrapper, .app-calendar') || node.parentElement
    if (!wrapper) return null
    const icon = wrapper.querySelector('.p-datepicker-trigger, .p-datepicker-dropdown, .p-calendar-trigger, .p-input-icon-right i, i.fa-calendar, i.pi-calendar, button')
    if (!icon) return null
    const r = icon.getBoundingClientRect()
    if (r.width < 3 || r.height < 3) return null
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }).catch(() => null)

  if (iconBox) {
    await page.mouse.click(iconBox.x, iconBox.y, { delay: 30 })
    await sleep(800)

    // Panel usually renders a typeable input
    const panelInput = await page.evaluateHandle(() => {
      const sels = [
        '.p-datepicker-panel input.p-inputtext',
        '.p-datepicker-panel input',
        '.p-datepicker .p-datepicker-input',
        '[role="dialog"] .p-datepicker-input',
        '.p-overlaypanel input',
        'p-datepicker input:not([readonly])',
        '.p-datepicker-input:not([readonly])',
      ]
      for (const sel of sels) {
        const els = document.querySelectorAll(sel)
        for (const el of els) {
          if (el.tagName === 'INPUT' && !el.readOnly && !el.disabled) return el
        }
      }
      return null
    })
    const pInput = panelInput.asElement()
    if (pInput) {
      await pInput.click({ clickCount: 3, delay: 30 })
      await sleep(200)
      await page.keyboard.press('Backspace').catch(() => {})
      await pasteText(page, pInput, String(dateValue))
      await sleep(600)
      await page.keyboard.press('Enter').catch(() => {})
      await sleep(500)

      const v = await input.evaluate(n => n.value).catch(() => '')
      if (v && v.trim()) {
        log(ctx, `✓ ${labelText} = "${v}" (via panel input)`)
        return true
      }
    }

    // ─── Method 3: navigate to correct day cell
    // Parse target date
    const parsed = (() => {
      const s = String(dateValue).trim()
      const m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/)
      if (m) {
        const months = ['January','February','March','April','May','June','July','August','September','October','November','December']
        const mo = months.indexOf(m[1])
        if (mo >= 0) return { year: parseInt(m[3], 10), month: mo + 1, day: parseInt(m[2], 10) }
      }
      const d = new Date(s)
      if (!isNaN(d.getTime())) return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }
      return null
    })()

    if (parsed) {
      // Try clicking the day cell text in the visible month grid
      const dayClicked = await page.evaluate(({ y, m, d }) => {
        // Navigate using the header month/year selects if available
        const headerSelects = document.querySelectorAll(
          '.p-datepicker-panel select, .p-datepicker select'
        )
        // PrimeNG datepicker has month panel + year panel triggered by header text
        const dayCells = Array.from(document.querySelectorAll(
          '.p-datepicker-panel td, .p-datepicker td, .p-datepicker-panel .p-datepicker-day, [role="gridcell"]'
        ))
        // Check if the header shows our target month/year
        const headerText = (document.querySelector('.p-datepicker-title, .p-datepicker-header')?.textContent || '').toLowerCase()
        const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december']
        const wantMonth = monthNames[m - 1]
        const wantYear = String(y)
        const headerMatches = headerText.includes(wantMonth) && headerText.includes(wantYear)
        if (!headerMatches) return { ok: false, reason: 'header-mismatch', header: headerText }

        const target = dayCells.find(td => {
          const t = (td.textContent || '').trim()
          return t === String(d) && !td.classList.contains('p-disabled') && !td.classList.contains('p-datepicker-other-month')
        })
        if (!target) return { ok: false, reason: 'day-not-found' }
        target.click()
        return { ok: true }
      }, parsed)

      if (dayClicked.ok) {
        await sleep(500)
        const v = await input.evaluate(n => n.value).catch(() => '')
        if (v && v.trim()) {
          log(ctx, `✓ ${labelText} = "${v}" (via day cell)`)
          return true
        }
      } else {
        log(ctx, `  ${labelText}: could not click day — ${dayClicked.reason}${dayClicked.header ? ' (header="' + dayClicked.header + '")' : ''}`, 'warn')
      }
    }
  } else {
    log(ctx, `  ${labelText}: no calendar icon found`, 'warn')
  }

  log(ctx, `✗ ${labelText}: all methods failed`, 'warn')
  return false
}

// ============================================================================
// PERSONAL PHOTO — DB resolve + modal upload (v17.3)
// ============================================================================

let _dbPromise = null
function getDb() {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      try {
        const mod = await import('../config/database.js')
        const db = mod.default || mod.knex || mod.db || null
        return (db && typeof db === 'function') ? db : null
      } catch { return null }
    })()
  }
  return _dbPromise
}

/** Recursive basename search (files first, then dirs). */
function findFileDeep(name, dir, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return null
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return path.join(dir, e.name)
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const hit = findFileDeep(name, path.join(dir, e.name), depth + 1, maxDepth)
    if (hit) return hit
  }
  return null
}

/**
 * Resolve the personal photo:
 *  1) absolute paths passed via ctx / profile columns
 *  2) DB: profile_fields('Photo') → files (newest, image/*, ≤5MB)
 */
async function resolvePersonalPhotoPath(ctx) {
  // Only a real file from the profile's Photo field. No guessing on disk and
  // no ctx.photoPath: both used to pick the face cut from the PASSPORT
  // ("<name>_photo.jpg"), which Musaned then showed as the personal photo.
  const pid = ctx.profileId ?? ctx.profile?.id ?? null
  if (pid == null) return { path: null, source: 'no-profile-id' }
  const db = await getDb()
  if (!db) return { path: null, source: 'no-db' }
  try {
    const r = await personalPhotoFile(db, pid)
    if (r.path) return { path: r.path, source: `db:Photo (file #${r.id})` }
    return { path: null, source: r.passportCropOnly ? 'passport-crop-only' : 'db-miss', passportCropOnly: r.passportCropOnly }
  } catch (e) {
    log(ctx, `photo DB resolve failed: ${e.message}`, 'warn')
    return { path: null, source: 'db-error' }
  }
}

/**
 * Put `window.__adalPhotoModal()` into the page: it returns the open
 * "Personal Photo Upload" window, or null. It first tries the usual dialog
 * containers, then any visible box holding the window's title or dropzone
 * text together with a file input or a Confirm/Cancel button — so it still
 * works if Musaned renders the window without Bootstrap's modal classes.
 */
async function installPhotoModalFinder(page) {
  await page.evaluate((sels, titleSrc, dzSrc) => {
    window.__adalPhotoModal = () => {
      const re = new RegExp(`${titleSrc}|${dzSrc}`, 'i')
      const vis = (e) => {
        const r = e.getBoundingClientRect()
        const cs = getComputedStyle(e)
        return r.width > 100 && r.height > 50 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'
      }
      for (const d of document.querySelectorAll(sels)) {
        if (re.test(d.textContent || '') && vis(d)) return d
      }
      const hits = Array.from(document.querySelectorAll('body *'))
        .filter(e => e.children.length < 6 && re.test(e.textContent || ''))
      for (const h of hits) {
        let n = h
        for (let i = 0; i < 8 && n && n !== document.body; i++, n = n.parentElement) {
          const hasControls = n.querySelector('input[type="file"]') ||
            Array.from(n.querySelectorAll('button')).some(b => /^(confirm|cancel)$/i.test((b.textContent || '').trim()))
          if (hasControls && vis(n)) return n
        }
      }
      return null
    }
  }, PHOTO_MODAL_SELS, PHOTO_MODAL_SRC, DROPZONE_SRC).catch(() => {})
}

function photoModalHandles(page) {
  return page.evaluateHandle((sels, reSrc) => {
    const re = new RegExp(reSrc, 'i')
    const dlgs = (window.__adalPhotoModal ? [window.__adalPhotoModal()].filter(Boolean) : Array.from(document.querySelectorAll(sels)).filter(d => re.test(d.textContent || '')))
    return dlgs[0] || null
  }, PHOTO_MODAL_SELS, PHOTO_MODAL_SRC)
}

async function photoModalOpen(page) {
  return await page.evaluate((sels, reSrc) => {
    const re = new RegExp(reSrc, 'i')
    if (window.__adalPhotoModal) return !!window.__adalPhotoModal()
    return Array.from(document.querySelectorAll(sels))
      .some(d => re.test(d.textContent || '') && d.getBoundingClientRect().width > 100)
  }, PHOTO_MODAL_SELS, PHOTO_MODAL_SRC).catch(() => false)
}

async function cancelPhotoModal(page) {
  await page.evaluate((sels, reSrc) => {
    const re = new RegExp(reSrc, 'i')
    const dlgs = (window.__adalPhotoModal ? [window.__adalPhotoModal()].filter(Boolean) : Array.from(document.querySelectorAll(sels)).filter(d => re.test(d.textContent || '')))
    for (const d of dlgs) {
      const b = Array.from(d.querySelectorAll('button, a, [role="button"]'))
        .find(x => /^cancel$/i.test((x.textContent || '').trim()))
      if (b) { b.click(); return }
      const x = d.querySelector('.p-dialog-header-close, .p-dialog-header-icon, button[aria-label="Close"], .close')
      if (x) x.click()
    }
  }, PHOTO_MODAL_SELS, PHOTO_MODAL_SRC).catch(() => {})
  await sleep(600)
}

/**
 * v17.3 — Personal photo upload.
 * Flow: click "Upload personal photo" → WAIT for the "Personal Photo Upload"
 * modal → put the file into the modal's hidden <input type=file> (or click the
 * dropzone and intercept the native chooser) → click CONFIRM → wait for close.
 */
export async function uploadPersonalPhoto(page, ctx) {
  const resolved = await resolvePersonalPhotoPath(ctx)
  const photoPath = resolved.path
  log(ctx, `personal photo: resolved = ${photoPath || 'NONE'} (source: ${resolved.source})`)
  if (!photoPath) { log(ctx, '⚠ no personal photo resolved — skipping', 'warn'); return { ok: false, reason: 'no-photo-path' } }
  if (!fs.existsSync(photoPath)) { log(ctx, '⚠ resolved photo missing on disk', 'warn'); return { ok: false, reason: 'file-missing' } }

  // The run tab catches file dialogs (tabManager): while this is armed, any
  // dialog the page opens gets the photo and the system window never shows.
  let chooserAccepted = false
  expectFile(page, photoPath, 120000).then(ok => {
    if (ok) { chooserAccepted = true; log(ctx, '✓ photo handed to the page\'s file dialog') }
  })

  // ── 1) click the "Upload personal photo" link ───────────────────────
  await installPhotoModalFinder(page)
  const target = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('a, button, [role="button"]'))
    const matches = all.filter(e => /upload\s+personal\s+photo/i.test((e.textContent || '').trim()) && e.children.length <= 2)
    if (!matches.length) return null
    matches.sort((a, b) => (a.tagName === 'A' ? 0 : 1) - (b.tagName === 'A' ? 0 : 1))
    const el = matches[0]
    document.querySelectorAll('[data-adal-photo-btn]').forEach(e => e.removeAttribute('data-adal-photo-btn'))
    el.setAttribute('data-adal-photo-btn', '1')
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    return { tag: el.tagName }
  })
  if (!target) {
    disarmFile(page)
    log(ctx, '✗ "Upload personal photo" not found', 'warn')
    return { ok: false, reason: 'not-found' }
  }
  // Measure AFTER the scroll has settled, and make sure the point really is
  // on the button (not under the chat bubble, a banner, or a stale position).
  await sleep(500)
  const pt = await page.evaluate(() => {
    const el = document.querySelector('[data-adal-photo-btn]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return { x, y, onTarget: !!hit && (hit === el || el.contains(hit)) }
  })
  const domClick = () => page.evaluate(() => {
    const el = document.querySelector('[data-adal-photo-btn]')
    if (el) el.click()
    return !!el
  }).catch(() => false)

  if (pt && pt.onTarget) {
    log(ctx, `clicking <${target.tag}> Upload personal photo at ${Math.round(pt.x)},${Math.round(pt.y)}`)
    await page.mouse.move(pt.x, pt.y, { steps: 6 }); await sleep(80)
    await page.mouse.down(); await sleep(50); await page.mouse.up()
  } else {
    log(ctx, `"Upload personal photo" is covered or off-screen — clicking it directly`)
    await domClick()
  }

  // ── 2) wait for the modal (or a direct chooser) ─────────────────────
  const waitForModal = async (ms) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (chooserAccepted) return false
      if (await photoModalOpen(page)) return true
      await sleep(250)
    }
    return false
  }
  let open = await waitForModal(6000)
  if (!open && !chooserAccepted) {
    log(ctx, 'photo window not open yet — clicking "Upload personal photo" again (direct click)')
    await domClick()
    open = await waitForModal(12000)
  }
  if (chooserAccepted && !open) {
    disarmFile(page)
    log(ctx, '✓ photo accepted via native chooser (no modal)')
    await sleep(2500)
    return { ok: true, via: 'filechooser-direct' }
  }
  if (!open) {
    disarmFile(page)
    log(ctx, '✗ Personal Photo Upload modal did not appear', 'warn')
    await diagnoseMusanedPage(page, ctx, 'photo-modal-missing')
    return { ok: false, reason: 'modal-did-not-open' }
  }
  log(ctx, '✓ Personal Photo Upload modal is open')
  await sleep(600)

  // ── 3) place the file inside the modal ──────────────────────────────
  let uploaded = false
  let viaInput = false
  const modalInput = (await page.evaluateHandle((sels, reSrc) => {
    const re = new RegExp(reSrc, 'i')
    const dlgs = (window.__adalPhotoModal ? [window.__adalPhotoModal()].filter(Boolean) : Array.from(document.querySelectorAll(sels)).filter(d => re.test(d.textContent || '')))
    for (const d of dlgs) { const inp = d.querySelector('input[type="file"]'); if (inp) return inp }
    return null
  }, PHOTO_MODAL_SELS, PHOTO_MODAL_SRC)).asElement()

  if (modalInput) {
    try {
      await modalInput.uploadFile(photoPath)
      uploaded = true; viaInput = true
      log(ctx, '✓ photo set on modal file input')
    } catch (e) { log(ctx, `✗ modal input upload failed: ${e.message}`, 'warn') }
  }
  if (!uploaded) {
    log(ctx, 'no file input in modal — clicking dropzone (chooser listener armed)')
    const dz = await page.evaluate((sels, reSrc, dzSrc) => {
      const re = new RegExp(reSrc, 'i'), dzRe = new RegExp(dzSrc, 'i')
      const dlgs = (window.__adalPhotoModal ? [window.__adalPhotoModal()].filter(Boolean) : Array.from(document.querySelectorAll(sels)).filter(d => re.test(d.textContent || '')))
      for (const d of dlgs) {
        const el = Array.from(d.querySelectorAll('div, span, a, button, label, p'))
          .filter(e => dzRe.test(e.textContent || ''))
          .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0]
        if (el) { const r = el.getBoundingClientRect(); if (r.width > 10) return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }
      }
      return null
    }, PHOTO_MODAL_SELS, PHOTO_MODAL_SRC, DROPZONE_SRC)
    if (dz) {
      await page.mouse.move(dz.x, dz.y, { steps: 5 }); await sleep(60)
      await page.mouse.down(); await sleep(40); await page.mouse.up()
      const t1 = Date.now()
      while (Date.now() - t1 < 5000 && !chooserAccepted) await sleep(200)
      uploaded = chooserAccepted
    }
  }
  await sleep(1500) // let preview render / CONFIRM enable
  if (!uploaded) {
    log(ctx, '✗ could not place photo into modal — cancelling', 'warn')
    disarmFile(page)
    await cancelPhotoModal(page)
    return { ok: false, reason: 'upload-failed' }
  }

  // ── 4) click CONFIRM and wait for the modal to close ────────────────
  let confirmed = false
  for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
    const btn = await page.evaluate((sels, reSrc) => {
      const re = new RegExp(reSrc, 'i')
      const dlgs = (window.__adalPhotoModal ? [window.__adalPhotoModal()].filter(Boolean) : Array.from(document.querySelectorAll(sels)).filter(d => re.test(d.textContent || '')))
      for (const d of dlgs) {
        const b = Array.from(d.querySelectorAll('button, [role="button"]'))
          .find(x => /^confirm$/i.test((x.textContent || '').trim()))
        if (!b) continue
        if (b.disabled) return { disabled: true }
        const r = b.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
      return null
    }, PHOTO_MODAL_SELS, PHOTO_MODAL_SRC)
    if (!btn) break
    if (btn.disabled) { log(ctx, '  CONFIRM disabled — waiting'); await sleep(1200); continue }
    await page.mouse.move(btn.x, btn.y, { steps: 5 }); await sleep(60)
    await page.mouse.down(); await sleep(40); await page.mouse.up()
    log(ctx, '✓ clicked CONFIRM')
    const t2 = Date.now()
    while (Date.now() - t2 < 8000) { if (!(await photoModalOpen(page))) break; await sleep(250) }
    confirmed = !(await photoModalOpen(page))
    if (!confirmed) await sleep(800)
  }
  disarmFile(page)

  if (!confirmed) {
    log(ctx, '⚠ modal still open after CONFIRM — cancelling', 'warn')
    await diagnoseMusanedPage(page, ctx, 'photo-confirm-stuck')
    await cancelPhotoModal(page)
    return { ok: false, reason: 'confirm-failed' }
  }
  log(ctx, '✓ personal photo uploaded & confirmed')
  await sleep(2000)
  return { ok: true, via: viaInput ? 'modal-input' : 'dropzone-chooser' }
}

async function clickAcknowledge(page, ctx) {
  const result = await page.evaluate(() => {
    const cb = document.getElementById('confirmCheck') ||
      Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .find(c => /i\s+acknowledge\s+that\s+the\s+candidate/i.test(
          c.closest('div, label')?.textContent || ''))
    if (!cb) return { ok: false, reason: 'not-found' }
    if (cb.checked) return { ok: true, already: true }
    cb.click()
    return { ok: true, clicked: true }
  })
  if (result.already) { log(ctx, '✓ acknowledge already checked'); return true }
  if (!result.ok) { log(ctx, `acknowledge: ${result.reason}`, 'warn'); return false }
  await sleep(300)
  const verified = await page.evaluate(() => document.getElementById('confirmCheck')?.checked ?? null)
  log(ctx, verified ? '✓ acknowledge checked' : '⚠ acknowledge unclear', verified ? 'info' : 'warn')
  return !!verified
}

async function playReadyBeep(page, ctx) {
  try {
    const ok = await page.evaluate(() => {
      try {
        const AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return false
        const ac = new AC()
        const beep = (f, s, d) => {
          const osc = ac.createOscillator(), gain = ac.createGain()
          osc.type = 'sine'; osc.frequency.value = f; gain.gain.value = 0.18
          osc.connect(gain); gain.connect(ac.destination)
          osc.start(ac.currentTime + s); osc.stop(ac.currentTime + s + d)
        }
        beep(880, 0, 0.18); beep(1320, 0.28, 0.22)
        setTimeout(() => { try { ac.close() } catch {} }, 900)
        return true
      } catch { return false }
    })
    log(ctx, ok ? '🔔 beep played' : 'beep unavailable', ok ? 'info' : 'warn')
  } catch (e) { log(ctx, `beep error: ${e.message}`, 'warn') }
  try { process.stdout.write('\x07') } catch {}
}

// ============================================================================
// STEP 6.5 — Details (v16.7)
// ============================================================================

export async function stepFillCandidateDetails(page, ctx) {
  log(ctx, '=== stepFillCandidateDetails v16.7 starting ===')
  await diagnoseMusanedPage(page, ctx, 'details-entry')
  const startUrl = page.url()

  await page.evaluate(() => {
    window.__MUSANED_BLOCK_SAVE__ = true
    if (window.__MUSANED_SAVE_BLOCKER_INSTALLED__) return
    window.__MUSANED_SAVE_BLOCKER_INSTALLED__ = true
    const isSaveButton = (el) => {
      for (let i = 0; i < 6 && el; i++) {
        if (el.tagName === 'BUTTON' || el.getAttribute?.('role') === 'button' ||
            (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button'))) {
          const t = (el.textContent || el.value || '').trim().toLowerCase()
          if (t === 'save' || t === 'حفظ') return true
        }
        el = el.parentElement
      }
      return false
    }
    const block = (e) => {
      if (!window.__MUSANED_BLOCK_SAVE__) return
      if (isSaveButton(e.target)) {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
        return false
      }
    }
    for (const ev of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      document.addEventListener(ev, block, true)
    }
    document.addEventListener('keydown', (e) => {
      if (!window.__MUSANED_BLOCK_SAVE__) return
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const tag = (document.activeElement?.tagName || '').toUpperCase()
        if (tag === 'TEXTAREA') return
        if (document.activeElement?.closest?.(
          '.p-datepicker, .p-calendar, .p-autocomplete, .p-select, .p-dropdown'
        )) return
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      }
    }, true)
  })

  try {
    try {
      await page.waitForFunction(
        () => /add\s+candidate/i.test(document.body?.innerText || '') &&
              !!document.querySelector('input[placeholder="Relative name"]'),
        { timeout: 30000, polling: 300 }
      )
    } catch { log(ctx, '⚠ form not detected — proceeding', 'warn') }
    await sleep(800)

    const profile = ctx.profile || {}
    const maritalStatusRaw = String(profile.marital_status || '').trim()
    const religionRaw      = String(profile.religion || '').trim()
    const mobileRaw        = String(profile.phone_number || '').trim()
    let   agencyEmail      = String(ctx.agencyEmail || ctx.agency_email || '').trim()
    let   employeeName     = String(ctx.employeeName || ctx.employee_name ||
      ctx.activeEmployee?.name || ctx.user?.name || '').trim()

    // PATCH 3 — DB fallback for agencyEmail
    if (!agencyEmail) {
      try {
        const db = await getDb()
        if (db) {
          const row = await db('settings').whereIn('key', ['agency_email', 'agencyEmail', 'email']).first().catch(() => null)
          if (row) agencyEmail = String(row.value ?? row.setting_value ?? '').trim()
        }
      } catch {}
      if (!agencyEmail) log(ctx, '⚠ agencyEmail missing — pass ctx.agencyEmail or store settings.agency_email', 'warn')
    }

    // PATCH 4 — DB fallback for employeeName: the machine's active operator
    // (device-login bound employee). "Relative name" is filled with this.
    if (!employeeName) {
      try {
        const db = await getDb()
        if (db) {
          const { getActiveEmployee } = await import('./activeEmployee.js')
          const active = await getActiveEmployee(db)
          if (active?.name) employeeName = active.name
        }
      } catch {}
      if (!employeeName) log(ctx, '⚠ employeeName missing — pass ctx.employeeName (active employee) when triggering the workflow', 'warn')
    }

    const relativePhoneRaw = String(profile.emergency_phone || profile.phone_number || '').trim()
    const mobileNumber  = cleanPhone(mobileRaw)
    const relativePhone = cleanPhone(relativePhoneRaw)
    const maritalStatus = maritalStatusRaw
      ? (maritalStatusRaw.toUpperCase() === 'MARRIED' ? 'Married' : 'Single') : ''
    const religion = religionRaw
      ? (/muslim|islam/i.test(religionRaw) ? 'Muslim' : 'Non Muslim') : ''

    const jobTitle        = 'House Maid'
    const education       = 'Preparatory School'
    const languages       = 'None'
    // Number Of Children comes from the profile (was hardcoded to '0').
    const rawChildren = profile.children_count ?? profile.childrenCount ?? ctx.children_count
    const childrenCount = (rawChildren !== undefined && rawChildren !== null && String(rawChildren).trim() !== '')
      ? String(rawChildren).trim()
      : '0'
    // Work experience from the profile (default 'No experience').
    const experience      = profile.work_experience === 'Have experience' ? 'Have experience' : 'No experience'
    const experienceCountry = experience === 'Have experience' ? String(profile.experience_country || '').trim() : ''
    const experienceYears   = experience === 'Have experience' && Number(profile.experience_years) > 0
      ? String(Number(profile.experience_years)) : ''
    const city            = 'Addis Ababa'
    const address         = 'Kolfe Keraniyo'
    const relativeAddress = 'Addis Ababa'
    const DEFAULT_SKILLS = [
      'Babysitting', 'Hard worker', 'Nanny',
      'Washing & ironing clothes', 'Dusting & cleaning', 'Washing kitchen dishes',
    ]
    const skills = Array.isArray(ctx.defaultSkills) && ctx.defaultSkills.length ? ctx.defaultSkills : DEFAULT_SKILLS
    const passportIssuePlace = String(profile.place_of_birth || '').trim()
    const passportIssueDate  = formatMusanedDate(profile.passport_issue_date)
    const passportExpiryDate = formatMusanedDate(profile.passport_expiry_date)

    log(ctx, `resolved: marital="${maritalStatus}" religion="${religion}" mobile="${mobileNumber}" ` +
      `issueDate="${passportIssueDate}" expiryDate="${passportExpiryDate}"`)

    // ─── Personal photo first ────────────────────────────────────────
    const photo = await uploadPersonalPhoto(page, ctx)
    if (!photo?.ok) {
      // Never report the form ready without the photo.
      throw new Error(`Personal photo was not uploaded to Musaned (${photo?.reason || 'unknown'})`)
    }
    await sleep(500)

    // ─── Radios ──────────────────────────────────────────────────────
    await clickRadioByLabel(page, 'Marital Status', maritalStatus, ctx)
    await clickRadioByLabel(page, 'Religion', religion, ctx)

    // ─── Dropdowns ───────────────────────────────────────────────────
    await typeAndCommitDropdown(page, 'Job', jobTitle, ctx)
    await sleep(400)
    await typeAndCommitDropdown(page, 'Education level', education, ctx)
    await sleep(400)
    await typeAndCommitDropdown(page, 'Languages', languages, ctx)
    await sleep(400)
    await typeAndCommitDropdown(page, 'Experience', experience, ctx)
    await sleep(400)
    let experienceFields = { country: null, years: null }
    if (experience === 'Have experience') {
      experienceFields = await fillExperienceDetails(page, { country: experienceCountry, years: experienceYears }, ctx)
    }

    // ─── Skills ──────────────────────────────────────────────────────
    await fillSkillsByTyping(page, skills, ctx)
    await sleep(500)

    // ─── Text fields ─────────────────────────────────────────────────
    await setFieldByLabel(page, 'Mobile Number', mobileNumber, ctx)
    await setFieldByLabel(page, 'E-Mail', agencyEmail, ctx)
    await setFieldByLabel(page, 'Number Of Children', childrenCount, ctx)
    await enterInField(page, 'Number Of Children', ctx)

    // ─── Passport ────────────────────────────────────────────────────
    if (passportIssuePlace) await setFieldByLabel(page, 'Passport Issue Place', passportIssuePlace, ctx)
    if (passportIssueDate) {
      await fillDateByLabel(page, 'Passport Issue Date', passportIssueDate, ctx)
    }
    if (passportExpiryDate) await fillDateByLabel(page, 'Passport Expiry Date', passportExpiryDate, ctx)

    // ─── Address + Relative ──────────────────────────────────────────
    await setFieldByLabel(page, 'City', city, ctx)
    await setFieldByLabel(page, 'Address', address, ctx)
    await setFieldByLabel(page, 'Relative name', employeeName, ctx)
    await setFieldByLabel(page, 'Relative kinship', 'cousin', ctx)
    await setFieldByLabel(page, 'Relative phone', relativePhone, ctx)
    await setFieldByLabel(page, 'Relative address', relativeAddress, ctx)

    await clickAcknowledge(page, ctx)

    // ─── FINAL CHECK: re-read the form, refill whatever is still empty ──
    const want = {
      radios: { 'Marital Status': maritalStatus, 'Religion': religion },
      dropdowns: {
        'Job': jobTitle, 'Education level': education, 'Languages': languages, 'Experience': experience,
        ...(experienceFields.country ? { [experienceFields.country]: experienceCountry } : {}),
      },
      texts: {
        'Mobile Number': mobileNumber, 'E-Mail': agencyEmail, 'Number Of Children': childrenCount,
        'Passport Issue Place': passportIssuePlace,
        'City': city, 'Address': address,
        'Relative name': employeeName, 'Relative kinship': 'cousin',
        'Relative phone': relativePhone, 'Relative address': relativeAddress,
        ...(experienceFields.years ? { [experienceFields.years]: experienceYears } : {}),
      },
      dates: { 'Passport Issue Date': passportIssueDate },
      skills,
    }
    const stillEmpty = await verifyAndRefill(page, want, ctx)

    // ─── FINAL DUMP ──────────────────────────────────────────────────
    const dump = await page.evaluate(() => {
      const out = []
      const RADIO_GROUPS = ['marital status', 'religion']
      const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
      const wanted = [
        'Marital Status', 'Religion', 'Job', 'Education level', 'Languages',
        'Experience', 'ID Number', 'Mobile Number', 'E-Mail', 'Number Of Children',
        'Passport Issue Place', 'Passport Issue Date', 'Passport Expiry Date',
        'City', 'Address',
        'Relative name', 'Relative kinship', 'Relative phone', 'Relative address',
      ]
      for (const w of wanted) {
        const label = Array.from(document.querySelectorAll('label'))
          .find(l => norm(l.textContent).replace(/\s*\*\s*$/, '').trim() === norm(w))
        if (!label) { out.push(`${w} = <label not found>`); continue }

        if (RADIO_GROUPS.includes(norm(w))) {
          let container = label.parentElement
          for (let i = 0; i < 6 && container; i++) {
            const checked = container.querySelector('input[type="radio"]:checked')
            if (checked) {
              const lbl = checked.id ? document.querySelector(`label[for="${checked.id}"]`) : null
              out.push(`${w} = [radio] "${(lbl?.textContent || checked.value || '').trim()}"`)
              break
            }
            container = container.parentElement
          }
          if (container) continue
          out.push(`${w} = <radio not found>`); continue
        }

        const forId = label.getAttribute('for')
        const el = forId ? document.getElementById(forId) : null
        if (el && el.tagName === 'INPUT') { out.push(`${w} = "${el.value}"`); continue }
        if (el) {
          const inner = el.querySelector('.p-autocomplete-input, .p-datepicker-input, input')
          if (inner) { out.push(`${w} = "${inner.value}"`); continue }
        }
        if (forId) {
          const byCtl = document.querySelector(`[formcontrolname="${forId}"]`)
          if (byCtl) {
            const inner = byCtl.tagName === 'INPUT' ? byCtl : byCtl.querySelector('input')
            if (inner) { out.push(`${w} = "${inner.value}"`); continue }
          }
        }
        const sib = label.nextElementSibling
        if (sib) {
          const inner = sib.querySelector?.('input') || (sib.tagName === 'INPUT' ? sib : null)
          if (inner) { out.push(`${w} = "${inner.value}"`); continue }
        }
        const needle = w.replace(/\s+/g, '').toLowerCase()
        const byPh = Array.from(document.querySelectorAll('input')).find(i =>
          (i.placeholder || '').replace(/\s+/g, '').toLowerCase().includes(needle))
        if (byPh) { out.push(`${w} = "${byPh.value}" (via placeholder)`); continue }
        out.push(`${w} = <unknown>`)
      }
      return out
    }).catch(() => [])
    log(ctx, '── FINAL FORM STATE ──\n' + dump.map(l => '  ' + l).join('\n'))

    const endUrl = page.url()
    if (endUrl !== startUrl) log(ctx, `⚠ URL CHANGED`, 'error')
    else log(ctx, '✓ URL unchanged — no accidental submission')

    await diagnoseMusanedPage(page, ctx, 'details-final')
    await playReadyBeep(page, ctx)
    await ctx.notify(
      `🔔 ${ctx.profileName}: Candidate form ready for manual SAVE`,
      stillEmpty.length
        ? `Please fill by hand before SAVE: ${stillEmpty.join(', ')}. Everything else is filled and acknowledged.`
        : `All fields filled and checked, acknowledge ticked. Review and click SAVE.`
    )
    log(ctx, '✅ done — WAITING for manual SAVE.')
    return { ok: true, note: 'awaiting manual SAVE' }
  } finally {
    await page.evaluate(() => { window.__MUSANED_BLOCK_SAVE__ = false }).catch(() => {})
    log(ctx, '✓ SAVE blocker disabled')
  }
}

export async function stepSubmitCandidateForm(page, ctx) { return { ok: true } }

// ============================================================================
// RUNNER
// ============================================================================

export async function runMusanedWorkflow(page, ctx) {
  const t0 = Date.now()
  const stage = ctx.musanedStage || 'start'
  log(ctx, `starting musaned workflow (stage=${stage})`)

  // Preflight: Musaned is not opened for a profile missing these items.
  const photoResolved = await resolvePersonalPhotoPath(ctx).catch(() => ({ path: null }))
  const missing = musanedMissing(ctx.profile || {}, photoResolved.path ? true : (photoResolved.passportCropOnly ? 'passport-crop' : false))
  if (missing.length) {
    const msg = 'Musaned not started. Profile is missing: ' + missing.join(', ')
    log(ctx, msg, 'error')
    await ctx.notify(`❌ ${ctx.profileName}: Musaned not started`, msg)
    return { ok: false, step: 'preflight', error: msg, seconds: Math.round((Date.now() - t0) / 1000) }
  }
  applyGlobalTimeouts(page, ctx)
  await disableSmoothScroll(page, ctx)

  // `page` is the tab this run owns (worker.js opened it). Every step below
  // works in it and nowhere else, so a second run never lands in this tab.

  try {
    if (stage === 'awaiting-musaned-captcha' || stage === 'awaiting-musaned-otp') {
      const review = await classifyScreen(page, ctx)
      if (review.screen === 'agency-picker') {
        await stepClickAgencyCard(page, ctx)
        const after = await waitForDashboard(page, ctx, 30000)
        if (after !== 'dashboard') return { ok: true, pauseReason: `awaiting-musaned-${after}`, seconds: Math.round((Date.now() - t0) / 1000) }
      } else if (review.screen === 'dashboard') { log(ctx, '✓ already on dashboard') }
      else if (review.screen === 'landing') { await stepClickGoToDashboard(page, ctx); await waitForDashboard(page, ctx, 30000) }
      else if (review.screen === 'captcha') return { ok: true, pauseReason: 'awaiting-musaned-captcha', seconds: Math.round((Date.now() - t0) / 1000) }
      else if (review.screen === 'otp') {
        await ctx.notify(`🖐 ${ctx.profileName}: Musaned needs OTP`, 'Enter the code from your phone.')
        return { ok: true, pauseReason: 'awaiting-musaned-otp', seconds: Math.round((Date.now() - t0) / 1000) }
      } else if (review.screen === 'login-error') { await dumpPageState(page, ctx, 'login-rejected'); throw new Error('Musaned rejected the credentials') }
    } else {
      const open = await stepOpenMusaned(page, ctx)
      if (open.onKeycloak) {
        await sleep(1000)
        const fill = await stepFillMusanedLogin(page, ctx)
        if (fill.filled) await sleep(1500)
      }
      await sleep(2000)
      const review = await classifyScreen(page, ctx)
      if (review.screen === 'agency-picker') {
        await stepClickAgencyCard(page, ctx)
        const after = await waitForDashboard(page, ctx, 30000)
        if (after !== 'dashboard') return { ok: true, pauseReason: `awaiting-musaned-${after}`, seconds: Math.round((Date.now() - t0) / 1000) }
      } else if (review.screen === 'dashboard') { log(ctx, '✓ already on dashboard') }
      else if (review.screen === 'landing') { await stepClickGoToDashboard(page, ctx); await waitForDashboard(page, ctx, 30000) }
      else if (review.screen === 'captcha') {
        await ctx.notify(`🖐 ${ctx.profileName}: Musaned needs reCAPTCHA`, 'Solve it then click Sign In.')
        return { ok: true, pauseReason: 'awaiting-musaned-captcha', seconds: Math.round((Date.now() - t0) / 1000) }
      } else if (review.screen === 'otp') {
        await ctx.notify(`🖐 ${ctx.profileName}: Musaned needs OTP`, 'Enter the code from your phone.')
        return { ok: true, pauseReason: 'awaiting-musaned-otp', seconds: Math.round((Date.now() - t0) / 1000) }
      } else if (review.screen === 'login-error') { await dumpPageState(page, ctx, 'login-rejected'); throw new Error('Musaned rejected the credentials') }
      else {
        await ctx.notify(`🖐 ${ctx.profileName}: Musaned needs attention`, `Screen unclassified (${review.source}).`)
        return { ok: true, pauseReason: 'awaiting-musaned-login', seconds: Math.round((Date.now() - t0) / 1000) }
      }
    }

    await stepClickHrPool(page, ctx)
    await stepClickAddNewCandidate(page, ctx)

    const pre = await stepFillCandidatePreCheck(page, ctx)
    if (!pre || !pre.ok) {
      log(ctx, `pre-check failed (${pre?.error || 'unknown'}) — running diagnostics before details`, 'warn')
      await diagnoseMusanedPage(page, ctx, 'post-pre-check-failure')
    }

    await diagnoseMusanedPage(page, ctx, 'before-details')
    await stepFillCandidateDetails(page, ctx)
    await diagnoseMusanedPage(page, ctx, 'after-details')

    const verify = await reviewStageComplete({
      stage: 'login+hr-pool+add-candidate',
      expected: { on_candidates_page: true, modal_open: true },
      observed: { on_candidates_page: true, modal_open: true, url: page.url() },
    })
    log(ctx, `stage verification -> complete=${verify.complete} (${verify.source})`)

    const secs = Math.round((Date.now() - t0) / 1000)
    await ctx.notify(
      `✅ ${ctx.profileName}: Musaned candidate form is ready`,
      `All fields filled, acknowledge checked. Click SAVE in the tab to submit.`
    )
    return { ok: true, pauseReason: 'awaiting-human-save', seconds: secs }
  } catch (e) {
    const secs = Math.round((Date.now() - t0) / 1000)
    log(ctx, `musaned failed after ${secs}s: ${e.message}`, 'error')
    await diagnoseMusanedPage(page, ctx, 'workflow-error')
    await dumpPageState(page, ctx, 'musaned')
    return { ok: false, step: 'musaned', error: e.message, seconds: secs }
  }
}

async function waitForDashboard(page, ctx, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = 'unknown'
  while (Date.now() < deadline) {
    const review = await classifyScreen(page, ctx)
    if (review.screen !== last) { log(ctx, `waiting — screen: ${review.screen}`); last = review.screen }
    if (['dashboard', 'captcha', 'otp', 'login-error', 'login-form'].includes(review.screen)) return review.screen
    await sleep(600)
  }
  return last
}
// For tests (mock Musaned pages): the field fillers.
export { typeAndCommitDropdown, fillDateByLabel, readFieldValues, chosenChips }
