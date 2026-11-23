// The control tower (services/tower.js): only commands signed by Adal's tower key, for this PC,
// not expired and never run before, are done; every one is answered; crashes are grouped.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import knex from 'knex'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-tower-'))
process.env.ADAL_TOWER_DATA = tmp
process.env.ADAL_NO_NET_PROBE = '1'
process.env.ADAL_NO_SOUND = '1'
const T = await import('../src/services/tower.js')

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
T._setTowerKeyForTests(publicKey.export({ type: 'spki', format: 'pem' }))
const ME = '11111111-1111-1111-1111-111111111111'
const sign = (cmd, key = privateKey) => { const payload = JSON.stringify(cmd); return { payload, sig: crypto.sign(null, Buffer.from(payload), key).toString('base64') } }
const cmd = (over = {}) => ({ id: crypto.randomUUID(), target: ME, kind: 'self_check', args: {}, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString(), ...over })

test('the baked public key is a real Ed25519 key', () => {
  const k = crypto.createPublicKey(T.TOWER_PUBLIC_KEY)
  assert.equal(k.asymmetricKeyType, 'ed25519')
})

test('a command runs only when signed by Adal, for this PC, in time, once', () => {
  assert.equal(T.checkCommand(sign(cmd()), { me: ME }).ok, true)
  const other = crypto.generateKeyPairSync('ed25519').privateKey
  assert.equal(T.checkCommand(sign(cmd(), other), { me: ME }).why, 'bad signature')
  const env = sign(cmd()); env.payload = env.payload.replace('self_check', 'restart')
  assert.equal(T.checkCommand(env, { me: ME }).why, 'bad signature')
  assert.equal(T.checkCommand(sign(cmd({ target: 'someone-else' })), { me: ME }).why, 'not for this PC')
  assert.equal(T.checkCommand(sign(cmd({ expires_at: new Date(Date.now() - 1000).toISOString() })), { me: ME }).why, 'expired')
  assert.equal(T.checkCommand(sign(cmd({ kind: 'rm_rf' })), { me: ME }).why, 'unknown command')
  const c = cmd()
  assert.equal(T.checkCommand(sign(c), { me: ME, done: new Set([c.id]) }).why, 'already done')
  assert.equal(T.checkCommand({ payload: 'x' }, { me: ME }).why, 'bad signature')
  assert.equal(T.checkCommand(null, { me: ME }).why, 'bad signature')
})

const dbs = []
test.after(async () => { for (const d of dbs) await d.destroy() })
async function makeDb() {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  dbs.push(db)
  await db.schema.createTable('notifications', t => { t.increments('id'); t.integer('company_id'); t.string('type'); t.string('title'); t.text('body'); t.string('created_day'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.string('status') })
  await db.schema.createTable('settings', t => { t.string('key'); t.string('value') })
  return db
}
function fakeCloud(cmds) {
  const meta = new Map([['/_tower/cmds', { cmds }]])
  const calls = []
  const cloud = async (method, p, body) => {
    calls.push({ method, p, body })
    if (method === 'GET' && p.startsWith('/rest/v1/keep_meta')) {
      const key = decodeURIComponent(p.match(/key=eq\.([^&]+)/)[1])
      return meta.has(key) ? [{ data: meta.get(key) }] : []
    }
    if (method === 'POST' && p.startsWith('/rest/v1/keep_meta')) { for (const r of body) { assert.equal(r.agency_id, ME); meta.set(r.key, r.data) } return null }
    if (method === 'POST' && p.startsWith('/storage/v1/object/keep/')) return { Key: p }
    throw new Error(`unexpected ${method} ${p}`)
  }
  return { cloud, meta, calls }
}

test('signed commands are done and answered; forged ones refused once; none twice', async () => {
  T._resetState()
  const db = await makeDb()
  await db('automation_queue').insert([{ status: 'running' }, { status: 'pending' }, { status: 'done' }])
  const cancelled = []
  T._setLocalForTests(async (method, p) => { cancelled.push(p); return { code: 200, body: { ok: true } } })
  const note = cmd({ kind: 'support_note', args: { text: 'Hello from Adal, call me' } })
  const cancel = cmd({ kind: 'cancel_runs' })
  const forged = sign(cmd({ kind: 'restart' }), crypto.generateKeyPairSync('ed25519').privateKey)
  const f = fakeCloud([sign(note), forged, sign(cancel)])
  await T.pollCommands(db, { cloud: f.cloud, me: ME })
  const acks = f.meta.get('/_tower/acks').acks
  assert.equal(acks.find(a => a.id === note.id).status, 'done')
  assert.equal(acks.find(a => a.id === cancel.id).status, 'done')
  assert.equal(acks.find(a => a.status === 'refused').result.message, 'bad signature')
  assert.deepEqual(cancelled.sort(), ['/automations/1/cancel', '/automations/2/cancel'])
  const n = await db('notifications').first()
  assert.equal(n.title, 'Adal support'); assert.match(n.body, /Hello from Adal/)
  // The same row read again: nothing runs twice, nothing new is answered.
  const before = f.calls.length
  await T.pollCommands(db, { cloud: f.cloud, me: ME })
  assert.equal(f.calls.length, before + 1)   // only the read
  assert.equal(await db('notifications').count({ c: '*' }).first().then(r => Number(r.c)), 1)
  T._setLocalForTests(null)
})

test('suspend holds new robot runs on this PC; resume lets them go', async () => {
  T._resetState()
  const db = await makeDb()
  const f = fakeCloud([sign(cmd({ kind: 'suspend', args: { note: 'checking the PC' } }))])
  await T.pollCommands(db, { cloud: f.cloud, me: ME })
  assert.equal(T.towerHeld(), true)
  const W = await import('../src/services/worker.js')
  await db.schema.dropTable('automation_queue')
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.string('status'); t.string('workflow_id'); t.string('run_after'); t.string('started_at'); t.string('updated_at'); t.integer('profile_id') })
  await db('automation_queue').insert({ status: 'pending' })
  assert.equal(await W.claimNextJob(db), null)
  f.meta.set('/_tower/cmds', { cmds: [sign(cmd({ kind: 'resume' }))] })
  await T.pollCommands(db, { cloud: f.cloud, me: ME })
  assert.equal(T.towerHeld(), false)
})

test('collect_logs uploads a gzip to the private bucket under this account, passwords hidden', async () => {
  T._resetState()
  fs.writeFileSync(path.join(tmp, 'server.log'), 'start\nlogin password=hunter2 for EP1234567 phone +251911223344\n')
  const db = await makeDb()
  const f = fakeCloud([sign(cmd({ kind: 'collect_logs' }))])
  await T.pollCommands(db, { cloud: f.cloud, me: ME })
  const up = f.calls.find(c => c.p.startsWith('/storage/v1/object/keep/'))
  assert.ok(up.p.startsWith(`/storage/v1/object/keep/${ME}/_support/logs/`))
  const text = (await import('zlib')).gunzipSync(up.body).toString()
  assert.match(text, /server\.log/)
  assert.doesNotMatch(text, /hunter2|EP1234567|251911223344/)
  assert.equal(f.meta.get('/_tower/acks').acks[0].status, 'done')
})

test('crashes are grouped by message, numbers hidden', () => {
  T._resetCrashes()
  T.noteCrash({ source: 'frontend', message: 'Minified React error #310; visit https://react.dev', where: 'Settings' })
  T.noteCrash({ source: 'frontend', message: 'Minified React error #310; visit https://react.dev', where: 'Settings' })
  T.noteCrash({ source: 'launcher', message: 'panic: index out of range [3] with length 2' })
  T.noteCrash({ source: 'backend', message: 'cannot read passport EP1234567' })
  const list = T.crashList()
  assert.equal(list.length, 3)
  assert.equal(list.find(g => g.source === 'frontend').count, 2)
  assert.ok(list.every(g => !/EP1234567/.test(g.message)))
})

test('the beat is small and has what Admin shows', async () => {
  const db = await makeDb()
  const b = await T.beatData(db, { agencyName: 'Adal Test agency' })
  for (const k of ['pc_name', 'cpu', 'ram', 'disk_free_mb', 'robots', 'net_type', 'crashes', 'role']) assert.ok(k in b, k)
  assert.ok(JSON.stringify(b).length < 6000)
})

test('the flag: Adal Test agency on, others only with a signed flag for their own account', async () => {
  delete process.env.ADAL_TOWER
  const none = async () => []
  assert.equal((await T.towerOn({ cloud: none, me: ME, agencyName: 'Adal Test agency' })).on, true)
  assert.equal((await T.towerOn({ cloud: none, me: ME, agencyName: 'Nuzla Agency' })).on, false)
  const flag = (target, key) => async () => [{ data: sign({ target, on: true, issued_at: new Date().toISOString() }, key) }]
  assert.equal((await T.towerOn({ cloud: flag(ME), me: ME, agencyName: 'Nuzla Agency' })).on, true)
  assert.equal((await T.towerOn({ cloud: flag('other'), me: ME, agencyName: 'Nuzla Agency' })).on, false)
  assert.equal((await T.towerOn({ cloud: flag(ME, crypto.generateKeyPairSync('ed25519').privateKey), me: ME, agencyName: 'Nuzla' })).on, false)
  process.env.ADAL_TOWER = '0'
  assert.equal((await T.towerOn({ cloud: none, me: ME, agencyName: 'Adal Test agency' })).on, false)
  delete process.env.ADAL_TOWER
})

test('Help: a ticket goes online with logs and the picture; Adal\'s signed answer comes back as a notification', async () => {
  T._resetState()
  const db = await makeDb()
  const f = fakeCloud([])
  await assert.rejects(T.createTicket(db, { text: 'x' }, null), /not open/)
  await assert.rejects(T.createTicket(db, { text: '  ' }, { cloud: f.cloud, me: ME }), /Write/)
  const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64')
  const r = await T.createTicket(db, { text: 'The CV button does nothing, password=abc123', image: png, who: 'Selam', page: '/cv' }, { cloud: f.cloud, me: ME })
  assert.equal(r.ok, true)
  const ups = f.calls.filter(c => c.p.startsWith('/storage/v1/object/keep/')).map(c => c.p)
  assert.ok(ups.some(p => p.endsWith(`/_support/tickets/${r.ticket.id}/log.txt.gz`)))
  assert.ok(ups.some(p => p.endsWith(`/_support/tickets/${r.ticket.id}/screen.png`)))
  const online = f.meta.get('/_tower/tickets').tickets
  assert.equal(online.length, 1)
  assert.equal(online[0].who, 'Selam'); assert.equal(online[0].status, 'open')
  assert.doesNotMatch(online[0].text, /abc123/)
  // Adal answers (signed), then closes.
  f.meta.set('/_tower/cmds', { cmds: [sign(cmd({ kind: 'ticket_reply', args: { ticket: r.ticket.id, reply_id: 'r1', text: 'Press Prepare first, then CV.' } }))] })
  await T.pollCommands(db, { cloud: f.cloud, me: ME })
  let t = f.meta.get('/_tower/tickets').tickets[0]
  assert.equal(t.status, 'answered'); assert.equal(t.replies[0].text, 'Press Prepare first, then CV.')
  const n = await db('notifications').orderBy('id', 'desc').first()
  assert.match(n.body, /Adal support answered .*Press Prepare first/)
  f.meta.set('/_tower/cmds', { cmds: [sign(cmd({ kind: 'ticket_reply', args: { ticket: r.ticket.id, status: 'closed' } }))] })
  await T.pollCommands(db, { cloud: f.cloud, me: ME })
  t = f.meta.get('/_tower/tickets').tickets[0]
  assert.equal(t.status, 'closed'); assert.equal(t.replies.length, 1)
  assert.equal(T.ticketList()[0].status, 'closed')
})
