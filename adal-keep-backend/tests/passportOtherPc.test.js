// A Companion reads the passport in its own window: its reader files come from /tess, and its
// date-of-issue rules are the PC's (frontend lib/passportText.js = backend passportVisual.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import express from 'express'
import fs from 'fs'

const text = new URL('../../adal-keep-frontend/src/lib/passportText.js', import.meta.url)
const there = fs.existsSync(text)

test('/tess serves the four reader files and nothing else', async () => {
  const { default: router } = await import('../src/routes/tessFiles.js')
  const app = express(); app.use('/tess', router)
  const server = http.createServer(app).listen(0)
  const base = `http://127.0.0.1:${server.address().port}/tess`
  try {
    for (const f of ['worker.min.js', 'tesseract-core-simd-lstm.wasm.js', 'ocrb.traineddata', 'eng.traineddata']) {
      const r = await fetch(`${base}/${f}`)
      assert.equal(r.status, 200, f); assert.ok(r.headers.get('cache-control').includes('max-age')); await r.arrayBuffer()
    }
    for (const f of ['amh.traineddata', '..%2Fmain.js', '__proto__', 'constructor']) assert.equal((await fetch(`${base}/${f}`)).status, 404, f)
  } finally { server.close() }
})

test('the window and the PC take the same date of issue', { skip: !there && 'frontend not here' }, async () => {
  const W = await import(text)
  const V = await import('../src/services/passportVisual.js')
  const box = (y) => ({ x0: 400, y0: y, x1: 700, y1: y + 20 })
  const known = { date_of_birth: '1974-08-12', date_of_expiry: '2012-04-15' }
  const cases = [
    [{ text: 'Date of Issue', bbox: box(100) }, { text: '16 APR 2007', bbox: box(130) }],
    [{ text: 'Date of Issue', bbox: box(100) }, { text: '16 APR 2009', bbox: box(130) }],
    [{ text: '16 APR 2007', bbox: box(10) }, { text: '01 JAN 2003', bbox: box(50) }],
    [{ text: 'Date of Issue 16 APR 2007', bbox: box(10) }],
  ]
  for (const lines of cases) assert.equal(W.issueFromLines(lines, known), V.issueFromLines(lines, known))
  assert.equal(W.issueFromLines(cases[0], known), '2007-04-16')
  assert.equal(W.issueFromLines(cases[1], known), '')
  assert.deepEqual(W.datesIn('16 APR 2007 03/10/2024'), V.datesIn('16 APR 2007 03/10/2024'))
})
