/**
 * dayLogin.test.js — the owner, 2026-11-24: "not relogin at all and keep every login for a day". A portal's
 * sign-in that lives only while the browser is open (a session cookie) is kept, locked with the account
 * vault, and given back to a robot browser that starts again (24 h at most); other sites' cookies never.
 * In a headless browser of the test's own (its own vault key and files). Skipped without one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const EXE = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/brave.com/brave/brave'].find(f => fs.existsSync(f))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-daylogin-'))
process.env.HOME = tmp
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'account-vault.key')
process.env.ADAL_SESSION_COOKIES = path.join(tmp, 'session-cookies.json')
process.env.ADAL_NO_BROWSER_START = '1'
process.env.JEV_ENABLED = 'false'
fs.writeFileSync(process.env.ACCOUNT_VAULT_KEY, (await import('crypto')).randomBytes(32).toString('base64'))

test('only the portals\' session cookies are kept', async () => {
  const { portalSessionCookies } = await import('../src/services/sessionKeeper.js')
  const kept = portalSessionCookies([
    { name: 'KEYCLOAK_SESSION', value: 'a', domain: 'accounts.wahid.sa', path: '/', session: true },
    { name: 'x', value: 'b', domain: '.tawtheeq.musaned.com.sa', path: '/', session: true },
    { name: 'remember', value: 'c', domain: 'accounts.wahid.sa', path: '/', session: false, expires: 2e9 },   // on disk already
    { name: 'ad', value: 'd', domain: '.doubleclick.net', path: '/', session: true },
  ])
  assert.deepEqual(kept.map(c => c.name), ['KEYCLOAK_SESSION', 'x'])
})

test('a browser started again gets the day\'s sign-ins back, locked on disk, none older than 24 h', { skip: !EXE && 'no browser', timeout: 60000 }, async () => {
  const { saveSessionCookies, restoreSessionCookies } = await import('../src/services/sessionKeeper.js')
  const puppeteer = (await import('puppeteer-core')).default
  const start = () => puppeteer.launch({ executablePath: EXE, headless: true, userDataDir: path.join(tmp, 'p' + Math.random()), args: ['--no-first-run'] })
  const cookie = { name: 'KEYCLOAK_SESSION', value: 'nuzla-signed-in', domain: 'accounts.wahid.sa', path: '/', secure: true, httpOnly: true }
  let a = await start()
  try {
    const cdp = await a.target().createCDPSession()
    await cdp.send('Storage.setCookies', { cookies: [cookie, { name: 'ad', value: 'x', domain: '.doubleclick.net', path: '/' }] })
    assert.equal(await saveSessionCookies(a), 1)
  } finally { await a.close() }
  const onDisk = fs.readFileSync(process.env.ADAL_SESSION_COOKIES, 'utf8')
  assert.ok(!onDisk.includes('nuzla-signed-in'), 'locked with the vault on disk')
  const b = await start()
  try {
    assert.equal(await restoreSessionCookies(b), 1)
    const cdp = await b.target().createCDPSession()
    const { cookies } = await cdp.send('Storage.getCookies')
    assert.equal(cookies.find(c => c.name === 'KEYCLOAK_SESSION')?.value, 'nuzla-signed-in')
    assert.ok(!cookies.some(c => c.name === 'ad'))
    assert.equal(await restoreSessionCookies(b, { now: Date.now() + 25 * 3600e3 }), 0)   // older than a day: not given
    // A connection where the browser will not give its own session ("No target with given id"): through a tab.
    const stubborn = { target: () => ({ createCDPSession: async () => { throw new Error('Protocol error (Target.attachToTarget): No target with given id found') } }), pages: () => b.pages() }
    if (!(await b.pages()).length) await b.newPage()
    assert.equal(await saveSessionCookies(stubborn), 1, 'kept through a tab')
    assert.equal(await restoreSessionCookies(stubborn), 1, 'given back through a tab')
  } finally { await b.close(); fs.rmSync(tmp, { recursive: true, force: true }) }
})
