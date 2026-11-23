/**
 * cloudRefine.js — "Refine" in Adal's cloud (asked on 2026-11-23): the owner has no
 * server, so it runs as Netlify Functions (adal-refine/): the PC uploads the picture
 * (shrunk to 2048 px, ~1 MB) with its Supabase sign-in, the cloud retouches it with
 * Gemini and finishes it to 4K, and the PC polls for the result. Only refine moves:
 * CVs and every document stay on the PC. Offline, refused, too slow, or the flag off:
 * the same Refine as before on this PC (services/photoRefine.js).
 *
 * Flag: ADAL_CLOUD_REFINE=1 plus ADAL_REFINE_URL=https://<site>.netlify.app (off by default).
 */
import crypto from 'crypto'
import sharp from 'sharp'
import { refinePhoto } from './photoRefine.js'
import { chatConfigured, cloudToken } from './chatCloud.js'

export const cloudRefineOn = (env = process.env) => env.ADAL_CLOUD_REFINE === '1' && !!env.ADAL_REFINE_URL && chatConfigured()

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** One round trip with the cloud: upload, poll, the finished JPEG. Throws on anything but a picture. */
export async function cloudRound(db, small, field, { fetchFn = fetch, token = cloudToken, base = process.env.ADAL_REFINE_URL, pollMs = 3000, maxMs = 170_000 } = {}) {
  const root = String(base).replace(/\/+$/, '') + '/.netlify/functions'
  const auth = { Authorization: `Bearer ${await token(db)}`, apikey: String(process.env.SUPABASE_ANON_KEY || '') }
  const job = crypto.randomBytes(18).toString('base64url')
  const up = await fetchFn(`${root}/refine-start?job=${job}&field=${encodeURIComponent(field)}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/jpeg' }, body: small, signal: AbortSignal.timeout(60_000) })
  if (up.status !== 202) throw new Error(`cloud refused the upload (${up.status})`)
  const end = Date.now() + maxMs
  while (Date.now() < end) {
    await sleep(pollMs)
    const r = await fetchFn(`${root}/refine-status?job=${job}`, { headers: auth, signal: AbortSignal.timeout(30_000) })
    if (r.status === 202) continue
    if (r.status === 200) return { buf: Buffer.from(await r.arrayBuffer()), model: r.headers.get('x-refine-model') || 'gemini' }
    const j = await r.json().catch(() => ({}))
    throw new Error(j.error || `cloud answered ${r.status}`)
  }
  throw Object.assign(new Error('the cloud took too long'), { name: 'TimeoutError' })
}

/** Cloud first when the flag is on; any failure → this PC's own refine. Same result shape as refinePhoto. */
export async function refineSmart(db, buf, field, { round = cloudRound, local = refinePhoto, on = cloudRefineOn() } = {}) {
  if (!on) return local(buf, field)
  let why
  try {
    const small = await sharp(buf).rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()
    const got = await round(db, small, field)
    const meta = await sharp(got.buf).metadata()
    return { buf: got.buf, by: `cloud:${got.model}`, width: meta.width, height: meta.height, note: '' }
  } catch (e) { why = e.message }
  const r = await local(buf, field)
  return { ...r, note: [`cloud refine not used: ${why}`, r.note].filter(Boolean).join('; ') }
}
