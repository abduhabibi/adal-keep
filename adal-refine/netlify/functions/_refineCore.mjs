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

// The agency's own words for the retouch (2026-11-14): identity before beauty.
const PORTRAIT = "PROFESSIONAL PORTRAIT ENHANCEMENT — NATURAL BEAUTY WITH IDENTITY PRESERVATION\nProfessionally enhance and retouch the provided photograph, making the girl look naturally beautiful, elegant, fresh, and photogenic while preserving her original identity and recognizable appearance.\n\n1. Absolute Identity Preservation\nThis is the most important requirement. Preserve the girl's original identity with maximum accuracy.\n* Keep her original facial structure, face shape, eyes, nose, lips, cheeks, eyebrows, and other distinguishing features.\n* Do not replace her face or generate a different person.\n* Maintain her recognizable natural appearance.\n* Do not change her apparent age or ethnic characteristics.\n\n2. Face Enhancement\nGently improve her natural facial appearance:\n* Improve facial clarity and overall visual balance.\n* Enhance natural facial definition.\n* Improve the appearance of her eyes, eyebrows, nose, and lips without changing their original shapes.\n* Remove temporary blemishes and imperfections.\n* Maintain natural facial proportions.\n* Avoid excessive beauty filters or artificial facial modifications.\n\n3. Skin Tone and Complexion\nGive her complexion a naturally brighter, fresher, smoother, and healthier appearance.\n* Apply subtle and tasteful skin brightening.\n* Make her complexion slightly lighter and more radiant while retaining her original skin tone and undertones.\n* Improve uneven skin tone and reduce dullness.\n* Remove temporary blemishes and spots.\n* Preserve realistic skin texture and natural details.\n* Maintain her ethnic characteristics and natural complexion.\nThe final skin should look healthy, luminous, and naturally beautiful, as if photographed under excellent professional lighting and after good skincare.\nAvoid excessive whitening, unnatural pale skin, or artificial skin smoothing.\n\n4. Eyes\n* Improve eye clarity and natural brightness.\n* Enhance eye definition and detail.\n* Preserve the original eye shape, size, and color.\n* Avoid exaggerated or artificially enlarged eyes.\n\n5. Lighting and Photography\nApply professional portrait photography techniques:\n* Balanced exposure and soft, flattering lighting.\n* Natural shadows and highlights.\n* Improved contrast and color balance.\n* Professional depth and visual clarity.\n* A clean, elegant photographic finish.\n\n6. Clothing and Head Covering\nPreserve her original clothing, cultural appearance, religious identity, and personal style.\n* If she is wearing a hijab, preserve its original style, color, and coverage while improving its neatness, fabric texture, folds, and presentation.\n* If she is wearing another type of head covering, preserve it in its original form.\n* If she is not wearing a head covering, do not add one.\n* Preserve the original outfit and its design while improving fabric details and appearance.\n* Do not add, remove, or invent religious symbols or clothing.\n\n7. Hair and Personal Appearance\nIf her hair is visible, improve its natural neatness, texture, and definition without changing its original style or color.\nDo not invent hair where it is covered.\n\n8. Image Restoration and Quality\nProfessionally restore the original photograph:\n* Remove blur, pixelation, noise, and compression artifacts.\n* Improve resolution and sharpness.\n* Recover visible details without inventing missing features.\n* Correct poor exposure and color distortion.\n* Produce a clean, high-resolution, professional portrait.\n\n9. Strict Restrictions\n* Never change her identity.\n* Never make her look like another person.\n* Never dramatically change her skin color.\n* Never apply excessive whitening.\n* Never apply heavy or inappropriate makeup.\n* Never exaggerate facial features.\n* Never change her religion or modest clothing.\n* Never add a hijab or other head covering if one is absent.\n* Never make her look artificial, plastic, or heavily AI-generated.\n* Never sacrifice identity preservation for conventional beauty standards.\n\nFINAL OBJECTIVE\nProduce a significantly improved, high-quality, naturally beautiful version of the exact same girl.\nShe should look more radiant, attractive, fresh, elegant, and professionally photographed, with a slightly brighter and more even complexion.\nThe result must look like the original girl on her very best day, photographed with an excellent professional camera and beautiful lighting — NOT like a different girl created by artificial intelligence.\nIdentity preservation comes before every beauty enhancement."
export const PROMPT = {
  Photo: PORTRAIT + '\n\nKeep the same head position, framing and background layout. Return only the retouched photograph.',
  'Full Body Photo': PORTRAIT + '\n\nThis is a full-length photo: keep her same body, shape, pose and outfit, and her whole body from head to feet in the frame. Return only the retouched photograph.',
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
