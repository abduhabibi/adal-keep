/**
 * oneConnection.test.js — 2026-11-23, Main (weak 2-core PC): Puppeteer 25 has no
 * browser.isConnected(), so every look at Adal Browser made a new connection (a
 * 7-s port check each, the live view "does not answer", old connections never let
 * go, Musaned's page blank). In a real headless Chromium of the test's own
 * (never the PC's Adal Browser): one connection for all, and a blank page is told.
 * Skipped when this PC has no Chrome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { spawn } from 'child_process'

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(f => fs.existsSync(f))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-onecon-'))
process.env.ADAL_NO_BROWSER_START = '1'
process.env.ADAL_BROWSER_PROFILE = path.join(tmp, 'never')
process.env.JEV_ENABLED = 'false'
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('alive(): Puppeteer 25 `connected`, and the old isConnected()', async () => {
  const { alive } = await import('../src/services/browser.js')
  assert.equal(alive(null), false)
  assert.equal(alive({ connected: true }), true)
  assert.equal(alive({ connected: false }), false)
  assert.equal(alive({ isConnected: () => true }), true)
})

test('one connection to the browser for every look, and a blank page is told', { skip: !CHROME && 'no Chrome on this PC', timeout: 60000 }, async () => {
  const port = await freePort()
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
  try {
    process.env.BRAVE_CDP_URL = `http://127.0.0.1:${port}`
    for (let i = 0; i < 40; i++) { try { await fetch(`${process.env.BRAVE_CDP_URL}/json/version`); break } catch { await sleep(250) } }
    const { openBrowserIfAny, getBrowser, closeBrowser } = await import('../src/services/browser.js')
    const many = await Promise.all([openBrowserIfAny(), openBrowserIfAny(), getBrowser(), openBrowserIfAny()])
    assert.ok(many[0], 'connected')
    for (const b of many) assert.equal(b, many[0], 'the same connection')
    assert.equal(await openBrowserIfAny(), many[0])
    assert.equal(await getBrowser(), many[0])

    const { blankPage } = await import('../src/services/musanedWorkflow.js')
    const page = await many[0].newPage()
    await page.setContent('<html><body><div id="app"></div></body></html>')
    assert.equal(await blankPage(page, 800), true)
    await page.setContent('<html><body><h1>Welcome back</h1></body></html>')
    assert.equal(await blankPage(page, 800), false)
    // Drawn a moment later (a slow PC): not blank.
    await page.setContent('<html><body><div id="app"></div><script>setTimeout(() => { app.textContent = "Login" }, 300)</script></body></html>')
    assert.equal(await blankPage(page, 3000), false)
    // The live view: pictures of the tab come over that one connection.
    const { watchFrames } = await import('../src/services/liveFrames.js')
    const frames = []
    const stop = await watchFrames(page, (img) => frames.push(img))
    for (let i = 0; i < 20 && !frames.length; i++) await sleep(250)
    stop()
    assert.ok(frames.length && frames[0].length > 100, 'a picture of the tab')
    assert.equal(await openBrowserIfAny(), many[0], 'still the same connection')
    await page.close()
    await closeBrowser()
  } finally { chrome.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }) }
})
