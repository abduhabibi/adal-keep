/**
 * lighter.test.js — the robot browser uses less of the PC (2026-11-25): what a page does not need does not come down
 * (pageDiet.js), a page that waits for a person rests while nobody looks (restPage.js) and is awake at once when one
 * does, empty tabs go (spareBlanks.js), no Wafid standby on a weak PC. Each with its off switch. Real headless Chrome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { findChrome, rmTmp } from './helpers/chrome.js'

process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
process.env.ADAL_NO_BROWSER_START = '1'
const CHROME = findChrome()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const req = (url, type = 'script', frame = 'https://tawtheeq.musaned.com.sa/', nav = false) => ({ url: () => url, resourceType: () => type, isNavigationRequest: () => nav, frame: () => ({ url: () => frame }) })

test('what does not come down: analytics, speed monitors, fonts; never the site\'s own, Google\'s box or its letters', async () => {
  const { notNeeded } = await import('../src/services/pageDiet.js')
  for (const u of ['https://snippet.maze.co/a.js', 'https://apm.tamkeentech.sa/intake', 'https://prompts.maze.co/x', 'https://js.sentry.io/x']) assert.equal(notNeeded(req(u)), true, u)
  for (const u of ['https://tawtheeq.musaned.com.sa/main.js', 'https://api-tawtheeq.musaned.com.sa/api/x', 'https://www.google.com/recaptcha/api.js', 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', 'https://amaze.com/x.js'])
    assert.equal(notNeeded(req(u)), false, u)
  const font = 'https://fonts.gstatic.com/s/roboto/v1/x.woff2'
  assert.equal(notNeeded(req(font, 'font')), true, 'a page\'s font')
  assert.equal(notNeeded(req(font, 'font', 'https://www.google.com/recaptcha/api2/bframe?k=x')), false, 'the captcha\'s letters')
  assert.equal(notNeeded(req(font, 'font'), { pictures: true }), false, 'a page whose pictures are wanted')
  assert.equal(notNeeded(req('https://snippet.maze.co/', 'document', '', true)), false, 'a page somebody opens')
  process.env.ADAL_PAGE_DIET = '0'
  assert.equal(notNeeded(req('https://snippet.maze.co/a.js')), false)
  delete process.env.ADAL_PAGE_DIET
  assert.equal(notNeeded({ url: () => { throw new Error('x') } }), false, 'an error: it comes down')
})

test('empty tabs: which go', async () => {
  const { spares } = await import('../src/services/spareBlanks.js')
  const blank = (x = {}) => ({ blank: true, used: false, anchor: false, ms: 90000, ...x })
  assert.equal(spares([blank(), blank()]).length, 0, 'only empty tabs: not its business')
  assert.equal(spares([{ blank: false }, blank()]).length, 1)
  assert.equal(spares([{ blank: false }, blank({ used: true }), blank({ anchor: true }), blank({ ms: 5000 })]).length, 0)
})

test('no Wafid standby on a weak PC', async () => {
  const { wafidStandby } = await import('../src/services/sessionKeeper.js')
  const cpus = os.cpus
  os.cpus = () => cpus().slice(0, 2)
  try {
    let closed = 0
    const tab = (x) => ({ url: () => 'https://wafid.com/en/search-slip/', close: async () => { closed++ }, ...x })
    assert.equal(await wafidStandby({}, [tab({ __adalStandbyAt: 1 }), tab({}), tab({ __adalStandbyAt: 1, __adalRunId: 7 })]), null)
    assert.equal(closed, 1, 'the standby tab only: never a run\'s or another')
  } finally { os.cpus = cpus }
})

test('a waiting page rests while nobody looks, is awake at once for the person, and the run goes on', { skip: !CHROME && 'no Chrome', timeout: 100000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-lighter-'))
  // A sign-in page with a spinner; the "tick" is a checkbox of the mock's own.
  const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(`<style>@keyframes s{to{transform:rotate(360deg)}}#s{width:80px;height:80px;border:6px solid #39c;animation:s 1s linear infinite}</style><div id=s></div>
<form><input type=password value=x><textarea name="g-recaptcha-response" style="display:none"></textarea><input type=checkbox id=t onclick="document.querySelector('textarea').value='x'.repeat(40)"></form>
<script>window.n=0;setInterval(()=>n++,50)</script>`) }).listen(0, '127.0.0.1')
  await new Promise(r => srv.once('listening', r))
  const url = `http://127.0.0.1:${srv.address().port}/`
  const puppeteer = (await import('puppeteer-core')).default
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: tmp, defaultViewport: null, ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],   // (as Adal Keep starts it)
    args: ['--no-first-run', '--disable-gpu', '--disable-backgrounding-occluded-windows'] })
  t.after(async () => { await b.close().catch(() => {}); srv.close(); rmTmp(tmp) })
  const tm = await import('../src/services/tabManager.js')
  const { waitForTick } = await import('../src/services/robotCheck.js')
  const p = await b.newPage()
  await tm.setupTab(p)
  await p.goto(url)
  await (await b.newPage()).goto(url)                  // another tab in front (a browser with more tabs than one)
  const ticks = async (ms) => { const a = await p.evaluate('n'); await sleep(ms); return (await p.evaluate('n') - a) / ms * 1000 }
  assert.ok(await ticks(1500) > 10, 'full speed before')
  let gone = false, submitted = 0
  const wait = waitForTick(p, { onForm: async () => !gone, submit: async () => { submitted++; gone = true }, timeoutMs: 60000, rest: { afterMs: 1500 } })
  await sleep(4500)
  const slow = await ticks(4000)
  assert.ok(slow < 3, `it rests: ${slow.toFixed(1)} timer ticks a second`)
  assert.equal(await p.evaluate(() => document.getAnimations()[0].currentTime === document.getAnimations()[0].currentTime && document.hidden), true, 'nobody sees it')
  const a1 = await p.evaluate(() => document.getAnimations()[0].currentTime); await sleep(600)
  assert.equal(await p.evaluate(() => document.getAnimations()[0].currentTime), a1, 'its spinner stands still')

  // A person opens the live view: awake before the first picture.
  const L = await import('../src/services/liveFrames.js')
  const t0 = Date.now()
  let pic = 0
  const un = await L.watchFrames(p, () => { pic ||= Date.now() - t0 })
  assert.equal(await p.evaluate(() => document.hidden), false, 'awake')
  assert.ok(await ticks(1500) > 10, 'full speed for the person')
  console.log(`rested: ${slow.toFixed(1)} ticks/s; awake and first picture after ${pic || Date.now() - t0} ms`)
  p.__adalInputAt = Date.now()
  await p.evaluate(() => document.querySelector('#t').click())
  assert.equal(await wait, 'submitted')
  assert.equal(submitted, 1)
  un?.()

  // Off: never rests.
  gone = false
  process.env.ADAL_REST = '0'
  await p.goto(url)
  const w2 = waitForTick(p, { onForm: async () => !gone, submit: async () => {}, timeoutMs: 60000, rest: { afterMs: 500 } })
  await sleep(2500)
  assert.ok(await ticks(1500) > 10)
  gone = true; await w2
  delete process.env.ADAL_REST
})

test('an empty tab beside a working one is closed; the last tab, the anchor and a run\'s stay', { skip: !CHROME && 'no Chrome', timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-blanks-'))
  const puppeteer = (await import('puppeteer-core')).default
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: tmp, args: ['--no-first-run'] })
  t.after(async () => { await b.close().catch(() => {}); rmTmp(tmp) })
  const { closeSpareBlanks } = await import('../src/services/spareBlanks.js')
  const go = (at) => closeSpareBlanks(b, { now: at, hidden: async () => true })
  await b.newPage()
  assert.equal(await go(1) + await go(1e6), 0, 'only empty tabs: none closed')
  const work = await b.newPage(); await work.goto('data:text/html,<h1>x</h1>')
  const anchor = await b.newPage(); await anchor.evaluate(() => { window.name = 'adal-agents-window' })
  const run = await b.newPage(); run.__adalRunId = 5
  await go(2e6)                                        // (the anchor and the run's are seen empty from here on)
  await go(3e6)
  const left = await b.pages()
  assert.ok(left.includes(work) && left.includes(anchor) && left.includes(run))
  assert.equal(left.length, 3)
})
