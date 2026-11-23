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
import { API, MODELS, PROMPT, tryModels, finish } from './refineCore.js'

// The keys pasted in Settings → Photo refining keys first, then the PC's own.
const keys = () => [...new Set([...refineKeys(), process.env.GEMINI_API_KEY, ...String(process.env.GEMINI_API_KEYS || '').split(/[,;\s]+/)]
  .map(k => String(k || '').trim()).filter(Boolean))]

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
/**
 * The refined picture: { buf, by, width, height, note }.
 * `by` is 'gemini:<model>' or 'local' (Gemini could not: `note` says why).
 */
export async function refinePhoto(buf, field = 'Photo', { useGemini = true } = {}) {
  const why = []
  const ai = useGemini ? await geminiRetouch(buf, field, why) : null
  // No Gemini: the free local AI (enhance or cut-out) when this PC has the model and is strong enough, else only the cleaning.
  let cut = null
  // (The default is the enhance engine — sharper, cleaner, 4K, background kept; the white-background cut-out is the optional extra.)
  if (!ai) { try { const L = await import('./localCutout.js'); cut = (await L.localEnhance(buf, field)) || (await L.localCutout(buf, field)) } catch {} }
  const out = ai ? await finish(ai.buf, { clean: false }) : cut ? cut.buf : await finish(buf)
  const meta = await sharp(out).metadata()
  return { buf: out, by: ai ? `gemini:${ai.model}` : cut?.ok ? 'local:ai' : 'local', width: meta.width, height: meta.height, note: ai ? '' : why.join('; ') }
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
