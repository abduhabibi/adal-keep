/**
 * photoRefine.js — "Refine" on a profile's Photo or Full Body Photo (asked on
 * 2026-11-13): the same girl, cleaned and a little more beautiful, at 4K.
 *
 *  1. Gemini's image model retouches it (noise, blur, lighting, colour, a
 *     clean plain background, gentle natural beautifying) — her face, features,
 *     skin tone, hijab, clothes and pose stay exactly as they are.
 *  2. The result is brought to 4K (3840 px on its long side) and sharpened.
 *  Without Gemini (no key, quota used, no internet): the same cleaning done
 *  here — levels, colour, denoise, 4K, sharpening — so the button always works.
 *
 * The original stays in the field; the refined picture is added as the newest
 * file (the CV takes the newest).
 */
import sharp from 'sharp'

import { refineKeys } from './aiKeys.js'
const API = 'https://generativelanguage.googleapis.com/v1beta/models'
// The most capable picture model first (best retouch, best at keeping the same face); the faster ones after.
const MODELS = (process.env.GEMINI_IMAGE_MODELS || 'gemini-3-pro-image,gemini-3.1-flash-image,gemini-2.5-flash-image')
  .split(',').map(s => s.trim()).filter(Boolean)
const LONG_SIDE = 3840

// The keys pasted in Settings → Photo refining keys first, then the PC's own.
const keys = () => [...new Set([...refineKeys(), process.env.GEMINI_API_KEY, ...String(process.env.GEMINI_API_KEYS || '').split(/[,;\s]+/)]
  .map(k => String(k || '').trim()).filter(Boolean))]

// The agency's own words for the retouch (2026-11-14): identity before beauty.
const PORTRAIT = "PROFESSIONAL PORTRAIT ENHANCEMENT — NATURAL BEAUTY WITH IDENTITY PRESERVATION\nProfessionally enhance and retouch the provided photograph, making the girl look naturally beautiful, elegant, fresh, and photogenic while preserving her original identity and recognizable appearance.\n\n1. Absolute Identity Preservation\nThis is the most important requirement. Preserve the girl's original identity with maximum accuracy.\n* Keep her original facial structure, face shape, eyes, nose, lips, cheeks, eyebrows, and other distinguishing features.\n* Do not replace her face or generate a different person.\n* Maintain her recognizable natural appearance.\n* Do not change her apparent age or ethnic characteristics.\n\n2. Face Enhancement\nGently improve her natural facial appearance:\n* Improve facial clarity and overall visual balance.\n* Enhance natural facial definition.\n* Improve the appearance of her eyes, eyebrows, nose, and lips without changing their original shapes.\n* Remove temporary blemishes and imperfections.\n* Maintain natural facial proportions.\n* Avoid excessive beauty filters or artificial facial modifications.\n\n3. Skin Tone and Complexion\nGive her complexion a naturally brighter, fresher, smoother, and healthier appearance.\n* Apply subtle and tasteful skin brightening.\n* Make her complexion slightly lighter and more radiant while retaining her original skin tone and undertones.\n* Improve uneven skin tone and reduce dullness.\n* Remove temporary blemishes and spots.\n* Preserve realistic skin texture and natural details.\n* Maintain her ethnic characteristics and natural complexion.\nThe final skin should look healthy, luminous, and naturally beautiful, as if photographed under excellent professional lighting and after good skincare.\nAvoid excessive whitening, unnatural pale skin, or artificial skin smoothing.\n\n4. Eyes\n* Improve eye clarity and natural brightness.\n* Enhance eye definition and detail.\n* Preserve the original eye shape, size, and color.\n* Avoid exaggerated or artificially enlarged eyes.\n\n5. Lighting and Photography\nApply professional portrait photography techniques:\n* Balanced exposure and soft, flattering lighting.\n* Natural shadows and highlights.\n* Improved contrast and color balance.\n* Professional depth and visual clarity.\n* A clean, elegant photographic finish.\n\n6. Clothing and Head Covering\nPreserve her original clothing, cultural appearance, religious identity, and personal style.\n* If she is wearing a hijab, preserve its original style, color, and coverage while improving its neatness, fabric texture, folds, and presentation.\n* If she is wearing another type of head covering, preserve it in its original form.\n* If she is not wearing a head covering, do not add one.\n* Preserve the original outfit and its design while improving fabric details and appearance.\n* Do not add, remove, or invent religious symbols or clothing.\n\n7. Hair and Personal Appearance\nIf her hair is visible, improve its natural neatness, texture, and definition without changing its original style or color.\nDo not invent hair where it is covered.\n\n8. Image Restoration and Quality\nProfessionally restore the original photograph:\n* Remove blur, pixelation, noise, and compression artifacts.\n* Improve resolution and sharpness.\n* Recover visible details without inventing missing features.\n* Correct poor exposure and color distortion.\n* Produce a clean, high-resolution, professional portrait.\n\n9. Strict Restrictions\n* Never change her identity.\n* Never make her look like another person.\n* Never dramatically change her skin color.\n* Never apply excessive whitening.\n* Never apply heavy or inappropriate makeup.\n* Never exaggerate facial features.\n* Never change her religion or modest clothing.\n* Never add a hijab or other head covering if one is absent.\n* Never make her look artificial, plastic, or heavily AI-generated.\n* Never sacrifice identity preservation for conventional beauty standards.\n\nFINAL OBJECTIVE\nProduce a significantly improved, high-quality, naturally beautiful version of the exact same girl.\nShe should look more radiant, attractive, fresh, elegant, and professionally photographed, with a slightly brighter and more even complexion.\nThe result must look like the original girl on her very best day, photographed with an excellent professional camera and beautiful lighting — NOT like a different girl created by artificial intelligence.\nIdentity preservation comes before every beauty enhancement."
const PROMPT = {
  Photo: PORTRAIT + '\n\nKeep the same head position, framing and background layout. Return only the retouched photograph.',
  'Full Body Photo': PORTRAIT + '\n\nThis is a full-length photo: keep her same body, shape, pose and outfit, and her whole body from head to feet in the frame. Return only the retouched photograph.',
}

/** Gemini's retouch, or null when it cannot (the reason is in `why`). */
let noQuotaUntil = 0   // every key refused image editing (Google's free plan has none): tried again after an hour
async function geminiRetouch(buf, field, why) {
  const ks = keys()
  if (!ks.length) { why.push('no Gemini key'); return null }
  if (Date.now() < noQuotaUntil) { why.push('Gemini image editing needs billing on the Google key'); return null }
  const r0 = await tryModels(buf, field, ks, why)
  if (!r0 && why.length && why.every(w => / 429$/.test(w))) noQuotaUntil = Date.now() + 3600_000
  return r0
}
async function tryModels(buf, field, ks, why) {
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
async function finish(buf, { clean = true } = {}) {
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

/**
 * The refined picture: { buf, by, width, height, note }.
 * `by` is 'gemini:<model>' or 'local' (Gemini could not: `note` says why).
 */
export async function refinePhoto(buf, field = 'Photo', { useGemini = true } = {}) {
  const why = []
  const ai = useGemini ? await geminiRetouch(buf, field, why) : null
  const out = ai ? await finish(ai.buf, { clean: false }) : await finish(buf)
  const meta = await sharp(out).metadata()
  return { buf: out, by: ai ? `gemini:${ai.model}` : 'local', width: meta.width, height: meta.height, note: ai ? '' : why.join('; ') }
}

export const REFINABLE = ['Photo', 'Full Body Photo']

/** Settings' check of one key: 'ok', 'needs-billing' (Google's free plan edits no pictures) or 'refused'. */
export async function canEditPictures(key) {
  const tiny = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#c8b49a' } }).jpeg().toBuffer()
  const body = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Make this picture slightly brighter. Return only the picture.' }, { inline_data: { mime_type: 'image/jpeg', data: tiny.toString('base64') } }] }], generationConfig: { responseModalities: ['IMAGE'] } })
  let saw429 = false
  for (const model of MODELS) {
    try {
      const r = await fetch(`${API}/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(90000) })
      if (r.ok) { noQuotaUntil = 0; return 'ok' }
      if (r.status === 429) saw429 = true
      if (r.status === 401 || r.status === 403) return 'refused'
    } catch {}
  }
  return saw429 ? 'needs-billing' : 'refused'
}
