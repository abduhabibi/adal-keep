/**
 * siteMap.test.js — locate, then go (docs/robot-architecture.md) on a mock Musaned in a real Chrome (every
 * tawtheeq.musaned.com.sa request answered in the test; signed in, no sign-in page): from any screen to the Add
 * Candidate pre-check by the cheapest clicks; an unknown screen asks a mock JEV, which may pick safe steps only;
 * a sign-in screen is a person's gate; the plan itself without a browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findChrome, rmTmp } from './helpers/chrome.js'
import { plan, recognise, goTo } from '../src/services/siteMap/engine.js'
import { musanedMap } from '../src/services/siteMap/musaned.js'
const CHROME = findChrome()
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'

const MENU = `<nav><a href="/dashboard">Dashboard</a> <a href="/hr-pool">HR Pool</a> <a href="/orgs">Organizations</a></nav>`
const PAGES = {
  '/': `<h1>Welcome to Musaned</h1><button onclick="location.href='/dashboard'">Go to dashboard</button>`,
  '/dashboard': `${MENU}<h2>Latest requests</h2><p>Your agency's dashboard with numbers and more text.</p>`,
  '/hr-pool': `${MENU}<h2>Candidates</h2><input placeholder="ID Number"><button onclick="setTimeout(() => box.style.display = 'block', 300)">Add new candidate</button><div id=box style="display:none"><h3>Candidate Pre-check</h3><input placeholder="ID Number"></div>`,
  '/hr-pool/candidates/add': `${MENU}<h2>Add Candidate</h2><label>Name</label><input>`,
  '/odd': `<h2>Something new Musaned shows</h2><p>A page this map does not know yet, long enough to read.</p>`,
  '/signin': `<form><input id=username><input type=password></form>`,
}

test('the plan: the cheapest clicks, an address only when no click leads there', () => {
  assert.deepEqual(plan(musanedMap, 'landing', 'precheck').map(a => a.name), ['go-to-dashboard', 'click-hr-pool', 'add-new-candidate'])
  assert.deepEqual(plan(musanedMap, 'add-form', 'precheck').map(a => a.name), ['click-hr-pool', 'add-new-candidate'])
  assert.deepEqual(plan(musanedMap, 'chrome-error', 'precheck').map(a => a.name), ['open-hr-pool', 'add-new-candidate'])
  assert.equal(plan(musanedMap, 'signed-out', 'precheck'), null)
  assert.equal(recognise(musanedMap, { host: 'accounts.wahid.sa' }), 'signed-out')
  assert.equal(recognise(musanedMap, null), '')
})

test('from wherever the tab is to the pre-check', { skip: !CHROME && 'no Chrome', timeout: 90000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-map-'))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-first-run', '--disable-gpu'] })
  t.after(async () => { await b.close().catch(() => {}); rmTmp(tmp) })
  const page = await b.newPage()
  await page.setRequestInterception(true)
  const hosts = new Set()
  page.on('request', (q) => {
    const u = new URL(q.url()); hosts.add(u.host)
    if (u.host !== 'tawtheeq.musaned.com.sa') return q.abort()
    const body = PAGES[u.pathname]
    q.respond({ status: body ? 200 : 404, contentType: 'text/html', body: `<!doctype html><body>${body || 'Not found'}</body>` })
  })
  const R = 'https://tawtheeq.musaned.com.sa'
  const asked = []
  const jev = async (png, text, goal, allowed) => { asked.push({ png: !!png, goal, allowed: allowed.map(a => a.name) }); return 'open-hr-pool' }
  const opts = { jev, unknownDir: path.join(tmp, 'unknown'), timesFile: path.join(tmp, 'times.json'), readMs: 600 }
  for (const [from, steps] of [['/', 3], ['/dashboard', 2], ['/hr-pool', 1], ['/hr-pool/candidates/add', 2], ['/odd', 2]]) {
    await page.goto(R + from)
    const logs = [], t0 = Date.now()
    const r = await goTo(page, musanedMap, 'precheck', { ...opts, log: (m) => logs.push(m) })
    console.log(`${from}: ${r.ok ? 'pre-check' : r.why} in ${r.steps} step(s), ${Date.now() - t0} ms`)
    assert.equal(r.ok, true, `${from}: ${r.why} ${logs.join(' | ')}`); assert.equal(r.steps, steps, logs.join(' | '))
  }
  // JEV was asked once (the unknown page), with the goal and safe steps only; the page kept, its digits masked.
  assert.equal(asked.length, 1); assert.equal(asked[0].png, true); assert.deepEqual(asked[0].allowed, ['open-hr-pool'])
  assert.equal(fs.readdirSync(path.join(tmp, 'unknown', 'musaned')).length, 2)
  // A JEV answer that is not an allowed step is not done.
  await page.goto(R + '/odd')
  const bad = await goTo(page, musanedMap, 'precheck', { ...opts, jev: async () => 'log-out' })
  assert.equal(bad.ok, false); assert.equal(bad.steps, 0)
  // A sign-in screen: a person's gate, nothing done.
  await page.goto(R + '/signin')
  const g = await goTo(page, musanedMap, 'precheck', opts)
  assert.equal(g.gate, 'sign-in'); assert.equal(g.steps, 0)
  // Step times kept across runs.
  const times = JSON.parse(fs.readFileSync(path.join(tmp, 'times.json'), 'utf8'))
  assert.ok(times['musaned:add-new-candidate'].n >= 5)
  assert.deepEqual([...hosts], ['tawtheeq.musaned.com.sa'])
})
