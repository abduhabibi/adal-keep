/**
 * refineCore.js — the picture work of "Refine", with no database or PC settings in it,
 * so the PC (photoRefine.js) and the cloud copy (adal-refine/netlify/functions, kept
 * identical by tests/refineCloud.test.js) run the very same words and the same finish.
 */
import sharp from 'sharp'

export const API = 'https://generativelanguage.googleapis.com/v1beta/models'
// The most capable picture model first (best retouch, best at keeping the same face); the faster ones after.
export const MODELS = (process.env.GEMINI_IMAGE_MODELS || 'gemini-3-pro-image,gemini-3.1-flash-image,gemini-2.5-flash-image')
  .split(',').map(s => s.trim()).filter(Boolean)
export const LONG_SIDE = 3840

// The agency's own words for the retouch (rewritten 2026-11-25: faithful — "her appearance must not change").
const PORTRAIT = "FAITHFUL PHOTO RESTORATION — THE SAME PERSON, THE SAME PICTURE, ONLY CLEANER AND SHARPER\nRestore the provided photograph of a real person. This is a documentation photo: she must be recognisable at once by the people who know her. Do not retouch her; only repair the picture.\n\n1. Identity and appearance are untouchable\n* Do not change, redraw, regenerate or idealise her face. Keep every feature, line, mark, mole, scar and asymmetry exactly where and how it is.\n* Do not change her face shape, eyes, nose, lips, eyebrows, teeth, jaw or body proportions. Do not make her slimmer, younger, older or prettier.\n* Do not lighten, whiten, brighten, tan, smooth or even out her skin. Keep her skin tone and texture exactly as photographed, including natural pores and shading.\n* Do not add makeup, change hair, or remove blemishes.\n\n2. Clothing and covering\n* Keep her clothes, head covering, jewellery and background exactly as they are. Do not add, remove or restyle anything.\n\n3. What you may do\n* Remove JPEG blocking, noise, blur and compression artifacts.\n* Recover only detail that is really visible in the picture; do not invent features that are not there.\n* Keep the exposure, colours and contrast as they are, apart from removing a clear colour cast.\n* Keep the same framing, pose and layout.\n\nIf you cannot do this without changing her appearance, return the picture unchanged. Return only the picture.\n"
export const PROMPT = {
  Photo: PORTRAIT + '\nKeep the same head position, framing and background layout.',
  'Full Body Photo': PORTRAIT + '\nThis is a full-length photo: keep her same body, shape, pose and outfit, and her whole body from head to feet in the frame.',
}

export async function tryModels(buf, field, ks, why) {
  const input = await sharp(buf).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer()
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: PROMPT[field] || PROMPT.Photo }, { inline_data: { mime_type: 'image/jpeg', data: input.toString('base64') } }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  })
  for (const model of MODELS) {
    for (const key of ks) {
      try {
        const r = await fetch(`${API}/${model}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(120000),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) { why.push(`${model}: ${r.status}`); if (r.status === 404 || r.status === 400) break; continue }
        const part = (j.candidates?.[0]?.content?.parts || []).find(p => (p.inline_data || p.inlineData)?.data)
        const data = (part?.inline_data || part?.inlineData)?.data
        if (data) return { buf: Buffer.from(data, 'base64'), model }
        why.push(`${model}: no picture (${j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'empty'})`)
        break
      } catch (e) { why.push(`${model}: ${e.name === 'TimeoutError' ? 'took too long' : e.message}`) }
    }
  }
  return null
}

/** Cleaning done here (also the finish after Gemini): levels, colour, denoise, 4K, sharp. */
export async function finish(buf, { clean = true } = {}) {
  let img = sharp(buf).rotate()
  const meta = await img.metadata()
  const long = Math.max(meta.width || 0, meta.height || 0) || LONG_SIDE
  // Gentle: a little light and colour, nothing that smears her face or makes it look made.
  if (clean) img = img.normalise({ lower: 0.5, upper: 99.5 }).modulate({ saturation: 1.03, brightness: 1.04 }).gamma(1.05)
  const scale = LONG_SIDE / long
  img = img.resize({
    width: Math.round((meta.width || LONG_SIDE) * scale), height: Math.round((meta.height || LONG_SIDE) * scale),
    kernel: 'lanczos3', fit: 'fill',
  })
  img = img.sharpen({ sigma: 0.6, m1: 0.3, m2: 1.2 })
  return img.jpeg({ quality: 93, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer()
}

// ── Cut-out refine: no Gemini, no quota, nothing but free models (2026-11-23) ───────────────────────
// silueta (U²-Net, Apache-2.0, 43 MB) finds the girl, she goes on a plain white background, the picture
// is cropped to a CV / passport framing around her, light and colour are fixed gently, and it is sharpened.
// The model runs in ONNX (onnxruntime-node) — in the Netlify function and, with the same file, on the PC.
export const SEG_MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx'
export const SEG_MODEL_BYTES = 44173029
const SEG = 320
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225]
let session = null, sessionPath = ''

async function segSession(modelPath) {
  if (session && sessionPath === modelPath) return session
  const ort = await import('onnxruntime-node')
  session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' })
  sessionPath = modelPath
  return session
}

/** The girl's mask at the picture's own size: { alpha: Buffer (1 byte per pixel, 0-255), w, h }. */
export async function personMask(buf, { modelPath }) {
  const ort = await import('onnxruntime-node')
  const sess = await segSession(modelPath)
  const meta = await sharp(buf).rotate().metadata()
  const w = meta.width, h = meta.height
  const raw = await sharp(buf).rotate().resize(SEG, SEG, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  let max = 1
  for (let i = 0; i < raw.length; i++) if (raw[i] > max) max = raw[i]
  const t = new Float32Array(3 * SEG * SEG)
  for (let i = 0; i < SEG * SEG; i++) for (let c = 0; c < 3; c++) t[c * SEG * SEG + i] = (raw[i * 3 + c] / max - MEAN[c]) / STD[c]
  const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, SEG, SEG]) })
  const m = out[sess.outputNames[0]].data
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < SEG * SEG; i++) { if (m[i] < lo) lo = m[i]; if (m[i] > hi) hi = m[i] }
  const small = Buffer.alloc(SEG * SEG)
  for (let i = 0; i < SEG * SEG; i++) small[i] = Math.round(255 * (m[i] - lo) / Math.max(1e-6, hi - lo))
  const alpha = await sharp(small, { raw: { width: SEG, height: SEG, channels: 1 } }).resize(w, h, { kernel: 'lanczos3' }).blur(1.2).extractChannel(0).raw().toBuffer()
  return { alpha, w, h }
}

/** Where she is: { x0, y0, x1, y1, share } from the mask (rows/columns holding at least a little of her). */
export function personBox({ alpha, w, h }) {
  const rows = new Uint32Array(h), cols = new Uint32Array(w)
  let on = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > 128) { rows[y]++; cols[x]++; on++ }
  const first = (a, min) => { for (let i = 0; i < a.length; i++) if (a[i] > min) return i; return 0 }
  const last = (a, min) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] > min) return i; return a.length - 1 }
  const rowMin = Math.max(2, Math.round(w * 0.004)), colMin = Math.max(2, Math.round(h * 0.004))
  return { x0: first(cols, colMin), x1: last(cols, colMin), y0: first(rows, rowMin), y1: last(rows, rowMin), share: on / (w * h) }
}

/** The crop (in the picture's pixels): a Photo = head and shoulders at 3:4, a Full Body Photo = all of her at 2:3. */
export function framing(box, w, h, field) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1
  const ratio = field === 'Full Body Photo' ? 2 / 3 : 3 / 4
  let ch = field === 'Full Body Photo' ? bh * 1.1 : bh * 1.12   // a little air above the head
  let cw = ch * ratio
  if (cw < bw * 1.08) { cw = bw * 1.08; ch = cw / ratio }        // never cut her shoulders / arms
  const cx = (box.x0 + box.x1) / 2
  const top = box.y0 - (field === 'Full Body Photo' ? bh * 0.05 : bh * 0.08)
  // The frame may leave the picture: the white fills it.
  return { left: Math.round(cx - cw / 2), top: Math.round(top), width: Math.round(cw), height: Math.round(ch) }
}

/**
 * The cut-out refine: { buf, ok, note }. When the mask is not believable (nobody found, or the whole
 * picture is "her") the picture is only cleaned (finish), never cut wrongly.
 */
export async function cutoutRefine(buf, field, { modelPath }) {
  const mask = await personMask(buf, { modelPath })
  const box = personBox(mask)
  if (mask.share < 0.04 || mask.share > 0.97) return { buf: await finish(buf), ok: false, note: `nobody found clearly (${Math.round(mask.share * 100)}% of the picture)` }
  const { w, h } = mask
  const rgb = await sharp(buf).rotate().removeAlpha().raw().toBuffer()
  const out = Buffer.alloc(w * h * 3)
  // Over white. Edges are softened by the mask's own blur; a little of the edge is pulled in so no old background shows as a halo.
  for (let i = 0; i < w * h; i++) {
    const a = Math.min(1, Math.max(0, (alpha(mask.alpha[i]) )))
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(rgb[i * 3 + c] * a + 255 * (1 - a))
  }
  const f = framing(box, w, h, field)
  const padL = Math.max(0, -f.left), padT = Math.max(0, -f.top)
  const padR = Math.max(0, f.left + f.width - w), padB = Math.max(0, f.top + f.height - h)
  // (two steps: sharp cuts before it extends when both are in one pipeline)
  const wide = await sharp(out, { raw: { width: w, height: h, channels: 3 } })
    .extend({ top: padT, bottom: padB, left: padL, right: padR, background: '#ffffff' }).png({ compressionLevel: 0 }).toBuffer()
  const framed = await sharp(wide).extract({ left: f.left + padL, top: f.top + padT, width: f.width, height: f.height }).jpeg({ quality: 95 }).toBuffer()
  return { buf: await finish(framed, { clean: true }), ok: true, note: '' }
}
// Contrast on the mask: below 0.15 → 0, above 0.85 → 1 (clean edges, no grey fringe), smooth between.
const alpha = (v) => { const x = (v / 255 - 0.15) / 0.7; return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x) }

// ── Enhance refine: sharper, cleaner, 4K, the background stays (owner, 2026-11-23) ──────────────────
// Real-ESRGAN realesr-general-x4v3 (BSD-3-Clause, 4.9 MB, made for real photos: it upscales ×4 and removes
// noise / blur / compression) in ONNX, run tile by tile so memory stays small; then a gentle light and
// colour fix, 3840 px on the long side, and a high-quality JPEG. Same file in the cloud and on the PC.
export const SR_MODEL_URL = 'https://huggingface.co/CoderViking/realesr-general-x4v3-onnx/resolve/main/realesr-general-x4v3.onnx'
export const SR_MODEL_BYTES = 4866417
export const SR_MAX_INPUT = 1400      // a longer picture is sharp enough already: only cleaned (×4 of it would be slow for nothing)
let srSession = null, srPath = ''

async function srSess(modelPath, threads) {
  if (srSession && srPath === modelPath) return srSession
  const ort = await import('onnxruntime-node')
  srSession = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', ...(threads ? { intraOpNumThreads: threads } : {}) })
  srPath = modelPath
  return srSession
}

/** The picture ×4, tile by tile: { raw: Buffer (RGB bytes), w, h } of the enlarged picture. */
export async function upscale4x(buf, { modelPath, tile = 192, pad = 12, threads = 0, onTile = null }) {
  const ort = await import('onnxruntime-node')
  const sess = await srSess(modelPath, threads)
  const { data, info } = await sharp(buf).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height, W = w * 4, H = h * 4
  const out = Buffer.alloc(W * H * 3)
  for (let ty = 0; ty < h; ty += tile) for (let tx = 0; tx < w; tx += tile) {
    const x0 = Math.max(0, tx - pad), y0 = Math.max(0, ty - pad), x1 = Math.min(w, tx + tile + pad), y1 = Math.min(h, ty + tile + pad)
    const tw = x1 - x0, th = y1 - y0
    const t = new Float32Array(3 * tw * th)
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const s = ((y0 + y) * w + x0 + x) * 3
      for (let c = 0; c < 3; c++) t[c * tw * th + y * tw + x] = data[s + c] / 255
    }
    const res = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, th, tw]) })
    const o = res[sess.outputNames[0]].data, ow = tw * 4, oh = th * 4
    // only the tile's own area (not its padding) goes into the picture
    const cx0 = (tx - x0) * 4, cy0 = (ty - y0) * 4, cw = Math.min(tile, w - tx) * 4, ch = Math.min(tile, h - ty) * 4
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const d = ((ty * 4 + y) * W + tx * 4 + x) * 3, si = (cy0 + y) * ow + cx0 + x
      for (let c = 0; c < 3; c++) { const v = Math.round(o[c * ow * oh + si] * 255); out[d + c] = v < 0 ? 0 : v > 255 ? 255 : v }
    }
    onTile?.()
  }
  return { raw: out, w: W, h: H }
}

/**
 * The enhance refine: { buf, ok, note }. A picture longer than SR_MAX_INPUT is only cleaned (finish).
 * Gentle on purpose: a little light and colour, sharpening kept small because the network already sharpened.
 */
export async function enhanceRefine(buf, field, { modelPath, threads = 0 }) {
  const meta = await sharp(buf).rotate().metadata()
  const long = Math.max(meta.width || 0, meta.height || 0)
  if (!long || long > SR_MAX_INPUT) return { buf: await finish(buf), ok: false, note: `already ${long}px: cleaned only` }
  const up = await upscale4x(buf, { modelPath, threads })
  const scale = LONG_SIDE / Math.max(up.w, up.h)
  const out = await sharp(up.raw, { raw: { width: up.w, height: up.h, channels: 3 } })
    .normalise({ lower: 0.5, upper: 99.5 }).modulate({ saturation: 1.03, brightness: 1.03 }).gamma(1.04)
    .resize({ width: Math.round(up.w * scale), height: Math.round(up.h * scale), kernel: 'lanczos3', fit: 'fill' })
    .sharpen({ sigma: 0.5, m1: 0.2, m2: 0.8 })
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer()
  return { buf: out, ok: true, note: '' }
}
