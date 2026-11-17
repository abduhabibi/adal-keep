import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import knex from 'knex'
import { lock, verifyBackup } from '../src/services/telegramBackup.js'

const PW = 'test-key-only'

async function fakeBackup({ rows = 3, damage = false, missing = false } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adal-bv-')), 'db.sqlite')
  const db = knex({ client: 'sqlite3', connection: { filename: file }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('name') })
  for (let i = 0; i < rows; i++) await db('profiles').insert({ name: `girl ${i}` })
  await db.destroy()
  const store = new Map()
  let raw = fs.readFileSync(file)
  if (damage) raw = Buffer.concat([Buffer.from('not a database!'), raw.subarray(15)])
  const locked = lock(zlib.gzipSync(raw), PW)
  const half = Math.ceil(locked.length / 2)
  store.set('db1', locked.subarray(0, half)); store.set('db2', locked.subarray(half))
  const index = { adal_backup: 1, sets: [{ type: 'db', parts: ['db1', 'db2'] }, { type: 'files', parts: ['f1'] }] }
  store.set('idx', lock(zlib.gzipSync(Buffer.from(JSON.stringify(index))), PW))
  if (!missing) store.set('f1', Buffer.from('x'))
  return {
    fetch: async (_t, id) => { if (!store.has(id)) throw new Error('gone'); return store.get(id) },
    exists: async (_t, id) => store.has(id),
  }
}

test('a good backup reads back: the database opens and has every profile', async () => {
  const f = await fakeBackup({ rows: 3 })
  const v = await verifyBackup(null, { token: 't', password: PW, indexId: 'idx', profiles: 3, ...f })
  assert.equal(v.ok, true, v.why)
  assert.equal(v.profiles, 3)
  assert.equal(v.pieces_checked, 1)
})

test('a backup with fewer profiles, a damaged database, a missing piece or the wrong key is reported', async () => {
  assert.match((await verifyBackup(null, { token: 't', password: PW, indexId: 'idx', profiles: 5, ...(await fakeBackup({ rows: 3 })) })).why, /3 profiles, the PC had 5/)
  assert.match((await verifyBackup(null, { token: 't', password: PW, indexId: 'idx', ...(await fakeBackup({ damage: true })) })).why, /not a database/)
  assert.match((await verifyBackup(null, { token: 't', password: PW, indexId: 'idx', ...(await fakeBackup({ missing: true })) })).why, /missing/)
  assert.match((await verifyBackup(null, { token: 't', password: 'wrong', indexId: 'idx', ...(await fakeBackup()) })).why, /Wrong backup password/)
})
