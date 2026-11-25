/**
 * freshForm.test.js — 2026-11-25: the form shown to a person was empty. Opening the live view fills an empty sign-in
 * of the run's own site, never another site's, never over what a person typed, never pressed; and Musaned's form that
 * emptied itself while the run waits is filled again. Real headless Chrome, mock Musaned. Skipped without them.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findChrome, rmTmp } from './helpers/chrome.js'

const CHROME = findChrome()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-form-'))
Object.assign(process.env, { ADAL_NO_BROWSER_START: '1', BRAVE_CDP_URL: 'http://127.0.0.1:9', SECRETS_PATH: path.join(tmp, 's.enc'), ACCOUNT_VAULT_KEY: path.join(tmp, 'v.key'), ADAL_SPACES_FILE: path.join(tmp, 'sp.json'), JEV_ENABLED: 'false' })
const { freshForm, credsOf } = await import('../src/services/freshForm.js')
const ACCOUNTS = [{ id: 1, name: 'Nuzla', username: 'nuzla', password: 'pw-nuzla' }]

test('whose name and password', () => {
  assert.equal(credsOf('{}'), null)
  assert.deepEqual(credsOf(JSON.stringify({ musaned_username: 'a', musaned_password: 'b', account_id: 3 })), { user: 'a', password: 'b', account_id: 3 })
  assert.deepEqual(credsOf({ login_value: '09', login_password: 'x' }), { user: '09', password: 'x', account_id: undefined })
})

test('the form a person opens', { skip: !CHROME && 'no Chrome', timeout: 100000 }, async (t) => {
  const { startMockPortal } = await import('./helpers/mockPortal.js')
  const mock = await startMockPortal({ accounts: ACCOUNTS, dir: tmp })
  const puppeteer = (await import('puppeteer-core')).default
  const map = ['tawtheeq.musaned.com.sa', 'accounts.wahid.sa', 'www.google.com'].map(h => `MAP ${h} 127.0.0.1:${mock.port}`).join(', ')
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-first-run', '--disable-gpu', `--host-resolver-rules=${map}, EXCLUDE localhost`, '--ignore-certificate-errors'] })
  t.after(async () => { await browser.close().catch(() => {}); await mock.close(); rmTmp(tmp) })
  const run = { id: 5, workflow_id: 'musaned_check_chosen', status: 'running', context: JSON.stringify({ musaned_username: 'nuzla', musaned_password: 'pw-nuzla', account_id: 1 }) }
  const db = () => ({ where: () => ({ first: async () => run }) })
  const SIGNIN = 'https://accounts.wahid.sa/auth/realms/wahid/protocol/openid-connect/auth'
  const val = (p) => p.evaluate(() => [document.querySelector('#username')?.value, document.querySelector('#password')?.value])
  const at = async () => { const p = await browser.newPage(); await p.goto(SIGNIN); return p }

  await t.test('empty: filled, Sign in not pressed', async () => {
    const p = await at()
    await p.evaluate(() => { for (const e of document.querySelectorAll('#username, #password')) e.value = '' })
    assert.equal(await freshForm(db, 5, p), 'filled')
    assert.deepEqual(await val(p), ['nuzla', 'pw-nuzla'])
    assert.equal(mock.events.filter(e => e.what === 'login-post').length, 0)
    await p.close()
  })
  await t.test('what a person typed stays; a person at it now: nothing', async () => {
    const p = await at()
    await p.evaluate(() => { document.querySelector('#username').value = 'another'; document.querySelector('#password').value = '' })
    assert.equal(await freshForm(db, 5, p), '')
    assert.deepEqual(await val(p), ['another', ''])
    p.__adalFreshAt = 0
    await p.evaluate(() => { document.querySelector('#username').value = '' })
    p.__adalInputAt = Date.now()
    assert.equal(await freshForm(db, 5, p), '')
    await p.close()
  })
  await t.test('another site (even a look-alike form), a finished run, switched off: nothing', async () => {
    const p = await browser.newPage()
    await p.setContent('<form><input id=username><input id=password type=password></form>')
    assert.equal(await freshForm(db, 5, p), '')
    assert.deepEqual(await val(p), ['', ''])
    await p.goto(SIGNIN); await p.evaluate(() => { document.querySelector('#password').value = '' })
    run.status = 'done'; assert.equal(await freshForm(db, 5, p), ''); run.status = 'running'
    process.env.ADAL_FRESH_FORM = '0'; assert.equal(await freshForm(db, 5, p), ''); delete process.env.ADAL_FRESH_FORM
    await p.close()
  })
  await t.test('a paused run\'s old form: opened fresh and filled; a running one\'s is the run\'s', async () => {
    const p = await at()
    await p.evaluate(() => { window.oldPage = true })
    assert.notEqual(await freshForm(db, 5, p, { freshMs: 0 }), 'fresh')
    assert.equal(await p.evaluate(() => !!window.oldPage), true)
    p.__adalFreshAt = 0; run.status = 'paused'
    assert.equal(await freshForm(db, 5, p, { freshMs: 0 }), 'fresh')
    assert.equal(await p.evaluate(() => !!window.oldPage), false)
    assert.deepEqual(await val(p), ['nuzla', 'pw-nuzla'])
    run.status = 'running'
    await p.close()
  })
  await t.test('the form empties itself while the run waits for the tick: filled again within seconds', async () => {
    const { waitForTick } = await import('../src/services/robotCheck.js')
    const p = await at()
    let refills = 0, off = false
    const w = waitForTick(p, { onForm: async () => true, submit: async () => {}, refill: async () => { refills++; await p.evaluate(() => { if (!document.querySelector('#password').value) document.querySelector('#password').value = 'pw-nuzla' }) }, isCancelled: () => off, timeoutMs: 20000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 1000))
    await p.evaluate(() => { document.querySelector('#password').value = '' })
    await new Promise(r => setTimeout(r, 6000))
    assert.ok(refills >= 1); assert.equal((await val(p))[1], 'pw-nuzla')
    off = true; await w
    await p.close()
  })
})
