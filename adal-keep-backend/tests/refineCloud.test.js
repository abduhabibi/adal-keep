// Cloud Refine (Netlify Functions in adal-refine/) and the PC's fallback (2026-11-23).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import sharp from 'sharp'

process.env.ADAL_NO_NET_PROBE = '1'
const L = await import('../../adal-refine/netlify/functions/_lib.mjs')
const { refineSmart, cloudRound } = await import('../src/services/cloudRefine.js')

const photo = () => sharp({ create: { width: 300, height: 400, channels: 3, background: '#b08060' } }).jpeg().toBuffer()

test('the cloud copy of the picture work is the same file as the PC\'s', () => {
  assert.equal(fs.readFileSync(new URL('../../adal-refine/netlify/functions/_refineCore.mjs', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../src/services/refineCore.js', import.meta.url), 'utf8'), 'run: npm run sync-core in adal-refine')
})

// A store like Netlify Blobs, in memory.
const memStore = () => {
  const m = new Map()
  return {
    m,
    async get(k, o) { const v = m.get(k)?.v; if (v == null) return null; return o?.type === 'arrayBuffer' ? new Uint8Array(v).buffer : (Buffer.isBuffer(v) ? v : String(v)) },
    async getMetadata(k) { return m.get(k) ? { metadata: m.get(k).meta } : null },
    async set(k, v, o) { m.set(k, { v, meta: o?.metadata }) },
    async delete(k) { m.delete(k) },
  }
}
const req = (url, init = {}) => new Request(`https://x.netlify.app${url}`, { ...init, headers: { authorization: 'Bearer ' + 'a'.repeat(30), ...(init.headers || {}) } })

test('the cloud: upload → work → result, one agency only, kept once', async () => {
  const store = memStore(), who = async () => ({ id: 'ag1' })
  let started
  const body = await photo()
  const r1 = await L.start(req('/f/start?job=job_aaaaaaaaaaaaaaaaaaaa&field=Photo', { method: 'POST', body }), { store, who, startBackground: async j => { started = j } })
  assert.equal(r1.status, 202); assert.equal(started, 'job_aaaaaaaaaaaaaaaaaaaa')
  const s0 = await L.status(req('/f/status?job=job_aaaaaaaaaaaaaaaaaaaa'), { store, who })
  assert.equal(s0.status, 202)
  const fin = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#c09070' } }).jpeg().toBuffer()
  await L.work('job_aaaaaaaaaaaaaaaaaaaa', { store, engine: 'gemini', keys: ['k'], gemini: async () => ({ buf: fin, model: 'm1' }), finishFn: async b => b })
  assert.equal(await store.get('in/job_aaaaaaaaaaaaaaaaaaaa'), null, 'the original is not kept')
  const other = await L.status(req('/f/status?job=job_aaaaaaaaaaaaaaaaaaaa'), { store, who: async () => ({ id: 'ag2' }) })
  assert.equal(other.status, 404)
  const done = await L.status(req('/f/status?job=job_aaaaaaaaaaaaaaaaaaaa'), { store, who })
  assert.equal(done.status, 200); assert.equal(done.headers.get('x-refine-model'), 'm1'); assert.equal((await done.arrayBuffer()).byteLength, fin.length)
  assert.equal((await L.status(req('/f/status?job=job_aaaaaaaaaaaaaaaaaaaa'), { store, who })).status, 404)
})

test('the cloud: signed-out, wrong field, too big, daily cap, Gemini failure', async () => {
  const store = memStore(), bg = async () => {}
  assert.equal((await L.start(req('/f/s?job=job_aaaaaaaaaaaaaaaaaaaa', { method: 'POST', body: 'x' }), { store, who: async () => null, startBackground: bg })).status, 401)
  const who = async () => ({ id: 'ag1' })
  assert.equal((await L.start(req('/f/s?job=job_aaaaaaaaaaaaaaaaaaaa&field=Passport', { method: 'POST', body: 'x' }), { store, who, startBackground: bg })).status, 400)
  await store.set(`cap/ag1/${new Date().toISOString().slice(0, 10)}`, String(L.DAILY_CAP))
  assert.equal((await L.start(req('/f/s?job=job_aaaaaaaaaaaaaaaaaaaa', { method: 'POST', body: 'x' }), { store, who, startBackground: bg })).status, 429)
  const s2 = memStore()
  await L.start(req('/f/s?job=job_bbbbbbbbbbbbbbbbbbbb', { method: 'POST', body: await photo() }), { store: s2, who, startBackground: bg })
  await L.work('job_bbbbbbbbbbbbbbbbbbbb', { store: s2, engine: 'gemini', keys: ['k'], gemini: async (b, f, k, why) => { why.push('m: 429'); return null }, finishFn: async b => b })
  const f = await L.status(req('/f/s?job=job_bbbbbbbbbbbbbbbbbbbb'), { store: s2, who })
  assert.equal(f.status, 200); assert.equal(f.headers.get('x-refine-model'), 'clean-only'); assert.match(f.headers.get('x-refine-note'), /429/)
  // a crash in the work is reported, not lost
  const s3 = memStore()
  await L.start(req('/f/s?job=job_cccccccccccccccccccc', { method: 'POST', body: await photo() }), { store: s3, who, startBackground: bg })
  await L.work('job_cccccccccccccccccccc', { store: s3, engine: 'gemini', keys: ['k'], gemini: async () => { throw new Error('boom') }, finishFn: async b => b })
  assert.equal((await L.status(req('/f/s?job=job_cccccccccccccccccccc'), { store: s3, who })).status, 502)
})

test('who is signed in is asked from Supabase', async () => {
  const env = { SUPABASE_URL: 'https://s.supabase.co/', SUPABASE_ANON_KEY: 'anon' }
  const ok = await L.whoIs(req('/x'), { env, fetchFn: async (u, o) => { assert.equal(u, 'https://s.supabase.co/auth/v1/user'); return new Response(JSON.stringify({ id: 'u1' })) } })
  assert.deepEqual(ok, { id: 'u1' })
  assert.equal(await L.whoIs(req('/x'), { env, fetchFn: async () => new Response('no', { status: 401 }) }), null)
  assert.equal(await L.whoIs(new Request('https://x/x'), { env }), null)
})

test('the PC: polls the cloud, and falls back on every failure', async () => {
  const seen = []
  const fetchFn = async (u, o) => {
    seen.push(u.replace(/job=[^&]+/, 'job=J'))
    if (/refine-start/.test(u)) return new Response('{}', { status: 202 })
    return seen.length < 4 ? new Response('{}', { status: 202 }) : new Response(await photo(), { headers: { 'x-refine-model': 'm9' } })
  }
  const got = await cloudRound(null, await photo(), 'Photo', { fetchFn, token: async () => 't', base: 'https://s.netlify.app/', pollMs: 1 })
  assert.equal(got.model, 'm9'); assert.match(seen[0], /^https:\/\/s\.netlify\.app\/\.netlify\/functions\/refine-start\?job=J&field=Photo$/)
  const mine = { buf: Buffer.from('x'), by: 'local', width: 1, height: 1, note: '' }
  const local = async () => ({ ...mine })
  const r1 = await refineSmart(null, await photo(), 'Photo', { round: async () => { throw new Error('fetch failed') }, local, on: true })
  assert.equal(r1.by, 'local'); assert.match(r1.note, /cloud refine not used: fetch failed/)
  const r2 = await refineSmart(null, await photo(), 'Photo', { round: async () => ({ buf: await photo(), model: 'm' }), local, on: true })
  assert.equal(r2.by, 'cloud:m')
  assert.equal((await refineSmart(null, await photo(), 'Photo', { round: async () => { throw new Error('no') }, local, on: false })).note, '')
})

test('the cloud engine is the cut-out by default; a failed cut-out still gives a cleaned picture', async () => {
  const who = async () => ({ id: 'ag1' }), bg = async () => {}
  const fin = await photo()
  const s1 = memStore()
  await L.start(req('/f/s?job=job_dddddddddddddddddddd&field=Full%20Body%20Photo', { method: 'POST', body: await photo() }), { store: s1, who, startBackground: bg })
  let sawField
  await L.work('job_dddddddddddddddddddd', { store: s1, cutout: async (b, f, o) => { sawField = f; assert.equal(o.modelPath, '/m.onnx'); return { buf: fin, ok: true, note: '' } }, finishFn: async b => b, modelPath: '/m.onnx' })
  assert.equal(sawField, 'Full Body Photo')
  assert.equal((await L.status(req('/f/s?job=job_dddddddddddddddddddd'), { store: s1, who })).headers.get('x-refine-model'), 'cutout')
  const s2 = memStore()
  await L.start(req('/f/s?job=job_eeeeeeeeeeeeeeeeeeee', { method: 'POST', body: await photo() }), { store: s2, who, startBackground: bg })
  await L.work('job_eeeeeeeeeeeeeeeeeeee', { store: s2, cutout: async () => { throw new Error('no model') }, finishFn: async b => b })
  const r = await L.status(req('/f/s?job=job_eeeeeeeeeeeeeeeeeeee'), { store: s2, who })
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-refine-model'), 'clean-only'); assert.match(r.headers.get('x-refine-note'), /no model/)
})

test('framing: a Photo is 3:4 around head and shoulders, a Full Body Photo 2:3 around all of her', async () => {
  const C = await import('../src/services/refineCore.js')
  const box = { x0: 300, x1: 600, y0: 200, y1: 1100 }
  const p = C.framing(box, 900, 1200, 'Photo'), f = C.framing(box, 900, 1200, 'Full Body Photo')
  assert.ok(Math.abs(p.width / p.height - 0.75) < 0.01); assert.ok(Math.abs(f.width / f.height - 2 / 3) < 0.01)
  assert.ok(p.left <= box.x0 && p.left + p.width >= box.x1 && p.top <= box.y0, 'nothing of her is cut')
  const wide = C.framing({ x0: 0, x1: 899, y0: 100, y1: 300 }, 900, 400, 'Photo')   // wide arms: the frame widens, never cuts
  assert.ok(wide.width >= 900)
  const mask = Buffer.alloc(10 * 10); for (let y = 2; y < 8; y++) for (let x = 3; x < 7; x++) mask[y * 10 + x] = 255
  const b = C.personBox({ alpha: mask, w: 10, h: 10 })
  assert.deepEqual([b.x0, b.x1, b.y0, b.y1, b.share], [3, 6, 2, 7, 0.24])
})

test('the PC cut-out is off without its flag and never throws without the model', async () => {
  const M = await import('../src/services/localCutout.js')
  delete process.env.ADAL_LOCAL_CUTOUT
  assert.equal(await M.localCutout(await photo(), 'Photo'), null)
  process.env.ADAL_LOCAL_CUTOUT = '1'
  const got = await M.localCutout(await photo(), 'Photo', { file: '/nonexistent/silueta.onnx', fetchFn: async () => new Response('x', { status: 404 }) })
  assert.equal(got, null); delete process.env.ADAL_LOCAL_CUTOUT
  assert.equal(await M.ensureModel({ file: '/tmp/none/x.onnx', fetchFn: async () => new Response('x', { status: 404 }) }), false)
})
