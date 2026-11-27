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
