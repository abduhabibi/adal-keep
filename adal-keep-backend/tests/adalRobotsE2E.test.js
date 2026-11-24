/**
 * adalRobotsE2E.test.js — Adal Robots end to end on a scratch copy (never the PC's own database, browser or
 * secrets): a "Check if chosen" put in line the way Adal Keep's button does ('In line for Adal Robots'), the real
 * program (robots/adal-robots.mjs, its own process) claims it, signs in to a mock Musaned in its own headless
 * Chrome with the vault's name and password, waits for the person's "I'm not a robot" — ticked through Adal
 * Keep's live view (services/robotsLink.js → the program's 127.0.0.1 port) — types the authenticator code,
 * reads the Employment Requests list and writes the result back. Times are printed.
 * Skipped without Chrome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const BACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(f => fs.existsSync(f))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-robots-e2e-'))
const ENV = {
  SQLITE_PATH: path.join(tmp, 'scratch.sqlite'),
  ACCOUNT_VAULT_KEY: path.join(tmp, 'vault.key'),
  SECRETS_PATH: path.join(tmp, 'secrets.enc'),
  ADAL_SPACES_FILE: path.join(tmp, 'spaces.json'),
  ADAL_SESSION_COOKIES: path.join(tmp, 'cookies.json'),
  ADAL_ROBOTS_DATA: tmp,
  ADAL_BROWSER_PROFILE: path.join(tmp, 'never'),
  JEV_ENABLED: 'false',
  ADAL_ROBOTS_EXTRAS: '0',
  ADAL_ROBOTS_CPU: '0.99',
  ADAL_WAFID_STANDBY: '0',
}
Object.assign(process.env, ENV)
fs.writeFileSync(ENV.ACCOUNT_VAULT_KEY, (await import('crypto')).randomBytes(32).toString('base64'))
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const ACCOUNTS = [{ id: 1, name: 'Nuzla', username: 'nuzla', password: 'pw-nuzla', secret: 'JBSWY3DPEHPK3PXP' }]

test('Adal Robots claims a queued Check if chosen, the person ticks through Adal Keep, the result is written back', { skip: !CHROME && 'no Chrome', timeout: 240000 }, async (t) => {
  const knex = (await import('knex')).default
  const db = knex({ client: 'sqlite3', connection: { filename: ENV.SQLITE_PATH }, useNullAsDefault: true })
  await db.migrate.latest({ directory: path.join(BACK, 'src', 'migrations') })
  await db('musaned_accounts').insert({ id: 1, name: 'Nuzla', username: 'nuzla', password: 'pw-nuzla', is_default: 1 }).catch(async () => db('musaned_accounts').insert({ id: 1, name: 'Nuzla', username: 'nuzla', password: 'pw-nuzla' }))
  const [pid] = await db('profiles').insert({ full_name: 'TEST CANDIDATE ONE', first_name: 'TEST', last_name: 'ONE', passport_number: 'EP1234567' })
  const totp = await import('../src/services/musanedTotp.js')
  await totp.saveAuthenticator(1, { text: ACCOUNTS[0].secret })
  const now = new Date().toISOString()
  const [runId] = await db('automation_queue').insert({
    profile_id: pid, workflow_id: 'musaned_check_chosen', account_id: 1, status: 'pending', pause_reason: 'In line for Adal Robots', current_step: 0,
    context: JSON.stringify({ account_id: 1, musaned_username: 'nuzla', musaned_password: 'pw-nuzla', musaned_name: 'Nuzla' }), log: '[]', created_at: now, updated_at: now,
  })

  const { startMockPortal } = await import('./helpers/mockPortal.js')
  const mock = await startMockPortal({ accounts: ACCOUNTS, dir: tmp, chosen: [] })
  const cdp = await freePort(), rport = await freePort()
  const map = ['tawtheeq.musaned.com.sa', 'api-tawtheeq.musaned.com.sa', 'accounts.wahid.sa', 'www.google.com'].map(h => `MAP ${h} 127.0.0.1:${mock.port}`).join(', ')
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdp}`, `--user-data-dir=${path.join(tmp, 'profile')}`, '--window-size=1366,900',
    `--host-resolver-rules=${map}, EXCLUDE localhost`, '--ignore-certificate-errors', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  // A scratch install of the program: its own folder (its own licence trial, data/ and token), node_modules linked.
  const COPY = path.join(tmp, 'backend'), HOME = path.join(tmp, 'home')
  fs.mkdirSync(HOME, { recursive: true })
  for (const f of ['src', 'robots', 'knexfile.js', 'package.json']) fs.cpSync(path.join(BACK, f), path.join(COPY, f), { recursive: true })
  fs.symlinkSync(path.join(BACK, 'node_modules'), path.join(COPY, 'node_modules'), 'dir')
  fs.mkdirSync(path.join(COPY, 'data'), { recursive: true })
  const T0 = Date.now()
  const robots = spawn(process.execPath, [path.join(COPY, 'robots', 'adal-robots.mjs')], {
    env: { ...process.env, ...ENV, HOME, BRAVE_CDP_URL: `http://127.0.0.1:${cdp}`, ADAL_ROBOTS_PORT: String(rport) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  robots.stdout.on('data', d => { out += d }); robots.stderr.on('data', d => { out += d })
  let app = null
  t.after(async () => {
    try { robots.kill('SIGTERM') } catch {}
    await sleep(800)
    try { robots.kill('SIGKILL') } catch {}
    chrome.kill('SIGKILL'); app?.close(); await mock.close(); await db.destroy().catch(() => {})
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const row = () => db('automation_queue').where('id', runId).first()
  const waitFor = async (fn, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(300) } assert.fail(`timed out: ${what}\n--- Adal Robots said:\n${out.slice(-3000)}`) }

  // Claimed by Adal Robots (Adal Keep runs none).
  await waitFor(async () => (await row()).status !== 'pending', 60000, 'Adal Robots claimed the run')
  const claimedS = (Date.now() - T0) / 1000

  // Adal Keep's side: the live view of the run's tab through services/robotsLink.js.
  process.env.ADAL_ROBOTS_PORT = String(rport)
  delete process.env.ADAL_ROBOTS_IN_APP
  const express = (await import('express')).default
  const { robotsLink } = await import('../src/services/robotsLink.js')
  const keep = express(); keep.use(express.json()); keep.use('/api', robotsLink); keep.use((req, res) => res.status(404).end())
  app = await new Promise(r => { const s = keep.listen(0, '127.0.0.1', () => r(s)) })
  const K = `http://127.0.0.1:${app.address().port}/api`

  // The robot waits for the tick: the box is drawn in its tab.
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdp}`, defaultViewport: null })
  let anchorBox = null, tab = null
  await waitFor(async () => {
    for (const p of await browser.pages()) {
      const f = p.frames().find(f => /recaptcha\/api2\/anchor/.test(f.url()))
      if (!f) continue
      const el = await f.$('#recaptcha-anchor'); if (!el) continue
      const b = await el.boundingBox(); if (!b) continue
      const vp = await p.evaluate(() => ({ w: innerWidth, h: innerHeight }))
      anchorBox = { x: (b.x + b.width / 2) / vp.w, y: (b.y + b.height / 2) / vp.h }; tab = p
      return true
    }
    return false
  }, 90000, 'the "I\'m not a robot" box drawn in the run\'s tab')
  const boxS = (Date.now() - T0) / 1000
  assert.equal(mock.events.filter(e => e.what === 'login-post').length, 0, 'Sign in is never pressed before the tick')
  const shot = await fetch(`${K}/automations/${runId}/screen`)
  assert.equal(shot.status, 200, 'Adal Keep shows the run\'s tab (through Adal Robots)')
  assert.match(shot.headers.get('content-type') || '', /image/)

  const ac = new AbortController()
  const st = await fetch(`${K}/automations/${runId}/stream`, { signal: ac.signal })
  assert.equal(st.status, 200, 'the live view\'s stream')
  const tPic = Date.now()
  const piece = await Promise.race([st.body.getReader().read(), sleep(15000).then(() => null)])
  assert.ok(piece?.value?.length, 'its first picture comes')
  console.log(`the live view's first picture: ${Date.now() - tPic} ms`)
  ac.abort()

  // The person ticks the box in Adal Keep's live view.
  const tick = await fetch(`${K}/automations/${runId}/input`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batch: [{ kind: 'mouse', type: 'move', ...anchorBox }, { kind: 'mouse', type: 'down', ...anchorBox, button: 0, buttons: 1, clickCount: 1 }, { kind: 'mouse', type: 'up', ...anchorBox, button: 0, buttons: 0, clickCount: 1 }] }) })
  assert.equal(tick.status, 200, 'the click reached the tab')
  const tickedAt = Date.now()
  await waitFor(async () => mock.events.some(e => e.what === 'login-post'), 15000, 'Sign in pressed after the tick')
  const final = await waitFor(async () => { const r = await row(); return ['done', 'failed', 'cancelled'].includes(r.status) ? r : null }, 120000, 'the run finished')
  const doneS = (Date.now() - tickedAt) / 1000
  const log = JSON.parse(final.log || '[]').map(l => l.msg).join('\n')
  console.log(`Adal Robots, scratch copy: claimed in ${claimedS.toFixed(1)} s, the box drawn at ${boxS.toFixed(1)} s, after the tick done in ${doneS.toFixed(1)} s (total ${((Date.now() - T0) / 1000).toFixed(1)} s)`)
  assert.equal(final.status, 'done', `the run is done (${final.pause_reason || ''})\n${log.slice(-1500)}`)
  assert.ok(mock.events.some(e => e.what === 'otp-post' && e.ok), 'the authenticator code typed and taken')
  assert.ok(mock.events.some(e => e.what === 'list' && e.ok), 'the Employment Requests list read with the page\'s own sign-in')
  assert.match(log, /Not on the chosen list/)
  assert.ok((await db('profiles').where('id', pid).first()).contract_checked_at, 'her check is written back')
  browser.disconnect()
  void tab
})
