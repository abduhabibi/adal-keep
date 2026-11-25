// One agent, one try: a robot run the 10-minute limit stopped (or one that failed, or that a person
// cancelled) is not put in line again by itself. On ce98582 the scan 2 minutes later queued the same
// girl again, so two girls whose tab froze took turns at 10 minutes each, for ever, and the PC was
// never quiet (the office's Main, 2026-11-24). A person's button still starts it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-onetry-'))
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'vault.key')
process.env.ADAL_KEYS_OUTSIDE = path.join(tmp, 'keys')
process.env.ADAL_NO_NET_PROBE = '1'
process.env.ADAL_NO_SOUND = '1'
const { default: knex } = await import('knex')
const F = await import('../src/services/firstStage.js')
const W = await import('../src/services/worker.js')
const A = await import('../src/services/autoScanner.js')

async function agency() {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('settings', t => { t.string('key'); t.string('value') })
  await db.schema.createTable('profiles', t => { t.increments('id'); for (const c of ['full_name', 'broker_id', 'religion', 'marital_status', 'musaned_stage', 'chosen_at', 'photo_path', 'passport_number', 'phone_number', 'date_of_birth', 'nationality', 'gender', 'contract_number', 'visa_number', 'employer_id', 'destination_country', 'labor_id', 'order_id', 'status', 'created_at']) t.string(c) })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.integer('profile_id'); t.string('workflow_id'); t.integer('account_id'); t.string('status'); t.integer('current_step'); t.text('context'); t.text('log'); t.string('pause_reason'); for (const c of ['started_at', 'finished_at', 'created_at', 'updated_at']) t.string(c) })
  await db.schema.createTable('generated_cvs', t => { t.increments('id'); t.integer('profile_id') })
  await db.schema.createTable('cv_templates', t => { t.increments('id'); t.integer('is_active') })
  await db.schema.createTable('profile_fields', t => { t.increments('id'); t.integer('profile_id'); t.string('name') })
  await db.schema.createTable('files', t => { t.increments('id'); t.integer('profile_field_id'); t.string('path'); t.string('mimetype'); t.string('original_name'); t.integer('size') })
  await db.schema.createTable('musaned_accounts', t => { t.increments('id'); t.string('name'); t.string('username'); t.string('password'); t.integer('is_default') })
  await db.schema.createTable('lmis_accounts', t => { t.increments('id'); for (const c of ['name', 'login_value', 'phone', 'password']) t.string(c); t.integer('is_default') })
  await db.schema.createTable('insurance_accounts', t => { t.increments('id'); t.integer('is_default') })
  await db('musaned_accounts').insert({ name: 'a', username: 'u', password: 'p', is_default: 1 })
  await db('lmis_accounts').insert({ name: 'l', login_value: '1', password: 'p', is_default: 1 })
  const now = new Date().toISOString()
  for (const id of [748, 751]) {
    await db('profiles').insert({ id, full_name: `G${id}`, broker_id: '1', religion: 'M', marital_status: 'S', phone_number: '911223344', created_at: now })
    await db('generated_cvs').insert({ profile_id: id })
    const photo = path.join(tmp, `${id}.jpg`); fs.writeFileSync(photo, 'x')
    const [f] = await db('profile_fields').insert({ profile_id: id, name: 'Photo' })
    await db('files').insert({ profile_field_id: f, path: photo, mimetype: 'image/jpeg', original_name: 'p.jpg' })
  }
  return db
}
const count = async (db, w) => Number((await db('automation_queue').where('workflow_id', w).count({ c: '*' }).first()).c)
const quiet = { log: () => {} }

test('two girls whose run the limit stops: queued once each, not for ever', async () => {
  const db = await agency()
  try {
    for (let scan = 0; scan < 6; scan++) {
      await F.pushFirstStage(db, quiet)
      for (const r of await db('automation_queue').where('status', 'pending')) await W.stopAtLimit(db, r, null)
    }
    assert.equal(await count(db, 'musaned_add_candidate'), 2)
    assert.equal((await db('automation_queue').first()).status, 'cancelled')
  } finally { await db.destroy() }
})

test('a run that failed is not tried again by itself, even hours later', async () => {
  const db = await agency()
  try {
    for (let scan = 0; scan < 4; scan++) {
      await F.pushFirstStage(db, quiet)
      await db('automation_queue').where('status', 'pending').update({ status: 'failed', updated_at: new Date(Date.now() - 5 * 3600e3).toISOString() })
    }
    assert.equal(await count(db, 'musaned_add_candidate'), 2)
  } finally { await db.destroy() }
})

test('the police certificate the scan queues: once, whatever ended it', async () => {
  for (const status of ['cancelled', 'failed']) {
    const db = await agency()
    try {
      await db('settings').insert({ key: 'first_stage_auto', value: '0' })
      await db('profiles').where('id', 748).update({ destination_country: 'Kuwait', labor_id: 'L', order_id: 'O' })
      for (const name of ['Passport', 'Full Body Photo', 'Slip']) {
        const [f] = await db('profile_fields').insert({ profile_id: 748, name })
        await db('files').insert({ profile_field_id: f, path: path.join(tmp, '748.jpg') })
      }
      for (let scan = 0; scan < 4; scan++) {
        await A.scanOnce(db)
        await db('automation_queue').where('status', 'pending').update({ status, updated_at: new Date(Date.now() - 5 * 3600e3).toISOString() })
      }
      assert.equal(await count(db, 'police_certificate'), 1, status)
    } finally { await db.destroy() }
  }
})
