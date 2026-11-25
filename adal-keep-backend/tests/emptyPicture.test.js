/**
 * emptyPicture.test.js — 2026-11-25, Main: Musaned's page asked for its "no-image" picture again and again because the
 * robots' tab failed every picture (576 requests in 8 s, idle). Answered with an empty picture: asked once.
 * And a finished run's tab with the robot's own text in it is free; a person's, or a waiting run's, is not.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { findChrome, rmTmp } from './helpers/chrome.js'
import { robotsOwnTab } from '../src/services/robotsOwnTab.js'

const CHROME = findChrome()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test("a finished run's tab nobody touched is the robots' own; a person's or a waiting run's is not", () => {
  const busy = new Set([7])
  assert.equal(robotsOwnTab({ name: 'adal-run-5', touched: 0 }, busy, {}), true)
  assert.equal(robotsOwnTab({ name: 'adal-run-5', touched: Date.now() - 3600e3 }, busy, {}), false, 'a person was there')
  assert.equal(robotsOwnTab({ name: 'adal-run-7', touched: 0 }, busy, {}), false, 'that run waits or works')
  assert.equal(robotsOwnTab({ name: '', touched: 0 }, busy, {}), false, 'not a run\'s tab')
  assert.equal(robotsOwnTab({ name: 'adal-run-5', touched: 0 }, null, {}), false, 'the runs are not known')
  assert.equal(robotsOwnTab({ name: 'adal-run-5', touched: 0 }, busy, { ADAL_OWN_TABS: '0' }), false)
})

test('a page that asks again for a picture that failed asks once', { skip: !CHROME && 'no Chrome' }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-emptypic-'))
  Object.assign(process.env, { SQLITE_PATH: path.join(tmp, 's.sqlite'), ADAL_NO_BROWSER_START: '1', BRAVE_CDP_URL: 'http://127.0.0.1:9' })
  const srv = http.createServer((q, r) => {
    if (/favicon/.test(q.url)) { r.writeHead(404); return r.end() }
    r.writeHead(200, { 'Content-Type': 'text/html' })
    r.end(`<body><h1>Dashboard</h1><img src="/logo.png" onerror="window.n=(window.n||0)+1;this.src='/no-image.svg?'+window.n"><script>window.n=0</script>`)
  }).listen(0)
  await new Promise(r => srv.once('listening', r))
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-sandbox'] })
  t.after(async () => { await browser.close().catch(() => {}); srv.close(); rmTmp(tmp) })
  const { setupTab } = await import('../src/services/tabManager.js')
  const look = async (off) => {
    if (off) process.env.ADAL_EMPTY_PICTURES = '0'; else delete process.env.ADAL_EMPTY_PICTURES
    const page = await browser.newPage()
    await setupTab(page, { runId: 1 })
    let asked = 0
    page.on('request', q => { if (q.resourceType() === 'image') asked++ })
    await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    await page.close()
    return asked
  }
  const before = await look(true), now = await look(false)
  console.log(`pictures asked for in 2.5 s: ${before} failed as before, ${now} answered empty`)
  assert.ok(before > 20, `the loop is there with the fix off (${before})`)
  assert.equal(now, 1)
})
