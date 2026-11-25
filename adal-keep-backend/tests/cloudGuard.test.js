// A PC standing in for the main PC never sends the agency to another online account (cloudGuard.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import knex from 'knex'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-guard-'))
process.env.ADAL_SYNC_ID = path.join(tmp, 'sync-id.json')
process.env.ADAL_CHAT_SESSION_FILE = path.join(tmp, 'chat.json')
const sent = []
const srv = await new Promise(ok => { const s = http.createServer((q, r) => { let b = ''; q.on('data', d => { b += d }); q.on('end', () => { if (q.method === 'POST' && q.url.startsWith('/rest/v1/keep_')) sent.push(b); r.setHeader('content-type', 'application/json'); r.end(q.url.startsWith('/auth') ? '{"access_token":"x","refresh_token":"y","expires_in":3600,"user":{"id":"OTHER-AGENCY"}}' : q.method === 'GET' ? '[]' : '{}') }) }).listen(0, '127.0.0.1', () => ok(s)); s.unref() })
process.env.SUPABASE_URL = `http://127.0.0.1:${srv.address().port}`
process.env.SUPABASE_ANON_KEY = 'dummy'
process.env.PORT = String(srv.address().port)
fs.writeFileSync(process.env.ADAL_CHAT_SESSION_FILE, JSON.stringify({ email: 'a', password: 'b', refresh_token: 'y', user_id: 'OTHER-AGENCY' }))
const I = await import('../src/services/sync/identity.js')
const C = await import('../src/services/cloudSync.js')
const G = await import('../src/services/cloudGuard.js')
const who = (j) => { I.writeIdentity({ pc_id: 'b207c0e58d60', slot: 2, key: 'k', ...j }) }
const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
await db.schema.createTable('settings', t => { t.string('key'); t.string('value') })
await db.schema.createTable('sync_role', t => { t.string('k'); t.string('holder'); t.string('data'); t.string('at') })
await db('sync_role').insert({ k: 'main', holder: 'b207c0e58d60', data: JSON.stringify({ how: 'auto', from: 'f67a99e92b17' }) })
test.after(() => db.destroy())

test('standing in by itself, its account another agency\'s: the online copy is off (backups, phones, live link go with it)', async () => {
  who({ joined_main: 'f67a99e92b17', online: { agency: 'NUZLA' } })
  assert.equal(await C.cloudOn(db), false)
  who({ joined_main: 'f67a99e92b17' })
  assert.equal(await C.cloudOn(db), false, 'not told the agency\'s account: not either')
  process.env.ADAL_CLOUD_GUARD = '0'
  try { assert.equal(await C.cloudOn(db), true, 'before: on, into that account') } finally { delete process.env.ADAL_CLOUD_GUARD }
  assert.equal(sent.length, 0)
})
test('the agency\'s own main PC, the agency\'s account, and a person\'s choice: on', async () => {
  who({}); assert.equal(await C.cloudOn(db), true)
  who({ joined_main: 'f67a99e92b17', online: { agency: 'OTHER-AGENCY' } }); assert.equal(await C.cloudOn(db), true, 'that is this agency\'s account')
  const identity = { joined_main: 'x' }
  assert.equal(G.refusal({ identity, account: 'a', role: { how: 'taken (forced)' } }), '')
  assert.notEqual(G.refusal({ identity: { ...identity, online: { agency: 'NUZLA' } }, account: 'a', role: { how: 'taken' } }), '', 'never into another agency\'s')
})
