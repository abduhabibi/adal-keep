/**
 * captchaSolver.js — DeepSeek Vision solver for reCAPTCHA v2 image grids.
 *
 * Strategy (grid method):
 *   1. Find the reCAPTCHA bframe iframe.
 *   2. Read the instruction ("Select all images with...").
 *   3. Screenshot the image grid.
 *   4. Ask DeepSeek Vision which tiles match (returns tile indices 1..N).
 *   5. Click each matching tile via page.mouse.click at absolute coords.
 *   6. Click Verify.
 *
 * Returns:
 *   { solved: true,  clicks, instruction, gridSize }
 *   { solved: false, reason: '...' }
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { reviewCaptchaState } from './jev/musanedDecisions.js'

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const VISION_MODEL = process.env.AI_VISION_MODEL || 'deepseek-flash'

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * Ask DeepSeek to solve a reCAPTCHA grid.
 * Returns an array of 1-based tile indices, or null on failure.
 */
async function askDeepSeekGrid(base64Png, instruction, gridSize) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return { ok: false, error: 'no_api_key' }

  const prompt = `You are solving a reCAPTCHA v2 image challenge.

Instruction: "${instruction}"
Grid: ${gridSize}x${gridSize} tiles, numbered 1 to ${gridSize * gridSize} in reading order (left→right, top→bottom).

Return ONLY a JSON array of the tile numbers that match the instruction.
Example: [1, 4, 7]
If none match, return [].

Do NOT include any explanation, only the JSON array.`

  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Png}`, detail: 'high' } },
          ],
        }],
        max_tokens: 200,
        temperature: 0.1,
      }),
    })
    const data = await resp.json()
    const content = data.choices?.[0]?.message?.content || ''

    // Extract the first JSON array from the response
    const m = content.match(/\[\s*\d*(?:\s*,\s*\d+)*\s*\]/)
    if (!m) return { ok: false, error: 'bad_model_response', raw: content.slice(0, 200) }

    const idx = JSON.parse(m[0])
    return { ok: true, indexes: idx }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/**
 * Main entry point.
 */
export async function solveRecaptchaChallenge(page, ctx = null) {
  const logFn = (msg, level = 'info') => {
    if (ctx?.onLog) ctx.onLog(level, msg)
    console.log(`[captcha] ${msg}`)
  }

  // 1. Find the bframe iframe
  const frames = page.frames()
  const challengeFrame = frames.find(f => f.url().includes('recaptcha/api2/bframe'))
  if (!challengeFrame) {
    return { solved: false, reason: 'no_challenge_iframe' }
  }
  logFn('found reCAPTCHA challenge iframe')

  // 2. Read instruction text
  const instruction = await challengeFrame.evaluate(() => {
    const el = document.querySelector('.rc-imageselect-desc-wrapper, .rc-imageselect-desc, .rc-imageselect-instructions')
    return el ? el.textContent.trim() : ''
  })
  logFn(`instruction: "${instruction.slice(0, 80)}"`)

  // 3. Detect grid size (3x3 or 4x4)
  const gridSize = await challengeFrame.evaluate(() => {
    // reCAPTCHA uses a class on the table wrapper to signal grid size
    if (document.querySelector('.rc-imageselect-table-44')) return 4
    if (document.querySelector('.rc-imageselect-table-33')) return 3
    // Fallback: count tiles
    const tiles = document.querySelectorAll('.rc-image-tile-wrapper, .rc-imageselect-tile')
    return tiles.length === 16 ? 4 : 3
  })
  logFn(`grid size: ${gridSize}x${gridSize}`)

  // 4. Get bounding boxes for the whole iframe and each tile
  const frameEl = await challengeFrame.frameElement()
  const frameBox = await frameEl.boundingBox()
  if (!frameBox) return { solved: false, reason: 'no_frame_box' }

  const tileRects = await challengeFrame.evaluate((gridSize) => {
    // The image grid is inside .rc-imageselect-target or a table
    const wrapper = document.querySelector('.rc-imageselect-target, .rc-imageselect-table, table')
    if (!wrapper) return null
    const wrapperRect = wrapper.getBoundingClientRect()
    const cell = wrapperRect.width / gridSize
    const tiles = []
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        tiles.push({
          index: r * gridSize + c + 1, // 1-based
          x: wrapperRect.left + c * cell + cell / 2,
          y: wrapperRect.top + r * cell + cell / 2,
        })
      }
    }
    return tiles
  }, gridSize)

  if (!tileRects) return { solved: false, reason: 'no_tile_rects' }

  // 5. Screenshot the grid
  const gridEl = await challengeFrame.$('.rc-imageselect-target, .rc-imageselect-table, table')
  if (!gridEl) return { solved: false, reason: 'no_grid_element' }

  const tmpPath = path.join(os.tmpdir(), `recaptcha_${Date.now()}.png`)
  await gridEl.screenshot({ path: tmpPath })

  let base64
  try {
    base64 = fs.readFileSync(tmpPath).toString('base64')
  } finally {
    try { fs.unlinkSync(tmpPath) } catch {}
  }

  // 6. Ask DeepSeek
  logFn('asking DeepSeek Vision to solve the grid...')
  const result = await askDeepSeekGrid(base64, instruction, gridSize)
  if (!result.ok) {
    logFn(`DeepSeek failed: ${result.error}`, 'warn')
    return { solved: false, reason: result.error, raw: result.raw }
  }

  logFn(`DeepSeek returned tiles: [${result.indexes.join(', ')}]`)
  if (result.indexes.length === 0) {
    logFn('no matching tiles — model says skip', 'warn')
    return { solved: false, reason: 'no_matches' }
  }

  // 7. Click each matching tile via page.mouse.click (absolute coords)
  for (const n of result.indexes) {
    const tile = tileRects.find(t => t.index === n)
    if (!tile) continue
    const absX = frameBox.x + tile.x
    const absY = frameBox.y + tile.y
    await page.mouse.move(absX, absY)
    await sleep(80)
    await page.mouse.down({ button: 'left' })
    await sleep(40)
    await page.mouse.up({ button: 'left' })
    logFn(`  clicked tile ${n} at (${Math.round(absX)}, ${Math.round(absY)})`)
    await sleep(300)
  }

  // 8. Click Verify
  await sleep(500)
  const verifyBtn = await challengeFrame.$('#recaptcha-verify-button')
  if (verifyBtn) {
    try { await verifyBtn.click() } catch {
      // fallback: dispatch via DOM
      await challengeFrame.evaluate(() => {
        const v = document.querySelector('#recaptcha-verify-button')
        if (v) v.click()
      })
    }
    logFn('clicked Verify')
  }

  return {
    solved: true,
    clicks: result.indexes.length,
    instruction: instruction.slice(0, 100),
    gridSize,
  }
}