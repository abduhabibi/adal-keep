/**
 * pictures.test.js — the small copies of pictures (thumbnails, CV pictures): made once,
 * kept, few at a time, gone with the document (a weak PC was stuck on each photo and preview, 2026-11-25).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-pics-'))
process.env.ADAL_PIC_CACHE = path.join(TMP, 'cache')
const { smallCopy, thumbnailFile, forgetPictures, inLine, pdfFirstPagePng, LANES } = await import('../src/services/pictures.js')
const sharp = (await import('sharp')).default
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }))

const kept = () => { try { return fs.readdirSync(process.env.ADAL_PIC_CACHE).filter(n => !n.endsWith('.tmp')) } catch { return [] } }
async function photo(name, w = 900, h = 1200, kind = 'png') {
  const file = path.join(TMP, name)
  const noise = randomBytes(w * h * 3)   // (a pattern packs under the 60 KB that is its own thumbnail)
  await sharp(noise, { raw: { width: w, height: h, channels: 3 } })[kind]().toFile(file)
  return file
}

test('asked for twice at once: made once, then read from disk', async () => {
  const a = await photo('one.png')
  let made = 0
  const make = async () => { made++; await new Promise(r => setTimeout(r, 30)); return Buffer.from('small') }
  const [x, y] = await Promise.all([smallCopy(a, 't', 'img', make), smallCopy(a, 't', 'img', make)])
  assert.equal(made, 1); assert.equal(x.buf.toString(), 'small'); assert.equal(y.buf.toString(), 'small')
  const z = await smallCopy(a, 't', 'img', make)
  assert.equal(made, 1); assert.equal(z.kept, true)
  assert.equal((await smallCopy(a, 'other settings', 'img', make)).kept, false); assert.equal(made, 2)
})

test('a changed picture is made again; one that cannot be made is not kept', async () => {
  const a = await photo('two.png')
  let made = 0
  const make = async () => { made++; return Buffer.from('v' + made) }
  await smallCopy(a, 't', 'img', make)
  fs.utimesSync(a, new Date(), new Date(Date.now() + 5000))
  assert.equal((await smallCopy(a, 't', 'img', make)).buf.toString(), 'v2')
  const before = kept().length
  await assert.rejects(smallCopy(a, 'bad', 'img', async () => { throw new Error('damaged') }), /damaged/)
  assert.equal(kept().length, before)
  assert.equal((await smallCopy(a, 'bad', 'img', make)).buf.toString(), 'v3')   // the next try is a fresh one
})

test('never more at once than the lanes; a thumbnail goes before the CV pictures waiting', async () => {
  let now = 0, most = 0
  const order = []
  const job = (n) => async () => { now++; most = Math.max(most, now); await new Promise(r => setTimeout(r, 15)); now--; order.push(n) }
  const all = [...Array(5)].map((_, i) => inLine(job('cv' + i)))
  all.push(inLine(job('thumb'), { first: true }))
  await Promise.all(all)
  assert.ok(most <= LANES, `${most} at once`)
  assert.ok(order.indexOf('thumb') <= LANES, order.join(' '))
})

test('a big photo gets a small square thumbnail, turned the right way; a small file is its own', async () => {
  const a = await photo('big.png')
  const t = await thumbnailFile(a, 'image/png', 20000)
  const m = await sharp(t).metadata()
  assert.equal(m.width, 400); assert.equal(m.height, 400)
  assert.ok(fs.statSync(t).size < fs.statSync(a).size / 4)
  const side = path.join(TMP, 'side.jpg')   // lying on its side (EXIF 6), red on the left → on top when turned
  const red = await sharp({ create: { width: 1200, height: 900, channels: 3, background: 'blue' } })
    .composite([{ input: { create: { width: 600, height: 900, channels: 3, background: 'red' } }, left: 0, top: 0 }]).png().toBuffer()
  await sharp(red).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toFile(side)
  if (fs.statSync(side).size < 60 * 1024) fs.appendFileSync(side, Buffer.alloc(70 * 1024))
  const { data, info } = await sharp(await thumbnailFile(side, 'image/jpeg', 20000)).raw().toBuffer({ resolveWithObject: true })
  const px = (x, y) => [...data.subarray((y * info.width + x) * info.channels).subarray(0, 3)]
  assert.ok(px(200, 20)[0] > 180 && px(200, 20)[2] < 80, 'top is red'); assert.ok(px(200, 380)[2] > 180, 'bottom is blue')
  const little = path.join(TMP, 'little.png')
  await sharp({ create: { width: 40, height: 40, channels: 3, background: 'red' } }).png().toFile(little)
  assert.equal(await thumbnailFile(little, 'image/png'), null)
  fs.writeFileSync(path.join(TMP, 'doc.pdf'), Buffer.alloc(90000))
  assert.equal(await thumbnailFile(path.join(TMP, 'doc.pdf'), 'application/pdf'), null)
  fs.writeFileSync(path.join(TMP, 'broken.jpg'), Buffer.alloc(90000))
  assert.equal(await thumbnailFile(path.join(TMP, 'broken.jpg'), 'image/jpeg', 5000), null)
  assert.equal(await thumbnailFile(path.join(TMP, 'gone.jpg'), 'image/jpeg'), null)
})

test('not ready in time: the page is answered, and it is there next time', async () => {
  const a = await photo('slow.png')
  let free
  const holds = [...Array(LANES)].map(() => inLine(() => new Promise(r => { const f = free; free = () => { f?.(); r() } })))
  const t0 = Date.now()
  assert.equal(await thumbnailFile(a, 'image/png', 100), null)
  assert.ok(Date.now() - t0 < 600)
  free(); await Promise.all(holds)
  // Made by itself a moment later (the pictures before it were in the way).
  for (let i = 0; i < 60 && !kept().some(n => n.endsWith('.webp')); i++) await new Promise(r => setTimeout(r, 50))
  assert.ok(await thumbnailFile(a, 'image/png', 20000))
})

test('a deleted document takes its small copies with it, also one being made', async () => {
  const a = await photo('erase.png'), b = await photo('stays.png')
  await thumbnailFile(a, 'image/png', 20000); await thumbnailFile(b, 'image/png', 20000)
  await smallCopy(a, 'cv', 'img', async () => Buffer.from('x'))
  const n = kept().length
  forgetPictures('uploads/7/8/erase.png')   // as the record names it, whatever folder it is in
  assert.equal(kept().length, n - 2)
  assert.ok(await thumbnailFile(b, 'image/png', 20000))
  const before = kept().length
  await smallCopy(a, 'late', 'img', async () => { fs.rmSync(a); return Buffer.from('x') })
  assert.equal(kept().length, before)
})

test('a PDF page is drawn off the main thread; a damaged PDF says so and the next one works', async () => {
  const imageToPdf = (await import('image-to-pdf')).default
  const img = await photo('page.png', 600, 800, 'png'), pdf = path.join(TMP, 'page.pdf')
  await new Promise((ok, no) => imageToPdf([img]).pipe(fs.createWriteStream(pdf)).on('finish', ok).on('error', no))
  fs.writeFileSync(path.join(TMP, 'bad.pdf'), 'not a pdf')
  let most = 0, last = performance.now()
  const beat = setInterval(() => { const n = performance.now(); most = Math.max(most, n - last); last = n }, 5)
  await assert.rejects(pdfFirstPagePng(path.join(TMP, 'bad.pdf')))
  const png = await pdfFirstPagePng(pdf)
  clearInterval(beat)
  const m = await sharp(png).metadata()
  assert.ok(m.width > 500 && m.format === 'png')
  assert.ok(most < 400, `the main thread stood still ${Math.round(most)} ms`)
})
