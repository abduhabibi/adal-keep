/**
 * robotGuard.test.js — 2026-11-25: a robot tab ("[NUZLA]", about:blank) held 98 % of a core of a 2-core PC for hours,
 * also after the server was updated and started again. No robot tab may do that: services/robotGuard.js.
 * A headless Chrome of the test's own. The processor is measured with the system's own counters. Skipped without Chrome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import http from 'http'
import { spawn } from 'child_process'

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(f => fs.existsSync(f))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-guard-'))
process.env.ADAL_NO_BROWSER_START = '1'
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
process.env.SECRETS_PATH = path.join(tmp, 'secrets.enc')
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'vault.key')
process.env.ADAL_SPACES_FILE = path.join(tmp, 'spaces.json')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const HOT = 0.3   // (this PC may be busy with other work while the test runs; 0.6 live)
const G = await import('../src/services/robotGuard.js')

test('what is done with a hot tab: never closed while something is in it', () => {
  const hot = { hotMs: 60000, url: 'https://x.sa/', ours: true, held: false, level: 0 }
  assert.equal(G.decide({ ...hot, hotMs: 40000 }), 'none', 'a minute first')
  assert.equal(G.decide({ ...hot, progressing: true }), 'none', 'a run that goes on is left')
  assert.equal(G.decide({ ...hot, ours: false }), 'priority', 'a person\'s own tab is not touched')
  assert.deepEqual([0, 1, 2, 3].map(level => G.decide({ ...hot, level })), ['end', 'reload', 'empty', 'close'])
  assert.equal(G.decide({ ...hot, url: 'about:blank' }), 'close')
  assert.equal(G.decide({ ...hot, url: 'about:blank', only: true }), 'end', 'the last tab stays: the browser would close')
  for (let level = 0; level < 9; level++) for (const url of ['https://x.sa/', 'about:blank']) for (const stuck of [true, false]) {
    assert.ok(['end', 'slow', 'priority'].includes(G.decide({ ...hot, held: true, level, url, stuck })), 'something in it: never loaded again, emptied or closed')
  }
  assert.equal(G.decide({ ...hot, held: true, level: 1, watched: true }), 'priority', 'never slowed under a person\'s hand')
  assert.equal(G.isOrphan({ url: 'about:blank', title: '[NUZLA]' }), true)
  assert.equal(G.isOrphan({ url: 'about:blank', title: '[NUZLA]', owned: true }), false)
  assert.equal(G.isOrphan({ url: 'about:blank', title: '' }), false)
})

// The label as ce98582 had it, on a page with no title.
const OLD_LABEL = (label) => {
  window.__adalLabel = label
  const mark = () => { const t = document.title || ''; const want = `[${window.__adalLabel}] ` + t.replace(/^\[[^\]]*\]\s*/, ''); if (t !== want) document.title = want }
  mark()
  window.__adalLabelObs = new MutationObserver(mark)
  window.__adalLabelObs.observe(document.head, { subtree: true, childList: true, characterData: true })
  setTimeout(() => { document.title = '' }, 30)
}
const BUSY = () => { setInterval(() => { const e = performance.now() + 120; while (performance.now() < e); }, 1) }

test('in a real browser', { skip: !CHROME && 'no Chrome', timeout: 240000 }, async (t) => {
  const PAGE = '<html><head></head><body><form><input name="a"><button>Save</button></form></body></html>'
  const site = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(/empty/.test(q.url) ? '<html><head></head><body>list</body></html>' : PAGE) })
  await new Promise(r => site.listen(0, '127.0.0.1', r))
  const U = (p) => `http://127.0.0.1:${site.address().port}/${p}`
  const cdp = await freePort()
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdp}`, `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' })
  const puppeteer = (await import('puppeteer-core')).default
  const connect = async () => { for (let i = 0; i < 60; i++) { const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdp}`, defaultViewport: null }).catch(() => null); if (b) return b; await sleep(250) } }
  let browser = await connect()
  t.after(async () => { try { browser?.disconnect() } catch {}; chrome.kill('SIGKILL'); site.close(); await sleep(300); fs.rmSync(tmp, { recursive: true, force: true }) })
  /** The busiest page process now, of a core. */
  const busiest = async (b = browser, ms = 2000) => {
    const c = await b.target().createCDPSession()
    const take = async () => new Map((await c.send('SystemInfo.getProcessInfo')).processInfo.filter(p => p.type === 'renderer').map(p => [p.id, p.cpuTime]))
    const a = await take(), t0 = Date.now(); await sleep(ms); const z = await take()
    c.detach().catch(() => {})
    return Math.max(0, ...[...z].map(([id, s]) => a.has(id) ? (s - a.get(id)) / ((Date.now() - t0) / 1000) : 0))
  }
  const { setupTab } = await import('../src/services/tabManager.js')
  // automation_queue of the test: the rows the guard asks about.
  const rows = {}, notes = []
  const db = () => ({ where: (k, id) => ({ first: async () => rows[id] || null, update: async (o) => { notes.push({ id, ...o }); if (rows[id]) Object.assign(rows[id], o) } }) })
  // Two looks: what each page process used in between (hotFor: 1 s here instead of a minute).
  const looks = async (n = 1, b = browser) => { const all = []; await G.guardLook(b, db, { hotFor: 0, orphanMs: 1e9, hotAt: HOT }); for (let i = 0; i < n; i++) { await sleep(1500); all.push(...await G.guardLook(b, db, { hotFor: 1000, orphanMs: 1e9, hotAt: HOT })) } return all }

  await t.test('the label on a page with no title (old code) is stopped; a form a person waits on keeps what was typed', async () => {
    G._resetGuardForTest()
    rows[7] = { id: 7, status: 'paused', pause_reason: 'awaiting-human-save', log: '[]' }
    const p = await browser.newPage(); await p.goto(U('form')); await setupTab(p, { runId: 7 })
    await p.type('input', 'her name')
    await p.evaluate(OLD_LABEL, 'NUZLA')
    await sleep(400)
    const before = await busiest()
    assert.ok(before > HOT, `the loop holds a core (${Math.round(before * 100)} %)`)
    const did = await looks(1)
    assert.deepEqual(did.map(d => d.act), ['end'])
    const after = await busiest()
    console.log(`old label loop, a form open: ${Math.round(before * 100)} % of a core → ${Math.round(after * 100)} %`)
    assert.ok(after < 0.2, `stopped (${Math.round(after * 100)} %)`)
    assert.equal(await p.evaluate(() => document.querySelector('input').value), 'her name')
    await p.close()
  })

  await t.test('a busy page with a form: ended first, then slowed, never closed; full speed when a person opens it', async () => {
    G._resetGuardForTest()
    const p = await browser.newPage(); await p.goto(U('form')); await setupTab(p, { runId: 7 })
    await p.type('input', 'her name')
    await p.evaluate(BUSY)
    const before = await busiest()
    const did = await looks(2)
    assert.deepEqual(did.map(d => d.act), ['end', 'slow'])
    const after = await busiest(browser, 4000)
    console.log(`a page busy by its own timers, a form open: ${Math.round(before * 100)} % → ${Math.round(after * 100)} %`)
    assert.ok(before > HOT && after < 0.35 && after < before / 2, `${before} → ${after}`)
    assert.equal(await p.evaluate(() => document.querySelector('input').value), 'her name', 'it still answers')
    assert.match(notes.at(-1).log, /slowed down until somebody opens it/, 'said in its run\'s log')
    assert.ok(p.__adalWake)
    await p.__adalWake('test')
    await sleep(1500)
    assert.ok(await busiest() > HOT, 'full speed again')
    assert.equal(p.isClosed(), false)
    await p.close()
  })

  await t.test('nothing in it: ended, loaded again, emptied', async () => {
    G._resetGuardForTest()
    const p = await browser.newPage(); await setupTab(p, { runId: 8 })
    await p.evaluateOnNewDocument(BUSY)                     // also after a load
    await p.goto(U('empty'))
    const did = await looks(3)
    assert.deepEqual(did.map(d => d.act), ['end', 'reload', 'empty'])
    await p.close().catch(() => {})
  })

  await t.test('a running run that goes on is left alone', async () => {
    G._resetGuardForTest()
    rows[9] = { id: 9, status: 'running', log: JSON.stringify([{ ts: Date.now(), msg: 'a step' }]) }
    const p = await browser.newPage(); await p.goto(U('empty')); await setupTab(p, { runId: 9 }); await p.evaluate(BUSY)
    assert.deepEqual(await looks(2), [])
    await p.close()
  })

  await t.test('the server starts again: the tab still looping from before is closed at once, nothing else is', async () => {
    const b0 = browser
    const bad = await b0.newPage(); await bad.evaluate(OLD_LABEL, 'NUZLA')
    const form = await b0.newPage(); await form.goto(U('form')); await form.type('input', 'kept'); await form.evaluate(() => { window.name = 'adal-run-7' })
    await b0.newPage()                        // an empty tab with no label: not ours to close
    await sleep(500)
    assert.ok(await busiest(b0) > HOT)
    b0.disconnect(); await sleep(300)
    browser = await connect()
    G._resetGuardForTest()
    const t0 = Date.now()
    const did = await G.guardLook(browser, db, { atStart: true })
    assert.deepEqual(did.map(d => [d.act, d.title]), [['orphan', '[NUZLA]']])
    await sleep(700)
    const after = await busiest()
    console.log(`after a restart: the looping tab closed in ${Date.now() - t0 - 700 - 2000} ms, ${Math.round(after * 100)} % of a core left`)
    assert.ok(after < 0.2)
    const left = await browser.pages()
    assert.ok(left.length >= 3)
    const f = await Promise.all(left.map(p => p.evaluate(() => document.querySelector('input')?.value || '').catch(() => '')))
    assert.ok(f.includes('kept'), 'the open form is there')
  })

  await t.test('a tab from before a restart that answers nothing and may hold a form: kept, after everything else', async () => {
    const p = await browser.newPage(); await p.goto(U('form')); await p.type('input', 'kept too'); await p.evaluate(OLD_LABEL, 'NUZLA')
    const id = p.target()._targetId
    await sleep(500)
    browser.disconnect(); await sleep(300)
    browser = await connect()
    G._resetGuardForTest()
    const did = await looks(1)
    assert.deepEqual(did.map(d => d.act), ['priority'])
    const { targetInfos } = await (await browser.target().createCDPSession()).send('Target.getTargets')
    assert.ok(targetInfos.some(x => x.targetId === id), 'never closed')
    if (process.platform === 'linux') {
      const c = await browser.target().createCDPSession()
      const pids = (await c.send('SystemInfo.getProcessInfo')).processInfo.filter(x => x.type === 'renderer').map(x => x.id)
      assert.ok(pids.some(x => { try { return os.getPriority(x) === 19 } catch { return false } }), 'its process comes last')
    }
    await (await browser.target().createCDPSession()).send('Target.closeTarget', { targetId: id })
  })

  await t.test('too many tabs: the oldest of finished runs go, one with a form stays', async () => {
    G._resetGuardForTest()
    rows[20] = { id: 20, status: 'done', log: '[]' }
    const mine = []
    for (let i = 0; i < 4; i++) { const p = await browser.newPage(); await p.goto(U(i === 1 ? 'form' : 'empty')); if (i === 1) await p.type('input', 'x'); await setupTab(p, { runId: 20 }); await p.evaluate(() => { window.name = 'adal-run-20' }); mine.push(p) }
    const open = (await browser.pages()).length
    const did = await G.guardLook(browser, db, { maxTabs: open - 2, orphanMs: 1e9 })
    assert.equal(did.filter(d => d.act === 'over').length, 2)
    await sleep(500)
    assert.equal(mine[1].isClosed(), false, 'the form stays')
    for (const p of mine) await p.close().catch(() => {})
  })

  await t.test('what the guard itself costs', async () => {
    G._resetGuardForTest()
    const pages = []
    for (let i = 0; i < 8; i++) { const p = await browser.newPage(); await p.goto(U('empty')); pages.push(p) }
    await sleep(1500)
    const b = await browser.target().createCDPSession()
    const all = async () => (await b.send('SystemInfo.getProcessInfo')).processInfo.reduce((a, p) => a + p.cpuTime, 0)
    const idle0 = await all(); await sleep(6000); const idle = await all() - idle0
    const n0 = process.cpuUsage(), a0 = await all(), t0 = Date.now()
    for (let i = 0; i < 30; i++) { await G.guardLook(browser, db); await sleep(200) }
    const n = process.cpuUsage(n0), took = Date.now() - t0
    const brow = Math.max(0, await all() - a0 - idle * took / 6000)
    const perLook = ((n.user + n.system) / 1e3 + brow * 1000) / 30
    console.log(`the guard: ${perLook.toFixed(1)} ms of processor a look (Node ${((n.user + n.system) / 3e4).toFixed(1)} + browser ${(brow * 1000 / 30).toFixed(1)}), one look in 20 s = ${(perLook / 20000 * 100).toFixed(3)} % of a core`)
    assert.ok(perLook / 20000 < 0.005, 'under 0.5 % of a core')
    for (const p of pages) await p.close().catch(() => {})
  })
})
