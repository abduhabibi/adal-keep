/**
 * selfAssignE2E.test.js — the real Adal Robots program (its own process, a scratch copy) with another PC of the
 * office: a stand-in Companion (what adal-companion/robot.go does: /robot/now, /robot/json/version, /robot/ws, the
 * token) with a Chrome of its own. A queued "Check if chosen" chooses that PC by itself and works there (the main PC's
 * Chrome stays empty); the next run's PC is "switched off" while it works — nothing closes, nothing answers — and the
 * run ends, said plainly, and is not started again. Skipped without Chrome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import http from 'http'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { findChrome, rmTmp } from './helpers/chrome.js'

const BACK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHROME = findChrome()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-assign-e2e-'))
const ENV = { SQLITE_PATH: path.join(tmp, 'x.sqlite'), ACCOUNT_VAULT_KEY: path.join(tmp, 'v.key'), SECRETS_PATH: path.join(tmp, 's.enc'), ADAL_SPACES_FILE: path.join(tmp, 'sp.json'), ADAL_SESSION_COOKIES: path.join(tmp, 'c.json'), ADAL_ROBOTS_DATA: tmp, ADAL_BROWSER_PROFILE: path.join(tmp, 'never'), JEV_ENABLED: 'false', ADAL_ROBOTS_EXTRAS: '0', ADAL_ROBOTS_GATE: '0', ADAL_WAFID_STANDBY: '0', ADAL_NO_NET_PROBE: '1', ADAL_AGENCY_MANAGER: '0' }
Object.assign(process.env, ENV)
fs.writeFileSync(ENV.ACCOUNT_VAULT_KEY, (await import('crypto')).randomBytes(32).toString('base64'))
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const ACCOUNTS = [{ id: 1, name: 'Nuzla', username: 'nuzla', password: 'pw-nuzla', secret: 'JBSWY3DPEHPK3PXP' }]
const TOKEN = 'b'.repeat(32)

test('a run goes to the best PC by itself; a PC that dies ends it once', { skip: !CHROME && 'no Chrome', timeout: 170000 }, async (t) => {
  const knex = (await import('knex')).default
  const db = knex({ client: 'sqlite3', connection: { filename: ENV.SQLITE_PATH }, useNullAsDefault: true })
  await db.migrate.latest({ directory: path.join(BACK, 'src', 'migrations') })
  await db('musaned_accounts').insert({ id: 1, name: 'Nuzla', username: 'nuzla', password: 'pw-nuzla' })
  const [pid] = await db('profiles').insert({ full_name: 'TEST CANDIDATE ONE', first_name: 'TEST', last_name: 'ONE', passport_number: 'EP1234567' })
  await (await import('../src/services/musanedTotp.js')).saveAuthenticator(1, { text: ACCOUNTS[0].secret })
  const { startMockPortal } = await import('./helpers/mockPortal.js')
  const mock = await startMockPortal({ accounts: ACCOUNTS, dir: tmp, chosen: [] })
  const map = ['tawtheeq.musaned.com.sa', 'api-tawtheeq.musaned.com.sa', 'accounts.wahid.sa', 'www.google.com'].map(h => `MAP ${h} 127.0.0.1:${mock.port}`).join(', ')
  const mainPort = await freePort(), compPort = await freePort(), rport = await freePort()
  const chromeAt = (port, name) => spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(tmp, name)}`, '--window-size=1366,900', `--host-resolver-rules=${map}, EXCLUDE localhost`, '--ignore-certificate-errors', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  const mainChrome = chromeAt(mainPort, 'main'), compChrome = chromeAt(compPort, 'comp')
  // The Companion: what robot.go answers. dead = the PC is switched off (its connections stay, nothing comes back).
  let dead = false
  const pipes = []
  const comp = http.createServer(async (q, r) => {
    if (dead) return
    if (q.headers['x-adal-robot'] !== TOKEN) { r.statusCode = 404; return r.end() }
    r.setHeader('content-type', 'application/json')
    if (q.url.startsWith('/robot/now')) return r.end(JSON.stringify({ cores: 16, mem_gb: 32, free_gb: 20, load: 5, updating: false, browser: true, version: 'another' }))
    if (q.url.startsWith('/robot/json/version')) { const v = await (await fetch(`http://127.0.0.1:${compPort}/json/version`)).json(); v.webSocketDebuggerUrl = v.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, `ws://127.0.0.1:${comp.address().port}/robot/ws`); return r.end(JSON.stringify(v)) }
    r.statusCode = 404; r.end()
  })
  comp.on('upgrade', (q, sock, head) => {
    if (q.headers['x-adal-robot'] !== TOKEN) return sock.destroy()
    const back = net.connect(compPort, '127.0.0.1', () => { const h = Object.entries(q.headers).filter(([k]) => !['x-adal-robot', 'origin', 'host'].includes(k)).map(([k, v]) => `${k}: ${v}`).join('\r\n'); back.write(`GET ${q.url.replace('/robot/ws', '')} HTTP/1.1\r\nHost: 127.0.0.1:${compPort}\r\n${h}\r\n\r\n`); if (head.length) back.write(head) })
    sock.on('data', d => { if (!dead) back.write(d) }); back.on('data', d => { if (!dead) sock.write(d) })
    for (const s of [sock, back]) s.on('error', () => {})
    sock.on('close', () => back.destroy()); back.on('close', () => { if (!dead) sock.destroy() })
    pipes.push(sock, back)
  })
  await new Promise(r => comp.listen(0, '127.0.0.1', r))
  // What Adal Keep (another program) heard from it 2 minutes ago.
  fs.writeFileSync(path.join(tmp, 'robot-pcs.json'), JSON.stringify([{ id: 'C1', name: 'STRONG-PC', ip: '127.0.0.1', port: comp.address().port, token: TOKEN, cores: 16, mem_gb: 32, free_gb: 20, load: 5, lan: true, version: 'another', at: Date.now() - 120e3 }]))

  const COPY = path.join(tmp, 'backend')
  fs.mkdirSync(path.join(tmp, 'home'), { recursive: true })
  for (const f of ['src', 'robots', 'knexfile.js', 'package.json']) fs.cpSync(path.join(BACK, f), path.join(COPY, f), { recursive: true })
  fs.symlinkSync(path.join(BACK, 'node_modules'), path.join(COPY, 'node_modules'), 'dir')
  fs.mkdirSync(path.join(COPY, 'data'), { recursive: true })
  const env = { ...process.env, ...ENV, HOME: path.join(tmp, 'home'), BRAVE_CDP_URL: `http://127.0.0.1:${mainPort}`, ADAL_ROBOTS_PORT: String(rport) }
  delete env.ADAL_LAN_ROBOTS
  const robots = spawn(process.execPath, [path.join(COPY, 'robots', 'adal-robots.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  robots.stdout.on('data', d => { out += d }); robots.stderr.on('data', d => { out += d })
  const puppeteer = (await import('puppeteer-core')).default
  let there, here
  t.after(async () => {
    robots.kill('SIGKILL'); for (const s of pipes) s.destroy()
    try { there?.disconnect(); here?.disconnect() } catch {}
    mainChrome.kill('SIGKILL'); compChrome.kill('SIGKILL'); comp.closeAllConnections(); comp.close(); await mock.close(); await db.destroy().catch(() => {})
    await sleep(500); rmTmp(tmp)
  })
  const waitFor = async (fn, ms, what) => { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn().catch(() => null); if (v) return v; await sleep(250) } assert.fail(`timed out: ${what}\n${out.slice(-2500)}`) }
  const attach = (port) => waitFor(() => puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }), 15000, 'the Chrome')
  there = await attach(compPort); here = await attach(mainPort)
  const now = () => new Date().toISOString()
  const queue = async () => (await db('automation_queue').insert({ profile_id: pid, workflow_id: 'musaned_check_chosen', account_id: 1, status: 'pending', pause_reason: 'In line for Adal Robots', current_step: 0, context: JSON.stringify({ account_id: 1, musaned_username: 'nuzla', musaned_password: 'pw-nuzla', musaned_name: 'Nuzla' }), log: '[]', created_at: now(), updated_at: now() }))[0]
  const row = (id) => db('automation_queue').where('id', id).first()
  const logOf = async (id) => JSON.parse((await row(id)).log || '[]').map(l => l.msg).join('\n')

  const id = await queue()
  await waitFor(async () => /does this run by itself/.test(await logOf(id)), 60000, 'the PC chosen')
  console.log((await logOf(id)).split('\n').find(l => /by itself/.test(l)))
  const box = await waitFor(async () => { for (const p of await there.pages()) { const f = p.frames().find(f => /recaptcha\/api2\/anchor/.test(f.url())); const el = f && await f.$('#recaptcha-anchor'); if (el && await el.boundingBox()) return el } return null }, 90000, 'the sign-in on the other PC')
  assert.equal((await here.pages()).filter(p => p.url() !== 'about:blank').length, 0, 'nothing on the main PC')
  await sleep(1000)
  await box.click()                                   // (the person's tick; on a mock)
  const done = await waitFor(async () => { const r = await row(id); return ['done', 'failed', 'cancelled'].includes(r.status) ? r : null }, 60000, 'the run finished')
  assert.equal(done.status, 'done', done.pause_reason)
  assert.equal((await here.pages()).filter(p => p.url() !== 'about:blank').length, 0)
  for (let i = 0; i < 40 && !fs.existsSync(path.join(tmp, 'sign-in-homes.json')); i++) await sleep(250)   // (written just after the run's end)
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(path.join(tmp, 'sign-in-homes.json'), 'utf8')))[0].pc, 'C1', 'the account is signed in there now')

  // The next run: the PC is switched off while it works.
  for (const c of await there.defaultBrowserContext().cookies()) await there.defaultBrowserContext().deleteCookie(c)
  for (const p of await there.pages()) if (p.url() !== 'about:blank') await p.goto('about:blank').catch(() => {})
  const id2 = await queue()
  await waitFor(async () => /STRONG-PC's robot browser/.test(await logOf(id2)), 60000, 'it works there again')
  await waitFor(async () => /filled|waiting for a person/.test(await logOf(id2)), 60000, 'it is working')
  dead = true
  const t0 = Date.now()
  const end = await waitFor(async () => { const r = await row(id2); return ['failed', 'cancelled', 'done'].includes(r.status) || (r.status === 'paused') ? r : null }, 60000, 'the run ended')
  console.log(`its PC switched off: the run ended after ${Math.round((Date.now() - t0) / 1000)} s — ${end.status}: ${end.pause_reason}`)
  assert.equal(end.status, 'failed')
  assert.match(end.pause_reason, /STRONG-PC went away/)
  await sleep(6000)
  const rows = await db('automation_queue')
  assert.equal(rows.length, 2, 'not started again'); assert.equal((await row(id2)).status, 'failed')
})
