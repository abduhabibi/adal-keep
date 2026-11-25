// The passport scan: the bottom lines read on this PC, quickly, in order, never guessed.
// Made-up pages only (tests/fixtures/sample-passport.jpg, the ICAO specimen); no network, no keys.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import sharp from 'sharp'

for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'JEV_API_KEY', 'TYPESAFE_API_KEY']) delete process.env[k]
const SAMPLE = new URL('./fixtures/sample-passport.jpg', import.meta.url).pathname
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'))
const { quickMrz, warmMrzReader, stopMrzReader } = await import('../src/services/quickMrz.js')
const { scan } = await import('../src/services/passportScan.js')
after(async () => { await stopMrzReader(); fs.rmSync(dir, { recursive: true, force: true }) })

test('an upright and an upside-down page both verify, the steps are reported in order', async () => {
  await warmMrzReader()
  const up = await quickMrz(SAMPLE)
  assert.equal(up.fields.passport_number, 'L898902C3')
  assert.equal(up.fields.date_of_birth, '1974-08-12')
  const flipped = path.join(dir, 'flipped.jpg')
  await sharp(SAMPLE).rotate(180).resize({ width: 2000 }).toFile(flipped)
  const steps = []
  const down = await quickMrz(flipped, { onStep: (s) => steps.push(s) })
  assert.equal(down?.fields.passport_number, 'L898902C3')
  assert.equal(steps[0], 'reading'); assert.ok(steps.includes('checking'))
})

test('a page with no passport lines is not read as a passport, and the deadline stops it', async () => {
  const blank = path.join(dir, 'blank.png')
  await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#ddd' } }).png().toFile(blank)
  assert.equal(await quickMrz(blank), null)
})

test('scans take their turn: the second answers after the first', async () => {
  const order = []
  const a = scan(SAMPLE).then(r => { order.push('a'); return r })
  const b = scan(SAMPLE).then(r => { order.push('b'); return r })
  const [ra, rb] = await Promise.all([a, b])
  assert.deepEqual(order, ['a', 'b'])
  assert.equal(ra.fields.passport_number, 'L898902C3'); assert.equal(rb.source, 'mrz-ocrb')
  assert.equal(typeof ra.placeLater?.then, 'function')   // the place follows behind, it is not waited for
})

test('POST /new-profile/read answers a verified passport at once, without waiting for the place', async () => {
  const { default: router } = await import('../src/routes/newProfile.js')
  const app = express()
  app.locals.db = () => ({ where: () => ({ first: async () => null }) })
  app.use('/api', router)
  const server = http.createServer(app).listen(0)
  try {
    const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(SAMPLE)], { type: 'image/jpeg' }), 'p.jpg')
    const t = Date.now()
    const r = await (await fetch(`http://127.0.0.1:${server.address().port}/api/new-profile/read`, { method: 'POST', body: fd })).json()
    assert.equal(r.verified, true); assert.equal(r.fields.passport_number, 'L898902C3')
    assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`)
    assert.equal(r.pending, undefined)
    const gone = await fetch(`http://127.0.0.1:${server.address().port}/api/new-profile/result/nothing`)
    assert.equal(gone.status, 404)
  } finally { server.close() }
})

test('a slow scan answers "pending" with its step, then the page asks for it', async () => {
  const { default: router } = await import('../src/routes/newProfile.js')
  const app = express()
  app.locals.db = () => ({ where: () => ({ first: async () => null }) })
  app.use('/api', router)
  const server = http.createServer(app).listen(0)
  process.env.SCAN_FIRST_MS = '1'
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`
    const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(SAMPLE)], { type: 'image/jpeg' }), 'p.jpg')
    let r = await (await fetch(`${base}/new-profile/read`, { method: 'POST', body: fd })).json()
    assert.equal(r.pending, true, JSON.stringify(r)); assert.ok(r.upload); assert.ok(r.step_text)
    for (let i = 0; r.pending && i < 40; i++) { await new Promise(x => setTimeout(x, 250)); r = await (await fetch(`${base}/new-profile/result/${r.upload}`)).json() }
    assert.equal(r.verified, true); assert.equal(r.fields.passport_number, 'L898902C3')
  } finally { delete process.env.SCAN_FIRST_MS; server.close() }
})
