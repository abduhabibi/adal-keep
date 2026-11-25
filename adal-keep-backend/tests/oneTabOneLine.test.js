/**
 * oneTabOneLine.test.js — 2026-11-25, Main (Windows), four failures seen live:
 *  A  the sign-in tab answered nothing any more (a page that waits for a synchronous request that never comes does
 *     exactly that, call by call): found, closed, its sign-in opened fresh; a person's form is never closed.
 *  B  three waiting Musaned runs each "found" the one sign-in tab; the next run started in it.
 *  C  two runs "started" in the same second, again and again (the robot browser was closed, both were put back).
 *  D  runs a person had pressed waited for ever for the browser to be open.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { findChrome, rmTmp } from './helpers/chrome.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-onetab-'))
Object.assign(process.env, { SQLITE_PATH: path.join(tmp, 's.sqlite'), ADAL_NO_BROWSER_START: '1', ADAL_ROBOTS_IN_APP: '1', ACCOUNT_VAULT_KEY: path.join(tmp, 'v.key'), SECRETS_PATH: path.join(tmp, 's.enc'), BRAVE_CDP_URL: 'http://127.0.0.1:9', JEV_ENABLED: 'false' })
fs.writeFileSync(process.env.ACCOUNT_VAULT_KEY, Buffer.alloc(32, 1).toString('base64'))
const CHROME = findChrome()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function makeDb(name) {
  const { openRows } = await import('../src/services/accountVault.js')
  const db = (await import('knex')).default({ client: 'sqlite3', connection: { filename: path.join(tmp, name) }, useNullAsDefault: true, postProcessResponse: openRows })
  await db.schema.createTable('automation_queue', t => { t.increments('id'); t.integer('profile_id'); t.integer('account_id'); t.string('workflow_id'); t.string('status'); t.text('context'); t.string('pause_reason'); t.text('log'); t.integer('priority').defaultTo(0); t.string('started_at'); t.string('finished_at'); t.string('created_at'); t.string('updated_at') })
  return db
}
const row = (o) => { const now = new Date().toISOString(); return { profile_id: 1, account_id: 1, workflow_id: 'musaned_add_candidate', status: 'pending', context: '{"account_id":1}', log: '[]', created_at: now, updated_at: now, ...o } }
const AUTO = JSON.stringify([{ msg: 'Auto-discovered by scanner — first stage' }])

test('B: the second run of an account waits while the first works — also when another program of this PC started it', async (t) => {
  const db = await makeDb('b.sqlite'); t.after(() => db.destroy())
  const w = await import('../src/services/worker.js')
  await db('automation_queue').insert([row({ status: 'running', started_at: new Date().toISOString() }), row({}), row({ account_id: 2, context: '{"account_id":2}' })])
  const next = await w.claimNextJob(db)
  assert.equal(next?.id, 3, 'another account\'s run starts; the same account\'s waits in line')
  assert.equal(await w.claimNextJob(db, [3]), null)
  await db('automation_queue').where('id', 1).update({ status: 'done' })
  await db('automation_queue').where('id', 3).update({ status: 'done' })
  assert.equal((await w.claimNextJob(db))?.id, 2, 'once the first ended')
})

test('C + D: the scanner\'s run waits in line while the robot browser is closed, not started; a person\'s starts', async (t) => {
  const db = await makeDb('c.sqlite'); t.after(() => db.destroy())
  const w = await import('../src/services/worker.js')
  const { nobodyAsked, personAsked } = await import('../src/services/personPress.js')
  await db('automation_queue').insert([row({ log: AUTO }), row({ account_id: 2, context: '{"account_id":2}', log: AUTO })])
  const asked = []
  const wait = async (r) => { asked.push(r.id); await db('automation_queue').where('id', r.id).update({ pause_reason: 'Waiting for Adal Browser to be open', updated_at: new Date(Date.now() + 120e3).toISOString() }); return true }
  assert.equal(await w.claimNextJob(db, [], new Set(), { wait }), null, 'none is started')
  assert.deepEqual(asked, [1, 2])
  assert.deepEqual((await db('automation_queue').select('status')).map(r => r.status), ['pending', 'pending'])
  // A person presses Continue on a waiting one: it starts now, and stays a person's through a restart.
  const r1 = await db('automation_queue').where('id', 1).first()
  assert.equal(nobodyAsked(r1), true)
  await personAsked(db, r1)
  const r2 = await db('automation_queue').where('id', 1).first()
  assert.equal(nobodyAsked(r2), false); assert.equal(r2.pause_reason, null)
  assert.equal((await w.claimNextJob(db, [], new Set(), { wait }))?.id, 1)
  // A person's run that was put to wait by an older version: not "nobody's".
  assert.equal(nobodyAsked(row({ pause_reason: 'Waiting for Adal Browser to be open' })), false)
})

test('A + B in a real browser', { skip: !CHROME && 'no Chrome', timeout: 110000 }, async (t) => {
  const held = []
  const srv = http.createServer((q, r) => {
    if (q.url.includes('/hang')) { held.push(r); return }
    r.setHeader('content-type', 'text/html')
    r.end(`<!doctype html><title>x</title><h1>page</h1><input id=n>${q.url.includes('dies') ? '<script>setTimeout(()=>{const x=new XMLHttpRequest();x.open("GET","/hang",false);x.send()},1000)</script>' : ''}`)
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), defaultViewport: null, args: ['--no-first-run', '--disable-gpu'] })
  const db = await makeDb('a.sqlite')
  t.after(async () => { await b.close().catch(() => {}); srv.closeAllConnections?.(); srv.close(); await db.destroy(); rmTmp(tmp) })
  const tm = await import('../src/services/tabManager.js')
  const D = await import('../src/services/deadTabs.js')

  await t.test('B: one sign-in tab, three waiting runs: only its own run has it', async () => {
    const p = await b.newPage()
    await p.goto(`${base}/musaned.com.sa/login`)
    const live = new Set([11, 12, 13])
    const got = []
    for (const id of live) got.push(await tm.findRunTab(b, id, 'musaned_add_candidate', { liveRuns: live }))
    assert.equal(got.filter(Boolean).length, 1, 'one run has the tab')
    assert.deepEqual(tm.runsWithTabs(), [11])
    assert.equal(await tm.findRunTab(b, 12, 'musaned_add_candidate', { liveRuns: live, lookOnly: true }), p, 'the live view still shows it')
    assert.deepEqual(tm.runsWithTabs(), [11])
    // After a restart (the registry is empty) the tab still carries its run's name.
    tm.dropTab(11)
    assert.equal(await tm.findRunTab(b, 12, 'musaned_add_candidate', { liveRuns: live }), null)
    assert.equal(await tm.findRunTab(b, 11, 'musaned_add_candidate', { liveRuns: live }), p)
    await tm.closeRunTab(11)
  })

  await t.test('A: the dead sign-in tab is found, closed and its run told; a working one and a person\'s form stay', async () => {
    const [run, form] = await db('automation_queue').insert([row({ status: 'paused', pause_reason: 'awaiting-musaned-captcha' })]).then(async ([a]) => [a, (await db('automation_queue').insert(row({ status: 'paused', pause_reason: 'awaiting-human-save', account_id: 2 })))[0]])
    const good = await tm.openRunTab(b, 900); await good.goto(`${base}/ok`)
    const dead = await tm.openRunTab(b, run); await dead.goto(`${base}/auth/login?dies`)
    const save = await tm.openRunTab(b, form); await save.goto(`${base}/form?dies`)
    await sleep(2500)
    assert.equal(await tm.tabAnswers(dead, 1500), false, 'it answers nothing')
    const t0 = Date.now(), closed = []
    const acts = await D.lookDead(b, db, { askMs: 2000, onClosed: async (x) => closed.push(x.run) })
    console.log(`dead tab found and closed in ${((Date.now() - t0) / 1000).toFixed(1)} s (asked 2 s; 5 s live, looked at every 8 s)`)
    assert.deepEqual(acts.map(a => [a.act, a.run]).sort(), [['close', run], ['keep', form]].sort())
    assert.deepEqual(closed, [run])
    assert.equal(dead.isClosed(), true); assert.equal(save.isClosed(), false); assert.equal(good.isClosed(), false)
    assert.equal(tm.tabOfRun(run), null, 'its run opens a fresh one')
    assert.match(dead.__adalDead, /fresh one/); assert.match(save.__adalDead, /left/)
    const w = await import('../src/services/worker.js')
    assert.equal((await w.reviveSignIns(db)).back, 1, 'the waiting sign-in goes back in line at its step')
    assert.equal((await D.lookDead(b, db, { askMs: 1000 })).length, 0, 'said once')
    await tm.closeTarget(save)
  })

  await t.test('A: a page that works hard for a while is not dead', async () => {
    const p = await tm.openRunTab(b, 901); await p.goto(`${base}/ok`)
    p.evaluate(() => { const e = Date.now() + 9000; while (Date.now() < e); }).catch(() => {})
    await sleep(200)
    assert.deepEqual(await D.lookDead(b, db, { askMs: 1500 }), [])
    assert.equal(p.isClosed(), false)
  })
})

test('what counts as a person\'s form', async () => {
  const { decide, isSignInPage } = await import('../src/services/deadTabs.js')
  assert.equal(isSignInPage('https://accounts.wahid.sa/auth/realms/x'), true)
  assert.equal(isSignInPage('https://tawtheeq.musaned.com.sa/hr-pool'), false)
  assert.equal(decide({ url: 'https://accounts.wahid.sa/login', touched: Date.now() }), 'close', 'a sign-in page is nobody\'s form')
  assert.equal(decide({ url: 'https://tawtheeq.musaned.com.sa/x', touched: Date.now() - 1000 }), 'keep')
  assert.equal(decide({ url: 'https://tawtheeq.musaned.com.sa/x' }), 'close')
  assert.equal(decide({ row: { status: 'paused', pause_reason: 'awaiting-visa-save' }, url: 'https://visa.mofa.gov.sa/login' }), 'keep')
})
