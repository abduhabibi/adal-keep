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
