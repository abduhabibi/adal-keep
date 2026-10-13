/**
 * smartClick.js — Find a button, scroll if needed, click it.
 *
 * Loop:
 *   1. Try DOM (exact text, then loose match).
 *   2. Screenshot viewport → ask DeepSeek "is the button visible?
 *      where is its center as % of the image?"
 *   3. If visible → click at that position → verify button gone.
 *   4. If not visible → native wheel-scroll → repeat.
 *
 * v1.1 — scrollDown now uses page.mouse.wheel() (a real native wheel event)
 *        instead of programmatically setting scrollTop. React scroll
 *        containers with custom onScroll handlers or virtual scroll ignore
 *        direct scrollTop writes, so the wheel event is required.
 *        Also adds a scrollbar-track click fallback when the wheel doesn't
 *        move the page at all.
 */

import { askEye } from './visionEye.js'

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function domFind(page, labelText) {
  return await page.evaluate((label) => {
    const re = new RegExp(`^${label}$`, 'i')
    const loose = new RegExp(label, 'i')
    const candidates = Array.from(document.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"]'
    )).filter(b => {
      const txt = (b.textContent || b.value || '').trim()
      return !b.disabled && (re.test(txt) || loose.test(txt))
    })
    if (!candidates.length) return null
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect()
      return (rb.width * rb.height) - (ra.width * ra.height)
    })
    const el = candidates[0]
    const r = el.getBoundingClientRect()
    if (r.width < 5 || r.height < 5) return null
    if (r.top < 0 || r.top > window.innerHeight) return null
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      text: (el.textContent || el.value || '').trim().slice(0, 40),
    }
  }, labelText)
}

async function clickAt(page, x, y) {
  await page.mouse.move(x, y)
  await sleep(80)
  await page.mouse.down()
  await sleep(60)
  await page.mouse.up()
}

/**
 * scrollDown — native wheel event, targeted at the largest scrollable
 * container on the page (usually the modal), then falls back to a
 * scrollbar-track click if the wheel didn't move anything.
 */
async function scrollDown(page) {
  // Remember how far the window is scrolled so we can detect a no-op.
  const scrollBefore = await page.evaluate(() => window.scrollY)

  // ── 1. Pick the best target for the wheel event ───────────────────
  const target = await page.evaluate(() => {
    // Prefer the largest scrollable element on the page (usually the modal).
    let best = null
    let bestArea = 0
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      const canY = (cs.overflowY === 'auto' || cs.overflowY === 'scroll')
      if (!canY) continue
      if (el.scrollHeight <= el.clientHeight + 20) continue
      const r = el.getBoundingClientRect()
      if (r.width < 100 || r.height < 100) continue
      const area = r.width * r.height
      if (area > bestArea) {
        bestArea = area
        best = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
    }
    if (best) return best
    // Fallback: center of viewport
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  })

  // ── 2. Native wheel scroll — 3 pulses of 400px ≈ 1200px total ────
  await page.mouse.move(target.x, target.y)
  await sleep(80)
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel({ deltaY: 400 })
    await sleep(150)
  }
  await sleep(700)

  // ── 3. If nothing moved, try clicking the scrollbar track ─────────
  const scrollAfter = await page.evaluate(() => window.scrollY)
  if (scrollAfter === scrollBefore) {
    const dims = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }))
    // Click ~5px from the right edge at 75% down, then again at 90%.
    // This pages down the native scrollbar track in most browsers.
    await page.mouse.click(dims.w - 4, dims.h * 0.75)
    await sleep(600)
    await page.mouse.click(dims.w - 4, dims.h * 0.9)
    await sleep(400)
  }
}

async function screenshotB64(page) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false })
  return Buffer.from(buf).toString('base64')
}

/**
 * smartClick — try DOM, fall back to DeepSeek vision, scroll if needed.
 * Returns true if a click was fired and verified.
 */
export async function smartClick({
  page, labelText, log = () => {}, pageContext, maxRounds = 8, stillVisible,
}) {
  log(`smartClick("${labelText}")`)

  for (let round = 1; round <= maxRounds; round++) {
    // ── 1. DOM ─────────────────────────────────────────────────────
    const dom = await domFind(page, labelText)
    if (dom) {
      log(`round ${round}: DOM found "${dom.text}" at (${Math.round(dom.x)},${Math.round(dom.y)}) — clicking`)
      await clickAt(page, dom.x, dom.y)
      await sleep(1500)
      if (typeof stillVisible === 'function') {
        const still = await stillVisible().catch(() => false)
        if (!still) { log(`✓ clicked "${labelText}" (DOM) — target gone`); return true }
        log(`still visible after DOM click — will scroll and retry`, 'warn')
      } else {
        log(`✓ clicked "${labelText}" (DOM)`); return true
      }
    } else {
      log(`round ${round}: DOM has no "${labelText}" button — asking DeepSeek`)
    }

    // ── 2. Ask the eye ─────────────────────────────────────────────
    let imgB64 = null
    try { imgB64 = await screenshotB64(page) } catch (e) { log(`screenshot failed: ${e.message}`, 'warn') }

    if (imgB64) {
      const prompt =
        `You are looking at a screenshot of a browser page: ${pageContext}\n\n` +
        `Question: is a clickable button labeled "${labelText}" visible anywhere in this image?\n\n` +
        `If it IS visible, return its center as percentages of the image size, so that\n` +
        `x_pct = 0 means the left edge, 100 means the right edge,\n` +
        `y_pct = 0 means the top,  100 means the bottom.\n\n` +
        `Reply with ONLY this JSON, no other text:\n` +
        `{"visible": true, "x_pct": <0-100>, "y_pct": <0-100>, "reason": "short note"}\n` +
        `or\n` +
        `{"visible": false, "x_pct": null, "y_pct": null, "reason": "short note"}`

      const eye = await askEye({ imageBase64: imgB64, prompt })
      if (!eye.ok) {
        log(`eye failed: ${eye.error}`, 'warn')
      } else {
        const d = eye.data || {}
        log(`eye says visible=${d.visible} x=${d.x_pct}% y=${d.y_pct}% (${d.reason || ''})`)

        if (d.visible && typeof d.x_pct === 'number' && typeof d.y_pct === 'number') {
          const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
          const x = Math.round((d.x_pct / 100) * vp.w)
          const y = Math.round((d.y_pct / 100) * vp.h)
          log(`clicking DeepSeek coords (${x},${y})`)
          await clickAt(page, x, y)
          await sleep(2000)

          if (typeof stillVisible === 'function') {
            const still = await stillVisible().catch(() => true)
            if (!still) { log(`✓ clicked "${labelText}" (DeepSeek eye)`); return true }
            log(`still visible after eye click — scrolling`, 'warn')
          } else {
            log(`✓ clicked "${labelText}" (DeepSeek eye)`); return true
          }
        }
      }
    }

    // ── 3. Native wheel scroll + scrollbar fallback for next round ─
    log(`round ${round}: wheel-scrolling 1200px`)
    await scrollDown(page)
  }

  log(`✗ "${labelText}" not found after ${maxRounds} rounds`, 'error')
  return false
}