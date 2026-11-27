/**
 * robotsEverywhere.test.js — a Companion's robots take runs from its own queue only while the main PC is off (45 s
 * without an answer, 120 s never reached) or while it holds the main role; the main PC always; the answer reaches
 * Adal Robots through data/robots-here.json (good for 15 s); ADAL_ROBOTS_HERE forces it, ADAL_ROBOTS_EVERYWHERE=0 off.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-here-'))
process.env.ADAL_ROBOTS_DATA = tmp
const E = await import('../src/services/robotsEverywhere.js')
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
const nodeWith = (st, { main = false } = {}) => ({ roles: { isMain: () => main, holder: () => 'MAIN' }, peerState: new Map(st ? [['MAIN', st]] : []) })

test('the main PC always; a Companion while the main PC is off or it holds the role', () => {
  E._resetForTest()
  const env = {}
  assert.equal(E.decide({ main: true, env }).may, true)
  assert.equal(E.decide({ main: false, full: false, node: nodeWith({ ok: false }), env }).may, false)
  assert.equal(E.decide({ main: false, full: true, node: null, env }).may, false, 'not joined')
  assert.equal(E.decide({ main: false, full: true, node: nodeWith({ ok: true }), env }).may, false, 'the main PC answers: it drives')
  const t0 = Date.now()
  assert.equal(E.decide({ main: false, full: true, node: nodeWith({ ok: false }), env, now: t0 }).may, false, 'just went quiet')
  const r = E.decide({ main: false, full: true, node: nodeWith({ ok: false }), env, now: t0 + 46000 })
  assert.equal(r.may, true); assert.match(r.why, /has not answered for 46 s/)
  assert.equal(E.decide({ main: false, full: true, node: nodeWith({ ok: true }), env, now: t0 + 50000 }).may, false, 'back: the main PC drives again')
  assert.equal(E.decide({ main: false, full: true, node: nodeWith({ ok: false }), env, now: t0 + 60000 }).may, false, 'a fresh 45 s')
  assert.equal(E.decide({ main: false, full: true, node: nodeWith(null, { main: true }), env }).may, true, 'it holds the main role')
  assert.equal(E.decide({ main: false, full: true, node: nodeWith({ ok: false }), env: { ADAL_ROBOTS_EVERYWHERE: '0' } }).may, false)
  assert.equal(E.decide({ main: false, full: false, node: null, env: { ADAL_ROBOTS_HERE: '1' } }).may, true)
  assert.equal(E.decide({ main: true, env: { ADAL_ROBOTS_HERE: '0' } }).may, false)
})

test('Adal Robots reads the answer while it is fresh', () => {
  E._resetForTest()
  const env = {}
  const file = path.join(tmp, 'robots-here.json')
  assert.equal(E.robotsMayRunHere({ env }).may, false, 'nothing said yet')
  fs.writeFileSync(file, JSON.stringify({ may: true, why: 'the main PC has not answered for 50 s', at: Date.now() }))
  assert.equal(E.robotsMayRunHere({ env }).may, true)
  assert.equal(E.robotsMayRunHere({ env, now: Date.now() + 16000 }).may, false, 'stale: not here')
  assert.equal(E.robotsMayRunHere({ main: true, env }).may, true)
  assert.equal(E.robotsMayRunHere({ env: { ADAL_ROBOTS_EVERYWHERE: '0' } }).may, false)
  // The server's writer.
  let st = { ok: true }
  E.startRobotsHere({ main: () => false, full: () => true, node: () => nodeWith(st), log: () => {} })
  assert.equal(E.robotsMayRunHere({ env }).may, false, 'the main PC answers')
  E._resetForTest()
})

test("a Companion's robots take only the runs put in line on that PC", async () => {
  const knex = (await import('knex')).default
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 }, migrations: { directory: new URL('../src/migrations', import.meta.url).pathname } })
  await db.migrate.latest()
  const W = await import('../src/services/worker.js')
  const at = Date.now() * 1000
  const row = (id) => ({ id, workflow_id: 'wafid_check', status: 'pending', profile_id: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  await db('automation_queue').insert([row(at + 0), row(at + 1000 + 7), row(at + 2000 + 3)])   // the main PC's, slot 7's, slot 3's
  try {
    W._setOwnSlotForTest(7)
    assert.equal((await W.claimNextJob(db))?.id, at + 1007)
    assert.equal(await W.claimNextJob(db), null, 'never the main PC\'s or slot 3\'s')
    W._setOwnSlotForTest(-1)
    assert.equal(await W.claimNextJob(db), null, 'not joined: none')
    W._setOwnSlotForTest(null)
    assert.ok([at, at + 2003].includes((await W.claimNextJob(db))?.id), 'the main PC: any')
  } finally { W._setOwnSlotForTest(null); await db.destroy() }
})

test("a Companion's robots drive the Companion's own robot browser, started by the Companion program", { timeout: 60000 }, async (t) => {
  const { findChrome, rmTmp } = await import('./helpers/chrome.js')
  const CHROME = findChrome()
  if (!CHROME) return t.skip('no Chrome')
  const http = await import('http'), { spawn } = await import('child_process')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-cbrowser-'))
  const port = 9300 + Math.floor(Math.random() * 500)
  let chrome = null, asked = 0
  // The Companion program (robot.go): /robot/json/version with its token starts the browser.
  const prog = http.createServer((q, r) => {
    if (q.url.startsWith('/robot/json/version') && q.headers['x-adal-robot'] === 'tok') {
      asked++
      chrome ||= spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${path.join(dir, 'p')}`, '--no-first-run', '--disable-gpu'], { stdio: 'ignore' })
      const wait = async () => { for (let i = 0; i < 100; i++) { try { const v = await fetch(`http://127.0.0.1:${port}/json/version`); if (v.ok) return v.text() } catch {} await new Promise(x => setTimeout(x, 100)) } return '{}' }
      return wait().then(b => r.end(b))
    }
    r.statusCode = 404; r.end()
  })
  await new Promise(r => prog.listen(0, '127.0.0.1', r))
  const saved = { ...process.env }
  Object.assign(process.env, { ADAL_ROBOTS_IN_APP: '1', ADAL_ROBOT_CDP: `http://127.0.0.1:${port}`, ADAL_ROBOT_BROWSER_URL: `http://127.0.0.1:${prog.address().port}/robot`, ADAL_ROBOT_TOKEN: 'tok', ADAL_NO_BROWSER_START: '1' })
  delete process.env.BRAVE_CDP_URL
  t.after(async () => { process.env = saved; prog.close(); chrome?.kill(); await new Promise(x => setTimeout(x, 300)); rmTmp(dir) })
  const B = await import('../src/services/browser.js')
  assert.equal(await B.openBrowserIfAny(), null, 'closed: never started by a look')
  const b = await B.getBrowser()
  assert.equal(asked, 1, 'the Companion program started it')
  assert.ok(b.connected)
  assert.ok((await b.version()).length > 0)
  b.disconnect()
})

test("at a start: this PC's interrupted runs end (none goes on by itself), another PC's live run is left", async () => {
  const knex = (await import('knex')).default
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 }, migrations: { directory: new URL('../src/migrations', import.meta.url).pathname } })
  await db.migrate.latest()
  const W = await import('../src/services/worker.js')
  const now = Date.now(), at = now * 1000
  const row = (id, ago) => ({ id, workflow_id: 'wafid_check', status: 'running', profile_id: 1, log: '[]', created_at: new Date(now).toISOString(), updated_at: new Date(now - ago).toISOString() })
  await db('automation_queue').insert([row(at + 7, 60e3), row(at + 1003, 60e3), row(at + 2003, 20 * 60e3)])   // mine (slot 7), slot 3's live, slot 3's silent
  try {
    const r = await W.endInterruptedRuns(db, { slot: 7, isMain: false, now })
    assert.deepEqual(r, { mine: 1, stale: 1, left: 1 })
    const st = Object.fromEntries((await db('automation_queue').select('id', 'status', 'pause_reason')).map(x => [x.id, x]))
    assert.equal(st[at + 7].status, 'failed'); assert.equal(st[at + 7].pause_reason, W.GONE_NOTE)
    assert.equal(st[at + 1003].status, 'running', "another PC's live run is left to it")
    assert.equal(st[at + 2003].status, 'failed')
  } finally { await db.destroy() }
})
