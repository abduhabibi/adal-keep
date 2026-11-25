/**
 * instantScreen.test.js — run 1795612477489001 (2026-11-25, Main): JEV answered after 19-25 s and the run paused at the
 * agency list with the dashboard there. A JEV that answers after 25 s, mock Musaned pages in a real Chrome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import https from 'https'
import { execFileSync } from 'child_process'
import { findChrome, rmTmp } from './helpers/chrome.js'
const CHROME = findChrome()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-instant-'))
Object.assign(process.env, { BRAVE_CDP_URL: 'http://127.0.0.1:9', ADAL_NO_BROWSER_START: '1', JEV_ENABLED: 'false', SECRETS_PATH: path.join(tmp, 's.enc'), ACCOUNT_VAULT_KEY: path.join(tmp, 'v.key'), ADAL_SPACES_FILE: path.join(tmp, 'sp.json'), SQLITE_PATH: path.join(tmp, 'db.sqlite') })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const M = { host: 'tawtheeq.musaned.com.sa', path: '/dashboard', hash: '', nav: 4 }
const W = { host: 'accounts.wahid.sa', path: '/auth', hash: '', nav: 0 }

test('told at once only when beyond doubt; never a wrong dashboard', async () => {
  const { sure } = await import('../src/services/instantScreen.js')
  assert.equal(sure(M), 'dashboard')
  assert.equal(sure({ ...M, error: true }), 'dashboard', '"expired" in a contract is not a sign-in error')
  for (const x of [{ password: true }, { code: true }, { captcha: true }, { denied: true }, { goTo: true }, { path: '/login' }, { nav: 1 }, { hash: '#state=abc&code=1' }, { picker: true }, { host: 'musaned.com.sa.evil.org' }, { host: 'accounts.wahid.sa' }]) assert.equal(sure({ ...M, ...x }), '', JSON.stringify(x))
  assert.equal(sure({ ...M, nav: 0, picker: true }), 'agency-picker')
  assert.equal(sure({ ...W, password: true, user: true }), 'login-form')
  assert.equal(sure({ ...W, password: true, user: true, captcha: true }), 'captcha')
  assert.equal(sure({ ...W, password: true, user: true, captcha: true, error: true }), '', 'a sign-in error is looked at with care')
  assert.equal(sure({ ...W, code: true }), 'otp')
  assert.equal(sure({ ...W, code: true, error: true }), '')
  assert.equal(sure(null), '')
})

const NAV = '<nav><span>Dashboard</span> <span>Organizations</span> <span>HR Pool</span> <span>Employment Requests</span></nav><h2>Latest Requests</h2>'
const CARD = '<p>Welcome back! Please select the establishment:</p><div id=card style="width:500px;height:120px;border:1px solid">ZADUL FOREIGN EMPLOYMENT AGENCY details</div>'
const PAGES = {
  '/dashboard': NAV,
  '/never': CARD + '<script>n=0;card.onclick=()=>{n++}</script>',
  '/second': CARD + `<script>n=0;card.onclick=()=>{n++; if (n===2) { document.body.innerHTML = ${JSON.stringify(NAV)} }}</script>`,
  '/slow': CARD + `<script>n=0;card.onclick=()=>{n++; document.body.innerHTML = '<p></p>'; setTimeout(() => { document.body.innerHTML = ${JSON.stringify(NAV)} }, 3000)}</script>`,
  '/later': `<p>Please wait</p><script>setTimeout(() => { document.body.innerHTML = ${JSON.stringify(NAV)} }, 1500)</script>`,
  '/spin': `<header><div style="width:400px;height:60px" onclick="window.wrong=(window.wrong||0)+1">ZADUL</div></header><p>Please select the establishment:</p><div id=l><i class="spinner" style="display:block;width:20px;height:20px">.</i></div><script>setTimeout(() => { const t = ['ZADUL FOR', 'EIGN EMPLOY', 'MENT AGE', 'NCY det', 'ails'].join(''); l.innerHTML = '<div id="card" style="width:500px;height:120px;border:1px solid">' + t + '</div>'; card.onclick = () => { window.n = (window.n || 0) + 1; document.body.innerHTML = ${JSON.stringify(NAV)} } }, 4000)</script>`,
  '/blank': '<p>One moment</p>',
  '/pool': '<h1>HR Pool</h1>' + NAV + '<input type=text id=q>',
  '/hr-pool': NAV + '<input type=text id=q>',
  '/hr-pool/candidates/add': NAV + '<input type=text id=a><input type=text id=b>',
  '/signin': '<form><input name=username><input type=password></form>',
}
async function browser(t) {
  const key = path.join(tmp, 'k.pem'), crt = path.join(tmp, 'c.pem')
  if (!fs.existsSync(crt)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=musaned'], { stdio: 'ignore' })
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (q, r) => { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><body>' + (PAGES[q.url.split('?')[0]] || '')) })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: fs.mkdtempSync(path.join(tmp, 'p')), defaultViewport: { width: 1366, height: 900 },
    args: ['--no-first-run', '--disable-gpu', '--ignore-certificate-errors', `--host-resolver-rules=MAP tawtheeq.musaned.com.sa 127.0.0.1:${srv.address().port}, MAP accounts.wahid.sa 127.0.0.1:${srv.address().port}`] })
  t.after(async () => { await b.close().catch(() => {}); srv.close(); srv.closeAllConnections?.() })
  return b
}
const U = (p) => `https://tawtheeq.musaned.com.sa${p}`
const slowJev = (counts, ms = 25000, screen = 'unknown') => async () => { counts.n++; await new Promise(r => { const x = setTimeout(r, ms); x.unref?.() }); return { screen, source: 'jev' } }

test('JEV answers after 25 s: the dashboard at once; the agency\'s card; a page still loading', { skip: !CHROME && 'no Chrome', timeout: 120000 }, async (t) => {
  const b = await browser(t), w = await import('../src/services/musanedWorkflow.js')
  const p = await b.newPage()
  const jev = { n: 0 }, logs = []
  const ctx = (o = {}) => ({ musaned_name: 'zadul', onLog: (l, m) => logs.push(m), profileName: 'T', reviewScreen: slowJev(jev), ...o })
  const F = w._form
  await p.goto(U('/dashboard'))
  let t0 = Date.now()
  assert.equal(await F.waitForDashboard(p, ctx(), 30000), 'dashboard')
  const at = Date.now() - t0
  assert.ok(at < 1000, `${at} ms`); assert.equal(jev.n, 0, 'JEV is not asked')
  // The card's first click is not taken: once more.
  await p.goto(U('/second')); t0 = Date.now()
  assert.equal(await F.cardToDashboard(p, ctx({ cardWait: { againMs: 1500 } })), 'dashboard')
  console.log(`JEV of 25 s: dashboard told after ${at} ms; a lost first click: dashboard ${Date.now() - t0} ms after it`)
  assert.ok(logs.some(l => /its card clicked once more/.test(l)))
  // The list still loading (the owner's picture, 16:17): the name in the header is never clicked; the card when it comes.
  await p.goto(U('/spin')); t0 = Date.now()
  assert.equal(await F.cardToDashboard(p, ctx()), 'dashboard')
  assert.deepEqual(await p.evaluate(() => [window.wrong || 0, window.n]), [0, 1]); assert.ok(Date.now() - t0 < 8000)
  // A click that takes long: not clicked again on a page without the list; longer than the limit on a slow line.
  await p.goto(U('/slow')); logs.length = 0
  assert.equal(await F.cardToDashboard(p, ctx({ cardWait: { againMs: 600, slowMs: 9000 } })), 'dashboard')
  assert.ok(!logs.some(l => /once more/.test(l)))
  // Never taken: it says what it waits for, two clicks in all, ends at the list.
  await p.goto(U('/never')); logs.length = 0; t0 = Date.now()
  assert.equal(await F.waitForDashboard(p, ctx(), 1500, { again: async () => { await p.evaluate(() => card.click()); return true }, againMs: 500, slowMs: 2500 }), 'agency-picker')
  assert.equal(await p.evaluate(() => n), 1, 'once more, not again and again'); assert.ok(Date.now() - t0 < 4000)
  // A page that says nothing yet: told as soon as it turns; JEV asked once.
  jev.n = 0
  await p.goto(U('/later')); t0 = Date.now()
  assert.equal((await w.classifyScreen(p, ctx())).screen, 'dashboard'); assert.ok(Date.now() - t0 < 3000, 'JEV (25 s) does not hold the look')
  // A page that stays unclear: 4 s for JEV once, then each look at once.
  jev.n = 0
  const q = await b.newPage()
  await q.goto(U('/blank')); t0 = Date.now()
  assert.equal((await w.classifyScreen(q, ctx())).screen, 'unknown'); const first = Date.now() - t0
  t0 = Date.now(); for (let i = 0; i < 5; i++) await w.classifyScreen(q, ctx())
  console.log(`a page nobody knows: ${first} ms, then ${Math.round((Date.now() - t0) / 5)} ms a look; JEV asked ${jev.n} time(s)`)
  assert.ok(first >= 3500 && first < 6000, `${first}`); assert.ok(Date.now() - t0 < 1500); assert.equal(jev.n, 1)
  // Its tab is gone: the wait ends at once, in the words a lost browser is known by.
  const { browserLost } = await import('../src/services/lostBrowser.js')
  const z = await b.newPage(); await z.goto(U('/blank')); setTimeout(() => z.close().catch(() => {}), 1000)
  t0 = Date.now()
  await assert.rejects(F.waitForDashboard(z, ctx(), 30000), (e) => browserLost(null, e.message))
  assert.ok(Date.now() - t0 < 6000)
  // Waiting is stopped at once.
  await assert.rejects(F.waitForDashboard(p, ctx({ isCancelled: () => true }), 30000), /Cancelled/)
})

test('JEV (quick) is asked for what is unclear, and not believed for a dashboard over a password box', { skip: !CHROME && 'no Chrome', timeout: 60000 }, async (t) => {
  const b = await browser(t), w = await import('../src/services/musanedWorkflow.js')
  const p = await b.newPage()
  const ctx = (screen) => ({ onLog: () => {}, profileName: 'T', reviewScreen: async () => ({ screen, source: 'jev' }) })
  await p.goto(U('/blank'))
  assert.equal((await w.classifyScreen(p, ctx('agency-picker'))).screen, 'agency-picker', 'JEV still answers')
  const q = await b.newPage()
  await q.goto(U('/signin'))
  assert.notEqual((await w.classifyScreen(q, ctx('dashboard'))).screen, 'dashboard')
  process.env.ADAL_INSTANT_SCREEN = '0'; t.after(() => { delete process.env.ADAL_INSTANT_SCREEN })
  await p.goto(U('/dashboard'))
  assert.deepEqual(await w.classifyScreen(p, ctx('captcha')), { screen: 'captcha', source: 'jev' }, 'off: as before')
})

test('a run paused at the list of agencies goes on by itself when Musaned\'s menu is there', { skip: !CHROME && 'no Chrome', timeout: 60000 }, async (t) => {
  const b = await browser(t), wk = await import('../src/services/worker.js')
  const p = await b.newPage()
  await p.goto(U('/never'))
  assert.equal(await wk.dashboardNow(p), false, 'the list itself')
  await p.goto(U('/blank')); assert.equal(await wk.dashboardNow(p), false)
  await p.goto(U('/dashboard')); assert.equal(await wk.dashboardNow(p), true)
  assert.ok(wk.SIGN_IN_WAIT.test('awaiting-musaned-agency-picker'), 'its tab gone: back in line like a sign-in')
  // The look itself, on rows.
  const browserUrl = new URL(b.wsEndpoint())
  process.env.BRAVE_CDP_URL = `http://${browserUrl.host}`
  t.after(() => { process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9' })
  const knex = (await import('knex')).default({ client: 'sqlite3', connection: { filename: path.join(tmp, 'q.sqlite') }, useNullAsDefault: true })
  t.after(() => knex.destroy())
  await knex.schema.createTable('automation_queue', (x) => { x.integer('id'); x.string('status'); x.string('pause_reason'); x.string('workflow_id'); x.integer('account_id'); x.text('context'); x.string('updated_at') })
  const now = new Date().toISOString()
  const at = await b.newPage(); await at.goto(U('/never')); await at.evaluate(() => { window.name = 'adal-run-12' }); await p.evaluate(() => { window.name = 'adal-run-11' })
  for (const id of [11, 12]) await knex('automation_queue').insert({ id, status: 'paused', pause_reason: 'awaiting-musaned-agency-picker', workflow_id: 'musaned_check_chosen', context: '{}', updated_at: now })
  process.env.ADAL_ROBOTS_IN_APP = '1'; wk.setClaimGate(() => false)   // looked at only: nothing starts
  t.after(() => { wk.setClaimGate(null); delete process.env.ADAL_ROBOTS_IN_APP })
  await wk.continueSignedIn(knex)
  const rows = await knex('automation_queue').orderBy('id')
  assert.deepEqual(rows.map(r => r.status), ['pending', 'paused'], '11 (dashboard) goes on, 12 (the list) waits')
})

test('spare Musaned tabs close when idle; the signed-in one, a form and a person\'s tab stay', { skip: !CHROME && 'no Chrome', timeout: 60000 }, async (t) => {
  const { closeSpare, spare } = await import('../src/services/spareTabs.js')
  const look = { name: '', touched: 0, typed: 0, ticked: false, signIn: false }, url = U('/hr-pool')
  assert.equal(spare({ url, look, ours: true }), true)
  assert.equal(spare({ url, look, ours: false }), false, 'not the robots\'')
  assert.equal(spare({ url, look: { ...look, name: 'adal-run-5' }, live: new Set([5]) }), false, 'a run\'s')
  assert.equal(spare({ url, look: { ...look, name: 'adal-run-5', typed: 1 } }), true, 'the list\'s search box')
  assert.equal(spare({ url: U('/hr-pool/candidates/add'), look: { ...look, typed: 1 }, ours: true }), false, 'a form')
  assert.equal(spare({ url, look: { ...look, touched: Date.now() - 60000 }, ours: true }), false, 'a person\'s')
  assert.equal(spare({ url, look: { ...look, ticked: true, signIn: true }, ours: true }), false, 'ticked just now')
  assert.equal(spare({ url, look: null, ours: true }), false)
  const b = await browser(t)
  const tab = async (u, name, typed) => { const p = await b.newPage(); await p.goto(u); await p.evaluate((n, v) => { window.name = n; if (v) document.querySelector('input').value = v }, name, typed); return p }
  const one = await tab(U('/hr-pool'), 'adal-run-1', 'EP1234567'), two = await tab(U('/hr-pool'), 'adal-run-2', 'EP7654321'), three = await tab(U('/hr-pool'), 'adal-run-3', ''), sign = await tab('https://accounts.wahid.sa/signin', 'adal-run-4', '')
  const form = await tab(U('/hr-pool/candidates/add'), 'adal-run-6', 'x')
  assert.equal(await closeSpare(b, { live: new Set() }), 4)
  assert.deepEqual([one, two, three, sign, form].map(p => p.isClosed()), [true, true, true, true, false], 'the form stays: it is signed in')
  await form.close()
  const a = await tab(U('/hr-pool'), 'adal-run-1', ''), s2 = await tab('https://accounts.wahid.sa/signin', 'adal-run-4', '')
  assert.equal(await closeSpare(b, { live: new Set([4]) }), 0, 'a waiting sign-in is its run\'s')
  assert.equal(await closeSpare(b, { live: new Set() }), 1); assert.deepEqual([a.isClosed(), s2.isClosed()], [false, true])
  const s3 = await tab('https://accounts.wahid.sa/signin', 'adal-run-4', ''); await a.close()
  await tab('https://accounts.wahid.sa/signin', 'adal-run-5', '')
  assert.equal(await closeSpare(b, { live: new Set() }), 0, 'none signed in: nothing closes'); void s3
})

test('a Companion\'s browser that starts slowly: waited for, each step named', { skip: !CHROME && 'no Chrome', timeout: 60000 }, async (t) => {
  const rb = await import('../src/services/remoteBrowsers.js')
  const b = await browser(t)
  let ms = 2500
  const srv = http.createServer((q, r) => { if (q.url === '/robot/now') return r.end('{}'); setTimeout(() => r.end(JSON.stringify({ webSocketDebuggerUrl: b.wsEndpoint() })), ms) })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => { srv.close(); srv.closeAllConnections(); delete process.env.ADAL_REMOTE_OPEN_MS; rb._resetForTest(); rmTmp(tmp) })
  const reg = (port) => rb.registerDevice({ id: 'u5', name: 'U5' }, '127.0.0.1', { token: 'T'.repeat(32), port, cores: 8 })
  reg(srv.address().port)
  process.env.ADAL_REMOTE_OPEN_MS = '1000'
  await assert.rejects(rb.browserForDevice('u5'), /opening its robot browser: no answer in 1 s; before: reaching it 0\.\d s/)
  delete process.env.ADAL_REMOTE_OPEN_MS
  ms = 3500
  const x = await rb.browserForDevice('u5')
  assert.match(rb.stepsOf(x), /opening its robot browser 3\.\d s, connecting to it/)
  await x.disconnect()
  const gone = http.createServer(); await new Promise(r => gone.listen(0, r)); const port = gone.address().port; gone.close()
  reg(port)
  const t0 = Date.now()
  await assert.rejects(rb.browserForDevice('u5'), /reaching it: ECONNREFUSED/)
  assert.ok(Date.now() - t0 < 2000, 'a PC that is off does not cost 50 s')
})
