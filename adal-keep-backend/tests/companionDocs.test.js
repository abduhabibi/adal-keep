// A Companion's own photos and documents (2026-11-25): what changed, without lists; what a file is, beside its answer.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import express from 'express'
import knex from 'knex'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-docs-'))
process.env.ADAL_BACKUP_SAFE = path.join(tmp, 'safe')
process.env.ADAL_UPLOADS_DIR = path.join(tmp, 'uploads')
fs.mkdirSync(path.join(tmp, 'safe')); fs.mkdirSync(path.join(tmp, 'uploads', '3', '9'), { recursive: true })
const F = await import('../src/services/docFeed.js')
const { default: router } = await import('../src/routes/companionDocs.js')
const { changed } = await import('../src/services/changes.js')

const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
await db.schema.createTable('files', t => { t.integer('id'); t.string('path'); t.string('mimetype'); t.integer('size'); t.integer('profile_field_id') })
await db.schema.createTable('profile_fields', t => { t.integer('id'); t.integer('profile_id') })
await db.schema.createTable('sync_log', t => { t.string('origin'); t.integer('seq'); t.string('tbl'); t.string('rid') })
await db('profile_fields').insert({ id: 4, profile_id: 31 })
await db('files').insert([{ id: 1, path: 'a.jpg', mimetype: 'image/jpeg', size: 5, profile_field_id: 4 }, { id: 2, path: 'uploads/3/9/b.pdf', mimetype: 'application/pdf', size: 3, profile_field_id: 4 }])
fs.writeFileSync(path.join(tmp, 'safe', 'a.jpg'), 'photo'); fs.writeFileSync(path.join(tmp, 'uploads', '3', '9', 'b.pdf'), 'pdf')

const app = express()
app.locals.db = db
let audited = 0
app.use(express.json(), (req, res, next) => { req.pcAccess = req.headers['x-adal-pc'] === 'k'; if (/^\/api\/files\/\d+\/download$/.test(req.path)) res.on('finish', () => { if (res.statusCode < 300) audited++ }); next() })
app.use('/api', router)
app.get('/api/files/:id/download', (req, res) => res.download(req.params.id === '1' ? path.join(tmp, 'safe', 'a.jpg') : path.join(tmp, 'uploads', '3', '9', 'b.pdf')))
const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/api`
const get = (p, h = {}) => fetch(base + p, { headers: { 'x-adal-pc': 'k', ...h } })
const json = async (p) => (await get(p)).json()
const wait = (ms) => new Promise(r => setTimeout(r, ms))
test.after(() => { F.stopDocFeed(); srv.close(); db.destroy(); fs.rmSync(tmp, { recursive: true, force: true }) })

test('only an approved Companion', async () => {
  assert.equal((await fetch(base + '/companion/docs')).status, 403)
  assert.equal((await fetch(base + '/companion/docs/file/1/download')).status, 403)
})

test('a change is told at once, nothing else is', async () => {
  const first = await json('/companion/docs?at=')
  assert.equal(first.reset, true)
  const quiet = await json('/companion/docs?at=' + first.at)
  assert.deepEqual([quiet.names, quiet.rows], [[], []])
  const t0 = Date.now(), open = json(`/companion/docs?at=${quiet.at}&wait=20`)
  await wait(100)
  fs.writeFileSync(path.join(tmp, 'safe', 'a.jpg'), 'another')
  const r = await open
  assert.ok(Date.now() - t0 < 3000)
  assert.deepEqual(r.names, ['a.jpg'])
  const open2 = json(`/companion/docs?at=${r.at}&wait=20`)
  fs.writeFileSync(path.join(tmp, 'uploads', '3', '9', 'b.pdf'), 'pdf2')
  assert.ok((await open2).names.includes('uploads/3/9/b.pdf'))
})

test('a new file row of a girl is told with her number; a deleted one as gone', async () => {
  const a = (await json('/companion/docs?at=')).at
  await db('sync_log').insert([{ origin: 'x', seq: 1, tbl: 'files', rid: '1' }, { origin: 'x', seq: 2, tbl: 'files', rid: '77' }, { origin: 'x', seq: 3, tbl: 'profiles', rid: '31' }])
  const open = json(`/companion/docs?at=${a}&wait=20`)
  changed('files')
  const r = await open
  assert.deepEqual(r.rows.map(x => [x.id, x.profile, x.gone]), [['1', 31, false], ['77', null, true]])
})

test('an answer says what the file is; the audit list as ever; a program reading is not a person', async () => {
  const body = fs.readFileSync(path.join(tmp, 'safe', 'a.jpg'))
  const r = await get('/files/1/download', { 'x-adal-own': '1' })
  const d = JSON.parse(Buffer.from(r.headers.get('x-adal-doc'), 'base64'))
  assert.deepEqual([d.id, d.name, d.sha, d.size], ['1', 'a.jpg', crypto.createHash('sha256').update(body).digest('hex'), body.length])
  assert.equal(audited, 1)
  assert.equal((await get('/files/1/download', { 'x-adal-own': '1', 'x-adal-seen': '1' })).status, 204)
  assert.equal(audited, 2)
  const p = await get('/companion/docs/file/2/download', { range: 'bytes=1-2' })
  assert.equal(p.status, 206)
  assert.equal(await p.text(), 'df')
  assert.equal(JSON.parse(Buffer.from(p.headers.get('x-adal-doc'), 'base64')).name, 'uploads/3/9/b.pdf')
  assert.equal(audited, 2)
  assert.equal((await get('/files/1/download')).headers.get('x-adal-doc'), null)   // a browser asking as ever
  // After a restart here: which of the held ones differ.
  const c = await fetch(base + '/companion/docs/check', { method: 'POST', headers: { 'x-adal-pc': 'k', 'content-type': 'application/json' }, body: JSON.stringify({ have: [[d.name, d.v], ['uploads/3/9/b.pdf', 'old'], ['../x', 'v']] }) })
  assert.deepEqual((await c.json()).differ, ['uploads/3/9/b.pdf', '../x'])
})
