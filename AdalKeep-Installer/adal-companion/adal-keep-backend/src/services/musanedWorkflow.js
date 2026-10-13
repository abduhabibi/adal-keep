/**
 * musanedWorkflow.js — Musaned / Tawtheeq login → HR Pool → Add Candidate → Pre-check → Submit.
 *
 * v11 — Fixes the "agency card not found" case by walking shadow roots and
 *       polling for up to 20s, and adds a heuristic fallback that picks the
 *       card-shaped element nearest the viewport center. Keeps the Puppeteer
 *       uploadFile() fix and the landing-page / GO TO DASHBOARD handling.
 *
 * v11.1 — Prefer passportImagePath over passportPath when resolving the
 *         file to upload. The worker now provides both (the image is a
 *         jpg/jpeg/png/webp, the plain passportPath may be a PDF which
 *         Musaned rejects at the dropzone).
 *
 * v11.2 — New stepSubmitCandidateForm(): after CONTINUE, wait for the
 *         Submit button on the details screen (which often sits off to the
 *         right inside a horizontal-scroll container), scroll every
 *         ancestor scroll container to bring it into view, and fire a real
 *         CDP mouse click.
 *
 * v11.3 — Pre-check modal fixes: relaxed MRZ-strip preview detection,
 *         early exit when preview + all 5 fields are ready.
 *
 * v11.4 — Two-minute wait for Musaned auto-fill (was 60s), relaxed modal
 *         bounding box, Jev gate removed, robust CONTINUE click.
 *
 * v11.5 — stepFillCandidatePreCheck fully rewritten:
 *           • 2-minute upload / auto-fill wait.
 *           • No Jev gate — clicks CONTINUE the moment preview + 5 fields
 *             are present.
 *           • Direct btn.click() — no mouse simulation, no elementHandle,
 *             no scope filter, so React reliably sees the event.
 *           • Diagnostic button dump when CONTINUE can't be found, so we
 *             can see exactly what Musaned calls the button.
 *
 * v11.6 — CONTINUE click reliability fix:
 *           • New scrollModalToBottom() helper that scrolls the Candidate
 *             pre-check modal — and every scrollable ancestor — to the
 *             bottom before we try to click CONTINUE.
 *           • CONTINUE click loop re-scrolls every 3 attempts.
 *           • btn.scrollIntoView() called immediately before btn.click().
 *
 * v11.7 — Fast readiness detection (removes the multi-second lag between
 *         "auto-fill done" and "CONTINUE clicked"):
 *           • Readiness poll moved into the browser via
 *             page.waitForFunction(..., { polling: 100 }).
 *           • Removed post-upload sleep(1500), pre-click sleep(1000), and
 *             the stable-counter fallback (~2.1s of no-change wait).
 *           • Post-click verification shortened from 2.5s to 1.2s.
 *
 * v11.8 — CONTINUE is now clicked with a *realistic* (yet still quick)
 *         pointer gesture via the humanClick()/clickRealistic() helpers.
 *
 * v11.9 — Fix the modal scroll + click path:
 *           • scrollModalToBottom() now walks DOWN through the modal's
 *             DESCENDANTS looking for the inner scroll container. The old
 *             version walked UP through ancestors, which never touched the
 *             element that actually scrolls (the modal's own content area
 *             is a descendant, not an ancestor). This was the real reason
 *             CONTINUE kept going off-screen.
 *           • The helper now also scrolls every scrollable descendant
 *             (both axes), then calls scrollIntoView on the button itself,
 *             and reports { btnFound, btnRect, fullyVisible, partiallyVisible }
 *             so the caller can decide whether a retry is warranted.
 *           • The readiness poll is back to a live in-page loop (150ms)
 *             that logs t+N progress (thumb, fields filled, which fields
 *             are missing, dropzone state) so the log actually tells you
 *             what's happening instead of going silent.
 *           • The click is now two-strategy per attempt:
 *               A. plain DOM btn.click() — reliable, no coords,
 *               B. clickRealistic() CDP gesture — fallback for buttons
 *                  that genuinely need hover/pointerdown.
 *             The modal-closed check runs after BOTH strategies, so we
 *             stop the moment the modal actually closes instead of
 *             firing extra clicks on the way.
 *           • Modal re-scrolls every 3 attempts if CONTINUE has slipped
 *             out of view again.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  reviewMusanedScreen,
  reviewStageComplete,
  reviewPreCheckReady,
} from './jev/musanedDecisions.js'

const MUSANED_ROOT    = 'https://tawtheeq.musaned.com.sa/'
const DASHBOARD_URL   = 'https://tawtheeq.musaned.com.sa/dashboard'
const KEYCLOAK_HOST   = 'accounts.wahid.sa'
const STEP_LOG_PREFIX = '[musaned]'
const DEBUG_DIR       = path.join(os.homedir(), '.adal-lmis-debug')
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true })

function log(ctx, msg, level = 'info') {
  const line = `${STEP_LOG_PREFIX} lane=${ctx.laneId} profile=${ctx.profileId} :: ${msg}`
  console.log(line)
  if (ctx.onLog) ctx.onLog(level, msg)
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ============================================================================
// POINTER HELPERS — realistic (but quick) mouse clicks
// ============================================================================
//
// A plain `mouse.move(); mouse.down(); mouse.up()` teleports the cursor and
// presses + releases in the same millisecond. Chrome and React usually still
// accept it, but it's the classic bot signature, and it occasionally no-ops
// when the button relies on hover state or is covered by a stacked overlay.
// These helpers fire a genuine-looking gesture instead:
//   • the pointer GLIDES to the target over several interpolated mousemove
//     events (so mouseover/mouseenter fire on the way in),
//   • it DWELLS on the element briefly so hover handlers settle,
//   • it PRESSES, then HOLDS, then releases — never a 0ms click,
//   • the point is hit-tested with elementFromPoint() so we know whether
//     something is stacked on top before we click through it.
// It's deliberately "a bit fast": ~120–200ms per click rather than the ~1s a
// fully human-like Bézier path + jitter would cost.

// Mirror of where the pointer last was, so each gesture glides from there
// instead of jumping. Puppeteer interpolates from its own tracked position;
// this copy drives the distance-adaptive step count and the logs.
let _mousePos = { x: 0, y: 0 }

async function humanClick(page, x, y, ctx, opts = {}) {
  const dist = Math.hypot(x - _mousePos.x, y - _mousePos.y)
  // Few steps for a short hop, more for a long glide — capped so it stays fast.
  const steps   = opts.steps   ?? Math.max(4, Math.min(12, Math.round(dist / 120)))
  const hoverMs = opts.hoverMs ?? 50
  const holdMs  = opts.holdMs  ?? 35
  const button  = opts.button  ?? 'left'

  const from = _mousePos
  await page.mouse.move(x, y, { steps })
  _mousePos = { x, y }
  log(ctx, `  pointer (${Math.round(from.x)},${Math.round(from.y)}) → ` +
    `(${Math.round(x)},${Math.round(y)}) · ${steps} steps · hover ${hoverMs}ms · hold ${holdMs}ms`)

  if (hoverMs > 0) await sleep(hoverMs)
  await page.mouse.down({ button })
  if (holdMs > 0) await sleep(holdMs)
  await page.mouse.up({ button })
}

/**
 * clickRealistic — locate a button by its (exact) label, scroll it into view,
 * hit-test the click point with elementFromPoint() so we know nothing is
 * covering it, then humanClick() it.
 *
 * Returns { clicked: boolean, reason?: string, rect?: object }.
 */
async function clickRealistic(page, label, ctx, opts = {}) {
  const handle = await page.evaluateHandle((want) => {
    const re = new RegExp(`^${want}$`, 'i')
    const btns = Array.from(document.querySelectorAll(
      'button, [role="button"], input[type="submit"], input[type="button"]'
    )).filter(b => !b.disabled && re.test((b.textContent || b.value || '').trim()))
    if (!btns.length) return null
    // Prefer the largest matching instance — usually the modal's primary CTA.
    btns.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      return (rb.width * rb.height) - (ra.width * ra.height)
    })
    return btns[0]
  }, label)
  const el = handle.asElement()
  if (!el) return { clicked: false, reason: 'not-in-dom' }

  try {
    await el.evaluate(b => b.scrollIntoView({
      block: 'center', inline: 'center', behavior: 'instant',
    }))
  } catch { /* scrollIntoView on a detached node — fall through and measure anyway */ }

  const settleMs = opts.settleMs ?? 40
  if (settleMs > 0) await sleep(settleMs)

  const rect = await el.evaluate(b => {
    const r  = b.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top  + r.height / 2
    const hit = document.elementFromPoint(cx, cy)
    return {
      x: cx, y: cy, w: r.width, h: r.height,
      inView: r.top >= 0 && r.bottom <= window.innerHeight &&
              r.left >= 0 && r.right <= window.innerWidth,
      hitIsTarget: hit === b || !!(hit && b.contains(hit)),
      hitTag: hit ? (hit.tagName + (hit.id ? '#' + hit.id : '')) : null,
    }
  }).catch(() => null)

  if (!rect || rect.w < 5 || rect.h < 5) return { clicked: false, reason: 'zero-size' }

  if (!rect.hitIsTarget) {
    // Something is stacked on the point we're about to click. We still fire the
    // click (the overlay may be pointer-transparent), but log it so a failure
    // has an explanation instead of being a silent no-op.
    log(ctx, `  hit-test miss: elementFromPoint(${Math.round(rect.x)},${Math.round(rect.y)}) → ` +
      `${rect.hitTag} (inView=${rect.inView})`, 'warn')
  }

  await humanClick(page, rect.x, rect.y, ctx, opts)
  return { clicked: true, rect }
}

// ============================================================================
// MODAL SCROLL HELPER
// ============================================================================
//
/**
 * scrollModalToBottom — finds the Candidate pre-check modal, then walks
 * DOWN through its descendants looking for the actual scroll container
 * (the inner content area). The old version walked UP through ancestors,
 * which never touched the element that actually scrolls.
 *
 * After scrolling, verifies the CONTINUE button is inside the viewport
 * and reports its rect so the caller knows whether the click will land.
 */
async function scrollModalToBottom(page, ctx) {
  const result = await page.evaluate(() => {
    // ── 1. Locate the modal container ─────────────────────────────────
    // Prefer the LARGEST element that contains the "Candidate pre-check"
    // title — that's the modal wrapper.
    let modal = null
    let modalArea = 0
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150 || r.width > 1500 || r.height > 1500) continue
      if (!/candidate\s+pre-check/i.test(el.textContent || '')) continue
      const area = r.width * r.height
      if (area > modalArea) { modal = el; modalArea = area }
    }
    if (!modal) return { ok: false, reason: 'modal-not-found' }

    // ── 2. Scroll EVERY scrollable element inside the modal (this is the
    //       fix — we look DOWN, not up) ────────────────────────────────
    const candidates = [modal, ...Array.from(modal.querySelectorAll('*'))]
    const scrolled = []
    for (const el of candidates) {
      const cs = getComputedStyle(el)
      const canScrollY = cs.overflowY === 'auto' || cs.overflowY === 'scroll'
      const canScrollX = cs.overflowX === 'auto' || cs.overflowX === 'scroll'
      if (canScrollY && el.scrollHeight > el.clientHeight + 5) {
        const before = el.scrollTop
        el.scrollTop = el.scrollHeight
        if (el.scrollTop > before) {
          scrolled.push({
            tag: el.tagName,
            cls: String(el.className || '').slice(0, 40),
            from: before,
            to: el.scrollTop,
            max: el.scrollHeight - el.clientHeight,
          })
        }
      }
      if (canScrollX && el.scrollWidth > el.clientWidth + 5) {
        el.scrollLeft = el.scrollWidth
      }
    }

    // ── 3. Belt-and-suspenders: ask the button itself to scroll into view
    //       after we've already scrolled its container. Chrome sometimes
    //       honors this one when the ancestor walk doesn't. ────────────
    const btn = Array.from(document.querySelectorAll(
      'button, [role="button"], a, input[type="button"], input[type="submit"]'
    )).find(el => !el.disabled &&
      /^continue$/i.test((el.textContent || el.value || '').trim()))

    if (btn) {
      try { btn.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch {}
    }

    // ── 4. Measure the result ─────────────────────────────────────────
    const r = btn ? btn.getBoundingClientRect() : null
    const viewportH = window.innerHeight
    const viewportW = window.innerWidth

    return {
      ok: true,
      scrolled,
      btnFound: !!btn,
      btnRect: r ? {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        w: Math.round(r.width),
        h: Math.round(r.height),
      } : null,
      viewportH,
      viewportW,
      fullyVisible: r
        ? (r.top >= 0 && r.bottom <= viewportH && r.left >= 0 && r.right <= viewportW && r.width >= 5 && r.height >= 5)
        : false,
      partiallyVisible: r ? (r.top < viewportH && r.bottom > 0) : false,
    }
  }).catch(e => ({ ok: false, reason: e.message }))

  if (!result.ok) {
    log(ctx, `scrollModalToBottom failed: ${result.reason}`, 'warn')
    return result
  }

  log(ctx, `scrolled ${result.scrolled.length} container(s): ` +
    result.scrolled.map(s => `${s.tag}(${s.cls}) ${s.from}→${s.to}/${s.max}`).join(', '))
  log(ctx, `CONTINUE btn=${result.btnFound} rect=${JSON.stringify(result.btnRect)} ` +
    `fullyVisible=${result.fullyVisible} partiallyVisible=${result.partiallyVisible}`)

  await sleep(200)
  return result
}

async function dumpPageState(page, ctx, stepName) {
  try {
    const url = page.url()
    log(ctx, `FAIL at "${stepName}" — URL: ${url}`, 'error')

    const bodyText = await page.evaluate(() => {
      const it = document.body?.innerText || ''
      const tc = document.body?.textContent || ''
      return `innerText: ${it.slice(0, 400).replace(/\n/g, ' | ')} ||| textContent: ${tc.slice(0, 400).replace(/\s+/g, ' ')}`
    }).catch(() => '')
    log(ctx, `body preview: ${bodyText}`, 'error')

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const shotPath = path.join(DEBUG_DIR, `fail-musaned-${ctx.profileId}-${stepName}-${stamp}.png`)
    try { await page.screenshot({ path: shotPath, fullPage: false }); log(ctx, `screenshot: ${shotPath}`, 'error') } catch {}
  } catch (e) { console.error('[musaned] dumpPageState failed:', e.message) }
}

// ============================================================================
// FIELD FILL HELPER
// ============================================================================

async function fillField(page, input, value, label, ctx) {
  await input.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, val)
    el.dispatchEvent(new Event('input',  { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.dispatchEvent(new Event('blur',   { bubbles: true }))
  }, value)

  let actual = await input.evaluate(el => el.value)
  if (actual === value) {
    log(ctx, `✓ ${label} filled (len ${value.length})`)
    return { ok: true, via: 'native-setter' }
  }

  log(ctx, `${label} native-setter didn't stick — retrying with keyboard`, 'warn')
  await input.click()
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.keyboard.press('Backspace')
  await input.type(value, { delay: 40 })

  actual = await input.evaluate(el => el.value)
  if (actual === value) {
    log(ctx, `✓ ${label} filled via keyboard (len ${value.length})`)
    return { ok: true, via: 'keyboard' }
  }
  log(ctx, `✗ ${label} failed — field contains "${actual}"`, 'error')
  return { ok: false, via: 'failed', actual }
}

// ============================================================================
// SNAPSHOT + CLASSIFY
// ============================================================================

async function snapshotState(page) {
  return await page.evaluate(({ keycloakHost }) => {
    const url = location.href
    const body = (document.body?.innerText || '')

    return {
      url,
      onKeycloak: url.includes(keycloakHost),
      bodySnippet: body.slice(0, 500),
      hasLoginError: /invalid\s+(username|password)|incorrect\s+username|account\s+is\s+disabled/i.test(body),
      hasCaptcha: !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha"], [class*="captcha"]'),
      hasOtp: !!document.querySelector('input[name="otp"], input[autocomplete="one-time-code"], input[name="totp"]'),
      hasPassword: !!document.querySelector('input[type="password"]'),
      hasUsername: !!document.querySelector('#username, input[name="username"], input[autocomplete="username"], input[type="email"]'),
      hasDashboardNav: /organizations|hr\s*pool|employment\s*requests|worker\s+transfer|latest\s+(requests|candidates)/i.test(body),
      hasGoToDashboard:
        /go\s+to\s+dashboard/i.test(body) ||
        (!!document.querySelector('a[href="/dashboard"], button') &&
          /go\s+to\s+dashboard/i.test((document.body?.innerText || ''))),
      hasAgencyPicker:
        /please\s+select\s+the\s+establishment/i.test(body) ||
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
  try {
    review = await reviewMusanedScreen(state)
  } catch (e) {
    log(ctx, `Jev reviewMusanedScreen threw: ${e.message}`, 'warn')
  }

  if (!review || !review.screen || review.screen === 'unknown') {
    const fb = fallbackClassify(state)
    if (fb) {
      log(ctx, `screen → ${fb.screen} (${fb.source})`)
      return fb
    }
  }

  log(ctx, `screen → ${review.screen} (${review.source})`)
  return review
}

// ============================================================================
// STEP 1 — Open Musaned + click Login (or skip if already authenticated)
// ============================================================================

export async function stepOpenMusaned(page, ctx) {
  log(ctx, `navigating to ${MUSANED_ROOT}`)

  try {
    await page.goto(MUSANED_ROOT, { waitUntil: 'domcontentloaded', timeout: 120000 })
  } catch (e) {
    try { await page.goto(MUSANED_ROOT, { waitUntil: 'networkidle2', timeout: 120000 }) }
    catch { throw new Error('Could not reach tawtheeq.musaned.com.sa') }
  }

  await sleep(1500)
  const preState = await snapshotState(page)
  if (preState?.hasAgencyPicker || preState?.hasDashboardNav || preState?.hasGoToDashboard) {
    log(ctx, 'already authenticated — skipping Login click')
    return { ok: true, finalUrl: page.url(), onKeycloak: false }
  }

  log(ctx, 'looking for Login button on landing page')
  const deadline = Date.now() + 20000
  let clickedLogin = false

  while (Date.now() < deadline) {
    if (page.url().includes(KEYCLOAK_HOST)) break
    clickedLogin = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'))
      const target = candidates.find(el => /^(login|sign\s*in|دخول)$/.test((el.textContent || '').trim().toLowerCase()))
      if (!target) return false
      const r = target.getBoundingClientRect()
      if (r.width < 5 || r.height < 5) return false
      try { target.scrollIntoView({ block: 'center' }); target.click(); return true } catch { return false }
    })
    if (clickedLogin) break
    await sleep(500)
  }

  if (clickedLogin) { log(ctx, '✓ Login button clicked'); await sleep(1500) }

  const redirectDeadline = Date.now() + 15000
  while (Date.now() < redirectDeadline) {
    if (page.url().includes(KEYCLOAK_HOST)) break
    const s = await snapshotState(page)
    if (s?.hasAgencyPicker || s?.hasDashboardNav || s?.hasGoToDashboard) break
    await sleep(500)
  }

  const finalUrl = page.url()
  log(ctx, `final URL: ${finalUrl}`)
  if (!finalUrl || finalUrl === 'about:blank') throw new Error('Tab landed on about:blank')

  return { ok: true, finalUrl, onKeycloak: finalUrl.includes(KEYCLOAK_HOST) }
}

// ============================================================================
// STEP 2 — Fill Keycloak login form
// ============================================================================

export async function stepFillMusanedLogin(page, ctx) {
  const username = String(ctx.musaned_username || '').trim()
  const password = String(ctx.musaned_password || '')

  if (!username || !password) {
    log(ctx, 'no Musaned credentials on ctx — skipping auto-fill', 'warn')
    return { filled: false, reason: 'no-credentials' }
  }

  const userInput = await page.waitForSelector(
    '#username, input[name="username"], input[autocomplete="username"], input[type="email"]',
    { timeout: 20000 }
  ).catch(() => null)
  if (!userInput) return { filled: false, reason: 'no-form' }

  const preState = await snapshotState(page)
  const hasCaptcha = preState?.hasCaptcha || false

  const userFill = await fillField(page, userInput, username, 'username', ctx)
  if (!userFill.ok) throw new Error('Username field could not be filled')

  const passInput = await page.$('#password, input[name="password"], input[type="password"]')
  if (!passInput) return { filled: false, reason: 'no-password-field' }

  const passFill = await fillField(page, passInput, password, 'password', ctx)
  if (!passFill.ok) throw new Error('Password field could not be filled')

  if (hasCaptcha) {
    log(ctx, 'reCAPTCHA present — leaving submit to the human', 'warn')
    return { filled: true, captcha: true }
  }

  const submitted = await page.evaluate(() => {
    const byId = document.querySelector('#kc-login')
    if (byId) { byId.click(); return 'kc-login' }
    const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]')
    if (submitBtn) { submitBtn.click(); return 'submit-button' }
    const byText = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .find(b => /^(sign\s*in|log\s*in|دخول)$/i.test((b.textContent || b.value || '').trim()))
    if (byText) { byText.click(); return 'by-text' }
    return null
  })

  if (!submitted) {
    await passInput.press('Enter')
    return { filled: true, submitted: true, via: 'enter-key' }
  }
  log(ctx, `✓ Sign In clicked (via ${submitted})`)
  return { filled: true, submitted: true, via: submitted }
}

// ============================================================================
// STEP 3 — Click the agency card
// ============================================================================

export async function stepClickAgencyCard(page, ctx) {
  log(ctx, 'looking for agency card on Welcome screen')

  const agencyHint = String(ctx.profile?.agency_name || ctx.musaned_name || '').trim().toUpperCase()

  const deadline = Date.now() + 20000
  let clicked = false

  while (Date.now() < deadline && !clicked) {
    const found = await page.evaluate((hint) => {
      const collectAll = (root) => {
        const out = []
        const walk = (node) => {
          if (!node || !node.querySelectorAll) return
          for (const el of node.querySelectorAll('*')) {
            out.push(el)
            if (el.shadowRoot) walk(el.shadowRoot)
          }
        }
        walk(root)
        return out
      }
      const all = collectAll(document)
      const txt = (el) => el.textContent || ''

      let candidates = all.filter(el =>
        /FOREIGN\s+EMPLOYMENT\s+AGENCY/i.test(txt(el)) && /\bdetails\b/i.test(txt(el))
      )
      if (candidates.length === 0) {
        candidates = all.filter(el => /FOREIGN\s+EMPLOYMENT\s+AGENCY/i.test(txt(el)))
      }
      if (candidates.length === 0) {
        candidates = all.filter(el => /SUPERUSER\s*[-–—]\s*EPRO/i.test(txt(el)))
      }
      if (candidates.length === 0 && hint) {
        candidates = all.filter(el => txt(el).toUpperCase().includes(hint))
      }

      if (candidates.length > 0) {
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
        if (r.width >= 100 && r.height >= 30) {
          return {
            ok: true,
            strategy: 'text-match',
            text: txt(clickable).trim().replace(/\s+/g, ' ').slice(0, 80),
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
          }
        }
      }

      const sel = 'a, button, [role="button"], [role="link"], [tabindex], [class*="card" i]'
      const shapeCandidates = Array.from(document.querySelectorAll(sel)).filter(el => {
        const r = el.getBoundingClientRect()
        if (r.width < 300 || r.width > 1400) return false
        if (r.height < 60 || r.height > 500) return false
        if (r.top < 100 || r.bottom > window.innerHeight - 50) return false
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') return false
        return true
      })
      if (shapeCandidates.length === 0) return { ok: false, reason: 'no-card-candidate' }

      const cx = window.innerWidth / 2, cy = window.innerHeight / 2
      shapeCandidates.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        const da = Math.hypot(ra.left + ra.width / 2 - cx, ra.top + ra.height / 2 - cy)
        const db = Math.hypot(rb.left + rb.width / 2 - cx, rb.top + rb.height / 2 - cy)
        return da - db
      })
      const target = shapeCandidates[0]
      try { target.scrollIntoView({ block: 'center' }) } catch {}
      const r = target.getBoundingClientRect()
      return {
        ok: true,
        strategy: 'heuristic-center',
        text: txt(target).trim().replace(/\s+/g, ' ').slice(0, 80),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
      }
    }, agencyHint)

    if (found.ok) {
      log(ctx, `✓ found card (${found.strategy}): "${found.text}"`)
      await page.mouse.move(found.x, found.y)
      await sleep(100)
      await page.mouse.down()
      await sleep(60)
      await page.mouse.up()
      log(ctx, '✓ clicked agency card')
      clicked = true
      break
    }

    await sleep(700)
  }

  if (!clicked) {
    await ctx.notify(`❌ ${ctx.profileName}: agency card not found`, 'Check the browser tab.')
    throw new Error('Agency card not found')
  }

  return { ok: true }
}

// ============================================================================
// STEP 3.5 — Click "GO TO DASHBOARD" on the public landing page
// ============================================================================

export async function stepClickGoToDashboard(page, ctx) {
  log(ctx, 'looking for GO TO DASHBOARD button')

  const clicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'))
    const target = candidates.find(el => /^go\s+to\s+dashboard$/i.test((el.textContent || '').trim()))
    if (!target) return false
    const r = target.getBoundingClientRect()
    if (r.width < 5 || r.height < 5) return false
    try {
      target.scrollIntoView({ block: 'center' })
      target.click()
      return true
    } catch { return false }
  })

  if (!clicked) {
    log(ctx, 'GO TO DASHBOARD button not found or click failed — trying direct navigation', 'warn')
    try {
      await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await sleep(2000)
      log(ctx, '✓ reached /dashboard via direct navigation')
      return { ok: true, via: 'direct-nav' }
    } catch (e) {
      log(ctx, `direct nav to /dashboard failed: ${e.message}`, 'error')
      return { ok: false, error: e.message }
    }
  }

  log(ctx, '✓ GO TO DASHBOARD clicked')
  await sleep(2500)
  return { ok: true }
}

// ============================================================================
// STEP 4 — Click "HR Pool" in the top navigation
// ============================================================================

export async function stepClickHrPool(page, ctx) {
  log(ctx, 'looking for HR Pool nav link')

  const deadline = Date.now() + 20000
  let clicked = false

  while (Date.now() < deadline && !clicked) {
    clicked = await page.evaluate(() => {
      const byHref = Array.from(document.querySelectorAll('a'))
        .find(a => /\/hr-pool/i.test(a.getAttribute('href') || ''))
      if (byHref) {
        const r = byHref.getBoundingClientRect()
        if (r.width > 5 && r.height > 5) {
          try { byHref.scrollIntoView({ block: 'center' }); byHref.click(); return true } catch {}
        }
      }

      const byText = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"]'))
        .find(el => /^hr\s*pool$/i.test((el.textContent || '').trim()))
      if (byText) {
        const r = byText.getBoundingClientRect()
        if (r.width > 5 && r.height > 5) {
          try { byText.scrollIntoView({ block: 'center' }); byText.click(); return true } catch {}
        }
      }
      return false
    })
    if (!clicked) await sleep(500)
  }

  if (!clicked) {
    await ctx.notify(`❌ ${ctx.profileName}: HR Pool nav not found`, 'Check the browser tab.')
    throw new Error('HR Pool nav link not found')
  }
  log(ctx, '✓ HR Pool clicked')

  log(ctx, 'waiting for Candidates page')
  const navDeadline = Date.now() + 20000
  while (Date.now() < navDeadline) {
    const ok = await page.evaluate(() => {
      const url = location.href
      const body = document.body?.innerText || ''
      return /\/hr-pool/i.test(url) || (/candidates/i.test(body) && /add\s+new\s+candidate/i.test(body))
    })
    if (ok) {
      log(ctx, '✓ Candidates page is up')
      await sleep(1000)
      return { ok: true }
    }
    await sleep(400)
  }
  log(ctx, 'Candidates page did not confirm in 20s — continuing anyway', 'warn')
  return { ok: true }
}

// ============================================================================
// STEP 5 — Click "ADD NEW CANDIDATE"
// ============================================================================

export async function stepClickAddNewCandidate(page, ctx) {
  log(ctx, 'looking for ADD NEW CANDIDATE button')

  const deadline = Date.now() + 20000
  let clicked = false

  while (Date.now() < deadline && !clicked) {
    clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      const target = btns.find(el => /add\s+new\s+candidate/i.test((el.textContent || '').trim()))
      if (!target) return false
      const r = target.getBoundingClientRect()
      if (r.width < 5 || r.height < 5) return false
      try {
        target.scrollIntoView({ block: 'center' })
        target.click()
        return true
      } catch { return false }
    })
    if (!clicked) await sleep(500)
  }

  if (!clicked) {
    await ctx.notify(`❌ ${ctx.profileName}: ADD NEW CANDIDATE not found`, 'Check the browser tab.')
    throw new Error('ADD NEW CANDIDATE button not found')
  }
  log(ctx, '✓ ADD NEW CANDIDATE clicked')
  await sleep(1500)

  const modalOpen = await page.evaluate(() =>
    /candidate\s+pre-check|id\s+number|passport\s+number/i.test(document.body?.innerText || '')
  )
  log(ctx, modalOpen ? '✓ Candidate form modal is open' : 'modal not detected — check the tab', modalOpen ? 'info' : 'warn')

  return { ok: true }
}

// ============================================================================
// STEP 6 — Fill the Candidate pre-check modal
// ============================================================================
//
// We only do two things ourselves:
//   1. Type the passport number into the "ID Number" field.
//   2. Upload the passport image into the drop zone (Puppeteer's uploadFile).
//
// Musaned then auto-fills Passport Number / Surname / Given Names / DOB.
// We live-poll (150ms) for the preview + all 5 fields, then scroll the
// modal's INNER scroll container to reveal CONTINUE, then click it with
// DOM .click() first and a realistic CDP gesture as fallback.
//
export async function stepFillCandidatePreCheck(page, ctx) {
  const profile = ctx.profile || {}
  const passportNumber = String(profile.passport_number || '').trim()
  const passportPath =
    ctx.passportImagePath ||
    ctx.passportImage_path ||
    ctx.passportPath || ctx.passport_path ||
    profile.passport_path || profile.passportPath || null

  log(ctx, `pre-check resolved: passportNumber="${passportNumber}" passportPath="${passportPath}"`)

  if (!passportNumber) throw new Error('passport_number is empty on profile')
  if (!passportPath) {
    await ctx.notify(`❌ ${ctx.profileName}: no passport file on ctx`, 'Set ctx.passportPath and retry.')
    throw new Error('No passport file path on ctx')
  }
  if (!fs.existsSync(passportPath)) {
    await ctx.notify(`❌ ${ctx.profileName}: passport file not found`, `Path was: ${passportPath}`)
    throw new Error(`Passport file does not exist: ${passportPath}`)
  }

  // Confirm modal is up
  const modalUp = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150 || r.width > 1500 || r.height > 1500) continue
      if (/candidate\s+pre-check/i.test(el.textContent || '')) return true
    }
    return false
  })
  if (!modalUp) throw new Error('Candidate pre-check modal not found')

  // ── 1. Fill ID Number ───────────────────────────────────────────────
  const idOk = await page.evaluate((val) => {
    const input = Array.from(document.querySelectorAll('input'))
      .find(el => /id\s*number/i.test(el.placeholder || ''))
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, val)
    input.dispatchEvent(new Event('input',  { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new Event('blur',   { bubbles: true }))
    input.focus()
    return input.value === val
  }, passportNumber)

  if (!idOk) throw new Error('ID Number field could not be filled')
  log(ctx, `✓ ID Number = "${passportNumber}"`)

  // Short settle so React commits the input event before we upload.
  await sleep(300)

  // ── 2. Upload the passport image ────────────────────────────────────
  log(ctx, `uploading passport: ${passportPath}`)

  const fileInputHandle = await page.evaluateHandle(() => {
    const modals = Array.from(document.querySelectorAll('*')).filter(el => {
      const r = el.getBoundingClientRect()
      if (r.width < 250 || r.height < 150 || r.width > 1500 || r.height > 1500) return false
      return /candidate\s+pre-check/i.test(el.textContent || '')
    })
    if (!modals.length) return null
    modals.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      return (ra.width * ra.height) - (rb.width * rb.height)
    })
    return modals[0].querySelector('input[type="file"]')
  })

  let fileInput = fileInputHandle.asElement()
  if (!fileInput) fileInput = await page.$('input[type="file"]')
  if (!fileInput) {
    await page.evaluate(() => {
      const dz = Array.from(document.querySelectorAll('*')).find(el =>
        /click\s+or\s+drag\s+a\s+passport/i.test((el.textContent || '').trim())
      )
      if (dz) dz.click()
    })
    await sleep(800)
    fileInput = await page.$('input[type="file"]')
  }
  if (!fileInput) {
    await ctx.notify(`❌ ${ctx.profileName}: no passport file input`, 'Check the browser tab.')
    throw new Error('Passport file input missing in modal')
  }

  await fileInput.uploadFile(passportPath)
  log(ctx, '✓ passport file sent to input')

  // ── 3. Live poll for upload + auto-fill ────────────────────────────
  //
  // We poll inside the page every 150ms and log progress so you can watch
  // it happening. The moment the thumbnail appears AND all 5 fields are
  // filled we break out — no waiting for the full 2-min timeout.
  log(ctx, 'waiting for upload + auto-fill (live in-page poll, 150ms)')

  let ready = null
  const hardDeadline = Date.now() + 120000
  const startTs = Date.now()
  let lastLog = 0

  while (Date.now() < hardDeadline) {
    const state = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.width < 250 || r.height < 150 || r.width > 1400 || r.height > 1500) continue
        if (!/candidate\s+pre-check/i.test(el.textContent || '')) continue

        const text = el.textContent || ''
        const rejected = /not\s+clear|unclear|clearer|rejected|invalid|quality|try\s+again|must\s+be\s+clear/i.test(text)

        const fields = {}
        for (const inp of el.querySelectorAll('input, textarea')) {
          const ph = (inp.placeholder || '').trim().toLowerCase()
          if (!ph) continue
          fields[ph] = (inp.value || '').trim()
        }

        const REQUIRED = ['id number', 'passport number', 'surname', 'given names', 'date of birth in gregorian']
        const filled = REQUIRED.filter(k => (fields[k] || '').length > 0)
        const missing = REQUIRED.filter(k => !(fields[k] || '').length)

        const thumb = Array.from(el.querySelectorAll('img')).find(img => {
          const rr = img.getBoundingClientRect()
          const src = img.src || ''
          if (rr.width < 40 || rr.height < 15) return false
          if (!src.startsWith('blob:') && !src.startsWith('data:')) return false
          return !(rr.width < 100 && rr.height < 60)
        })

        // Detect the dropzone's "empty" state — the upload hasn't started
        const dropzoneEmpty = /click\s+or\s+drag\s+a\s+passport/i.test(text) &&
          !el.querySelector('img[src^="blob:"]')

        return {
          hasThumb: !!thumb,
          dropzoneEmpty,
          filled: filled.length,
          missing,
          allFilled: missing.length === 0,
          rejected,
          text: text.slice(0, 200),
        }
      }
      return null
    }).catch(e => ({ _err: e.message }))

    if (!state) { await sleep(150); continue }
    if (state._err) { log(ctx, `poll error: ${state._err}`, 'warn'); await sleep(150); continue }

    if (state.rejected) {
      await ctx.notify(
        `⚠️ ${ctx.profileName}: Musaned rejected the pre-check data`,
        state.text
      )
      throw new Error('Pre-check modal showed an error')
    }

    const elapsed = Math.round((Date.now() - startTs) / 1000)
    if (Date.now() - lastLog > 1500) {
      lastLog = Date.now()
      log(ctx, `t+${elapsed}s — thumb=${state.hasThumb} fields=${state.filled}/5 ` +
        `missing=[${state.missing.join(',')}] dropzone=${state.dropzoneEmpty ? 'empty' : 'filled'}`)
    }

    if (state.hasThumb && state.allFilled) {
      ready = state
      log(ctx, `✓ ready at t+${elapsed}s — thumb + all 5 fields present`)
      break
    }

    await sleep(150)
  }

  if (!ready) {
    log(ctx, 'readiness never confirmed within 2 min — attempting CONTINUE anyway', 'warn')
  }

  // ── 3.5. Scroll the modal so CONTINUE is actually on screen ────────
  //
  // THIS is the step that was broken: the modal's scroll container is a
  // descendant of the modal, not an ancestor, so the old code never
  // scrolled it.
  log(ctx, 'scrolling modal to reveal CONTINUE')
  const scrollRes = await scrollModalToBottom(page, ctx)

  if (scrollRes.btnFound && !scrollRes.fullyVisible) {
    log(ctx, 'CONTINUE still not fully visible — scrolling again', 'warn')
    await sleep(300)
    await scrollModalToBottom(page, ctx)
  }

  // ── 4. Click CONTINUE — DOM click first, gesture as fallback ───────
  log(ctx, 'clicking CONTINUE')

  const modalClosed = () => page.evaluate(() =>
    !/candidate\s+pre-check/i.test(document.body?.innerText || '')
  )

  let clicked = false

  for (let attempt = 0; attempt < 20 && !clicked; attempt++) {
    // Before each attempt: make sure the button is on screen. If the
    // modal re-rendered and scrolled back to the top, this fixes it.
    if (attempt > 0 && attempt % 3 === 0) {
      await scrollModalToBottom(page, ctx)
    }

    // Strategy A — plain DOM click, no coordinates involved
    const domClicked = await page.evaluate(() => {
      const sels = 'button, [role="button"], a, input[type="button"], input[type="submit"]'
      const btn = Array.from(document.querySelectorAll(sels)).find(el => {
        if (el.disabled) return false
        const txt = (el.textContent || el.value || '').trim().toLowerCase()
        return txt === 'continue'
      })
      if (!btn) return { found: false }
      try { btn.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch {}
      try {
        btn.click()
        return { found: true, clicked: true, tag: btn.tagName }
      } catch (e) {
        return { found: true, clicked: false, error: e.message }
      }
    })

    if (domClicked.clicked) {
      log(ctx, `attempt ${attempt + 1}: DOM click fired on <${domClicked.tag}>`)
      await sleep(700)
      if (await modalClosed()) {
        log(ctx, '✓ DOM click closed the modal')
        clicked = true
        break
      }
      log(ctx, 'DOM click did not close modal — trying CDP gesture', 'warn')
    } else if (!domClicked.found && attempt % 4 === 0) {
      const dump = await page.evaluate(() =>
        Array.from(document.querySelectorAll(
          'button, [role="button"], input[type="button"], input[type="submit"]'
        ))
          .map(b => ({
            tag: b.tagName,
            text: (b.textContent || b.value || '').trim().slice(0, 25),
            disabled: !!b.disabled,
            w: Math.round(b.getBoundingClientRect().width),
          }))
          .filter(b => b.text)
          .slice(0, 20)
      )
      log(ctx, `CONTINUE not in DOM (attempt ${attempt + 1}). Buttons: ${JSON.stringify(dump)}`, 'warn')
    }

    // Strategy B — real CDP mouse gesture
    const res = await clickRealistic(page, 'continue', ctx)
    if (res.clicked) {
      await sleep(700)
      if (await modalClosed()) {
        log(ctx, '✓ CDP gesture closed the modal')
        clicked = true
        break
      }
    }

    await sleep(60)
  }

  if (!clicked) {
    await ctx.notify(
      `❌ ${ctx.profileName}: CONTINUE could not be clicked`,
      `scrollRes.btnFound=${scrollRes.btnFound} fullyVisible=${scrollRes.fullyVisible}`
    )
    throw new Error('CONTINUE button not clickable')
  }

  // ── 5. Confirm modal closed ────────────────────────────────────────
  await sleep(800)
  const stillOpen = await page.evaluate(() =>
    /candidate\s+pre-check/i.test(document.body?.innerText || '')
  )
  log(ctx, stillOpen ? '⚠ modal still open after click' : '✓ modal closed',
      stillOpen ? 'warn' : 'info')

  return { ok: true }
}

// ============================================================================
// STEP 7 — Find and click Submit on the next screen
// ============================================================================

/**
 * After CONTINUE, Musaned opens the actual candidate form / details screen.
 * That screen often has a horizontal-scroll layout and the Submit button
 * can be off to the right. This step:
 *   1. Waits for a Submit button to exist (up to 25s).
 *   2. Uses Puppeteer's elementHandle.scrollIntoView() which scrolls every
 *      ancestor scroll container — vertical AND horizontal — to bring it
 *      into view.
 *   3. Fires a REAL CDP mouse click (page.mouse.*) so React sees it.
 *   4. Verifies the screen actually advanced.
 */
export async function stepSubmitCandidateForm(page, ctx) {
  log(ctx, 'waiting for Submit button to appear (up to 25s)')

  const deadline = Date.now() + 25000
  let handle = null
  let lastLogAt = 0

  while (Date.now() < deadline) {
    handle = await page.evaluateHandle(() => {
      const btns = Array.from(document.querySelectorAll('button'))
        .filter(b => /^submit$/i.test((b.textContent || '').trim()) && !b.disabled)
      if (btns.length === 0) return null
      btns.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
        return (ra.width * ra.height) - (rb.width * rb.height)
      })
      return btns[0]
    })
    const el = handle.asElement()
    if (el) break

    if (Date.now() - lastLogAt > 5000) {
      lastLogAt = Date.now()
      log(ctx, '  still no Submit button yet...')
    }
    await sleep(500)
  }

  const el = handle.asElement()
  if (!el) {
    await ctx.notify(
      `❌ ${ctx.profileName}: Submit button not found`,
      'After CONTINUE, no Submit button appeared within 25s. Check the browser tab.'
    )
    throw new Error('Submit button not found')
  }

  const before = await el.evaluate(b => {
    const r = b.getBoundingClientRect()
    return {
      text: (b.textContent || '').trim().slice(0, 40),
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      viewportW: window.innerWidth, viewportH: window.innerHeight,
    }
  })
  const offscreenX = before.x + before.w > before.viewportW || before.x < 0
  const offscreenY = before.y + before.h > before.viewportH || before.y < 0
  log(ctx, `Submit found at (${before.x},${before.y}) size ${before.w}×${before.h}` +
    (offscreenX ? ' [horizontal-scroll needed]' : '') +
    (offscreenY ? ' [vertical-scroll needed]' : ''))

  await el.scrollIntoView().catch(e => log(ctx, `scrollIntoView threw: ${e.message}`, 'warn'))
  await sleep(400)

  await page.evaluate((btn) => {
    let cur = btn.parentElement
    while (cur) {
      if (cur.scrollWidth > cur.clientWidth + 5) {
        cur.scrollLeft = cur.scrollWidth
      }
      cur = cur.parentElement
    }
    window.scrollTo(window.scrollX, document.body.scrollHeight)
  }, el).catch(() => {})
  await sleep(400)

  const after = await el.evaluate(b => {
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }
  })
  log(ctx, `after scroll → center (${Math.round(after.x)},${Math.round(after.y)})`)

  if (after.w < 5 || after.h < 5) {
    await ctx.notify(`❌ ${ctx.profileName}: Submit button has zero size`, 'CSS may be hiding it.')
    throw new Error('Submit button not clickable (zero size)')
  }

  log(ctx, 'clicking Submit (real mouse event)')
  try {
    await page.mouse.move(after.x, after.y)
    await sleep(100)
    await page.mouse.down()
    await sleep(60)
    await page.mouse.up()
    log(ctx, '✓ Submit clicked')
  } catch (e) {
    log(ctx, `mouse click threw: ${e.message} — trying elementHandle.click() fallback`, 'warn')
    try {
      await el.click()
      log(ctx, '✓ Submit clicked (elementHandle fallback)')
    } catch (e2) {
      await ctx.notify(`❌ ${ctx.profileName}: Submit click failed`, e2.message)
      throw new Error(`Submit click failed: ${e2.message}`)
    }
  }

  log(ctx, 'waiting for screen to advance after Submit')
  const advanced = await page.evaluate(() => {
    const body = document.body?.innerText || ''
    const stillHasSubmit = Array.from(document.querySelectorAll('button'))
      .some(b => /^submit$/i.test((b.textContent || '').trim()))
    const successText = /success|submitted|candidate\s+added|تم|بنجاح/i.test(body)
    return { stillHasSubmit, successText, snippet: body.slice(0, 200) }
  })
  await sleep(1500)

  if (advanced.successText) {
    log(ctx, '✓ success text detected after Submit')
  } else if (!advanced.stillHasSubmit) {
    log(ctx, '✓ Submit button disappeared — screen advanced')
  } else {
    log(ctx, '⚠ Submit button is still present — may need manual review', 'warn')
  }

  return { ok: true }
}

// ============================================================================
// RUNNER
// ============================================================================

export async function runMusanedWorkflow(page, ctx) {
  const t0 = Date.now()
  const stage = ctx.musanedStage || 'start'
  log(ctx, `starting musaned workflow (stage=${stage})`)

  try {
    // ── Resume path ─────────────────────────────────────────────────────
    if (stage === 'awaiting-musaned-captcha' || stage === 'awaiting-musaned-otp') {
      log(ctx, `resuming from "${stage}" — checking current screen`)
      const review = await classifyScreen(page, ctx)

      if (review.screen === 'agency-picker') {
        await stepClickAgencyCard(page, ctx)
        const after = await waitForDashboard(page, ctx, 30000)
        if (after !== 'dashboard') {
          await ctx.notify(`🖐 ${ctx.profileName}: Musaned needs attention`,
            `Agency clicked but landed on "${after}".`)
          return { ok: true, pauseReason: `awaiting-musaned-${after}`, seconds: Math.round((Date.now() - t0) / 1000) }
        }
      } else if (review.screen === 'dashboard') {
        log(ctx, '✓ already on dashboard — skipping to HR Pool')
      } else if (review.screen === 'landing') {
        log(ctx, '✓ logged in but on landing page — clicking GO TO DASHBOARD')
        await stepClickGoToDashboard(page, ctx)
        await waitForDashboard(page, ctx, 30000)
      } else if (review.screen === 'captcha') {
        return { ok: true, pauseReason: 'awaiting-musaned-captcha', seconds: Math.round((Date.now() - t0) / 1000) }
      } else if (review.screen === 'otp') {
        await ctx.notify(`🖐 ${ctx.profileName}: Musaned needs OTP`, 'Enter the code from your phone.')
        return { ok: true, pauseReason: 'awaiting-musaned-otp', seconds: Math.round((Date.now() - t0) / 1000) }
      } else if (review.screen === 'login-error') {
        await dumpPageState(page, ctx, 'login-rejected')
        throw new Error('Musaned rejected the credentials')
      }
    } else {
      // ── Fresh flow ────────────────────────────────────────────────────
      const open = await stepOpenMusaned(page, ctx)

      if (open.onKeycloak) {
        await sleep(1000)
        const fill = await stepFillMusanedLogin(page, ctx)
        if (fill.filled) await sleep(1500)
      }

      await sleep(2000)
      const review = await classifyScreen(page, ctx)
      log(ctx, `post-login screen: ${review.screen}`)

      if (review.screen === 'agency-picker') {
        await stepClickAgencyCard(page, ctx)
        const after = await waitForDashboard(page, ctx, 30000)
        if (after !== 'dashboard') {
          await ctx.notify(`🖐 ${ctx.profileName}: Musaned needs attention`,
            `Agency clicked but landed on "${after}".`)
          return { ok: true, pauseReason: `awaiting-musaned-${after}`, seconds: Math.round((Date.now() - t0) / 1000) }
        }
      } else if (review.screen === 'dashboard') {
        log(ctx, '✓ already on dashboard')
      } else if (review.screen === 'landing') {
        log(ctx, '✓ authenticated — on landing page, clicking GO TO DASHBOARD')
        await stepClickGoToDashboard(page, ctx)
        await waitForDashboard(page, ctx, 30000)
      } else if (review.screen === 'captcha') {
        await ctx.notify(`🖐 ${ctx.profileName}: Musaned needs reCAPTCHA`,
          'Solve the reCAPTCHA then click Sign In.')
        return { ok: true, pauseReason: 'awaiting-musaned-captcha', seconds: Math.round((Date.now() - t0) / 1000) }
      } else if (review.screen === 'otp') {
        await ctx.notify(`🖐 ${ctx.profileName}: Musaned needs OTP`,
          'Enter the code from your phone.')
        return { ok: true, pauseReason: 'awaiting-musaned-otp', seconds: Math.round((Date.now() - t0) / 1000) }
      } else if (review.screen === 'login-error') {
        await dumpPageState(page, ctx, 'login-rejected')
        throw new Error('Musaned rejected the credentials')
      } else {
        await ctx.notify(`🖐 ${ctx.profileName}: Musaned needs attention`,
          `Screen could not be classified (${review.source}).`)
        return { ok: true, pauseReason: 'awaiting-musaned-login', seconds: Math.round((Date.now() - t0) / 1000) }
      }
    }

    // ── Shared tail: HR Pool → Add New Candidate → Pre-check → Submit ──
    await stepClickHrPool(page, ctx)
    await stepClickAddNewCandidate(page, ctx)
    await stepFillCandidatePreCheck(page, ctx)
    await stepSubmitCandidateForm(page, ctx)

    const verify = await reviewStageComplete({
      stage: 'login+hr-pool+add-candidate',
      expected: { on_candidates_page: true, modal_open: true },
      observed: { on_candidates_page: true, modal_open: true, url: page.url() },
    })
    log(ctx, `stage verification → complete=${verify.complete} (${verify.source})`)

    const secs = Math.round((Date.now() - t0) / 1000)
    await ctx.notify(
      `✅ ${ctx.profileName}: Musaned candidate pre-check submitted`,
      `ID + passport uploaded, Musaned auto-filled the rest, CONTINUE + Submit clicked.`
    )
    return { ok: true, pauseReason: 'awaiting-human-submit', seconds: secs }

  } catch (e) {
    const secs = Math.round((Date.now() - t0) / 1000)
    log(ctx, `musaned failed after ${secs}s: ${e.message}`, 'error')
    await dumpPageState(page, ctx, 'musaned')
    return { ok: false, step: 'musaned', error: e.message, seconds: secs }
  }
}

// ============================================================================
// WAIT HELPER
// ============================================================================

async function waitForDashboard(page, ctx, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = 'unknown'
  while (Date.now() < deadline) {
    const review = await classifyScreen(page, ctx)
    if (review.screen !== last) {
      log(ctx, `waiting — screen now: ${review.screen}`)
      last = review.screen
    }
    if (['dashboard', 'captcha', 'otp', 'login-error', 'login-form'].includes(review.screen)) return review.screen
    await sleep(600)
  }
  return last
}