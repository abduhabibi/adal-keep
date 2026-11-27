/**
 * officeCompute.test.js — robots on the PC that finishes first (asked on
 * 2026-11-21), human steps as tasks that go after 10 minutes, and the
 * sidebar's Browsers list.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-office-'))
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'vault.key')
process.env.ADAL_KEYS_OUTSIDE = path.join(tmp, 'keys')
process.env.ADAL_SPACES_FILE = path.join(tmp, 'spaces.json')
process.env.ADAL_NO_NET_PROBE = '1'
process.env.ADAL_NO_SOUND = '1'

const { chooseBest, estimate, isLanAddress, placeRun, tabsOnPCs } = await import('../src/services/sharePower.js')
const { summarize, probeOnce } = await import('../src/services/netQuality.js')

const fastNet = { rtt_ms: 80, mbps: 40, ok: 1 }
const slowNet = { rtt_ms: 900, mbps: 1.5, ok: 0.7 }
const main = { id: '', name: 'Front desk', cores: 4, mem_gb: 8, free_gb: 3, load: 60, net: fastNet, lan: true }
const strong = { id: 'S', name: 'Manager PC', cores: 12, mem_gb: 32, free_gb: 20, load: 10, net: fastNet, lan: true }
const weakSlow = { id: 'W', name: 'Old PC', cores: 2, mem_gb: 4, free_gb: 1, load: 70, net: slowNet, lan: true }

test('placement: the stronger, less busy PC gets the run', () => {
  const c = chooseBest({ from: '', pcs: [main, strong, weakSlow] })
  assert.equal(c.to, 'S')
  assert.equal(c.help, true)
  assert.ok(c.secs.S < c.secs[''])
  assert.ok(!('W' in c.secs) || c.secs.W > c.secs[''])
})

test('placement: one run per Companion at a time (ADAL_RUNS_PER_PC for more); Main has no such limit', () => {
  assert.equal(chooseBest({ from: '', pcs: [main, strong], running: { S: 1 } }).to, '')
  assert.equal(chooseBest({ from: '', pcs: [main, strong], running: { S: 0, '': 3 } }).to, 'S')
  process.env.ADAL_RUNS_PER_PC = '2'
  try { assert.equal(chooseBest({ from: '', pcs: [main, strong], running: { S: 1, '': 3 } }).to, 'S') } finally { delete process.env.ADAL_RUNS_PER_PC }
})

test('placement: the PC with the faster internet wins when they are as strong', () => {
  const a = { ...strong, id: 'A', name: 'A', net: slowNet }
  const b = { ...strong, id: 'B', name: 'B', net: fastNet }
  const c = chooseBest({ from: 'A', pcs: [{ ...main, load: 95, free_gb: 1 }, a, b] })
  assert.equal(c.to, 'B')
  assert.match(c.why, /internet/)
})

test('placement: a signed-in tab for that site and account counts (tab reuse)', () => {
  const twin = { ...strong, id: 'T', name: 'Twin' }
  assert.equal(chooseBest({ from: '', pcs: [main, strong, twin], tabs: { T: { signedIn: true } } }).to, 'T')
  // Signed in here already and the other PC only slightly stronger: it stays here.
  const near = { ...main, id: 'N', cores: 7 }
  assert.equal(chooseBest({ from: '', pcs: [{ ...main, cores: 6 }, near], tabs: { '': { signedIn: true } } }).help, false)
})

test('placement: what a PC does already counts; no hopping for a small gain', () => {
  assert.equal(chooseBest({ from: '', pcs: [main, strong], running: { S: 3 } }).to, '')
  assert.equal(chooseBest({ from: '', pcs: [{ ...main, cores: 6 }, { ...main, id: 'M2', cores: 7 }] }).help, false)
})

test('placement: office network only, and an older Companion that says nothing is never given work', () => {
  assert.ok(isLanAddress('192.168.1.7') && isLanAddress('::ffff:10.0.0.3') && isLanAddress('127.0.0.1'))
  assert.ok(!isLanAddress('8.8.8.8') && !isLanAddress('100.64.1.2') && !isLanAddress(''))
  assert.equal(chooseBest({ from: '', pcs: [main, { ...strong, lan: false }] }).help, false)
  assert.equal(chooseBest({ from: '', pcs: [main, { id: 'U', name: 'Unknown', cores: 32 }] }).help, false)
  assert.equal(chooseBest({ from: 'gone', pcs: [main, strong] }).to, 'gone')
  assert.ok(estimate({ ...strong, battery: true }) > estimate(strong))
})

test('a Companion off the office network is not registered', async () => {
  const rb = await import('../src/services/remoteBrowsers.js')
  rb._resetForTest()
  assert.equal(rb.registerDevice({ id: 'x' }, '8.8.4.4', { token: 'b'.repeat(32) }).ok, false)
  assert.equal(rb.registerDevice({ id: 'y' }, '192.168.0.9', { token: 'b'.repeat(32), mem_gb: 16, net_rtt_ms: 120, net_mbps: 20, net_ok: 1 }).ok, true)
  assert.deepEqual(rb.liveDevices()[0].net, { rtt_ms: 120, mbps: 20, ok: 1 })
  rb._resetForTest()
})

// A tiny stand-in for knex: one table, where/first/select/update.
function fakeDb(rows) {
  const q = (list) => ({
    where(k, v) { return q(list.filter(r => typeof k === 'object' ? Object.entries(k).every(([a, b]) => r[a] === b) : r[k] === v)) },
    whereNot(k, v) { return q(list.filter(r => r[k] !== v)) },
    orderBy() { return this },
    first() { return Promise.resolve(list[0]) },
    select() { return Promise.resolve(list) },
    update(ch) { for (const r of list) Object.assign(r, ch); return Promise.resolve(list.length) },
  })
  return (t) => q(t === 'automation_queue' ? rows : [])
}

test('placeRun writes where the run works and says why in its log', async () => {
  const rows = [{ id: 7, workflow_id: 'musaned_contract', status: 'pending', context: '{}' }]
  const line = await placeRun(fakeDb(rows), { ...rows[0] }, { pcs: [main, strong], tabs: {} })
  assert.match(line, /Manager PC .* does this run: about/)
  const { open } = await import('../src/services/accountVault.js')
  const ctx = JSON.parse(open ? open(rows[0].context) : rows[0].context)
  assert.equal(ctx.on_device, 'S')
  assert.equal(ctx.quiet, 1)
  assert.equal(ctx.placed, 1)
  // Once only.
  assert.equal(await placeRun(fakeDb(rows), { ...rows[0], context: JSON.stringify(ctx) }, { pcs: [main, strong], tabs: {} }), '')
})

test('tabsOnPCs: an open, signed-in tab of the run\'s site in the same account', async () => {
  const page = (url, own = true) => ({ url: () => url, browser: () => ({ defaultBrowserContext: () => 'D' }), browserContext: () => own ? 'D' : 'X' })
  const browsers = [
    { device: '', browser: { pages: async () => [page('https://lmis.gov.et/auth/login')] } },
    { device: 'S', browser: { pages: async () => [page('https://www.musaned.com.sa/home'), page('https://lmis.gov.et/home', false)] } },
  ]
  const db = (t) => ({ orderBy() { return this }, first: async () => ({ id: 1 }) })
  assert.deepEqual(await tabsOnPCs(db, { workflow_id: 'musaned_contract', account_id: 1 }, { browsers, spaceOf: () => '' }), { S: { signedIn: true } })
  assert.deepEqual(await tabsOnPCs(db, { workflow_id: 'lmis_upload', account_id: 1 }, { browsers, spaceOf: () => 'lmis:2' }), { '': { signedIn: false } })
})

test('the internet is measured: answer time, speed, how often it answers', async () => {
  assert.equal(summarize([]), null)
  const s = summarize([{ ok: true, first: 100, ms: 200, bytes: 125000 }, { ok: false }, { ok: true, first: 300, ms: 400, bytes: 10 }, { ok: true, first: 200, ms: 300, bytes: 125000 }])
  assert.equal(s.rtt_ms, 200)
  assert.equal(s.ok, 0.75)
  assert.ok(Math.abs(s.mbps - 10) < 0.2)
  const fake = async (url) => { if (/down/.test(url)) throw new Error('no'); return { status: 200, body: null } }
  const got = await probeOnce({ fetchFn: fake, hosts: ['https://up.test/', 'https://down.test/'] })
  assert.deepEqual(got.map(g => g.ok), [true, false])
})

test('a human step is a task: grouped per run, gone after 10 minutes, and its run is paused', async () => {
  const A = await import('../src/services/attention.js')
  const W = await import('../src/services/worker.js')
  const { isCancelled, clearCancelled } = await import('../src/services/cancellation.js')
  const rows = [{ id: 501, status: 'running' }, { id: 502, status: 'paused' }]
  W._hookTaskExpiryForTest(fakeDb(rows))
  A.needPerson(501, 'Sign in to Musaned')
  A.askCaptcha(501, null, async () => {}, { title: 'Type the SMS code', label: 'Code' })
  A.needPerson(502, 'Pick a time slot on Tasheer')
  let w = A.waiting()
  const t501 = w.find(x => x.run_id === 501)
  assert.equal(t501.step, 2)                               // its 2nd human step
  assert.equal(t501.kind, 'code')
  assert.equal(w.find(x => x.run_id === 502).kind, 'slot')
  assert.ok(t501.expires_in_ms > 9 * 60e3 && t501.expires_in_ms <= A.TASK_MS)
  // The tick's window and the pause are the same 10 minutes.
  assert.equal(A.TASK_MS, 10 * 60e3)
  assert.match(W.NO_ANSWER, /^No answer for 10 minutes/)
  // 9 minutes later: still there.
  assert.equal(A.expireTasks(Date.now() + 9 * 60e3).length, 0)
  // A person at the tab then: it stays, as long again at most.
  A.keepWhile(id => id === 501)
  assert.deepEqual(A.expireTasks(Date.now() + A.TASK_MS + 500).map(g => g.run_id), [502])
  A.keepWhile(() => false)
  A.needPerson(502, 'Pick a time slot on Tasheer')
  // 10 minutes later: gone, and the running run stops before its next step, as paused.
  const gone = A.expireTasks(Date.now() + A.TASK_MS + 1000)
  assert.deepEqual(gone.map(g => g.run_id).sort(), [501, 502])
  assert.equal(A.waiting().filter(x => [501, 502].includes(x.run_id)).length, 0)
  await new Promise(r => setTimeout(r, 20))
  assert.ok(isCancelled(501) && W.pausedForNoAnswer(501))
  assert.ok(!isCancelled(502))                            // paused already: only its task went
  clearCancelled(501)
})

test('one gentle sound per run, not per step', async () => {
  const W = await import('../src/services/worker.js')
  W._forgetBeep(9001)
  assert.equal(W.beepFor(9001), true)
  assert.equal(W.beepFor(9001), false)
  assert.equal(W.beepFor(9001), false)
  W._forgetBeep(9001)
})

test('Browsers lists every robot browser, the other PCs\' too', async () => {
  const knex = (await import('knex')).default
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await db.schema.createTable('profiles', t => { t.increments('id'); t.string('full_name') })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.integer('profile_id'); t.string('workflow_id'); t.string('status'); t.text('context'); t.string('pause_reason'); t.string('started_at'); t.string('updated_at') })
  await db('profiles').insert([{ id: 1, full_name: 'Amina Ali' }, { id: 2, full_name: 'Sara Bekele' }])
  const now = new Date().toISOString()
  await db('automation_queue').insert([
    { id: 11, profile_id: 1, workflow_id: 'musaned_contract', status: 'running', context: JSON.stringify({ on_device: 'S' }), started_at: now, updated_at: now },
    { id: 12, profile_id: 2, workflow_id: 'tasheer_book', status: 'paused', context: '{}', started_at: now, updated_at: now },
    { id: 13, profile_id: 2, workflow_id: 'wafid_book', status: 'done', context: '{}', started_at: now, updated_at: now },
  ])
  const { listBrowsers, registerLiveTab, _resetForTest } = await import('../src/services/robotBrowsers.js')
  _resetForTest()
  registerLiveTab('tr-pextran', { isClosed: () => false, once() {} }, { site: 'Pextran', girl: 'Transition', pc_id: 'S', status: 'Sign in', needs_you: true })
  const list = await listBrowsers(db, { devices: [{ id: 'S', name: 'Manager PC' }], waiting: [{ run_id: 12, title: 'Pick a time slot' }], hasTab: () => true, hostname: 'Front desk' })
  const by = Object.fromEntries(list.map(b => [b.key, b]))
  assert.deepEqual(Object.keys(by).sort(), ['11', '12', 'tr-pextran'])
  assert.deepEqual([by['11'].site, by['11'].girl, by['11'].pc, by['11'].remote, by['11'].status], ['Musaned', 'Amina Ali', 'Manager PC', true, 'Working'])
  assert.deepEqual([by['12'].site, by['12'].pc, by['12'].needs_you, by['12'].task], ['Tasheer', 'Front desk', true, 'Pick a time slot'])
  assert.equal(by['tr-pextran'].pc, 'Manager PC')
  _resetForTest()
  await db.destroy()
})

test('placement: a weak PC (4 cores or fewer) gives its robots to a stronger PC of the office, however small the gain', () => {
  const weak = { ...main, cores: 4 }
  const near = { ...main, id: 'N', name: 'Near', cores: 4, load: 55, free_gb: 6, mem_gb: 8 }
  const c = chooseBest({ from: '', pcs: [weak, near] })
  assert.equal(c.to, 'N'); assert.equal(c.help, true); assert.match(c.why, /weak/)
  // a normal PC (more than 4 cores) keeps its own for a small gain
  assert.equal(chooseBest({ from: '', pcs: [{ ...main, cores: 6 }, { ...near, cores: 7 }] }).help, false)
  // a weak PC alone, or with only weak neighbours, does its own work
  assert.equal(chooseBest({ from: '', pcs: [weak] }).help, false)
  assert.equal(chooseBest({ from: '', pcs: [weak, { ...weakSlow, id: 'W2' }] }).help, false)
  // never to a PC that is itself weak or busy
  assert.equal(chooseBest({ from: '', pcs: [weak, { ...near, load: 95 }] }).help, false)
})
