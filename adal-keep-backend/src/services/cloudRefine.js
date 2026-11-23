/**
 * cloudRefine.js — "Refine" in Adal's cloud (asked on 2026-11-23): a weak agency
 * PC uploads the picture (shrunk to 2048 px, ~1 MB), the Supabase Edge Function
 * refine-photo (adal-admin/supabase/functions/refine-photo) retouches it, and the
 * result comes back. Only refine moves: CVs and every document stay on the PC.
 * Offline, refused, too slow, or the flag off: the same Refine as before on this PC
 * (services/photoRefine.js).
 *
 * Flag: ADAL_CLOUD_REFINE=1 (off by default).
 */
import sharp from 'sharp'
import { refinePhoto, finishLocal } from './photoRefine.js'
import { chatConfigured, cloudCall } from './chatCloud.js'

export const cloudRefineOn = (env = process.env) => env.ADAL_CLOUD_REFINE === '1' && chatConfigured()

/** Cloud first when the flag is on; any failure → this PC's own refine. Same result shape as refinePhoto. */
export async function refineSmart(db, buf, field, { call = cloudCall, local = refinePhoto, on = cloudRefineOn() } = {}) {
  if (!on) return local(buf, field)
  let why
  try {
    const small = await sharp(buf).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()
    const res = await call(db, 'POST', `/functions/v1/refine-photo?field=${encodeURIComponent(field)}`, small, {
      headers: { 'Content-Type': 'image/jpeg' }, raw: true, timeout: 150_000,
    })
    if (!res.ok) throw new Error(`cloud answered ${res.status}`)
    const got = Buffer.from(await res.arrayBuffer())
    if (!got.length) throw new Error('cloud sent nothing')
    const out = res.headers.get('x-refine-finished') === '1' ? got : await finishLocal(got, { clean: false })
    const meta = await sharp(out).metadata()
    return { buf: out, by: `cloud:${res.headers.get('x-refine-model') || 'gemini'}`, width: meta.width, height: meta.height, note: '' }
  } catch (e) { why = e.name === 'TimeoutError' ? 'the cloud took too long' : e.message }
  const r = await local(buf, field)
  return { ...r, note: [`cloud refine not used: ${why}`, r.note].filter(Boolean).join('; ') }
}
