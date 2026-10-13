/**
 * compositeDetector.js
 *
 * Many agencies send passport + headshot + full-body photo merged into a
 * single image. This module:
 *   1. Asks DeepSeek vision whether the image is a composite
 *   2. If yes, returns bounding boxes for each component (in pixels)
 *   3. Crops each region to a temp file via sharp
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import sharp from 'sharp'
import { getSecret } from './secretStore.js'

const PROMPT = `You are given a scanned image from an Ethiopian employment agency.

The image may be:
  (a) A single item (just a passport page, or just a photo)
  (b) A COMPOSITE of three items side by side:
        - passport data page
        - a small passport-sized headshot photo
        - a full-body photo of the person

Look at the image carefully.

If it is a COMPOSITE (contains at least two distinct items), return:
{
  "is_composite": true,
  "passport":  { "x": <px>, "y": <px>, "width": <px>, "height": <px> },
  "headshot":  { "x": <px>, "y": <px>, "width": <px>, "height": <px> },
  "full_body": { "x": <px>, "y": <px>, "width": <px>, "height": <px> }
}

Omit any key whose item is not present.

If the image is a SINGLE item, return:
{ "is_composite": false }

Return ONLY the JSON object. No prose, no markdown.
All coordinates are pixel positions in the ORIGINAL image (top-left origin).`

export async function detectComposite(imagePath) {
  const key = getSecret('DEEPSEEK_API_KEY') || process.env.DEEPSEEK_API_KEY
  if (!key) {
    console.warn('[composite] no DeepSeek key — skipping detection')
    return { is_composite: false }
  }

  let meta
  try {
    meta = await sharp(imagePath).metadata()
  } catch (e) {
    console.warn('[composite] cannot read image:', e.message)
    return { is_composite: false }
  }

  // Cheap pre-filter: composites are wide. Single passport pages are
  // roughly 0.68 aspect (portrait). Single photos are square or portrait.
  const aspect = (meta.width || 1) / (meta.height || 1)
  if (aspect < 1.15) {
    return { is_composite: false }
  }

  const b64 = fs.readFileSync(imagePath).toString('base64')
  const mime = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg'
  const dataUrl = `data:${mime};base64,${b64}`

  const body = {
    model: process.env.AI_VISION_MODEL || 'deepseek-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `${PROMPT}\n\nImage dimensions: ${meta.width}x${meta.height} px.` },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ],
    }],
    max_tokens: 500,
    temperature: 0,
  }

  try {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      console.warn('[composite] vision HTTP', r.status)
      return { is_composite: false }
    }
    const data = await r.json()
    const content = data.choices?.[0]?.message?.content || ''
    const m = content.match(/\{[\s\S]*\}/)
    if (!m) return { is_composite: false }
    const parsed = JSON.parse(m[0])

    // Sanity-check the bounding boxes
    if (!parsed.is_composite) return { is_composite: false }
    const W = meta.width, H = meta.height
    for (const key of ['passport', 'headshot', 'full_body']) {
      const b = parsed[key]
      if (!b) continue
      if (typeof b.x !== 'number' || typeof b.y !== 'number' ||
          typeof b.width !== 'number' || typeof b.height !== 'number') {
        delete parsed[key]
        continue
      }
      // Clamp
      b.x = Math.max(0, Math.min(b.x, W - 10))
      b.y = Math.max(0, Math.min(b.y, H - 10))
      b.width = Math.max(20, Math.min(b.width, W - b.x))
      b.height = Math.max(20, Math.min(b.height, H - b.y))
    }
    return { ...parsed, _dims: { width: W, height: H } }
  } catch (e) {
    console.warn('[composite] detect failed:', e.message)
    return { is_composite: false }
  }
}

/**
 * Crop a region from the source image. Returns the temp file path.
 */
export async function cropRegion(imagePath, bbox, ext) {
  const { x, y, width, height } = bbox
  const out = path.join(
    os.tmpdir(),
    `composite_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`
  )
  const fmt = ext.toLowerCase()
  let pipeline = sharp(imagePath).extract({
    left: Math.round(x), top: Math.round(y),
    width: Math.round(width), height: Math.round(height),
  })
  if (fmt === '.png') pipeline = pipeline.png()
  else pipeline = pipeline.jpeg({ quality: 92 })
  await pipeline.toFile(out)
  return out
}