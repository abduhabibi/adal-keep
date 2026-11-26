/**
 * restartReuse.test.js — Adal Robots restarted between two runs, real Chrome, real processes (2026-11-25, Main: every
 * run after a restart opened a Musaned tab of its own): run 1 types in the HR Pool's search and ends, the process ends,
 * run 2 takes the same tab; a paused run's tab, a person's and a sign-in page stay as they are.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import https from 'https'
import { execFile, execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { findChrome, rmTmp } from './helpers/chrome.js'
const CHROME = findChrome()
const HERE = path.dirname(fileURLToPath(import.meta.url))

test('run 1 types and ends, the robots restart, run 2 takes the same tab; a paused run\'s and a person\'s stay', { skip: !CHROME && 'no Chrome', timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-restart-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k`, '-out', `${tmp}/c`, '-days', '2', '-subj', '/CN=m'], { stdio: 'ignore' })
  const srv = https.createServer({ key: fs.readFileSync(`${tmp}/k`), cert: fs.readFileSync(`${tmp}/c`) }, (q, r) => {
    r.setHeader('content-type', 'text/html')
    r.end(q.url.startsWith('/hr-pool') || q.url.startsWith('/dashboard') ? '<nav><a>Dashboard</a> <a>Organizations</a> <a>HR Pool</a></nav><input id=q>' : '<input id=username><input type=password>')
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), defaultViewport: null,
    args: ['--no-first-run', '--disable-gpu', '--ignore-certificate-errors', ...['tawtheeq.musaned.com.sa', 'accounts.wahid.sa'].map(h => `--host-resolver-rules=MAP * 127.0.0.1:${srv.address().port}`).slice(0, 1)] })
  t.after(async () => { await b.close().catch(() => {}); srv.close(); srv.closeAllConnections(); rmTmp(tmp) })
  const env = { ...process.env, BRAVE_CDP_URL: 'http://127.0.0.1:9', ADAL_NO_BROWSER_START: '1', JEV_ENABLED: 'false', SECRETS_PATH: `${tmp}/s`, ACCOUNT_VAULT_KEY: `${tmp}/v`, ADAL_SPACES_FILE: `${tmp}/sp`, ADAL_ROBOT_PROCESS: '1', ADAL_ROBOTS_DATA: tmp, SQLITE_PATH: `${tmp}/d.sqlite` }
  delete env.NODE_TEST_CONTEXT
  const robots = (id, what, busy = '') => new Promise((ok, no) => execFile(process.execPath, [path.join(HERE, 'helpers', 'runTabChild.mjs'), b.wsEndpoint(), String(id), what, busy], { env, cwd: path.join(HERE, '..'), timeout: 40000 }, (e, so, se) => { const m = /OUT (.*)/.exec(so); m ? ok(JSON.parse(m[1])) : no(new Error(`${e?.message} ${so} ${se}`)) }))
  const musaned = async () => (await b.pages()).filter(p => /musaned/.test(p.url())).length

  const one = await robots(1, 'finish')
  assert.equal(one.isNew, true)
  const two = await robots(2, 'look')
  assert.equal(two.target, one.target, 'run 2 works in the same tab'); assert.equal(await musaned(), 1)
  // Again, with a sign-in page opened beside it earlier: the signed-in tab first.
  const signIn = await b.newPage(); await signIn.goto('https://accounts.wahid.sa/login'); await signIn.evaluate(() => { window.name = 'adal-run-90' })
  const three = await robots(3, 'finish')
  assert.equal(three.target, one.target, 'never /login with a signed-in tab beside it')
  await signIn.close()
  // A paused run's tab stays its own: the next run gets another.
  const four = await robots(4, 'pause')
  assert.equal(four.target, one.target)
  assert.notEqual((await robots(5, 'look', '4')).target, one.target, 'a paused run keeps its tab')
  const pages = await b.pages()
  const own = pages.find(p => p.target()._targetId === one.target)
  assert.equal(await own.evaluate(() => window.name), 'adal-run-4', 'still run 4\'s')
  assert.equal(await own.evaluate(() => document.querySelector('#q').value), 'EP1234567', 'as it was')
  for (const p of pages) if (p !== own && /musaned|blank/.test(p.url()) && pages.length > 2) await p.close().catch(() => {})
  // A person clicked and typed in it a moment ago: theirs. The run waits while they click (one page a site), then,
  // their form staying, opens its own.
  await own.evaluate(() => { window.name = 'adal-run-6'; sessionStorage.setItem('adal-touched', String(Date.now() - 57000)) })
  const t7 = Date.now(), seven = await robots(7, 'look')
  assert.notEqual(seven.target, one.target, 'a person\'s tab is not taken')
  assert.ok(Date.now() - t7 >= 2500, 'it waited while the person clicked')
  assert.equal(await own.evaluate(() => document.querySelector('#q').value), 'EP1234567')
})
