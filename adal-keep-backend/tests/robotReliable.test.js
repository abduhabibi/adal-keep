/**
 * robotReliable.test.js — 2026-11-23 robot faults seen in the office:
 *  - two Musaned runs of one account worked side by side in two tabs: runs of one site and account
 *    now wait for each other (lanes), so they queue on the site's one tab;
 *  - a run on Main went to a Companion still on an old release, sat on a blank page 5 minutes and
 *    failed after 307 s: never to a Companion on another release, installing an update or silent;
 *    Musaned's first page gets one try of 60 s and a reason a person can act on.
 * No browser, no database.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.JEV_ENABLED = 'false'
// (this PC's own licence file must not lock the worker in the test)
process.env.HOME = (await import('fs')).mkdtempSync((await import('path')).join((await import('os')).tmpdir(), 'rr-home-'))
const { createRunQueue } = await import('../src/services/runQueue.js')
const { chooseBest, ready } = await import('../src/services/sharePower.js')
const { unreachable } = await import('../src/services/musanedWorkflow.js')
const rb = await import('../src/services/remoteBrowsers.js')
const { laneOf } = await import('../src/services/worker.js')

const quiet = () => {}
const tick = () => new Promise(r => setTimeout(r, 10))

test('laneOf: a site and its account', () => {
  assert.equal(laneOf({ workflow_id: 'musaned_add_candidate', account_id: 3 }), 'musaned:3')
  assert.equal(laneOf({ workflow_id: 'musaned_check_chosen', context: JSON.stringify({ account_id: 3 }) }), 'musaned:3')
  assert.equal(laneOf({ workflow_id: 'musaned_check_chosen' }), 'musaned:main')
  assert.equal(laneOf({ workflow_id: 'lmis_add_labour', account_id: 2 }), 'lmis:2')
  assert.equal(laneOf({ workflow_id: 'make_cv' }), '')
})

test('a second run of the same site and account waits for the first, even while the first waits for a code', async () => {
  const jobs = [
    { id: 1, workflow_id: 'musaned_add_candidate', account_id: 3 },
    { id: 2, workflow_id: 'musaned_import', account_id: 3 },
    { id: 3, workflow_id: 'lmis_add_labour', account_id: 1 },
  ]
  const pending = [...jobs], started = [], finish = new Map()
  const q = createRunQueue({
    max: 1, log: quiet, warn: quiet, laneOf,
    isIdle: (id) => id === 1,   // run 1 waits for a person (a code): it holds no slot …
    claimNext: async (exclude, lanes) => {
      const i = pending.findIndex(j => !exclude.includes(j.id) && !lanes.has(laneOf(j)))
      return i < 0 ? null : pending.splice(i, 1)[0]
    },
    runJob: (job) => { started.push(job.id); return new Promise(r => finish.set(job.id, r)) },
  })
  await q.drain(); await tick()
  // … so the LMIS run starts, but the second Musaned run of the same account does not (one tab, one run).
  assert.deepEqual(started, [1, 3])
  finish.get(3)(); await tick(); await q.drain(); await tick()
  assert.deepEqual(started, [1, 3])
  finish.get(1)(); await tick(); await q.drain(); await tick()
  assert.deepEqual(started, [1, 3, 2])
})

const now = Date.now()
const main = { id: '', name: 'Main', version: 'aaaaaaa', cores: 2, mem_gb: 4, free_gb: 1, load: 70 }
const companion = { id: 'C', name: 'DESKTOP-10RD4GN', version: 'aaaaaaa', cores: 8, mem_gb: 16, free_gb: 8, load: 10, at: now }

test('ready(): never a Companion on another release, installing an update, or silent for 45 s', () => {
  assert.equal(ready(companion, main, now), true)
  assert.equal(ready({ ...companion, version: '4af9140' }, main, now), false)
  assert.equal(ready({ ...companion, version: null }, main, now), false)
  assert.equal(ready({ ...companion, updating: true }, main, now), false)
  assert.equal(ready({ ...companion, at: now - 60e3 }, main, now), false)
  assert.equal(ready(companion, { ...main, version: null }, now), true)   // a PC without a release (a developer's) asks nothing
  assert.equal(ready(main, main, now), true)
})

test('a weak Main gives its run to a ready Companion only', () => {
  assert.equal(chooseBest({ from: '', pcs: [main, companion] }).to, 'C')
  assert.equal(chooseBest({ from: '', pcs: [main, { ...companion, version: '4af9140' }] }).to, '')
  assert.equal(chooseBest({ from: '', pcs: [main, { ...companion, updating: true }] }).to, '')
})

test('freeStrongDevice: not one on another release or updating', () => {
  rb._resetForTest()
  process.env.ADAL_LAN_ROBOTS = '1'   // (the hand-off over the LAN is off unless switched on: ce98582)
  const reg = (id, body) => rb.registerDevice({ id, name: id }, '192.168.1.20', { token: 'x'.repeat(20), cores: 8, ...body })
  reg('OLD', { version: '4af9140' })
  reg('UPD', { version: 'aaaaaaa', updating: true })
  assert.equal(rb.freeStrongDevice(new Set(), Date.now(), 'aaaaaaa'), '')
  reg('NEW', { version: 'aaaaaaa' })
  assert.equal(rb.freeStrongDevice(new Set(), Date.now(), 'aaaaaaa'), 'NEW')
  assert.equal(rb.liveDevices().find(d => d.id === 'UPD').updating, true)
  rb._resetForTest()
})

test("Musaned's first page: a reason a person can act on", () => {
  assert.match(unreachable(new Error('Navigation timeout of 60000 ms exceeded')), /no answer in 60 s/)
  assert.match(unreachable(new Error('Attempted to use detached Frame')), /tab stopped answering/)
  assert.match(unreachable(new Error('Runtime.callFunctionOn timed out.')), /tab stopped answering/)
  assert.match(unreachable(new Error('net::ERR_INTERNET_DISCONNECTED at https://tawtheeq.musaned.com.sa/')), /not on the internet/)
})

test("Tasheer: Cloudflare's hard block is not a box to tick (live page text, 2026-11-23)", async () => {
  const { blockedText, challengeText } = await import('../src/services/tasheer.js')
  const live = 'Attention Required! | Cloudflare Sorry, you have been blocked You are unable to access agents.tasheer.com Why have I been blocked?'
  assert.equal(blockedText(live), true)
  assert.equal(challengeText(live), false)
  assert.equal(challengeText('Just a moment... Verify you are human by completing the action below.'), true)
  assert.equal(blockedText('Login Username Password'), false)
})

test('a run paused at the sign-in (a captcha) holds back the next run of its site and account, not other ones', async () => {
  const { claimNextJob, signInLanes, _setTabLiveForTest } = await import('../src/services/worker.js')
  _setTabLiveForTest((id) => id === 1)   // run 1's tab is open
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    await db.schema.createTable('automation_queue', t => {
      t.increments('id'); t.string('workflow_id'); t.integer('profile_id'); t.integer('account_id'); t.text('context')
      t.string('status'); t.string('pause_reason'); t.string('updated_at'); t.string('started_at'); t.text('log')
    })
    const now = new Date().toISOString()
    await db('automation_queue').insert([
      { workflow_id: 'musaned_add_candidate', account_id: 1, status: 'paused', pause_reason: 'awaiting-musaned-captcha', updated_at: now },
      { workflow_id: 'musaned_add_candidate', account_id: 1, status: 'pending', updated_at: now },
      { workflow_id: 'lmis_add_labour', account_id: 4, status: 'pending', updated_at: now },
      { workflow_id: 'musaned_add_candidate', account_id: 2, status: 'paused', pause_reason: 'awaiting-human-save', updated_at: now },
    ])
    assert.deepEqual([...await signInLanes(db)], ['musaned:1'])
    // A sign-in nobody answered in 5 minutes holds its account too while its tab waits at the box.
    const { NO_ANSWER } = await import('../src/services/worker.js')
    const [nid] = await db('automation_queue').insert({ workflow_id: 'musaned_add_candidate', account_id: 3, status: 'paused', pause_reason: NO_ANSWER, updated_at: now })
    _setTabLiveForTest((id) => id === 1 || id === nid)
    assert.deepEqual([...await signInLanes(db)].sort(), ['musaned:1', 'musaned:3'])
    await db('automation_queue').where('id', nid).del()
    _setTabLiveForTest((id) => id === 1)
    const first = await claimNextJob(db)
    assert.equal(first.workflow_id, 'lmis_add_labour')          // the second Musaned run of account 1 waits
    assert.equal(await claimNextJob(db), null)
    // The person signed in: the paused run went on and ended; the next one starts.
    await db('automation_queue').where('id', 1).update({ status: 'done' })
    assert.equal((await claimNextJob(db)).id, 2)
  } finally { _setTabLiveForTest(null); await db.destroy() }
})

test("a run waiting for a sign-in whose browser is gone holds nothing and goes back in line; past 6 h it ends", async () => {
  const { claimNextJob, signInLanes, reviveSignIns, _setTabLiveForTest } = await import('../src/services/worker.js')
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  _setTabLiveForTest(() => false)   // the robot browser died: no tab of any run
  try {
    await db.schema.createTable('automation_queue', t => {
      t.increments('id'); t.string('workflow_id'); t.integer('profile_id'); t.integer('account_id'); t.text('context')
      t.string('status'); t.string('pause_reason'); t.string('updated_at'); t.string('started_at'); t.string('finished_at'); t.text('log')
    })
    const now = Date.now(), iso = (ms) => new Date(ms).toISOString()
    await db('automation_queue').insert([
      { workflow_id: 'musaned_add_candidate', account_id: 1, status: 'paused', pause_reason: 'awaiting-musaned-login', updated_at: iso(now - 5 * 60e3) },
      { workflow_id: 'musaned_add_candidate', account_id: 1, status: 'paused', pause_reason: 'awaiting-musaned-captcha', updated_at: iso(now - 7 * 3600e3) },
      { workflow_id: 'musaned_add_candidate', account_id: 1, status: 'paused', pause_reason: 'awaiting-human-save', updated_at: iso(now) },
    ])
    assert.equal((await signInLanes(db)).size, 0)
    assert.deepEqual(await reviveSignIns(db, now), { back: 1, ended: 1 })
    const rows = await db('automation_queue').orderBy('id')
    assert.deepEqual(rows.map(r => r.status), ['pending', 'cancelled', 'paused'])
    assert.equal(rows[0].pause_reason, 'awaiting-musaned-login')   // it goes on from its step
    assert.match(rows[1].pause_reason, /within 6 hours/)
    assert.equal((await claimNextJob(db)).id, 1)
  } finally { _setTabLiveForTest(null); await db.destroy() }
})

test('at most a few forms wait for Save per site and account: the next run waits in line', async () => {
  process.env.ADAL_MAX_SAVE_WAITING = '2'
  const { claimNextJob, _setTabLiveForTest } = await import('../src/services/worker.js')
  const { default: knex } = await import('knex')
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  _setTabLiveForTest(() => true)
  try {
    await db.schema.createTable('automation_queue', t => {
      t.increments('id'); t.string('workflow_id'); t.integer('profile_id'); t.integer('account_id'); t.text('context')
      t.string('status'); t.string('pause_reason'); t.string('updated_at'); t.string('started_at'); t.string('finished_at'); t.text('log')
    })
    const now = new Date().toISOString()
    await db('automation_queue').insert([
      { workflow_id: 'musaned_add_candidate', account_id: 1, status: 'paused', pause_reason: 'awaiting-human-save', updated_at: now },
      { workflow_id: 'musaned_add_candidate', account_id: 1, status: 'paused', pause_reason: 'awaiting-human-save', updated_at: now },
      { workflow_id: 'musaned_add_candidate', account_id: 1, status: 'pending', updated_at: now },
      { workflow_id: 'wafid_slip', status: 'pending', updated_at: now },
    ])
    assert.equal((await claimNextJob(db)).workflow_id, 'wafid_slip')     // Musaned waits: 2 forms wait for Save
    assert.equal(await claimNextJob(db), null)
    await db('automation_queue').where('id', 1).update({ status: 'done' })   // a person saved one
    assert.equal((await claimNextJob(db)).id, 3)
  } finally { delete process.env.ADAL_MAX_SAVE_WAITING; _setTabLiveForTest(null); await db.destroy() }
})
