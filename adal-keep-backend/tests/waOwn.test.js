/** Own WhatsApp on each PC: off until switched on, only the known program, only agents, a pace; a Companion's page reaches its own PC only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import knex from 'knex'

process.env.ADAL_BEHIND_COMPANION = '1'   // another computer = another loopback address
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'waown-'))
// A pretend program: speaks the same lines, sends nothing anywhere.
const FAKE = path.join(TMP, 'fake.mjs')
fs.writeFileSync(FAKE, `import fs from 'fs'; import readline from 'readline'
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n'); let n = 0
readline.createInterface({ input: process.stdin }).on('line', (l) => { const q = JSON.parse(l)
  if (q.cmd === 'start') { say({ event: 'state', status: 'qr', qr: 'https://wa.me/x' }); setTimeout(() => say({ event: 'state', status: 'ready', me: { number: '251911' } }), 1500) }
  let result = true; if (q.cmd === 'send') { result = 'own_' + (++n); fs.appendFileSync(${JSON.stringify(path.join(TMP, 'sent.txt'))}, q.chat + '|' + q.name + '|' + fs.readFileSync(q.path).length + '\\n'); setTimeout(() => say({ event: 'ack', message_id: result, ack: 2 }), 30) }
  say({ id: q.id, ok: true, result }) }).on('close', () => process.exit(0))`)
process.env.ADAL_WA_HELPER = FAKE
const own = await import('../src/services/waOwn.js')
const { default: routes } = await import('../src/routes/waOwn.js')
const link = await import('../src/services/pcLink.js')
const { up } = await import('../src/migrations/069_whatsapp_sends_who.js')

async function makeDb() {
  const db = knex({ client: 'sqlite3', connection: ':memory:', useNullAsDefault: true, pool: { min: 1, max: 1 } })
  await db.schema.createTable('settings', t => { t.string('key'); t.string('value'); t.string('created_at'); t.string('updated_at') })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name'); t.string('chosen_at'); t.string('musaned_pro') })
  await db.schema.createTable('whatsapp_agents', t => { t.increments('id'); t.string('name'); t.string('chat_id'); t.string('musaned_office'); t.boolean('active') })
  await db.schema.createTable('whatsapp_sends', t => { t.increments('id'); t.integer('profile_id'); t.integer('agent_id'); t.integer('template_id'); t.string('chat_id'); t.string('message_id'); t.string('status'); t.text('error'); t.string('sent_at'); t.string('closed_at'); t.string('user_key') })
  await up(db)
  await db('whatsapp_agents').insert([{ id: 1, name: 'Riyadh', chat_id: 'A@c.us', musaned_office: 'RIYADH OFFICE', active: 1 }, { id: 2, name: 'Jeddah', chat_id: 'B@c.us', active: 1 }])
  return db
}

test('off until switched on; never on a test copy; only the program this version knows is run', async () => {
  const db = await makeDb()
  assert.equal(await own.ownOn(db), false)
  await assert.rejects(own.connect(db), /off/)
  await own.setOwn(db, true); assert.equal(await own.ownOn(db), true)
  await assert.rejects(own.connect(db), /not on this computer yet/, 'another file than the known one')
  for (const [k, v] of [['ADAL_OWN_WHATSAPP', '0'], ['ADAL_ISOLATED', '1'], ['ADAL_WHATSAPP', '0']]) { process.env[k] = v; assert.equal(await own.ownOn(db), false, k); delete process.env[k] }
  const f = path.join(TMP, 'h.mjs'); fs.writeFileSync(f, 'x')
  assert.equal(own.helperReady(f, crypto.createHash('sha256').update('x').digest('hex')), true)
  assert.equal(own.helperReady(f, 'other'), false)
  assert.match(own.HELPER_SHA, /^[0-9a-f]{64}$/)
  await db.destroy()
})

test('the pace: 40 an hour and 150 a day from this WhatsApp, the failed ones not counted', async () => {
  const db = await makeDb(), key = 'pc:x', row = (min, status = 'sent') => ({ user_key: key, status, sent_at: new Date(Date.now() - min * 60_000).toISOString() })
  await db.batchInsert('whatsapp_sends', Array.from({ length: 39 }, () => row(10)), 20)
  await db('whatsapp_sends').insert(row(5, 'failed'))
  assert.equal(await own.paceStop(db, Date.now(), key), '')
  await db('whatsapp_sends').insert(row(1)); assert.match(await own.paceStop(db, Date.now(), key), /40 messages/)
  assert.equal(await own.paceStop(db, Date.now(), 'pc:other'), '')
  await db('whatsapp_sends').update({ sent_at: new Date(Date.now() - 5 * 3600_000).toISOString() })
  assert.equal(await own.paceStop(db, Date.now(), key), '')
  await db.batchInsert('whatsapp_sends', Array.from({ length: 110 }, () => row(300)), 20)
  assert.match(await own.paceStop(db, Date.now(), key), /tomorrow/)
  await assert.rejects(own.sendFile(db, 'A@c.us', {}), /off/)
  await db.destroy()
})

test('she was chosen: kept at the agent who chose her, taken back at the others, marked when it cannot be', async () => {
  const db = await makeDb(), key = 'pc:x', told = []
  await db('profiles').insert({ id: 1, full_name: 'HANNA', chosen_at: '2026-11-20', musaned_pro: 'Riyadh Office' })
  await db('whatsapp_sends').insert([{ profile_id: 1, agent_id: 1, chat_id: 'A@c.us', message_id: 'own_1', status: 'sent', user_key: key }, { profile_id: 1, agent_id: 2, chat_id: 'B@c.us', message_id: 'own_2', status: 'sent', user_key: key },
    { profile_id: 1, agent_id: 2, chat_id: 'B@c.us', message_id: null, status: 'sent', user_key: key }, { profile_id: 1, agent_id: 2, chat_id: 'B@c.us', message_id: 'own_9', status: 'sent', user_key: 'pc:another' }])
  await own.closeChosen(db, { key, ready: () => true, tell: async (c, a) => { told.push(c + ' ' + (a.message_id || '')) } })
  assert.deepEqual((await db('whatsapp_sends').orderBy('id')).map(r => r.status), ['chosen_here', 'withdrawn', 'marked', 'sent'])
  assert.deepEqual(told, ['revoke own_2', 'text '])
  await db.destroy()
})

test('a Companion\'s page on the main PC reaches its own PC, and no other; a file goes once; only that PC answers', async () => {
  link._resetLink()
  const app = express(); app.use(express.json()); app.locals.db = await makeDb()
  app.use((req, res, next) => { const id = req.headers['x-test-pc']; if (id) req.pcAccess = { id, name: id }; next() })
  app.get('/api/ask', (req, res) => link.askPC(req, 'wa.state', { x: 1 }, 2000).then(r => res.json(r), e => res.status(400).json({ error: e.message })))
  const lend = path.join(TMP, 'cv.pdf'); fs.writeFileSync(lend, 'PDFDATA')
  app.get('/api/lend', (req, res) => res.json({ token: link.lendFile(req, lend) }))
  app.use('/api', routes)
  const server = app.listen(0, '0.0.0.0'); await new Promise(r => server.once('listening', r)); const port = server.address().port
  const opts = (p, ip, pc, method = 'GET') => ({ host: '127.0.0.1', port, path: '/api' + p, method, localAddress: ip.replace(/^192/, '127'), headers: { 'x-adal-real-ip': ip, 'content-type': 'application/json', ...(pc ? { 'x-test-pc': pc } : {}) }, agent: false })
  const call = (p, ip, pc, body, method = body ? 'POST' : 'GET') => new Promise((ok) => { const r = http.request(opts(p, ip, pc, method), (res) => { let b = ''; res.on('data', d => { b += d }); res.on('end', () => ok({ s: res.statusCode, b })) }); r.end(body ? JSON.stringify(body) : undefined) })
  const A = '192.168.1.20', B = '192.168.1.21'
  let got = ''
  const stream = http.request(opts('/pc-link/stream', A, 'server-a'), (res) => { res.setEncoding('utf8'); res.on('data', d => { got += d }) }); stream.on('error', () => {}); stream.end()
  for (let i = 0; i < 60 && !/"link"/.test(got); i++) await new Promise(r => setTimeout(r, 20))
  const id = /"link":"([^"]+)"/.exec(got)[1]
  // Its window holds another key, the same computer.
  const asked = call('/ask', A, 'window-a')
  for (let i = 0; i < 60 && !/wa\.state/.test(got); i++) await new Promise(r => setTimeout(r, 20))
  const q = JSON.parse(/data: (\{"id".*\})/.exec(got)[1])
  assert.equal((await call('/pc-link/answer', B, 'server-b', { link: id, id: q.id, ok: true, result: { status: 'ready' } })).s, 403)
  assert.equal((await call('/pc-link/answer', A, 'server-a', { link: id, id: q.id, ok: true, result: { status: 'ready', key: 'pc:a' } })).s, 200)
  assert.deepEqual(JSON.parse((await asked).b), { status: 'ready', key: 'pc:a' })
  assert.match((await call('/ask', B, 'window-b')).b, /not running/)
  const { token } = JSON.parse((await call('/lend', A, 'window-a')).b)
  assert.equal((await call(`/pc-link/file/${token}`, B, 'server-b')).s, 404)
  assert.deepEqual([(await call(`/pc-link/file/${token}`, A, 'server-a')).b, (await call(`/pc-link/file/${token}`, A, 'server-a')).s], ['PDFDATA', 404])
  assert.equal((await call('/pc-link/stream', A, '')).s, 403)
  assert.equal((await call('/whatsapp/own/switch', A, 'window-a', { on: true })).s, 403, 'the switch is the main PC\'s')
  stream.destroy(); server.close(); server.closeAllConnections?.(); await app.locals.db.destroy(); link._resetLink()
})

test('the whole way with a pretend program: QR, signed in, one CV to an agent, a stranger refused, delivered, signed out', async () => {
  // In a copy of the source with the pretend program's own SHA and its own data folder.
  const back = path.join(import.meta.dirname, '..'), dir = path.join(TMP, 'app')
  fs.cpSync(path.join(back, 'src'), path.join(dir, 'src'), { recursive: true })
  fs.copyFileSync(path.join(back, 'package.json'), path.join(dir, 'package.json'))
  fs.symlinkSync(fs.realpathSync(path.join(back, 'node_modules')), path.join(dir, 'node_modules'), 'junction')
  const f = path.join(dir, 'src', 'services', 'waOwn.js')
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/HELPER_SHA = '[0-9a-f]+'/, `HELPER_SHA = '${crypto.createHash('sha256').update(fs.readFileSync(FAKE)).digest('hex')}'`))
  const { pathToFileURL } = await import('node:url')
  const o = await import(pathToFileURL(f).href)
  const { record } = await import(pathToFileURL(path.join(dir, 'src', 'services', 'waRecords.js')).href)
  const db = await makeDb()
  await o.setOwn(db, true)
  await o.connect(db)
  const until = async (fn) => { for (let i = 0; i < 100 && !(await fn()); i++) await new Promise(r => setTimeout(r, 30)); return fn() }
  assert.ok(await until(() => /^data:image\/png/.test(o.ownState().qr || '')), 'the QR')
  assert.ok(await until(() => o.ownState().status === 'ready')); assert.equal(o.ownState().qr, null)
  const pdf = path.join(TMP, 'x.pdf'); fs.writeFileSync(pdf, '%PDF')
  const t = o.ownTransport(db)
  const id = await t.send('A@c.us', { path: pdf, name: 'HANNA.pdf', mime: 'application/pdf', caption: 'HANNA' })
  await record(db, { profile_id: 1, agent_id: 1, message_id: id, status: 'sent', user_key: t.key, sent_at: new Date().toISOString() }, { ack: 1 })
  await assert.rejects(t.send('stranger@c.us', { path: pdf }), /Not one of the agency/)
  assert.equal(fs.readFileSync(path.join(TMP, 'sent.txt'), 'utf8'), 'A@c.us|HANNA.pdf|4\n')
  await o.logout()
  assert.equal(o.ownState().status, 'off'); assert.equal(fs.existsSync(path.join(dir, 'data', 'whatsapp-own')), false)
  await o.setOwn(db, false); await db.destroy()
})
