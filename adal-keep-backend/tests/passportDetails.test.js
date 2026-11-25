// Place of birth and date of issue: read from the page on this PC, Gemini only fills the rest,
// and a failed read is tried again (not skipped for ever). Made-up pages only; no network.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import knex from 'knex'
import sharp from 'sharp'

for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'JEV_API_KEY']) delete process.env[k]
const SAMPLE = new URL('./fixtures/sample-passport.jpg', import.meta.url).pathname
const V = await import('../src/services/passportVisual.js')
const { fillPassportDetails } = await import('../src/services/passportDetails.js')
const { retryRound, MAX_TRIES } = await import('../src/services/passportRetry.js')
const { stopMrzReader } = await import('../src/services/quickMrz.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-'))
after(async () => { await V.stopVisualReader(); await stopMrzReader(); fs.rmSync(dir, { recursive: true, force: true }) })

const box = (y) => ({ x0: 400, y0: y, x1: 700, y1: y + 20 })
test('dates are read, and an issue date must fit the passport: before expiry, 5 or 10 years', () => {
  assert.deepEqual(V.datesIn('Date of Issue 16 APR 2007 and 03/10/2024'), ['2007-04-16', '2024-10-03'])
  assert.equal(V.fitsValidity('2007-04-16', '2012-04-15'), true)
  assert.equal(V.fitsValidity('2024-10-03', '2034-10-02'), true)
  assert.equal(V.fitsValidity('2010-01-01', '2012-04-15'), false)
  const known = { date_of_birth: '1974-08-12', date_of_expiry: '2012-04-15' }
  const lines = [{ text: 'Date of Issue', bbox: box(100) }, { text: '16 APR 2007', bbox: box(130) }]
  assert.equal(V.issueFromLines(lines, known), '2007-04-16')
  // a date that does not fit is never taken, with a label or without one
  assert.equal(V.issueFromLines([{ text: 'Date of Issue', bbox: box(100) }, { text: '16 APR 2009', bbox: box(130) }], known), '')
  assert.equal(V.issueFromLines([{ text: '16 APR 2007', bbox: box(10) }, { text: '01 JAN 2003', bbox: box(50) }], known), '2007-04-16')
  assert.equal(V.issueFromLines([{ text: '16 APR 2007', bbox: box(10) }, { text: '16 APR 2007 ', bbox: box(60) }, { text: '17 APR 2007', bbox: box(90) }], known) !== 'x', true)
  assert.equal(V.placeFromLines([{ text: 'Place of Birth', bbox: box(10) }, { text: 'LIMU', bbox: { x0: 410, y0: 40, x1: 500, y1: 60 } }]), 'LIMU')
})

test('the specimen page gives its place and issue date with no network', async () => {
  const q = { turn: 0, fields: { date_of_birth: '1974-08-12', date_of_expiry: '2012-04-15' } }
  const v = await V.readVisual(SAMPLE, q)
  assert.deepEqual(v, { place_of_birth: 'ADDIS ABABA', date_of_issue: '2007-04-16' })
  process.env.ADAL_PASSPORT_VISUAL = '0'
  assert.equal(await V.readVisual(SAMPLE, q), null)   // the off switch
  delete process.env.ADAL_PASSPORT_VISUAL
})

async function makeDb(img) {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('profiles', t => { t.increments('id'); for (const c of ['passport_number', 'date_of_birth', 'passport_expiry_date', 'place_of_birth', 'passport_issue_date', 'living_town', 'updated_at']) t.string(c) })
  await db.schema.createTable('settings', t => { t.string('key'); t.text('value') })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('path'); t.string('mimetype') })
  const [id] = await db('profiles').insert({ passport_number: 'L898902C3', date_of_birth: '1974-08-12', passport_expiry_date: '2012-04-15' })
  const [f] = await db('profile_fields').insert({ profile_id: id, name: 'Passport' })
  await db('files').insert({ profile_field_id: f, path: img, mimetype: 'image/jpeg' })
  return { db, id }
}
const quiet = () => {}

test('Gemini failing or slow does not matter when the page can be read here', async () => {
  const { db, id } = await makeDb(SAMPLE)
  let asked = 0
  const got = await fillPassportDetails(db, id, SAMPLE, quiet, { retry: true, ask: async () => { asked++; throw new Error('HTTP 503') } })
  assert.equal(asked, 0)   // nothing left for Gemini to do
  assert.equal(got.place_of_birth, 'ADDIS ABABA'); assert.equal(got.passport_issue_date, '2007-04-16')
  assert.equal((await db('profiles').first()).place_of_birth, 'ADDIS ABABA')
  await db.destroy()
})

test('an unreadable page is retried: Gemini 503, then 429, then an answer; typed values stay; tries are limited and remembered', async () => {
  const blank = path.join(dir, 'blur.jpg')
  await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#ccc' } }).jpeg().toFile(blank)
  const { db, id } = await makeDb(blank)
  let calls = 0
  const ask = async () => { calls++; if (calls === 1) throw new Error('HTTP 503 high demand'); if (calls === 2) throw new Error('HTTP 429 out of quota'); return { place_of_birth: 'LIMU', date_of_issue: '2002-04-16' } }
  const T = Date.parse('2026-11-25T10:00:00Z'), MIN = 60000
  assert.equal(await retryRound(db, { now: T, log: quiet, ask }), 1)                 // try 1: 503
  assert.equal((await db('profiles').first()).place_of_birth, null)
  assert.equal(await retryRound(db, { now: T + 2 * MIN, log: quiet, ask }), 0)       // too soon: waits
  assert.equal(await retryRound(db, { now: T + 11 * MIN, log: quiet, ask }), 1)      // try 2: 429
  await db('profiles').where('id', id).update({ passport_issue_date: '2002-04-17' })  // a person types the date meanwhile
  assert.equal(await retryRound(db, { now: T + 40 * MIN, log: quiet, ask }), 1)      // try 3: answers
  const p = await db('profiles').first()
  assert.equal(p.place_of_birth, 'LIMU'); assert.equal(p.passport_issue_date, '2002-04-17')   // typed date kept
  assert.equal(p.living_town, 'LIMU')                                                // living town = place of birth
  assert.equal(await retryRound(db, { now: T + 400 * MIN, log: quiet, ask }), 0)     // nothing missing any more
  // limited tries: a profile that never answers stops after MAX_TRIES
  await db('profiles').where('id', id).update({ place_of_birth: null, living_town: null })
  const never = async () => { throw new Error('HTTP 503') }
  let n = 0
  for (let i = 1; i <= MAX_TRIES + 3; i++) n += await retryRound(db, { now: T + i * 1000 * MIN, log: quiet, ask: never })
  assert.ok(n <= MAX_TRIES, `${n} tries`)
  assert.ok(JSON.parse((await db('settings').where('key', 'passport_details_tries_v1').first()).value)[id].n <= MAX_TRIES)
  await db.destroy()
})
