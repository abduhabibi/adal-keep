/**
 * composite.js — one picture that holds several things (asked on 2026-11-17):
 * most agencies send the passport, her photo and her full-body photo pasted
 * side by side in one image, each in its own place and size. JEV points at
 * each part (nothing is at a fixed place); each is cut out and handled on its
 * own: the passport is read as a passport, the photo goes into Photo, the
 * standing one into Full Body Photo.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import sharp from 'sharp'

export const PARTS = {
  passport: 'The passport scan: the whole open passport with its data page (her small printed photo, name, dates and the two machine-readable lines at the bottom). Not the separate photos of the woman beside it.',
  photo: 'A separate head-and-shoulders portrait photo of the woman (a passport-style photo standing on its own) — NOT the small photo printed inside the passport.',
  fullbody: 'A separate photo of the woman standing, showing her whole body from head to feet.',
}

const area = (b) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top)
/** How much of box a lies inside box b (0..1). */
export function insideOf(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? (w * h) / (area(a) || 1) : 0
}

/**
 * The parts JEV found, checked: at least two separate things, the photos not
 * inside the passport, the full-body photo taller than wide. `boxes` is
 * findOnPage's answer; `W`/`H` the picture's size (for the full-body shape).
 */
export function pickParts(boxes, W = 1, H = 1, { min = 0.3 } = {}) {
  if (!boxes) return null
  const ok = (b) => b && (b.confidence ?? 1) >= min && b.right - b.left > 0.04 && b.bottom - b.top > 0.04
  const pass = ok(boxes.passport) ? boxes.passport : null
  const apart = (b) => !pass || insideOf(b, pass) < 0.5
  const photo = ok(boxes.photo) && apart(boxes.photo) ? boxes.photo : null
  const body = ok(boxes.fullbody) && apart(boxes.fullbody) && (boxes.fullbody.bottom - boxes.fullbody.top) * H > (boxes.fullbody.right - boxes.fullbody.left) * W ? boxes.fullbody : null
  // A photo inside the full-body picture is not a photo of its own.
  const photo2 = photo && body && insideOf(photo, body) > 0.6 ? null : photo
  const parts = { passport: pass, photo: photo2, fullbody: body }
  return Object.values(parts).filter(Boolean).length >= 2 ? parts : null
}

/**
 * Each part with a small margin, then trimmed back from its neighbours so no
 * cut-out shows a piece of the next one (JEV's boxes often overlap a little).
 */
const GAP = 0.008   // a frame around a photo often reaches a little past its box
export function apart(parts, pad = 0.012) {
  const out = {}
  for (const [k, b] of Object.entries(parts)) out[k] = b && { left: Math.max(0, b.left - pad), top: Math.max(0, b.top - pad), right: Math.min(1, b.right + pad), bottom: Math.min(1, b.bottom + pad) }
  const keys = Object.keys(out).filter(k => out[k])
  for (const k of keys) for (const o of keys) {
    // The bigger part gives way: a small photo keeps all of itself.
    if (k === o || area(parts[k]) < area(parts[o])) continue
    const a = out[k], b = parts[o]   // trim against the neighbour's own (unpadded) box
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
    if (w <= 0 || h <= 0) continue
    const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2
    const ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2
    // Trim along the side where the overlap is thinnest (keeps most of the part).
    const t = w <= h
      ? (cx > ax ? { ...a, right: Math.max(a.left, b.left - GAP) } : { ...a, left: Math.min(a.right, b.right + GAP) })
      : (cy > ay ? { ...a, bottom: Math.max(a.top, b.top - GAP) } : { ...a, top: Math.min(a.bottom, b.bottom + GAP) })
    if (area(t) >= 0.6 * area(a)) out[k] = t
  }
  return out
}

/**
 * Splits a picture into its parts. Returns { passport, photo, fullbody } (paths
 * of cut-out JPEGs, or null) and `dir` to remove afterwards — or null when it
 * is one thing only, not a picture, or JEV is not there.
 */
export async function splitComposite(filePath, { find = null } = {}) {
  if (!/\.(jpe?g|png|webp)$/i.test(filePath)) return null
  const img = sharp(filePath).rotate()
  const meta = await img.metadata()
  const W = meta.autoOrient?.width || meta.width, H = meta.autoOrient?.height || meta.height
  if (!W || !H || W * H < 400 * 300) return null
  // Side by side means wider than tall: a single photo, a standing photo or a CV page is never asked about (speed).
  if (W < H * 1.15) return null
  const png = await sharp(filePath).rotate().png().toBuffer()
  const look = find || (await import('./jevClassifier.js')).findOnPage
  const parts = pickParts(await look(png, PARTS), W, H)
  if (!parts) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-parts-'))
  const out = { dir }
  const cut = apart(parts)
  for (const [k, b] of Object.entries(cut)) {
    if (!b) { out[k] = null; continue }
    const left = Math.max(0, Math.floor(b.left * W)), top = Math.max(0, Math.floor(b.top * H))
    const right = Math.min(W, Math.ceil(b.right * W)), bottom = Math.min(H, Math.ceil(b.bottom * H))
    if (right - left < 20 || bottom - top < 20) { out[k] = null; continue }
    const file = path.join(dir, `${k}.jpg`)
    await sharp(png).extract({ left, top, width: right - left, height: bottom - top }).jpeg({ quality: 93 }).toFile(file)
    out[k] = file
  }
  return out
}
