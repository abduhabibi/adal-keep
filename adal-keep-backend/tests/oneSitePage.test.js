/**
 * oneSitePage.test.js — 2026-11-25, Main: the contracts check had the one Musaned page, a run opened a second, Musaned
 * asked to sign out, the sign-out was stopped and the tab was left on Chrome's error page ("This site can't be reached").
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { findChrome, rmTmp } from './helpers/chrome.js'
import { pageForRun } from '../src/services/oneSitePage.js'

const CHROME = findChrome()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('a Musaned run asks the check to stop and goes on once it let go', async () => {
  const check = { running: true }
  const said = []
  const cancel = (why) => { said.push(why); setTimeout(() => { check.running = false }, 400) }
  const ms = await pageForRun('musaned_add_candidate', { check, cancel })
  assert.equal(said.length, 1)
  assert.ok(ms >= 300 && ms < 3000, `waited ${ms} ms`)
  assert.equal(await pageForRun('musaned_add_candidate', { check, cancel }), 0, 'no check: at once')
  check.running = true
  assert.equal(await pageForRun('lmis_contract', { check, cancel }), 0, 'another site: not asked')
  const stuck = await pageForRun('musaned_add_candidate', { check, cancel: () => {}, limitMs: 600 })
  assert.ok(stuck >= 600 && stuck < 3000, 'a check that does not let go never holds a run for ever')
  process.env.ADAL_ONE_PAGE = '0'
  assert.equal(await pageForRun('musaned_add_candidate', { check, cancel }), 0)
  delete process.env.ADAL_ONE_PAGE
})

test('a stopped sign-out leaves the page as it is, not an error page', { skip: !CHROME && 'no Chrome' }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-signout-'))
  Object.assign(process.env, { SQLITE_PATH: path.join(tmp, 's.sqlite'), ADAL_NO_BROWSER_START: '1', BRAVE_CDP_URL: 'http://127.0.0.1:9' })
  let outs = 0
  const srv = http.createServer((q, r) => {
    if (/logout/.test(q.url)) { outs++; r.writeHead(200); return r.end('SIGNED OUT') }
    r.writeHead(200, { 'Content-Type': 'text/html' }); r.end('<body><h1>HR Pool</h1><input id="x"><script>window.kept=1</script>')
  }).listen(0)
  await new Promise(r => srv.once('listening', r))
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-sandbox', '--host-resolver-rules=MAP *.wahid.sa 127.0.0.1, MAP *.musaned.com.sa 127.0.0.1'] })
  t.after(async () => { await browser.close().catch(() => {}); srv.close(); rmTmp(tmp) })
  const { setupTab } = await import('../src/services/tabManager.js')
  const port = srv.address().port
  const look = async (off) => {
    if (off) process.env.ADAL_ONE_PAGE = '0'; else delete process.env.ADAL_ONE_PAGE
    const page = await browser.newPage()
    await setupTab(page, { runId: 1 })
    await page.goto(`http://tawtheeq.musaned.com.sa:${port}/hr-pool`, { waitUntil: 'load' })
    await page.type('#x', 'EP123')
    await page.evaluate((u) => { location.href = u }, `http://accounts.wahid.sa:${port}/auth/realms/wahid/protocol/openid-connect/logout?client_id=x`)
    await sleep(1200)
    const r = { url: page.url(), text: await page.evaluate(() => document.querySelector('#x')?.value || ''), stopped: !!page.__adalSignOutStopped }
    await page.close()
    return r
  }
  const before = await look(true), now = await look(false)
  console.log('before:', before.url.slice(0, 40), '| now:', new URL(now.url).pathname, now.text)
  assert.match(before.url, /^chrome-error:/)
  assert.equal(new URL(now.url).pathname, '/hr-pool')
  assert.equal(now.text, 'EP123', 'what was typed stays')
  assert.equal(now.stopped, true)
  assert.equal(outs, 0, 'never signed out')
})
