/**
 * liveInputSlow.test.js — 2026-11-24, the owner: "I can't even click things in it … with less fast
 * internet". A person's clicks in the live view reach the run's tab, and a box in another site's frame
 * (like Google's "I'm not a robot") is ticked, on a slowed PC (CPU 6×) and a slow line (1 Mbit/s,
 * 300 ms), while the page keeps the processor busy. Through the real POST /automations/:id/input.
 * Before: each click looked for the tab again and asked it to answer in 2.5 s; a busy page missed
 * that, the view dropped the run's tab and the click was refused.
 * In a headless browser of the test's own on a free port; the "sites" are local pages. Skipped without one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import http from 'http'
import { spawn } from 'child_process'

const EXE = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/brave.com/brave/brave'].find(f => fs.existsSync(f))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-liveinput-'))
process.env.ADAL_NO_BROWSER_START = '1'
process.env.ADAL_SPACES_FILE = path.join(tmp, 'spaces.json')
process.env.JEV_ENABLED = 'false'
process.env.HOME = tmp
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('clicks reach the run tab and a box in another site\'s frame, on a slow PC and line', { skip: !EXE && 'no browser', timeout: 120000 }, async () => {
  // "Musaned's sign-in" with "Google's box" in a frame of another site.
  const site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.headers.host.startsWith('www.google.com')) return res.end(`<!doctype html><body style="margin:0"><div id="recaptcha-anchor" role="checkbox" aria-checked="false"
      style="width:28px;height:28px;border:2px solid #999;margin:10px" onclick="this.setAttribute('aria-checked','true');this.style.background='green'"></div></body>`)
    res.end(`<!doctype html><title>Sign in</title><body style="margin:0">
      <button id="b" style="position:absolute;left:100px;top:100px;width:200px;height:60px" onclick="window.clicks=(window.clicks||0)+1">Sign In</button>
      <iframe id="f" src="http://www.google.com:${site.address().port}/recaptcha/api2/anchor" style="position:absolute;left:100px;top:300px;width:300px;height:80px;border:0"></iframe>
      <script>const BUSY = ${process.env.LIVE_BUSY_MS || 120}; setInterval(() => { const t = performance.now(); while (performance.now() - t < BUSY) {} }, BUSY + 200)</script></body>`)
  })
  await new Promise(r => site.listen(0, '127.0.0.1', r))
  const sp = site.address().port
  const port = await freePort()
  const child = spawn(EXE, ['--headless=new', '--no-first-run', '--window-size=1366,900', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, 'profile')}`,
    `--host-resolver-rules=MAP accounts.wahid.sa 127.0.0.1:${sp}, MAP www.google.com 127.0.0.1:${sp}`, '--site-per-process', 'about:blank'], { stdio: 'ignore', detached: true })
  let app = null
  try {
    process.env.BRAVE_CDP_URL = `http://127.0.0.1:${port}`
    for (let i = 0; i < 60; i++) { try { await fetch(`${process.env.BRAVE_CDP_URL}/json/version`); break } catch { await sleep(250) } }
    const { getBrowser, closeBrowser } = await import('../src/services/browser.js')
    const tm = await import('../src/services/tabManager.js')
    const { default: knex } = await import('knex')
    const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('automation_queue', t => { t.increments('id'); t.string('workflow_id'); t.integer('account_id'); t.text('context'); t.string('status'); t.string('pause_reason'); t.string('updated_at') })
    await db('automation_queue').insert({ id: 7, workflow_id: 'musaned_add_candidate', status: 'running' })
    const browser = await getBrowser()
    const page = await tm.openRunTab(browser, 7, { workflowId: 'musaned_add_candidate', busyRuns: new Set([7]), keepRuns: new Set([7]), quiet: true })
    const cdp = await page.createCDPSession()
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 1e6 / 8, uploadThroughput: 1e6 / 8 })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
    await page.goto(`http://accounts.wahid.sa:${sp}/auth`, { waitUntil: 'load', timeout: 60000 })
    await page.waitForFunction(() => document.getElementById('f')?.contentWindow, { timeout: 30000 })
    for (let i = 0; i < 40 && !page.frames().some(f => /anchor/.test(f.url())); i++) await sleep(250)

    const express = (await import('express')).default
    const router = (await import('../src/routes/automations.js')).default
    const server = express(); server.use(express.json()); server.locals.db = db; server.use('/api', router)
    app = await new Promise(r => { const s = server.listen(0, '127.0.0.1', () => r(s)) })
    const at = (x, y) => ({ x: x / 1366, y: y / 900 })
    const click = async (x, y) => {
      const t0 = Date.now()
      const r = await fetch(`http://127.0.0.1:${app.address().port}/api/automations/7/input`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batch: [{ kind: 'mouse', type: 'move', ...at(x, y) }, { kind: 'mouse', type: 'down', ...at(x, y), button: 0, buttons: 1, clickCount: 1 }, { kind: 'mouse', type: 'up', ...at(x, y), button: 0, buttons: 0, clickCount: 1 }] }) })
      return { status: r.status, ms: Date.now() - t0 }
    }
    const a = await click(200, 130)
    const b = await click(200, 130)
    const box = await click(100 + 10 + 16, 300 + 10 + 16)
    console.log(`clicks on a slow PC and line: ${a.ms} ms, ${b.ms} ms; the box in the other site's frame: ${box.ms} ms`)
    assert.equal(a.status, 200); assert.equal(box.status, 200)
    assert.equal(await page.evaluate(() => window.clicks), 2)
    const anchor = page.frames().find(f => /anchor/.test(f.url()))
    assert.ok(anchor, 'the frame of the other site is there')
    assert.equal(await anchor.evaluate(() => document.getElementById('recaptcha-anchor').getAttribute('aria-checked')), 'true')
    assert.ok(tm.tabOfRun(7) === page, 'the run still has its tab')
    tm.forgetRunTab(7)
    await db.destroy()
    await closeBrowser()
  } finally {
    app?.close(); site.close()
    try { process.kill(-child.pid) } catch { child.kill() }
    await sleep(500)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
