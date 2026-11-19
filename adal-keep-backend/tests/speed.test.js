// The quick paths (docs/speed.md): the passport's bottom lines read at once,
// its place of birth behind; the CV's full-body box found once on the PC.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import sharp from 'sharp'

const sample = new URL('./fixtures/sample-passport.jpg', import.meta.url).pathname
const model = new URL('../ocrb.traineddata', import.meta.url).pathname
// The OCR reader is let go at the end (it would keep the test running for minutes).
test.after(async () => { const { stopMrzReader } = await import('../src/services/quickMrz.js'); await stopMrzReader() })

test('the sample passport is read from its bottom lines, also upside down', { skip: !fs.existsSync(model) && 'no OCR-B model' }, async () => {
  const { quickMrz } = await import('../src/services/quickMrz.js')
  const r = await quickMrz(sample, { tries: 1 })
  assert.equal(r?.fields?.passport_number, 'L898902C3')
  assert.equal(r.fields.date_of_birth, '1974-08-12')
  const up = await sharp(sample).rotate(180).jpeg().toBuffer()
  const tmp = `${process.env.TMPDIR || '/tmp'}/adal-speed-up-${process.pid}.jpg`
  fs.writeFileSync(tmp, up)
  try { assert.equal((await quickMrz(tmp))?.fields?.passport_number, 'L898902C3') } finally { fs.rmSync(tmp, { force: true }) }
})

test('placeLater: the passport answers at once, its place comes in a promise', { skip: !fs.existsSync(model) && 'no OCR-B model' }, async () => {
  const keep = process.env.GEMINI_API_KEY
  delete process.env.GEMINI_API_KEY
  try {
    const { analyzeWithMineru } = await import('../src/services/mineruClassifier.js')
    const r = await analyzeWithMineru(sample, { placeLater: true })
    assert.equal(r.doc_type, 'Passport')
    assert.ok(r.placeLater instanceof Promise)
    assert.equal(typeof (await r.placeLater), 'object')
  } finally { if (keep !== undefined) process.env.GEMINI_API_KEY = keep }
})

test('the full-body box is found on the PC and put on the picture', async () => {
  const { bodyBoxOf, mergeTemplate } = await import('../src/services/cvRender.js')
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="100%" height="100%" fill="#e8e2d6"/><rect x="250" y="80" width="100" height="650" fill="#22303f"/></svg>')
  const uri = 'data:image/jpeg;base64,' + (await sharp(svg).jpeg().toBuffer()).toString('base64')
  const box = await bodyBoxOf(uri)
  const [x0, y0, x1, y1, w, h] = box.split(',').map(Number)
  assert.equal(w, 600); assert.equal(h, 800)
  assert.ok(x0 <= 250 && x0 > 200 && x1 >= 350 && x1 < 400, box)
  assert.ok(y0 <= 80 && y1 >= 700, box)
  const html = mergeTemplate('<body><img src="{{FULL_BODY_PHOTO_URL}}"></body>', '', { FULL_BODY_PHOTO_URL: uri, FULL_BODY_BOX: box })
  assert.match(html, new RegExp(`data-adal-body="1" data-adal-box="${box}"`))
  // Nothing odd goes into the page.
  assert.doesNotMatch(mergeTemplate('<body><img src="{{FULL_BODY_PHOTO_URL}}"></body>', '', { FULL_BODY_PHOTO_URL: uri, FULL_BODY_BOX: '"><script>' }), /data-adal-box="/)
})
