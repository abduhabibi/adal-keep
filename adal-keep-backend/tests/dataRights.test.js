// Data protection: consent line, export of one candidate (zip), erase for good, audit log.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'

async function setup() {
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('brokers', t => { t.increments('id'); t.string('name') })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name'); t.string('passport_number'); t.integer('broker_id'); t.string('photo_path'); t.string('full_body_photo_path'); t.string('passport_file') })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('path'); t.string('original_name') })
  await db.schema.createTable('generated_cvs', t => { t.increments('id'); t.integer('profile_id'); t.string('pdf_path') })
  await db.schema.createTable('tasks', t => { t.increments('id'); t.integer('profile_id'); t.string('title') })
  await db.schema.createTable('trash', t => { t.increments('id'); t.string('kind'); t.integer('item_id'); t.string('title'); t.text('payload'); t.text('files'); t.string('deleted_by'); t.string('deleted_from'); t.string('deleted_at') })
  await (await import('../src/migrations/065_run_history.js')).up(db)
  // 066 adds the consent columns to profiles and makes audit_log
  await (await import('../src/migrations/066_data_protection.js')).up(db)
  return db
}
const req = (who = 'Sara') => ({ get: (h) => (h.toLowerCase() === 'x-adal-who' ? encodeURIComponent(who) : undefined), headers: {}, socket: { remoteAddress: '127.0.0.1' }, app: {} })

async function seed(db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-'))
  const doc = path.join(dir, 'passport.jpg'); fs.writeFileSync(doc, Buffer.from('PASSPORT-BYTES'))
  const [a] = await db('profiles').insert({ full_name: 'Almaz Tesfaye', passport_number: 'EP123' })
  const [b] = await db('profiles').insert({ full_name: 'Other Girl', passport_number: 'EP999' })
  const [f] = await db('profile_fields').insert({ profile_id: a, name: 'Passport' })
  await db('files').insert({ profile_field_id: f, path: doc, original_name: 'passport.jpg' })
  await db('tasks').insert({ profile_id: a, title: 'call her' })
  await db('tasks').insert({ profile_id: b, title: 'other' })
  await db('run_history').insert({ profile_id: a, profile_name: 'Almaz Tesfaye', site: 'Musaned' })
  return { a, b, doc }
}

// a tiny zip reader for the test
function unzip(buf) {
  const out = {}; let end = buf.length - 22
  const n = buf.readUInt16LE(end + 10); let p = buf.readUInt32LE(end + 16)
  for (let i = 0; i < n; i++) {
    const nl = buf.readUInt16LE(p + 28), method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), off = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nl)
    const l = 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28)
    const body = buf.subarray(off + l, off + l + size)
    out[name] = method === 8 ? zlib.inflateRawSync(body) : body
    p += 46 + nl
  }
  return out
}

test('consent is recorded with who and when, and can be taken back', async () => {
  const db = await setup(); const R = await import('../src/services/dataRights.js'); const { a } = await seed(db)
  assert.equal((await db('profiles').where({ id: a }).first()).data_consent, 0)
  await R.setConsent(db, a, true, 'Sara')
  const p = await db('profiles').where({ id: a }).first()
  assert.equal(p.data_consent, 1); assert.equal(p.data_consent_by, 'Sara'); assert.ok(p.data_consent_at)
  await R.setConsent(db, a, false, 'Sara')
  assert.equal((await db('profiles').where({ id: a }).first()).data_consent_at, null)
  assert.equal(await R.setConsent(db, 9999, true, 'x'), null)
  await db.destroy()
})

test('export: a zip with her record, her tasks, robot history and her documents, and nobody else', async () => {
  const db = await setup(); const R = await import('../src/services/dataRights.js'); const { a } = await seed(db)
  const { zip } = await R.exportOne(db, a)
  const z = unzip(zip)
  const json = JSON.parse(z['candidate.json'].toString())
  assert.equal(json.profile.full_name, 'Almaz Tesfaye')
  assert.equal(json.tasks.length, 1); assert.equal(json.tasks[0].title, 'call her')
  assert.equal(json.run_history.length, 1)
  assert.ok(!JSON.stringify(json).includes('Other Girl'))
  const docName = Object.keys(z).find(n => n.startsWith('documents/Passport/'))
  assert.equal(z[docName].toString(), 'PASSPORT-BYTES')
  assert.equal(await R.exportOne(db, 424242), null)
  await db.destroy()
})

test('erase: needs her exact name; then her rows, documents, tasks and robot history are gone; others stay', async () => {
  const db = await setup(); const R = await import('../src/services/dataRights.js'); const A = await import('../src/services/audit.js'); const { a, b, doc } = await seed(db)
  await A.record(db, req(), { action: 'viewed', id: a })
  await assert.rejects(R.eraseOne(db, a, 'wrong name', req()), /full name/)
  assert.ok(await db('profiles').where({ id: a }).first())
  const r = await R.eraseOne(db, a, '  almaz   TESFAYE ', req())
  assert.equal(r.ok, true)
  assert.equal(await db('profiles').where({ id: a }).first(), undefined)
  assert.equal((await db('profile_fields').where({ profile_id: a })).length, 0)
  assert.equal((await db('tasks').where({ profile_id: a })).length, 0)
  assert.equal((await db('run_history').where({ profile_id: a })).length, 0)
  assert.equal((await db('trash')).length, 0)           // not left in the Trash
  assert.equal(fs.existsSync(doc), false)                // the document is gone from disk
  assert.ok(await db('profiles').where({ id: b }).first())
  assert.equal((await db('tasks').where({ profile_id: b })).length, 1)
  assert.equal((await db('audit_log').where({ target_id: a }))[0].target_name, null)   // no name left in the log
  assert.equal(await R.eraseOne(db, a, 'x', req()), null)
  await db.destroy()
})

test('audit: who, what and when; the same look within 10 minutes is one line; a failure never throws', async () => {
  const db = await setup(); const A = await import('../src/services/audit.js'); const { a } = await seed(db)
  await A.record(db, req('Sara'), { action: 'viewed', id: a })
  await A.record(db, req('Sara'), { action: 'viewed', id: a })
  await A.record(db, req('Hana'), { action: 'viewed', id: a })
  await A.record(db, req('Sara'), { action: 'exported', id: a, detail: 'zip' })
  await A.record(db, req('Sara'), { action: 'exported', id: a, detail: 'zip' })   // exports are never merged
  const rows = await A.list(db, { profile_id: a })
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map(r => `${r.who}:${r.action}`).sort(), ['Hana:viewed', 'Sara:exported', 'Sara:exported', 'Sara:viewed'])
  assert.equal(rows[0].target_name, 'Almaz Tesfaye')
  assert.equal(await A.record({ schema: { hasTable: () => { throw new Error('db down') } } }, req(), { action: 'viewed', id: 1 }), null)
  await db.destroy()
})

test('audit middleware logs a profile view and a download, not a failed request', async () => {
  const db = await setup(); const A = await import('../src/services/audit.js'); const { a } = await seed(db)
  const run = async (path, status) => {
    const r = req('Tigist'); r.method = 'GET'; r.path = path; r.app = { locals: { db } }
    let done; const res = { statusCode: status, on: (e, f) => { if (e === 'finish') done = f } }
    A.auditViews(r, res, () => {}); done?.(); await new Promise(r => setTimeout(r, 30))
  }
  await run(`/profiles/${a}`, 200); await run(`/profiles/${a}`, 404); await run('/profiles', 200); await run(`/profiles/${a}/opened`, 200)
  const rows = await A.list(db, {})
  assert.equal(rows.length, 1); assert.equal(rows[0].action, 'viewed'); assert.equal(rows[0].who, 'Tigist')
  await db.destroy()
})
