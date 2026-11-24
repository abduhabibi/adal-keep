/**
 * signInReuse.test.js — asked on 2026-11-19, in a real Chrome (headless, its
 * own profile and port; never the PC's Adal Browser) against a mock Musaned on
 * its real addresses (tests/helpers/mockPortal.js):
 *  1. Morning sign-in and runs use the tab already signed in for that site and
 *     account: nothing opens, no second sign-in.
 *  2. A second account signs in in a browser space of its own: the two
 *     sessions never mix, and each tab is labelled with its account.
 *  3. Musaned needs the person for the tick only: name and password come from
 *     the vault, Sign in is pressed as soon as the box is ticked (never before),
 *     the authenticator code is typed from the stored key, and it goes on.
 * Skipped when this PC has no Chrome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import net from 'net'

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(f => fs.existsSync(f))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-signin-'))
// This test's own files only: never the PC's secrets, vault key, spaces or browser.
process.env.SECRETS_PATH = path.join(tmp, 'secrets.enc')
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'vault.key')
process.env.ADAL_SPACES_FILE = path.join(tmp, 'spaces.json')
process.env.JEV_ENABLED = 'false'
process.env.ADAL_NO_BROWSER_START = '1'
process.env.ADAL_WAFID_STANDBY = '0'   // the keeper's look never opens Wafid (the internet) in this test's Chrome
process.env.ADAL_BROWSER_PROFILE = path.join(tmp, 'never')
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const ACCOUNTS = [
  { id: 1, name: 'Nuzla', username: 'nuzla', password: 'pw-nuzla', secret: 'JBSWY3DPEHPK3PXP', is_default: 1 },
  { id: 2, name: 'Zad', username: 'zad', password: 'pw-zad', secret: 'KRSXG5CTMVRXEZLU', is_default: 0 },
]

test('sign-in: tab reuse, one space per account, the person only ticks the box', { skip: !CHROME && 'no Chrome on this PC', timeout: 180000 }, async (t) => {
  const { startMockPortal } = await import('./helpers/mockPortal.js')
  const mock = await startMockPortal({ accounts: ACCOUNTS, dir: tmp })
  const cdpPort = await freePort()
  const map = ['tawtheeq.musaned.com.sa', 'accounts.wahid.sa', 'www.google.com'].map(h => `MAP ${h} 127.0.0.1:${mock.port}`).join(', ')
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(tmp, 'profile')}`,
    `--host-resolver-rules=${map}, EXCLUDE localhost`, '--ignore-certificate-errors', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
  process.env.BRAVE_CDP_URL = `http://127.0.0.1:${cdpPort}`
  const knex = (await import('knex')).default
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
  let browser
  t.after(async () => {
    try { browser?.disconnect() } catch {}
    chrome.kill('SIGKILL'); await db.destroy().catch(() => {}); await mock.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  await db.schema.createTable('musaned_accounts', (x) => { x.integer('id'); x.string('name'); x.string('username'); x.string('password'); x.integer('is_default') })
  await db.schema.createTable('automation_queue', (x) => { x.integer('id'); x.string('status'); x.string('pause_reason'); x.string('workflow_id'); x.integer('account_id'); x.text('context') })
  await db('musaned_accounts').insert(ACCOUNTS.map(({ secret, ...a }) => a))
  const totp = await import('../src/services/musanedTotp.js')
  for (const a of ACCOUNTS) await totp.saveAuthenticator(a.id, { text: a.secret })

  const puppeteer = (await import('puppeteer-core')).default
  for (let i = 0; i < 40 && !browser; i++) { await sleep(250); browser = await puppeteer.connect({ browserURL: process.env.BRAVE_CDP_URL, defaultViewport: null }).catch(() => null) }
  assert.ok(browser, 'the test Chrome answers')
  const keeper = await import('../src/services/sessionKeeper.js')
  const { openRunTab, tabOfRun, forgetRunTab } = await import('../src/services/tabManager.js')
  const { spaceOf } = await import('../src/services/browser.js')
  const SITE = keeper.SITES.find(s => s.key === 'musaned')
  const cookieOf = async (p) => (await (await p.createCDPSession()).send('Network.getCookies', { urls: ['https://tawtheeq.musaned.com.sa/'] })).cookies.find(c => c.name === 'sess')?.value || ''
  const allPages = () => browser.pages()
  const waitFor = async (fn, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(250) } assert.fail(`timed out: ${what}`) }

  // ── The main account (Nuzla) is signed in already in a tab of the browser's own space.
  const nuzlaTab = (await allPages())[0]
  await nuzlaTab.goto('https://tawtheeq.musaned.com.sa/sso?u=nuzla', { waitUntil: 'domcontentloaded' })
  assert.equal(await cookieOf(nuzlaTab), 'nuzla')

  await t.test('1. Morning sign-in uses the tab already signed in: nothing opens, no sign-in', async () => {
    const before = (await allPages()).length
    const r = await keeper.openSite('musaned', db, { accountId: 1, browser })
    assert.equal(r.already, true)
    assert.equal((await allPages()).length, before, 'no new tab')
    assert.equal(mock.events.filter(e => e.what === 'login-post').length, 0, 'no second sign-in')
    await waitFor(async () => /^\[Nuzla\] /.test(await nuzlaTab.title()), 5000, 'the tab is labelled [Nuzla]')
  })

  let zadTab
  await t.test('2+3. Zad signs in in a space of its own; the person only ticks the box', async () => {
    const r = await keeper.openSite('musaned', db, { accountId: 2, browser })
    assert.ok(r.live, 'the tab is shown in the live view')
    zadTab = keeper.siteTab(r.live)
    assert.ok(zadTab, 'the live view finds the tab')
    assert.equal(spaceOf(zadTab), 'musaned:2', 'Zad works in its own browser space')
    // The vault's name and password are filled, the box is left for the person.
    await waitFor(() => zadTab.evaluate(() => document.querySelector('#username')?.value === 'zad' && document.querySelector('#password')?.value === 'pw-zad'), 60000, 'name and password filled')
    await sleep(3000)
    assert.equal(mock.events.filter(e => e.what === 'login-post').length, 0, 'Sign in is never pressed before the tick')
    const anchor = zadTab.frames().find(f => /recaptcha\/api2\/anchor/.test(f.url()))
    assert.equal(await anchor.evaluate(() => document.querySelector('#recaptcha-anchor').getAttribute('aria-checked')), 'false', 'Adal Keep never ticks the box')
    // The person ticks it.
    const tickedAt = Date.now()
    await anchor.click('#recaptcha-anchor')
    await waitFor(async () => mock.events.some(e => e.what === 'login-post'), 5000, 'Sign in pressed after the tick')
    const post = mock.events.find(e => e.what === 'login-post')
    assert.ok(post.ok && post.ticked && post.user === 'zad', 'signed in with the vault account and the token')
    assert.ok(post.at - tickedAt < 3000, `Sign in pressed at once (${post.at - tickedAt} ms)`)
    // The authenticator code from the stored key, then the dashboard.
    await waitFor(async () => mock.events.some(e => e.what === 'otp-post' && e.ok && e.user === 'zad'), 30000, 'the authenticator code typed and taken')
    await waitFor(async () => /\/dashboard/.test(zadTab.url()), 15000, 'on the dashboard')
    await waitFor(async () => !zadTab.__adalBorrowed, 15000, 'the tab is free for runs again')
    assert.equal(mock.events.filter(e => e.what === 'otp-post' && !e.ok).length, 0, 'no wrong code')
    await waitFor(async () => /^\[Zad\] /.test(await zadTab.title()), 5000, 'the tab is labelled [Zad]')
    // The sessions never mix.
    assert.equal(await cookieOf(zadTab), 'zad')
    assert.equal(await cookieOf(nuzlaTab), 'nuzla', 'Nuzla is still signed in as Nuzla')
  })

  // The keeper's background look (keepAlive) borrows a tab for a moment: wait until both are free,
  // so the checks below never depend on that timing (it made this test fail now and then).
  const bothFree = () => waitFor(async () => !zadTab.__adalBorrowed && !nuzlaTab.__adalBorrowed, 30000, 'both tabs free')
  await t.test('again for Zad: its signed-in tab is used, no new sign-in', async () => {
    await bothFree()
    const before = (await allPages()).length, posts = mock.events.length
    const r = await keeper.openSite('musaned', db, { accountId: 2, browser })
    assert.equal(r.already, true)
    assert.equal((await allPages()).length, before)
    assert.equal(mock.events.length, posts)
  })

  await t.test('runs take the signed-in tab of their own account, never the other one', async () => {
    await bothFree()
    const { spaceForAccount } = await import('../src/services/tabManager.js')
    const runZad = await openRunTab(browser, 901, { workflowId: 'musaned_check_chosen', busyRuns: new Set([901]), keepRuns: new Set([901]), space: await spaceForAccount(db, browser, 'musaned', 2) })
    assert.equal(runZad, zadTab, "Zad's run uses Zad's signed-in tab")
    const runNuzla = await openRunTab(browser, 902, { workflowId: 'musaned_check_chosen', busyRuns: new Set([901, 902]), keepRuns: new Set([901, 902]), space: await spaceForAccount(db, browser, 'musaned', 1) })
    assert.equal(runNuzla, nuzlaTab, "Nuzla's run uses Nuzla's signed-in tab")
    assert.equal(tabOfRun(901), zadTab)
    assert.equal(mock.events.filter(e => e.what === 'login-post').length, 1, 'still only the one sign-in (Zad)')
    forgetRunTab(901); forgetRunTab(902)
  })
})

test('a robot check that is never ticked: nothing is pressed', async () => {
  const { waitForTick } = await import('../src/services/robotCheck.js')
  let pressed = 0
  const fake = { evaluate: async () => ({ present: true, token: false }), frames: () => [] }
  const w = await waitForTick(fake, { onForm: async () => true, submit: async () => { pressed++ }, timeoutMs: 1200, pollMs: 100 })
  assert.equal(w, 'timeout')
  assert.equal(pressed, 0)
})
