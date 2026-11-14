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

const API = 'https://generativelanguage.googleapis.com/v1beta/models'
const MODELS = (process.env.GEMINI_IMAGE_MODELS || 'gemini-3.1-flash-image,gemini-2.5-flash-image,gemini-3-pro-image')
  .split(',').map(s => s.trim()).filter(Boolean)
const LONG_SIDE = 3840

const keys = () => [...new Set([process.env.GEMINI_API_KEY, ...String(process.env.GEMINI_API_KEYS || '').split(/[,;\s]+/)]
  .map(k => String(k || '').trim()).filter(Boolean))]

const PROMPT = {
  Photo: 'Professionally retouch this passport-style portrait photo. It must stay the exact same real person: keep her face shape, eyes, nose, lips, skin tone, age, expression, hijab or hair, clothing and the head position and framing exactly as they are. Remove noise, blur, grain and compression artifacts; make it sharp and high-resolution; even, soft, flattering studio lighting; natural true colours; a clean plain light background. Gentle natural beautification only: slightly smoother skin, fewer blemishes, brighter eyes. Do not add makeup, jewellery, text or anything new; do not change her identity. Return only the retouched photograph.',
  'Full Body Photo': 'Professionally retouch this full-length photo of a woman. It must stay the exact same real person with the same body, pose, face, skin tone, hijab or hair and the same clothes: do not change her identity, shape or outfit, and keep her whole body from head to feet in frame. Remove noise, blur, grain and compression artifacts; make it sharp and high-resolution; even, soft, flattering lighting; natural true colours; a clean plain light background. Gentle natural beautification only. Do not add anything new or any text. Return only the retouched photograph.',
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
  if (clean) img = img.median(3).normalise({ lower: 1, upper: 99 }).modulate({ saturation: 1.06, brightness: 1.03 }).linear(1.04, -4)
  const scale = LONG_SIDE / long
  img = img.resize({
    width: Math.round((meta.width || LONG_SIDE) * scale), height: Math.round((meta.height || LONG_SIDE) * scale),
    kernel: 'lanczos3', fit: 'fill',
  })
  img = img.sharpen({ sigma: clean ? 1.2 : 0.8, m1: 0.6, m2: 2.2 })
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
