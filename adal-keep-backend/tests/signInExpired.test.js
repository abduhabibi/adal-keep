/**
 * signInExpired.test.js — 2026-11-24 live: the person ticked "I'm not a robot" through the live view after the
 * form had waited 2–3 minutes; wahid.sa's sign-in had expired ("Your login attempt timed out. Login will start
 * from the beginning."), the form came back empty, and the run waited for a new tick that could never work.
 * Now: that page → Musaned's sign-in again (name and password filled), the person told once to tick again;
 * a person opening a form that waited over a minute → loaded fresh first; a refused password → said plainly,
 * nothing more tried. Real headless Chrome against the mock Musaned (tests/helpers/mockPortal.js).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findChrome, rmTmp } from './helpers/chrome.js'
import net from 'net'
import { spawn } from 'child_process'

const CHROME = findChrome()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-expired-'))
process.env.SECRETS_PATH = path.join(tmp, 'secrets.enc')
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'vault.key')
process.env.ADAL_SPACES_FILE = path.join(tmp, 'spaces.json')
process.env.JEV_ENABLED = 'false'
process.env.ADAL_NO_BROWSER_START = '1'
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const ACCOUNTS = [{ id: 1, name: 'Nuzla', username: 'nuzla', password: 'pw-nuzla', secret: 'JBSWY3DPEHPK3PXP' }]

test('an expired Musaned sign-in starts again; a stale form is fresh for the tick; a wrong password is said', { skip: !CHROME && 'no Chrome', timeout: 280000 }, async (t) => {
  const { startMockPortal } = await import('./helpers/mockPortal.js')
  const mock = await startMockPortal({ accounts: ACCOUNTS, dir: tmp, loginTtlMs: 4000 })
  const cdp = await freePort()
  const map = ['tawtheeq.musaned.com.sa', 'accounts.wahid.sa', 'www.google.com'].map(h => `MAP ${h} 127.0.0.1:${mock.port}`).join(', ')
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdp}`, `--user-data-dir=${path.join(tmp, 'profile')}`, '--window-size=1366,900',
    `--host-resolver-rules=${map}, EXCLUDE localhost`, '--ignore-certificate-errors', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  const puppeteer = (await import('puppeteer-core')).default
  let browser
  for (let i = 0; i < 40 && !browser; i++) { await sleep(250); browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdp}`, defaultViewport: null }).catch(() => null) }
  t.after(async () => { try { browser?.disconnect() } catch {}; chrome.kill('SIGKILL'); await mock.close(); rmTmp(tmp) })
  await (await import('../src/services/musanedTotp.js')).saveAuthenticator(1, { text: ACCOUNTS[0].secret })
  const w = await import('../src/services/musanedWorkflow.js')
  const anchor = (p) => p.frames().find(f => /recaptcha\/api2\/anchor/.test(f.url()))
  const tick = async (p) => { for (let i = 0; i < 60; i++) { const f = anchor(p); const el = f && await f.$('#recaptcha-anchor').catch(() => null); if (el && await el.boundingBox()) { await el.click(); return } await sleep(250) } assert.fail('no box to tick') }
  const ctxOf = (logs, asks, extra = {}) => ({ musaned_username: 'nuzla', musaned_password: 'pw-nuzla', account_id: 1, profileName: 'Test', runId: 't', profileId: '-',
    onLog: (l, m) => logs.push(m), notify: async (title) => { asks.push(title) }, isCancelled: () => false, ...extra })

  await t.test('timed out after the tick: started again, the person told once, signed in on the second tick', async () => {
    const p = await (await browser.createBrowserContext()).newPage()   // (its own cookies: signed out)
    const logs = [], asks = []
    const run = w.signInMusaned(p, ctxOf(logs, asks))
    for (let i = 0; i < 80 && !anchor(p); i++) await sleep(250)
    await sleep(4500)                                   // the sign-in expires while it waits (4 s here; 2–3 min on wahid.sa)
    await tick(p)
    for (let i = 0; i < 80 && !mock.events.some(e => e.what === 'login-expired'); i++) await sleep(250)
    assert.ok(mock.events.some(e => e.what === 'login-expired'), 'Musaned said the sign-in timed out')
    for (let i = 0; i < 80 && !asks.some(a => /again/.test(a)); i++) await sleep(250)
    assert.equal(asks.filter(a => /again/.test(a)).length, 1, 'the person is told once to tick again')
    assert.ok(logs.some(l => /timed out .*started again/.test(l)), logs.join('\n'))
    // The new sign-in is filled again; the person ticks at once.
    await p.waitForFunction(() => document.querySelector('#password')?.value === 'pw-nuzla', { timeout: 30000 })
    await tick(p)
    assert.equal(await run, 'dashboard', logs.join('\n'))
    await p.close()
  })

  await t.test('a person opens a form that waited too long: loaded fresh before the tick', async () => {
    const p = await (await browser.createBrowserContext()).newPage()   // (its own cookies: signed out)
    const logs = [], asks = []
    const expiredBefore = mock.events.filter(e => e.what === 'login-expired').length
    const run = w.signInMusaned(p, ctxOf(logs, asks, { loginFreshMs: 2000 }))
    for (let i = 0; i < 120 && !logs.some(l => /waiting for a person to tick/.test(l)); i++) await sleep(250)
    await sleep(2500)                                    // the form waits longer than loginFreshMs (2 s here; 60 s live)
    p.__adalLookedAt = Date.now()                        // the live view opened (a person looks)
    for (let i = 0; i < 60 && !logs.some(l => /loaded fresh for the tick/.test(l)); i++) await sleep(250)
    assert.ok(logs.some(l => /loaded fresh for the tick/.test(l)), logs.join('\n'))
    await p.waitForFunction(() => document.querySelector('#password')?.value === 'pw-nuzla', { timeout: 30000 })
    await tick(p)
    assert.equal(await run, 'dashboard', logs.join('\n'))
    assert.equal(mock.events.filter(e => e.what === 'login-expired').length, expiredBefore, 'the tick went onto a live sign-in')
    await p.close()
  })

  // Run 1795531032938001, 18:14: put back in line, filled on the old page that said it had timed out.
  for (const how of ['shows "timed out"', 'is an old form']) await t.test(`a run put back in line whose tab ${how}: loaded fresh before anything is filled`, async () => {
    const p = await (await browser.createBrowserContext()).newPage()
    await p.goto(`https://accounts.wahid.sa/auth/realms/wahid/protocol/openid-connect/auth${/timed out/.test(how) ? '?expired=1' : ''}`)
    await p.evaluate(() => { window.oldPage = true })
    if (/timed out/.test(how)) p.__adalRootAt = Date.now()       // even one it loaded a moment ago
    const logs = [], asks = []
    let cancelled = false
    const run = w.runMusanedWorkflow(p, ctxOf(logs, asks, { musanedStage: 'awaiting-musaned-captcha', workflowId: 'musaned_check_chosen', profile: { passport_number: 'EP1234567' }, isCancelled: () => cancelled }))
    run.catch(() => {})
    for (let i = 0; i < 160 && !logs.some(l => /waiting for a person to tick/.test(l)); i++) await sleep(250)
    assert.ok(logs.some(l => /loading Musaned's sign-in fresh/.test(l)), logs.join('\n'))
    assert.equal(await p.evaluate(() => !!window.oldPage), false, 'a new page')
    assert.equal(await p.evaluate(() => document.querySelector('#password').value), 'pw-nuzla', 'filled again')
    assert.equal(asks.filter(a => /tick/.test(a)).length, 1, 'asked once')
    cancelled = true
    await run.catch(() => {})
    await p.close().catch(() => {})
  })

  await t.test('a form the person has ticked is left as it is', async () => {
    const p = await (await browser.createBrowserContext()).newPage()
    await p.goto('https://accounts.wahid.sa/auth/realms/wahid/protocol/openid-connect/auth')
    await p.evaluate(() => { window.oldPage = true })
    await tick(p)
    await sleep(500)
    const o = await w.stepOpenMusaned(p, ctxOf([], []))
    assert.equal(o.onKeycloak, true)
    assert.equal(await p.evaluate(() => window.oldPage), true, 'not loaded again')
    await p.close()
  })

  await t.test('JEV answers after 25 s: after the tick and the code the dashboard is told at once (2026-11-25, Main)', async () => {
    const p = await (await browser.createBrowserContext()).newPage()
    const logs = [], asks = []
    let asked = 0
    const run = w.signInMusaned(p, ctxOf(logs, asks, { reviewScreen: async () => { asked++; await new Promise(r => { setTimeout(r, 25000).unref?.() }); return { screen: 'unknown', source: 'jev' } } }))
    for (let i = 0; i < 80 && !anchor(p); i++) await sleep(250)
    await tick(p)
    const t0 = Date.now()
    assert.equal(await run, 'dashboard', logs.join('\n'))
    const ms = Date.now() - t0
    console.log(`JEV of 25 s: signed in ${ms} ms after the tick (JEV asked ${asked} time(s))`)
    assert.ok(ms < 15000, `${ms} ms`)
    await p.close()
  })

  await t.test('a refused password is said in plain words and nothing more is tried', async () => {
    const p = await (await browser.createBrowserContext()).newPage()   // (its own cookies: signed out)
    const logs = [], asks = []
    const run = w.signInMusaned(p, ctxOf(logs, asks, { musaned_password: 'wrong' }))
    for (let i = 0; i < 80 && !anchor(p); i++) await sleep(250)
    await tick(p)
    await assert.rejects(run, /refused the name or password/)
    await p.close()
  })
})
