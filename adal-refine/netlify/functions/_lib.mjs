// The Refine service's logic, with every outside thing (Supabase, the job store, Gemini, sharp) handed in,
// so the tests run it without Netlify. The three function files only wire the real ones in.
export const FIELDS = ['Photo', 'Full Body Photo']
export const MAX_BYTES = 8 * 1024 * 1024
export const DAILY_CAP = Number(process.env.REFINE_DAILY_CAP) || 150   // pictures per agency per day

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The signed-in agency, asked from Supabase itself (no secret shared): { id } or null. */
export async function whoIs(req, { fetchFn = fetch, env = process.env } = {}) {
  const auth = req.headers.get('authorization') || ''
  if (!/^Bearer\s+\S{20,}/.test(auth) || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null
  try {
    const r = await fetchFn(`${String(env.SUPABASE_URL).replace(/\/+$/, '')}/auth/v1/user`, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: auth }, signal: AbortSignal.timeout(8000) })
    if (!r.ok) return null
    const u = await r.json()
    return u?.id ? { id: String(u.id) } : null
  } catch { return null }
}

const JOB = /^[A-Za-z0-9_-]{16,64}$/
const today = () => new Date().toISOString().slice(0, 10)

/** POST ?job=<id>&field=Photo, body = the picture. Keeps it, asks the background function to work, answers 202. */
export async function start(req, { store, who, startBackground }) {
  if (req.method !== 'POST') return json(405, { error: 'POST the picture' })
  const user = await who(req)
  if (!user) return json(401, { error: 'Not signed in' })
  const q = new URL(req.url).searchParams
  const job = q.get('job') || '', field = q.get('field') || 'Photo'
  if (!JOB.test(job)) return json(400, { error: 'Bad job id' })
  if (!FIELDS.includes(field)) return json(400, { error: 'Only a Photo or Full Body Photo can be refined' })
  const buf = Buffer.from(await req.arrayBuffer())
  if (!buf.length) return json(400, { error: 'No picture' })
  if (buf.length > MAX_BYTES) return json(413, { error: 'Picture too big' })
  const capKey = `cap/${user.id}/${today()}`
  const used = Number(await store.get(capKey) || 0)
  if (used >= DAILY_CAP) return json(429, { error: 'Daily Refine limit reached' })
  await store.set(capKey, String(used + 1))
  await store.set(`in/${job}`, buf, { metadata: { user: user.id, field } })
  await store.set(`state/${job}`, JSON.stringify({ status: 'working', user: user.id, at: Date.now() }))
  await startBackground(job)
  return json(202, { job, status: 'working' })
}

/** The background work: read the picture, Gemini, finish to 4K, keep the result (or the reason). */
export async function work(job, { store, keys, gemini = null, finishFn = null }) {
  const st = JSON.parse(await store.get(`state/${job}`) || 'null')
  if (!st || st.status !== 'working') return
  const fail = (error) => store.set(`state/${job}`, JSON.stringify({ ...st, status: 'failed', error }))
  try {
    // (loaded here, so the tests of the rest need no sharp)
    if (!gemini || !finishFn) { const core = await import('./_refineCore.mjs'); gemini ||= core.tryModels; finishFn ||= core.finish }
    const input = Buffer.from(await store.get(`in/${job}`, { type: 'arrayBuffer' }))
    const meta = await store.getMetadata(`in/${job}`)
    const why = []
    const ai = keys.length ? await gemini(input, meta?.metadata?.field || 'Photo', keys, why) : null
    // No Gemini (no key, or Google's free plan edits no pictures): the same cleaning without it, here in the cloud.
    const out = ai ? await finishFn(ai.buf, { clean: false }) : await finishFn(input, { clean: true })
    const model = ai ? ai.model : 'clean-only'
    await store.set(`out/${job}`, out, { metadata: { model } })
    await store.set(`state/${job}`, JSON.stringify({ ...st, status: 'done', model, note: ai ? '' : (keys.length ? why.join('; ') : 'no Gemini key set') }))
  } catch (e) { await fail(e.message) } finally { try { await store.delete(`in/${job}`) } catch {} }
}

/** GET ?job=<id>: 202 working, 200 the picture (kept once), 502 the reason. */
export async function status(req, { store, who }) {
  const user = await who(req)
  if (!user) return json(401, { error: 'Not signed in' })
  const job = new URL(req.url).searchParams.get('job') || ''
  if (!JOB.test(job)) return json(400, { error: 'Bad job id' })
  const st = JSON.parse(await store.get(`state/${job}`) || 'null')
  if (!st || st.user !== user.id) return json(404, { error: 'No such job' })
  if (st.status === 'working') return json(Date.now() - st.at > 15 * 60e3 ? 504 : 202, { status: 'working' })
  if (st.status === 'failed') { await store.delete(`state/${job}`); return json(502, { error: st.error || 'Refine failed' }) }
  const out = await store.get(`out/${job}`, { type: 'arrayBuffer' })
  await store.delete(`out/${job}`); await store.delete(`state/${job}`)
  return new Response(out, { headers: { 'Content-Type': 'image/jpeg', 'x-refine-model': st.model || '', 'x-refine-note': String(st.note || '').slice(0, 200) } })
}
