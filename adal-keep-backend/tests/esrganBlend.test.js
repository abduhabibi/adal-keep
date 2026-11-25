// The AI way (Real-ESRGAN blended in a little), with a STAND-IN for the network: onnxruntime and the model are not on this PC.
// What is real here: the blend, the limits, the fallback, the checksum guard, the no-download rule, the time limit, the route.
// What is stub only: the network's picture itself (a stand-in that enlarges the input, with a chosen fault).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import http from 'http'
import express from 'express'
import sharp from 'sharp'
import { portrait, degrade } from '../scripts/refine-lab.mjs'

const F = await import('../src/services/faithfulRefine.js')
const M = await import('../src/services/esrganModel.js')
const input = await degrade(await portrait(1280), { long: 640, q: 42 })

/** A stand-in network: x4 of the picture, with an optional fault (brightness shift `add`, tint). */
const stub = ({ add = 0, blur = 0.6 } = {}) => async (png) => {
  let s = sharp(png).resize({ width: (await sharp(png).metadata()).width * 4, kernel: 'lanczos3' }).blur(blur)
  if (add) s = s.linear(1, add)
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true })
  return { raw: data, w: info.width, h: info.height }
}

test('a harmless AI picture is blended in at 30 %, and the result still matches the input', async () => {
  const r = await F.refineFaithful(input, { size: '2k', engine: 'esrgan', upscale: stub() })
  assert.equal(r.engine, 'esrgan'); assert.equal(r.blend, 0.3)
  assert.ok(r.check.db >= F.LIMIT_DB && r.check.shift <= F.LIMIT_SHIFT, JSON.stringify(r.check))
  assert.equal(Math.max(r.width, r.height), 2048)
  assert.equal((await sharp(r.buf).metadata()).chromaSubsampling, '4:4:4')
})

test('over the limit the blend is lowered, then the plain way is used — never a brighter or tinted face', async () => {
  const mild = await F.refineFaithful(input, { size: 'original', engine: 'esrgan', upscale: stub({ add: 4 }) })
  assert.equal(mild.engine, 'esrgan'); assert.equal(mild.blend, 0.1)      // 30 % and 20 % moved the colours too far, 10 % did not
  assert.match(mild.note, /30%.*20%/)
  const bad = await F.refineFaithful(input, { size: 'original', engine: 'esrgan', upscale: stub({ add: 40 }) })
  assert.equal(bad.engine, 'plain'); assert.equal(bad.blend, 0); assert.match(bad.note, /plain way is used/)
  const plain = await F.refineFaithful(input, { size: 'original' })
  assert.deepEqual(bad.buf, plain.buf)                                       // the fallback IS the plain result
})

test('every failure falls back to the plain way with the reason', async () => {
  const boom = await F.refineFaithful(input, { engine: 'esrgan', upscale: async () => { throw new Error('out of memory') } })
  assert.equal(boom.engine, 'plain'); assert.match(boom.note, /out of memory/)
  const big = await F.refineFaithful(await sharp(await portrait(1600)).jpeg().toBuffer(), { engine: 'esrgan', upscale: stub() })
  assert.equal(big.engine, 'plain'); assert.match(big.note, /already 1600px/)
  delete process.env.ADAL_REFINE_ESRGAN
  const off = await F.refineFaithful(input, { engine: 'esrgan' })           // no stand-in: the real way needs its flag and the model
  assert.equal(off.engine, 'plain'); assert.match(off.note, /turned off/)
  process.env.ADAL_REFINE_ESRGAN = '1'
  try { const nomodel = await F.refineFaithful(input, { engine: 'esrgan' }); assert.match(nomodel.note, /model file is not in data\/models|checksum|bytes/) } finally { delete process.env.ADAL_REFINE_ESRGAN }
})

test('the model loads only with exactly the approved size and sha256; nothing is ever downloaded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-test-'))
  const good = Buffer.from('pretend model bytes'), file = path.join(dir, 'm.onnx')
  const sha = crypto.createHash('sha256').update(good).digest('hex')
  fs.writeFileSync(file, good)
  assert.equal(M.verifyModel(file, { bytes: good.length, sha256: sha }).ok, true)
  assert.match(M.verifyModel(file, { bytes: good.length + 1, sha256: sha }).reason, /bytes/)           // wrong size
  fs.writeFileSync(file, Buffer.from('pretend model bytez'))                                           // same size, other content
  assert.match(M.verifyModel(file, { bytes: good.length, sha256: sha }).reason, /checksum/)
  assert.match(M.verifyModel(path.join(dir, 'none.onnx')).reason, /not in data\/models/)
  assert.equal(M.MODEL_BYTES, 4866417); assert.equal(M.MODEL_SHA256, '1940a93ee08283a0a7286183186357b1688fe9fa8ede74604b424586aaddf112')
  const real = globalThis.fetch; let fetched = 0; globalThis.fetch = async () => { fetched++; throw new Error('no network') }
  try {
    const L = await import('../src/services/localCutout.js')
    assert.equal(await L.ensureSrModel({ file: path.join(dir, 'none.onnx') }), false)
    process.env.ADAL_LOCAL_ENHANCE = '1'
    assert.equal(await L.localEnhance(input, 'Photo', { file: path.join(dir, 'none.onnx'), strong: true }), null)
  } finally { globalThis.fetch = real; delete process.env.ADAL_LOCAL_ENHANCE }
  assert.equal(fetched, 0)
  assert.doesNotMatch(fs.readFileSync(new URL('../src/services/localCutout.js', import.meta.url), 'utf8'), /SR_MODEL_URL/)
})

test('the network runs in its own process and is stopped at the time limit', async () => {
  const t = Date.now()
  await assert.rejects(F.esrganUpscale(input, { model: '/nonexistent.onnx', timeoutMs: 20_000 }), /AI|model|onnx|Cannot|find/i)   // no runtime here: it ends with an error, not a hang
  assert.ok(Date.now() - t < 20_000)
  await assert.rejects(F.esrganUpscale(input, { model: '/nonexistent.onnx', timeoutMs: 1 }), /3 minutes|AI/)             // killed by the limit
  assert.equal(F.ESRGAN_TIMEOUT_MS, 180_000)
  assert.equal(fs.readdirSync(os.tmpdir()).filter(f => /^adal-sr-/.test(f)).length, 0)                                    // temporary files removed
})

test('the page: AI offered only with the flag and the exact model; the preview says how much AI went in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-route-'))
  const { default: router } = await import('../src/routes/refineCompare.js')
  const src = path.join(dir, 'o.jpg'); fs.writeFileSync(src, input)
  const db = { _f: [{ id: 1, profile_field_id: 1, original_name: 'o.jpg', path: src, mimetype: 'image/jpeg' }] }
  const table = (t) => ({ where: (k, v) => ({ first: async () => (t === 'files' ? db._f[0] : { id: 1, name: 'Photo' }) }) })
  const app = express(); app.use(express.json()); app.locals.db = table; app.locals.srUpscale = stub(); app.use('/api', router)
  const server = http.createServer(app).listen(0); const base = `http://127.0.0.1:${server.address().port}/api/photo-refine`
  try {
    assert.equal((await (await fetch(`${base}/status`)).json()).esrgan, false)       // flag off, no model
    const r = await (await fetch(`${base}/1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"size":"2k","engine":"esrgan"}' })).json()
    assert.equal(r.engine, 'esrgan'); assert.equal(r.blend, 0.3); assert.ok(r.check.db > 34)
    const p = await (await fetch(`${base}/1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"size":"2k"}' })).json()
    assert.equal(p.engine, 'plain')                                                    // the default stays the plain way
  } finally { server.close() }
})

test('a replaced picture is moved aside, not destroyed', async () => {
  const { keepReplaced } = await import('../src/services/keepOriginals.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-')), f = path.join(root, 'old.jpg'); fs.writeFileSync(f, 'old picture')
  const to = keepReplaced(f, { root })
  assert.equal(fs.existsSync(f), false); assert.equal(fs.readFileSync(to, 'utf8'), 'old picture'); assert.match(to, /replaced/)
  assert.equal(keepReplaced(path.join(root, 'nothing.jpg'), { root }), null)   // never throws
  process.env.ADAL_PHOTO_QUALITY = '0'
  try { const g = path.join(root, 'b.jpg'); fs.writeFileSync(g, 'x'); keepReplaced(g, { root }); assert.equal(fs.existsSync(g), false) } finally { delete process.env.ADAL_PHOTO_QUALITY }
})
