import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import path from 'path'
import fs from 'fs'
import knex from 'knex'

process.env.ACCOUNT_VAULT_KEY = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')), 'k')
const { seal, open, openRows, sealStored, vaultKey, stageVaultKey, applyStagedVaultKey } = await import('../src/services/accountVault.js')

test('a password is unreadable sealed, opens again, and is never sealed twice', () => {
  const s = seal('Secret@1')
  assert.match(s, /^enc:v1:/)
  assert.ok(!s.includes('Secret'))
  assert.equal(open(s), 'Secret@1')
  assert.equal(seal(s), s)
  assert.equal(open('plain'), 'plain')
  assert.equal(seal(''), '')
})

test('rows come out open, a user hash stays as it is', () => {
  assert.deepEqual(openRows([{ password: seal('a') }, { password: '$2b$hash' }]), [{ password: 'a' }, { password: '$2b$hash' }])
  assert.equal(openRows({ context: seal('{"x":1}') }).context, '{"x":1}')
  assert.equal(openRows(3), 3)
})

test('stored open passwords get locked, and the code still reads them', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, postProcessResponse: openRows, pool: { min: 1, max: 1 } })
  await db.raw('create table musaned_accounts (id integer primary key, password text)')
  await db.raw('create table automation_queue (id integer primary key, context text)')
  await db.raw(`insert into musaned_accounts (password) values ('pw1')`)
  await db.raw(`insert into automation_queue (context) values ('{"musaned_password":"pw1"}'), ('{}')`)
  try {
    assert.equal(await sealStored(db), 2)
    assert.equal(await sealStored(db), 0)
    // knex opens every answer, so the stored text is looked at inside SQL
    const [{ locked }] = await db.raw(`select count(*) locked from musaned_accounts where password like 'enc:v1:%'`)
    assert.equal(locked, 1)
    assert.equal((await db('musaned_accounts').first()).password, 'pw1')
    assert.equal(JSON.parse((await db('automation_queue').where('id', 1).first()).context).musaned_password, 'pw1')
  } finally { await db.destroy() }
})

test('a restored key waits for its database, and the old one is kept', () => {
  const old = seal('old'), other = Buffer.alloc(32, 7).toString('base64')
  stageVaultKey(other)
  assert.equal(open(old), 'old')          // the current database still opens
  assert.notEqual(vaultKey(), other)
  applyStagedVaultKey()
  assert.equal(vaultKey(), other)
  const dir = path.dirname(process.env.ACCOUNT_VAULT_KEY)
  assert.ok(fs.readdirSync(dir).some(f => f.includes('before-restore')))
  stageVaultKey(undefined)                // a backup from before the vault changes nothing
  applyStagedVaultKey()
  assert.equal(vaultKey(), other)
})
