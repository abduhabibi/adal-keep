// The AI never puts a picture into Photo / Full Body Photo (owner, 2026-11-26). Real schema (migrations on in-memory SQLite),
// stand-ins for JEV (what a picture shows) and for the cutting (composite.js); made-up pictures only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import knex from 'knex'
import sharp from 'sharp'

const { allowed, OFF_BY_DEFAULT } = await import('../src/services/aiPhotoGuard.js')
const P = await import('../src/services/placement.js')
const D = await import('../src/services/docPipeline.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-'))
const jpg = async (name, color) => { const f = path.join(dir, name); fs.writeFileSync(f, await sharp({ create: { width: 200, height: 260, channels: 3, background: color } }).jpeg().toBuffer()); return f }

async function setup() {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 }, migrations: { directory: new URL('../src/migrations', import.meta.url).pathname } })
  await db.migrate.latest()
  const [pid] = await db('profiles').insert({ full_name: 'TEST GIRL', passport_number: 'EP1234567' })
  const field = async (name) => (await db('profile_fields').where({ profile_id: pid, name }).first())?.id || (await db('profile_fields').insert({ profile_id: pid, name, data_type: 'file', is_permanent: 1 }))[0]
  const combined = await jpg('combined.jpg', '#c9b')
  const pf = await field('Passport')
  const [fid] = await db('files').insert({ profile_field_id: pf, original_name: 'combined.jpg', path: combined, mimetype: 'image/jpeg', size: 1000 })
  const file = await db('files').where('id', fid).first()
  const inBoxes = async () => {
    const rows = await db('files as f').join('profile_fields as pf', 'pf.id', 'f.profile_field_id').whereIn('pf.name', ['Photo', 'Full Body Photo']).select('pf.name', 'f.original_name')
    return rows
  }
  return { db, pid, file, inBoxes, field }
}
// JEV says "several things side by side"; the cutting gives a passport, a head photo and a standing photo.
const several = async () => ({ what: { choice: 'several', confidence: 0.95 } })
const cut = async () => { const d = fs.mkdtempSync(path.join(dir, 'parts-')); const m = async (n, c) => { const f = path.join(d, n); fs.writeFileSync(f, await sharp({ create: { width: 120, height: 160, channels: 3, background: c } }).jpeg().toBuffer()); return f }; return { dir: d, passport: await m('passport.jpg', '#ddd'), photo: await m('photo.jpg', '#a75'), fullbody: await m('fullbody.jpg', '#58a') } }
const quiet = () => {}

test('every AI path is off by default except the copies of the same passport\'s own record; ADAL_AI_PHOTOS brings them back', () => {
  for (const k of OFF_BY_DEFAULT) assert.equal(allowed(k, undefined), false, k)
  assert.equal(allowed('pdf', undefined), true)
  assert.equal(allowed('split', '1'), true); assert.equal(allowed('face', 'all'), true)
  assert.equal(allowed('move', 'move,sweep'), true); assert.equal(allowed('split', 'move,sweep'), false)
})

test('a pasted combined picture: the passport is cut out, nothing lands in Photo or Full Body Photo', async () => {
  const { db, pid, file, inBoxes } = await setup()
  // (a) a person's paste goes to a crop check (review): only the passport part is offered
  const r = await P.checkPlacement(db, pid, 'Passport', file, { choose: several, split: cut, review: true, log: quiet })
  assert.equal(r.act, 'review')
  const review = await db('crop_reviews').where('id', r.id).first()
  assert.deepEqual(JSON.parse(review.parts).map(x => x.kind), ['passport'])
  assert.deepEqual(await inBoxes(), [])
  // (b) without a review (the older direct way): the passport part replaces it, the photos are dropped
  const r2 = await P.checkPlacement(db, pid, 'Passport', file, { choose: several, split: cut, log: quiet })
  assert.deepEqual(r2.parts, ['Passport'])
  assert.deepEqual(await inBoxes(), [])
  await db.destroy()
})

test('with ADAL_AI_PHOTOS=split the cut photos come back (the switch works)', async () => {
  process.env.ADAL_AI_PHOTOS = 'split'
  try {
    const { db, pid, file, inBoxes } = await setup()
    const r = await P.checkPlacement(db, pid, 'Passport', file, { choose: several, split: cut, log: quiet })
    assert.deepEqual(r.parts.sort(), ['Full Body Photo', 'Passport', 'Photo'])
    assert.equal((await inBoxes()).length, 2)
    await db.destroy()
  } finally { delete process.env.ADAL_AI_PHOTOS }
})

test('JEV never moves a head photo out of Passport into Photo; a picture in Photo is not even asked about', async () => {
  const { db, pid, file, inBoxes } = await setup()
  const head = async () => ({ what: { choice: 'photo', confidence: 0.99 } })
  assert.equal((await P.checkPlacement(db, pid, 'Passport', file, { choose: head, log: quiet })).act, 'stay')
  assert.deepEqual(await inBoxes(), [])
  assert.equal((await db('files').where('id', file.id).first()).profile_field_id, file.profile_field_id)   // still where the person put it
  let asked = 0
  const spy = async () => { asked++; return several() }
  const photoField = await db('profile_fields').insert({ profile_id: pid, name: 'Photo', data_type: 'file' })
  const mine = { ...file, profile_field_id: photoField[0] }
  assert.equal((await P.checkPlacement(db, pid, 'Photo', mine, { choose: spy, split: cut, log: quiet })).act, 'stay')
  assert.equal(asked, 0)
  process.env.ADAL_AI_PHOTOS = 'move'
  try { assert.equal((await P.checkPlacement(db, pid, 'Passport', file, { choose: head, log: quiet })).act, 'move') } finally { delete process.env.ADAL_AI_PHOTOS }
  await db.destroy()
})

test('the 7-day look-back and its undo do nothing by default', async () => {
  const boom = () => { throw new Error('the database must not be touched') }
  await P.sweepRecent(boom)
  assert.equal(await P.undoWrongMoves(boom), 0)
})

test('a person ticking a cut in the crop check still puts it there (their own click)', async () => {
  process.env.ADAL_AI_PHOTOS = 'split'
  const { db, pid, file, inBoxes } = await setup()
  const r = await P.checkPlacement(db, pid, 'Passport', file, { choose: several, split: cut, review: true, log: quiet })
  delete process.env.ADAL_AI_PHOTOS            // later, with the AI path off again
  const review = await db('crop_reviews').where('id', r.id).first()
  assert.deepEqual(JSON.parse(review.parts).map(x => x.kind).sort(), ['fullbody', 'passport', 'photo'])
  const done = await P.answerReview(db, r.id, { use: ['photo'] })
  assert.deepEqual(done.done, ['Photo']); assert.equal((await inBoxes()).length, 1)
  await db.destroy()
})

test('the document pipeline: a file the AI calls a Photo is not filed; a cut part is not filed; a CV PDF\'s own pictures still are', async () => {
  const { db, pid, inBoxes } = await setup()
  const pic = await jpg('someone.jpg', '#964')
  const asPhoto = async () => ({ doc_type: 'Photo', confidence: 0.97, fields: { full_name: 'TEST GIRL' }, markdown: '' })
  const r = await D.runPipeline(pic, db, asPhoto, '[test]', { part: true, name: 'TEST GIRL.jpg' })
  assert.equal(r.ok, false); assert.equal(r.reason, 'photo_needs_a_person')
  assert.deepEqual(await inBoxes(), [])
  assert.equal(await D.fileInto(db, pid, 'Photo', pic, 'photo-x.jpg'), false)             // a part of a combined picture
  assert.equal(await D.fileInto(db, pid, 'Photo', pic, 'photo-x.jpg', 'pdf'), true)        // a picture inside a CV PDF of this passport
  assert.equal((await inBoxes()).length, 1)
  assert.equal(await D.fileInto(db, pid, 'Labour ID', pic, 'labour.jpg'), true)            // other boxes are untouched by the guard
  await db.destroy()
})
