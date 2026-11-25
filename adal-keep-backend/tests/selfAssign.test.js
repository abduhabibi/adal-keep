/**
 * selfAssign.test.js — a run chooses the best PC of the office by itself (the owner, 2026-11-25), in under a second,
 * nobody asked: the Companions known to the program that runs the robots, each asked how it is just before; the next
 * best one, then this PC, when it cannot be reached; a PC that goes away ends the run (one try). No browser here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-assign-'))
Object.assign(process.env, { ADAL_ROBOTS_DATA: tmp, ACCOUNT_VAULT_KEY: path.join(tmp, 'v.key'), ADAL_SPACES_FILE: path.join(tmp, 's.json'), BRAVE_CDP_URL: 'http://127.0.0.1:9', ADAL_NO_BROWSER_START: '1', ADAL_NO_NET_PROBE: '1' })
fs.writeFileSync(process.env.ACCOUNT_VAULT_KEY, (await import('crypto')).randomBytes(32).toString('base64'))
delete process.env.ADAL_LAN_ROBOTS
const rb = await import('../src/services/remoteBrowsers.js')
const pcs = await import('../src/services/robotPCs.js')
const { selfAssign } = await import('../src/services/selfAssign.js')
const sp = await import('../src/services/sharePower.js')
const homes = await import('../src/services/signInHome.js')
test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }) })
const T = 'a'.repeat(32)
const MAIN = { id: '', name: 'Main', version: 'd1f23ee', cores: 2, mem_gb: 7.5, free_gb: 1, load: 95, lan: true }
const STRONG = { id: 'C', name: '10RD4GN', cores: 8, mem_gb: 16, free_gb: 9, load: 12, lan: true, answers: true, version: 'other', at: Date.now() }
const MID = { ...STRONG, id: 'M', name: 'MID', cores: 4, mem_gb: 8, free_gb: 4, load: 30 }
const fakeDb = (rows) => { const f = () => { const q = { where: () => q, select: async () => rows, first: async () => rows[0], update: async (o) => { Object.assign(rows[0], o) } }; return q }; return f }
const job = (ctx = {}) => ({ id: 1, workflow_id: 'musaned_add_candidate', account_id: 3, context: JSON.stringify(ctx) })

test('a 2-core main PC: its run goes to the strongest PC that answers, whatever release it is on', async () => {
  const rows = [{ id: 1, context: '{}' }], j = job()
  const line = await selfAssign(fakeDb(rows), j, { pcs: [MAIN, MID, STRONG], tabs: {}, running: {}, home: null })
  const ctx = JSON.parse(j.context)
  assert.equal(ctx.on_device, 'C'); assert.deepEqual(ctx.place_order, ['M']); assert.equal(ctx.quiet, 1)
  assert.match(line, /10RD4GN .*by itself, out of sight there/)
  assert.equal(await selfAssign(fakeDb(rows), j, { pcs: [MAIN, STRONG], tabs: {}, running: {}, home: null }), '', 'once for a run')
})

test('where the account is signed in counts; a busy, small, updating or browserless PC is not given it; alone: here', async () => {
  const on = async (list, opt = {}) => { const j = job(); await selfAssign(fakeDb([{ id: 1 }]), j, { pcs: list, tabs: {}, running: {}, home: null, ...opt }); return JSON.parse(j.context).on_device || '' }
  const MAIN8 = { ...MAIN, cores: 8, load: 40, free_gb: 5, mem_gb: 16 }
  const A = { ...STRONG, id: 'A' }, B = { ...STRONG, id: 'B', load: 25 }
  assert.equal(await on([MAIN, A, B]), 'A')
  assert.equal(await on([MAIN, A, B], { home: 'B' }), 'B', 'a person signed this account in there')
  assert.equal(await on([MAIN8, A], { home: '' }), '', 'signed in here, and here is able')
  assert.equal(await on([MAIN, A, B], { running: { A: 1 } }), 'B')
  assert.equal(await on([MAIN, { ...A, updating: true }]), '')
  assert.equal(await on([MAIN, { ...A, browser: false }]), '')
  assert.equal(await on([MAIN, { ...A, cores: 2 }]), '')
  assert.equal(await on([MAIN]), '')
  // Not answering (an older one, on another release): as before, not given it.
  assert.equal(await on([MAIN, { ...A, answers: false }]), '')
  process.env.ADAL_LAN_ROBOTS = '0'
  assert.equal(await on([MAIN, A]), '', 'the emergency switch')
  delete process.env.ADAL_LAN_ROBOTS
})

test('the Companions Adal Keep heard are known to Adal Robots; each is asked how it is, in under a second', async () => {
  let load = 10, asked = 0
  const up = http.createServer((q, r) => { asked++; if (q.headers['x-adal-robot'] !== T) { r.statusCode = 404; return r.end() } r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ cores: 8, mem_gb: 16, free_gb: 9, load, updating: false, browser: true, version: 'zzz' })) })
  const old = http.createServer((q, r) => { r.statusCode = 404; r.end() })
  const hung = http.createServer(() => {})
  for (const s of [up, old, hung]) await new Promise(r => s.listen(0, '127.0.0.1', r))
  const port = (s) => s.address().port
  rb._resetForTest(); pcs._resetForTest()
  // Adal Keep's side.
  rb.registerDevice({ id: 'UP', name: 'UP' }, '127.0.0.1', { token: T, port: port(up), cores: 8, mem_gb: 16, free_gb: 8, load: 90, version: 'zzz' })
  await new Promise(r => setTimeout(r, 20))
  rb.registerDevice({ id: 'OLD', name: 'OLD' }, '127.0.0.1', { token: T, port: port(old), cores: 8 })
  rb.registerDevice({ id: 'HUNG', name: 'HUNG' }, '127.0.0.1', { token: T, port: port(hung), cores: 8 })
  await new Promise(r => setTimeout(r, 2300))
  const f = path.join(tmp, 'robot-pcs.json')
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).length, 3)
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o77, 0, 'this user only: it holds tokens')
  // Adal Robots' side: another program, an empty memory; the last announcement 5 minutes ago.
  rb._resetForTest(); pcs._resetForTest()
  const list = JSON.parse(fs.readFileSync(f, 'utf8')).map(d => ({ ...d, at: Date.now() - 5 * 60e3 }))
  fs.writeFileSync(f, JSON.stringify(list))
  process.env.ADAL_ROBOT_PROCESS = '1'
  const t0 = Date.now()
  const got = await rb.askDevices(600)
  const ms = Date.now() - t0
  console.log(`three PCs asked in ${ms} ms (one hangs)`)
  assert.ok(ms < 900)
  assert.deepEqual(got.map(d => [d.id, d.answers]).sort(), [['OLD', false], ['UP', true]], 'a hung one is not there')
  assert.equal(got.find(d => d.id === 'UP').load, 10, 'how it is now, not what it said 5 minutes ago')
  assert.equal(got.some(d => d.token), false)
  assert.equal(rb.deviceLive('UP'), true, 'heard from now'); assert.equal(rb.deviceLive('OLD'), false)
  // The whole decision, as a run makes it.
  const j = job(), t1 = Date.now()
  await selfAssign(fakeDb([{ id: 1 }]), j)
  console.log(`decided in ${Date.now() - t1} ms`)
  assert.ok(Date.now() - t1 < 1000)
  delete process.env.ADAL_ROBOT_PROCESS
  for (const s of [up, old, hung]) { s.closeAllConnections(); s.close() }
})

test('a PC switched off closes nothing: its browser is let go after it missed 3 looks', async () => {
  let version = async () => 'Chrome', let_go = 0
  const b = { connected: true, target: () => ({ createCDPSession: async () => ({ send: () => version() }) }), disconnect: async () => { let_go++; b.connected = false } }
  const t = rb.watchOver(b, { name: 'X' }, { everyMs: 250, misses: 3 })
  await new Promise(r => setTimeout(r, 900))
  assert.equal(let_go, 0)
  version = () => new Promise(() => {})
  await new Promise(r => setTimeout(r, 1600))
  assert.equal(let_go, 1)
  clearInterval(t)
})

test('an account\'s home: remembered 12 hours', () => {
  assert.equal(homes.homeOf('musaned', 3), null)
  homes.rememberHome('musaned', 3, 'C')
  assert.equal(homes.homeOf('musaned', 3), 'C'); assert.equal(homes.homeOf('musaned', 4), null)
  assert.equal(homes.homeOf('musaned', 3, Date.now() + homes.HOME_MS + 1), null)
})

test('moves and CV PDFs stay on this PC', async () => {
  assert.equal(await sp.helperForPdf(), null)
  assert.deepEqual(await sp.placeTransition('https://example.org', { from: '' }), { to: '' })
})

test('the person\'s 10 minutes: the same everywhere, and nobody is cut off while at the tab', async () => {
  const A = await import('../src/services/attention.js')
  const W = await import('../src/services/worker.js')
  assert.equal(A.TASK_MS, 10 * 60e3)
  assert.match(W.NO_ANSWER, /10 minutes/)
  A.needPerson(9001, 'tick "I\'m not a robot"')
  assert.equal(A.expireTasks(Date.now() + 9.9 * 60e3).length, 0)
  A.keepWhile((id) => id === 9001)
  assert.equal(A.expireTasks(Date.now() + 10.1 * 60e3).length, 0, 'a person is at its tab')
  assert.equal(A.expireTasks(Date.now() + 20.1 * 60e3).length, 1, 'not for ever')
  A.keepWhile(() => false)
})
