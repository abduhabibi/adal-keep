// Pictures keep their quality: the faithful Refine (no change of her look, before/after, original kept),
// the CV's full-quality level and the JPEG already stored going in untouched. Made-up portraits only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import knex from 'knex'
import sharp from 'sharp'
import { portrait, degrade, psnr, meanRGB } from '../scripts/refine-lab.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-test-'))
const truth = await portrait(1280)
const input = await degrade(truth, { long: 640, q: 42 })

test('faithful refine: her look does not change, nothing shrinks, the choice is the size', async () => {
  const { refineFaithful } = await import('../src/services/faithfulRefine.js')
  const same = await refineFaithful(input, { size: 'original' })
  assert.deepEqual([same.width, same.height], [same.from.width, same.from.height]); assert.equal(same.scale, 1)
  const two = await refineFaithful(input, { size: '2k' })
  assert.equal(Math.max(two.width, two.height), 2048)
  const four = await refineFaithful(input, { size: '4k' })
  assert.equal(Math.max(four.width, four.height), 3840)
  // already bigger than the choice: not enlarged, never made smaller
  const big = await refineFaithful(await sharp(truth).resize({ width: 1800 }).jpeg().toBuffer(), { size: '2k' })
  assert.ok(Math.max(big.width, big.height) >= 2048 || big.scale === 1)
  const inM = await meanRGB(input)
  for (const r of [same, two]) {
    const m = await meanRGB(r.buf)
    assert.ok(Math.max(...m.map((v, i) => Math.abs(v - inM[i]))) < 1.5, 'mean colour moved: lighter, darker or tinted')
    const back = await sharp(r.buf).resize({ width: r.from.width, height: r.from.height, fit: 'fill' }).png().toBuffer()
    assert.ok(await psnr(back, input, r.from.width, r.from.height) > 33, 'shrunk back it is no longer the same picture')
  }
  const meta = await sharp(two.buf).metadata()
  assert.equal(meta.format, 'jpeg'); assert.equal(meta.chromaSubsampling, '4:4:4')
})

test('the old finish() did change her look (the reason for the new one)', async () => {
  const { finish } = await import('../src/services/refineCore.js')
  const old = await finish(input), inM = await meanRGB(input), m = await meanRGB(old)
  assert.ok(Math.max(...m.map((v, i) => Math.abs(v - inM[i]))) > 3)
})

test('the cloud prompt no longer asks for lighter skin or beautifying', async () => {
  const { PROMPT } = await import('../src/services/refineCore.js')
  const text = PROMPT.Photo
  assert.doesNotMatch(text, /slightly lighter|brighter|naturally beautiful|skin brightening|radiant/i)
  assert.match(text, /Do not lighten/i); assert.match(text, /return the picture unchanged/i)
})

test('the CV level is full quality; ADAL_PHOTO_QUALITY=0 brings the old levels back', async () => {
  const PQ = await import('../src/services/photoQuality.js')
  const OLD = [{ scale: 0.8, q: 70, palette: true }, { scale: 0.36, q: 46, palette: true }]
  assert.deepEqual(PQ.level(OLD, 3), PQ.FULL)   // never a smaller level because of file size
  assert.equal(PQ.FULL.q, 95); assert.equal(Math.round(600 * PQ.FULL.scale), 1200)
  assert.equal(PQ.jpegOptions(95).chromaSubsampling, '4:4:4'); assert.equal(PQ.jpegOptions(70).chromaSubsampling, '4:2:0')
  process.env.ADAL_PHOTO_QUALITY = '0'
  try { assert.deepEqual(PQ.level(OLD, 1), OLD[1]) } finally { delete process.env.ADAL_PHOTO_QUALITY }
})

test('a stored JPEG that fits goes into the CV as it is; a bigger one is re-encoded at q95 4:4:4 and not enlarged', async () => {
  const { _imageDataUri: img } = await import('../src/services/cvRender.js')
  const fits = path.join(dir, 'fits.jpg'); fs.writeFileSync(fits, input)
  const uri = await img(fits, 'image/jpeg', 1200, { quality: 95 })
  assert.equal(uri, 'data:image/jpeg;base64,' + input.toString('base64'))
  const bigFile = path.join(dir, 'big.jpg'); fs.writeFileSync(bigFile, await sharp(truth).resize({ width: 2400 }).jpeg({ quality: 90 }).toBuffer())
  const re = Buffer.from((await img(bigFile, 'image/jpeg', 1200, { quality: 95 })).split(',')[1], 'base64')
  const m = await sharp(re).metadata()
  assert.equal(Math.max(m.width, m.height), 1200); assert.equal(m.chromaSubsampling, '4:4:4')
  const small = path.join(dir, 'small.png'); fs.writeFileSync(small, await sharp({ create: { width: 300, height: 400, channels: 3, background: '#a87' } }).png().toBuffer())
  const tiny = Buffer.from((await img(small, 'image/png', 1200, { quality: 95 })).split(',')[1], 'base64')
  assert.equal((await sharp(tiny).metadata()).width, 300)   // not enlarged
})

test('the page: preview (original stays) then keep → the refined picture is the newest file', async () => {
  const cwd = process.cwd(); const work = fs.mkdtempSync(path.join(dir, 'cwd-')); process.chdir(work)
  try {
    const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name') })
    await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('original_name'); t.string('path'); t.string('mimetype'); t.integer('size'); t.string('created_at'); t.string('updated_at') })
    const src = path.join(work, 'orig.jpg'); fs.writeFileSync(src, input)
    await db('profile_fields').insert({ profile_id: 1, name: 'Photo' })
    await db('files').insert({ profile_field_id: 1, original_name: 'orig.jpg', path: src, mimetype: 'image/jpeg', size: input.length })
    const { default: router } = await import('../src/routes/refineCompare.js')
    const app = express(); app.use(express.json()); app.locals.db = db; app.use('/api', router)
    const server = http.createServer(app).listen(0); const base = `http://127.0.0.1:${server.address().port}/api/photo-refine`
    try {
      assert.equal((await (await fetch(`${base}/status`)).json()).faithful, true)
      const p = await (await fetch(`${base}/1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"size":"2k"}' })).json()
      assert.equal(Math.max(p.width, p.height), 2048); assert.ok(p.token)
      assert.equal((await db('files')).length, 1)                        // a preview saves nothing
      assert.equal((await fetch(`${base}/preview/${p.token}`)).status, 200)
      const k = await (await fetch(`${base}/preview/${p.token}/keep`, { method: 'POST' })).json()
      assert.ok(k.ok); const rows = await db('files').orderBy('id')
      assert.equal(rows.length, 2); assert.equal(fs.readFileSync(src).length, input.length)   // the original is untouched
      assert.match(rows[1].original_name, /-refined\.jpg$/)
      assert.equal((await fetch(`${base}/preview/${p.token}`)).status, 404)
      process.env.ADAL_PHOTO_QUALITY = '0'
      assert.equal((await fetch(`${base}/1/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404)   // the off switch
    } finally { delete process.env.ADAL_PHOTO_QUALITY; server.close(); await db.destroy() }
  } finally { process.chdir(cwd) }
})
