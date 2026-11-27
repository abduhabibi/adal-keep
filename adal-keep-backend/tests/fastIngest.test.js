// ADAL_FAST_INGEST: the picture sent to Gemini is smaller (the file on disk is not touched), and a slow or dead line is not asked again
// at once. A mock Gemini of its own; the times and sizes are printed.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import sharp from 'sharp'

let server, base, hits = [], mode = 'ok'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fastingest-${process.pid}-`))
test.before(async () => {
  server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      hits.push({ url: req.url, bytes: Buffer.concat(chunks).length })
      if (mode === 'hang') return   // never answers
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ doc_type: 'passport', confidence: 0.9, fields: {} }) }] } }] }))
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}/v1beta/models`
  process.env.GEMINI_API_BASE = base
  process.env.GEMINI_API_KEY = 'test-key'
  process.env.GEMINI_TIMEOUT_MS = '600'
})
test.after(async () => { await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }) })

// A real-size scan: a 300 dpi A4 page of noise-like texture (what a phone or scanner makes: several MB).
async function scan() {
  const w = 2480, h = 3508, raw = Buffer.alloc(w * h * 3)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761 >>> 24) & 255
  const f = path.join(dir, 'scan.jpg')
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toFile(f)
  return f
}

test('the picture goes up smaller with it on, as big as the file with it off; the file is untouched', async () => {
  const { classifyWithGemini, _resetGeminiRests } = await import('../src/services/geminiClassifier.js')
  const f = await scan(), size = fs.statSync(f).size, before = fs.readFileSync(f)
  const sent = {}
  for (const on of ['1', '0']) {
    process.env.ADAL_FAST_INGEST = on; _resetGeminiRests(); hits = []; mode = 'ok'
    const r = await classifyWithGemini({ filePath: f, filename: 'scan.jpg', models: ['m1'] })
    assert.match(r.doc_type, /passport/i)
    sent[on] = hits[0].bytes
  }
  delete process.env.ADAL_FAST_INGEST
  const secs = (b) => (b * 8 / 4.5e6).toFixed(1)
  console.log(`scan ${(size / 1e6).toFixed(1)} MB on disk; sent with it off ${(sent['0'] / 1e6).toFixed(2)} MB (${secs(sent['0'])} s on a 4.5 Mbit/s Wi-Fi), on ${(sent['1'] / 1e6).toFixed(2)} MB (${secs(sent['1'])} s)`)
  assert.ok(sent['1'] < sent['0'] / 2)
  assert.ok(fs.readFileSync(f).equals(before), 'the stored file is not changed')
})

test('a model that gave no answer rests; the next ask does not wait for it again (off: it waits again)', async () => {
  const { classifyWithGemini, _resetGeminiRests } = await import('../src/services/geminiClassifier.js')
  const f = path.join(dir, 'small.png'); await sharp({ create: { width: 50, height: 50, channels: 3, background: '#fff' } }).png().toFile(f)
  const t = {}
  for (const on of ['1', '0']) {
    process.env.ADAL_FAST_INGEST = on; _resetGeminiRests(); mode = 'hang'
    const t0 = Date.now(); await assert.rejects(classifyWithGemini({ filePath: f, filename: 'a.png', models: ['slow'] }))
    const t1 = Date.now(); await assert.rejects(classifyWithGemini({ filePath: f, filename: 'b.png', models: ['slow'] }))
    t[on] = [t1 - t0, Date.now() - t1]
  }
  delete process.env.ADAL_FAST_INGEST; mode = 'ok'
  console.log(`no answer, 0.6 s timeout: first ask ${t['1'][0]} ms, second ask ${t['1'][1]} ms with it on, ${t['0'][1]} ms off`)
  assert.ok(t['0'][1] >= 500)
  assert.ok(t['1'][1] < 500)
})

test('no internet: the first ask fails once, the next fails at once (off: every model and attempt is tried)', async () => {
  const { classifyWithGemini, _resetGeminiRests } = await import('../src/services/geminiClassifier.js')
  const f = path.join(dir, 'small.png')
  const saved = process.env.GEMINI_API_BASE
  const t = {}
  // the module read GEMINI_API_BASE at load, so a dead line is made by closing the mock for this check
  await new Promise(r => server.close(r))
  for (const on of ['1']) {
    process.env.ADAL_FAST_INGEST = on; _resetGeminiRests()
    const t0 = Date.now(); await assert.rejects(classifyWithGemini({ filePath: f, filename: 'a.png', models: ['m1', 'm2'] }))
    const t1 = Date.now(); await assert.rejects(classifyWithGemini({ filePath: f, filename: 'b.png', models: ['m1', 'm2'] }))
    t[on] = [t1 - t0, Date.now() - t1]
  }
  delete process.env.ADAL_FAST_INGEST
  console.log(`no line: first ask ${t['1'][0]} ms, second ask ${t['1'][1]} ms (old: 2 models x 3 tries x 2-6 s sleeps = about 24 s each)`)
  assert.ok(t['1'][1] < 100)
  server = http.createServer(() => {}); await new Promise(r => server.listen(0, '127.0.0.1', r)); process.env.GEMINI_API_BASE = saved
})
