// refine-photo — "Refine" (✨ on Photo / Full Body Photo) done in Adal's cloud, not on the agency's weak PC.
// POST /functions/v1/refine-photo?field=Photo|Full%20Body%20Photo, body = the picture (JPEG/PNG, ≤ 8 MB),
// Authorization: the agency's own Supabase sign-in (verify_jwt stays ON: only signed-in agencies).
// Answer: the retouched JPEG, with x-refine-model and x-refine-finished (1 = already 4K, 0 = the PC finishes it).
// Secrets (supabase secrets set): GEMINI_API_KEYS (comma separated), optional GEMINI_IMAGE_MODELS.
// Deploy: supabase functions deploy refine-photo --project-ref <ref>
// Nothing is stored here: the picture lives in this request only.
import { Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts'

const API = 'https://generativelanguage.googleapis.com/v1beta/models'
const MODELS = (Deno.env.get('GEMINI_IMAGE_MODELS') || 'gemini-3-pro-image,gemini-3.1-flash-image,gemini-2.5-flash-image').split(',').map(s => s.trim()).filter(Boolean)
const KEYS = (Deno.env.get('GEMINI_API_KEYS') || '').split(/[,;\s]+/).filter(Boolean)
const MAX_BYTES = 8 * 1024 * 1024
const LONG_SIDE = 3840

// Same words as the PC's own retouch (adal-keep-backend/src/services/photoRefine.js): identity before beauty.
const PORTRAIT = `PROFESSIONAL PORTRAIT ENHANCEMENT — NATURAL BEAUTY WITH IDENTITY PRESERVATION
Professionally enhance and retouch the provided photograph, making the girl look naturally beautiful, elegant, fresh and photogenic while preserving her original identity and recognizable appearance.
Absolute identity preservation: keep her facial structure, eyes, nose, lips, cheeks, eyebrows and distinguishing features; never replace her face or make her look like another person; do not change her apparent age or ethnic characteristics.
Gently improve clarity, skin evenness and brightness (keep her own skin tone, no excessive whitening, keep real skin texture), eye clarity, balanced soft lighting, remove blur, noise and compression artifacts, restore sharpness.
Preserve her clothing, hijab or head covering exactly (never add or remove one), her hair style and colour. No heavy makeup, nothing plastic or artificial.
She should look like the original girl on her very best day, photographed with an excellent camera — NOT like a different girl created by AI.`
const PROMPT: Record<string, string> = {
  'Photo': PORTRAIT + '\n\nKeep the same head position, framing and background layout. Return only the retouched photograph.',
  'Full Body Photo': PORTRAIT + '\n\nThis is a full-length photo: keep her same body, shape, pose and outfit, and her whole body from head to feet in the frame. Return only the retouched photograph.',
}

const b64 = (u8: Uint8Array) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s) }
const text = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } })

async function retouch(input: Uint8Array, field: string): Promise<{ data: Uint8Array; model: string } | { why: string }> {
  if (!KEYS.length) return { why: 'no Gemini key set in the cloud' }
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: PROMPT[field] }, { inline_data: { mime_type: 'image/jpeg', data: b64(input) } }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  })
  const why: string[] = []
  for (const model of MODELS) for (const key of KEYS) {
    try {
      const r = await fetch(`${API}/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(110_000) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { why.push(`${model}: ${r.status}`); if (r.status === 404 || r.status === 400) break; continue }
      const part = (j.candidates?.[0]?.content?.parts || []).find((p: any) => (p.inline_data || p.inlineData)?.data)
      const data = (part?.inline_data || part?.inlineData)?.data
      if (data) return { data: Uint8Array.from(atob(data), c => c.charCodeAt(0)), model }
      why.push(`${model}: no picture`); break
    } catch (e) { why.push(`${model}: ${(e as Error).name === 'TimeoutError' ? 'took too long' : (e as Error).message}`) }
  }
  return { why: why.join('; ') || 'Gemini gave nothing' }
}

// To 4K when the picture is small enough to do it inside the function's memory; else the PC finishes it.
async function to4k(jpeg: Uint8Array): Promise<{ data: Uint8Array; finished: boolean }> {
  try {
    const img = await Image.decode(jpeg)
    const long = Math.max(img.width, img.height)
    if (long >= LONG_SIDE) return { data: jpeg, finished: true }
    if (img.width * img.height > 6_000_000) return { data: jpeg, finished: false }
    const k = LONG_SIDE / long
    img.resize(Math.round(img.width * k), Math.round(img.height * k))
    return { data: await img.encodeJPEG(93), finished: true }
  } catch { return { data: jpeg, finished: false } }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return text(405, 'POST the picture')
  const field = new URL(req.url).searchParams.get('field') || 'Photo'
  if (!PROMPT[field]) return text(400, 'Only a Photo or Full Body Photo can be refined')
  const input = new Uint8Array(await req.arrayBuffer())
  if (!input.length) return text(400, 'No picture')
  if (input.length > MAX_BYTES) return text(413, 'Picture too big')
  const r = await retouch(input, field)
  if ('why' in r) return text(502, r.why)
  const out = await to4k(r.data)
  return new Response(out.data, { headers: { 'Content-Type': 'image/jpeg', 'x-refine-model': r.model, 'x-refine-finished': out.finished ? '1' : '0', 'Access-Control-Expose-Headers': 'x-refine-model,x-refine-finished' } })
})
