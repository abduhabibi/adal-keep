// A picture a person put in that JEV cuts into parts (asked on 2026-11-20):
// the cut-outs wait for the person's OK; only the parts they keep go in.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The AI cutting photos out of a combined picture is off by default (services/aiPhotoGuard.js, tests/aiPhotoGuard.test.js);
// this file tests the crop check itself, so the path is switched on here.
process.env.ADAL_AI_PHOTOS = 'split'

async function setup() {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('field_templates', t => { t.increments('id'); t.string('name') })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.integer('field_template_id'); t.string('name'); t.string('data_type'); t.boolean('is_permanent'); t.timestamps() })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('original_name'); t.string('path'); t.string('mimetype'); t.integer('size'); t.string('content_hash'); t.timestamps() })
  await (await import('../src/migrations/064_crop_reviews.js')).up(db)
  const sharp = (await import('sharp')).default
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crop-'))
  const jpg = async (name, r) => { const p = path.join(tmp, name); await sharp({ create: { width: 40, height: 60, channels: 3, background: { r, g: 0, b: 0 } } }).jpeg().toFile(p); return p }
  const { SAFE_STORAGE_DIR } = await import('../src/services/docPipeline.js')
  fs.mkdirSync(SAFE_STORAGE_DIR, { recursive: true })
  const orig = `croptest_${Date.now()}.jpg`
  fs.copyFileSync(await jpg('o.jpg', 10), path.join(SAFE_STORAGE_DIR, orig))
  const [fid] = await db('profile_fields').insert({ profile_id: 5, name: 'Passport', data_type: 'file' })
  const [fileId] = await db('files').insert({ profile_field_id: fid, original_name: 'all.jpg', path: orig, mimetype: 'image/jpeg' })
  const file = await db('files').where('id', fileId).first()
  const split = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-'))
    const at = async (k, r) => { const p = path.join(dir, `${k}.jpg`); fs.copyFileSync(await jpg(`${k}.jpg`, r), p); return p }
    return { dir, photo: await at('photo', 100), fullbody: await at('fullbody', 150), passport: await at('passport', 200) }
  }
  const choose = async () => ({ what: { choice: 'several', confidence: 0.95 } })
  const made = () => db('files as f').join('profile_fields as pf', 'pf.id', 'f.profile_field_id').select('pf.name', 'f.path')
  const cleanup = async () => {
    for (const r of await db('files').select('path')) fs.rmSync(path.join(SAFE_STORAGE_DIR, r.path), { force: true })
    for (const r of await db('crop_reviews').select('dir')) if (r.dir) fs.rmSync(r.dir, { recursive: true, force: true })
    fs.rmSync(path.join(SAFE_STORAGE_DIR, orig), { force: true })
    fs.rmSync(tmp, { recursive: true, force: true })
    await db.destroy()
  }
  return { db, file, split, choose, made, cleanup }
}

test('a picture put in by a person: the cut-outs wait, nothing goes into her boxes yet', async () => {
  const { db, file, split, choose, made, cleanup } = await setup()
  const { checkPlacement } = await import('../src/services/placement.js')
  const r = await checkPlacement(db, 5, 'Passport', file, { choose, split, review: true, log: () => {} })
  assert.equal(r.act, 'review')
  const row = await db('crop_reviews').where('id', r.id).first()
  assert.equal(row.status, 'waiting')
  assert.deepEqual(JSON.parse(row.parts).map(p => p.kind), ['photo', 'fullbody', 'passport'])
  assert.deepEqual((await made()).map(x => x.name), ['Passport'])   // only the picture itself
  await cleanup()
})

test('the person keeps the photo and the passport, drops the full body', async () => {
  const { db, file, split, choose, made, cleanup } = await setup()
  const { checkPlacement, answerReview } = await import('../src/services/placement.js')
  const { id } = await checkPlacement(db, 5, 'Passport', file, { choose, split, review: true, log: () => {} })
  const out = await answerReview(db, id, { use: ['photo', 'passport'] })
  assert.deepEqual(out.done.sort(), ['Passport', 'Photo'])
  const names = (await made()).map(x => x.name).sort()
  assert.deepEqual(names, ['Passport', 'Photo'])        // the passport part replaced the combined picture
  assert.equal((await db('crop_reviews').where('id', id).first()).status, 'done')
  assert.equal((await answerReview(db, id, { use: ['fullbody'] })).already, 'done')   // answered once
  await cleanup()
})

test('keep as it was: nothing changes', async () => {
  const { db, file, split, choose, made, cleanup } = await setup()
  const { checkPlacement, answerReview } = await import('../src/services/placement.js')
  const { id } = await checkPlacement(db, 5, 'Passport', file, { choose, split, review: true, log: () => {} })
  await answerReview(db, id, { use: [] })
  assert.deepEqual((await made()).map(x => x.name), ['Passport'])
  assert.equal((await db('crop_reviews').where('id', id).first()).status, 'kept')
  await cleanup()
})
