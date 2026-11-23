/**
 * robotSystemBrowser.test.js — 2026-11-23, the owner: "get that specific browser stuff [before Adal Browser]
 * and put it back here and just make the robots work". The robots' browser is the PC's own Brave / Chrome /
 * Edge again (system mode, the default), started on its port and driven over CDP; a run's tab is a plain new
 * tab (headless on Linux). Adal Browser stays behind ADAL_ROBOT_BROWSER=adal.
 * In a headless browser of the test's own on a free port (never the PC's browser on 9222). Skipped without one.
 * BENCH_LIVE=1 also opens Musaned's public home page in that tab (read-only, nothing typed).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { spawn } from 'child_process'

const EXE = ['/usr/bin/brave-browser', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(f => fs.existsSync(f))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-sysbrowser-'))
process.env.ADAL_NO_BROWSER_START = '1'
process.env.ADAL_BROWSER_PROFILE = path.join(tmp, 'never')
process.env.ADAL_SPACES_FILE = path.join(tmp, 'spaces.json')
process.env.JEV_ENABLED = 'false'
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('system mode is the default; the profile follows the browser', async () => {
  const b = await import('../src/services/browser.js')
  assert.equal(b.robotBrowserMode(), 'system')
  assert.equal(b.profileFor('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'system'), 'browser-profile')
  assert.equal(b.profileFor('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'system'), 'browser-profile-edge')
  assert.equal(b.profileFor('/usr/bin/google-chrome', 'system'), 'browser-profile-chrome')
  if (process.platform === 'linux') assert.ok(b.findBrowserExecutable(), 'a browser of the PC is found')
})

test("a run's tab in the PC's own browser, over CDP, out of sight", { skip: !EXE && 'no browser on this PC', timeout: 90000 }, async () => {
  const port = await freePort()
  const child = spawn(EXE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, 'profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', detached: true })
  try {
    process.env.BRAVE_CDP_URL = `http://127.0.0.1:${port}`
    for (let i = 0; i < 60; i++) { try { await fetch(`${process.env.BRAVE_CDP_URL}/json/version`); break } catch { await sleep(250) } }
    const t0 = Date.now()
    const { getBrowser, closeBrowser } = await import('../src/services/browser.js')
    const tm = await import('../src/services/tabManager.js')
    const browser = await getBrowser()
    const page = await tm.openRunTab(browser, 1, { workflowId: 'musaned_check_chosen', busyRuns: new Set([1]), keepRuns: new Set([1]), quiet: true })
    assert.ok(page && !page.isClosed())
    assert.equal(await page.evaluate(() => window.name), 'adal-run-1')
    console.log(`connected + run tab: ${(Date.now() - t0) / 1000} s`)
    if (process.env.BENCH_LIVE === '1') {
      const t1 = Date.now()
      await page.goto('https://tawtheeq.musaned.com.sa/', { waitUntil: 'domcontentloaded', timeout: 60000 })
      const dcl = (Date.now() - t1) / 1000
      await page.waitForFunction(() => [...document.querySelectorAll('a, button')].some(e => e.offsetWidth > 0 && /^\s*login\s*$/i.test(e.textContent || '')), { timeout: 45000 })
      console.log(`Musaned home: first page ${dcl} s, LOGIN shown ${(Date.now() - t1) / 1000} s (${page.url()})`)
    }
    tm.forgetRunTab(1)
    await closeBrowser()
  } finally {
    try { process.kill(-child.pid) } catch { child.kill() }   // the whole group: brave-browser is a script that starts brave
    await sleep(500)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test("Adal Browser's sign-ins carry over once to the PC's browser; its own profile stays", async () => {
  const { carryOverSignIns, profileFor } = await import('../src/services/browser.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-carry-'))
  const from = path.join(root, 'adal-browser'), to = path.join(root, 'browser-profile-edge')
  const saved = process.env.ADAL_BROWSER_PROFILE; delete process.env.ADAL_BROWSER_PROFILE
  try {
    fs.mkdirSync(path.join(from, 'Default', 'Network'), { recursive: true })
    fs.mkdirSync(path.join(from, 'Default', 'Cache'), { recursive: true })
    fs.writeFileSync(path.join(from, 'Default', 'Network', 'Cookies'), 'musaned-signin')
    fs.writeFileSync(path.join(from, 'Local State'), '{"os_crypt":{}}')
    fs.writeFileSync(path.join(from, 'SingletonLock'), 'x')
    assert.equal(carryOverSignIns({ from, to, mode: 'system' }), true)
    assert.equal(fs.readFileSync(path.join(to, 'Default', 'Network', 'Cookies'), 'utf8'), 'musaned-signin')
    assert.ok(fs.existsSync(path.join(to, 'Local State')))           // the key the cookies are locked with
    assert.ok(!fs.existsSync(path.join(to, 'Default', 'Cache')) && !fs.existsSync(path.join(to, 'SingletonLock')))
    assert.ok(fs.existsSync(path.join(from, 'Default', 'Network', 'Cookies')))   // Adal Browser's own stays
    assert.equal(carryOverSignIns({ from, to, mode: 'system' }), false)          // once: its own are as new now
    assert.equal(carryOverSignIns({ from, to, mode: 'adal' }), false)
    // A PC with no Brave/Chrome/Edge: Adal Browser after all, on its own profile.
    const { systemBrowser, ownBrowserPath } = await import('../src/services/browser.js')
    const own = ownBrowserPath()
    assert.equal(systemBrowser((f) => f === own, 'win32'), own)
    assert.equal(profileFor(own, 'system'), 'adal-browser')
    assert.match(systemBrowser((f) => /msedge|AdalBrowser/.test(f), 'win32'), /msedge\.exe$/)   // Edge before Adal Browser
    assert.equal(systemBrowser(() => false, 'win32'), null)
  } finally {
    if (saved !== undefined) process.env.ADAL_BROWSER_PROFILE = saved
    fs.rmSync(root, { recursive: true, force: true })
  }
})
