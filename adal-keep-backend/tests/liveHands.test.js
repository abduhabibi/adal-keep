/**
 * liveHands.test.js — 2026-11-25, Main: every click in the live view waited behind screenshots and questions to a busy
 * page and was given up after 8 s. Now: sent at once, in order, never dropped, answered with sent / taken. A page
 * frozen for 5 s in a real Chrome, pictures asked for meanwhile.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findChrome, rmTmp } from './helpers/chrome.js'
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
process.env.ADAL_NO_BROWSER_START = '1'
const CHROME = findChrome()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('clicks on a frozen page: answered at once, taken when it can, all of them, in order', { skip: !CHROME && 'no Chrome', timeout: 90000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-hands-'))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: tmp, defaultViewport: null, args: ['--no-first-run', '--disable-gpu', '--window-size=1366,900'] })
  t.after(async () => { await b.close().catch(() => {}); rmTmp(tmp) })
  const tm = await import('../src/services/tabManager.js')
  const { hands, handsBusy } = await import('../src/services/liveHands.js')
  const { liveInput } = await import('../src/routes/automations.js')
  const L = await import('../src/services/liveFrames.js')
  const p = await b.newPage()
  await tm.setupTab(p)
  await p.goto('data:text/html,' + encodeURIComponent('<body style="margin:0"><button id=a style="position:absolute;left:100px;top:100px;width:100px;height:50px" onclick="log.push(\'a\')">a</button><button id=b style="position:absolute;left:300px;top:100px;width:100px;height:50px" onclick="log.push(\'b\')">b</button><input id=i style="position:absolute;left:100px;top:300px;width:200px;height:40px" onfocus="log.push(\'i\')"><script>log=[]</script>'))
  const un = await L.watchFrames(p, () => {})
  await sleep(600)
  const at = (x, y) => ({ x: x / 1366, y: y / 900 })
  const press = (x, y) => [{ kind: 'mouse', type: 'move', ...at(x, y) }, { kind: 'mouse', type: 'down', ...at(x, y), button: 0, buttons: 1, clickCount: 1 }, { kind: 'mouse', type: 'up', ...at(x, y), button: 0, buttons: 0, clickCount: 1 }]
  const other = (x) => liveInput(p, x)
  // A page that answers: taken at once.
  let r = await hands(p, press(150, 125), { other })
  assert.ok(r.taken !== null && r.taken < 1000, `taken after ${r.taken} ms`)
  assert.deepEqual(await p.evaluate(() => log), ['a'])
  // Frozen for 5 s, somebody asking for pictures all the time.
  p.evaluate(() => { const e = Date.now() + 5000; while (Date.now() < e); }).catch(() => {})
  await sleep(150)
  const shots = setInterval(() => L.latestFrame(p).catch(() => {}), 300)
  const t0 = Date.now(), times = []
  for (const [x, y] of [[350, 125], [150, 125], [200, 320]]) { const t1 = Date.now(); r = await hands(p, press(x, y), { other, waitMs: 300 }); times.push(Date.now() - t1); assert.equal(r.sent, 3); assert.equal(r.taken, null, 'the page has not taken it yet') }
  assert.ok(Math.max(...times) < 900, `each answered in ${times.join(', ')} ms`)
  assert.equal(handsBusy(p), true, 'no screenshot is asked for while it is on its way')
  for (let i = 0; i < 40 && (await Promise.race([p.evaluate(() => log.length), sleep(500)])) !== 4; i++) await sleep(150)
  assert.deepEqual(await p.evaluate(() => log), ['a', 'b', 'a', 'i'], 'all taken, in order')
  console.log(`frozen page: clicks answered in ${times.join(', ')} ms, taken ${Date.now() - t0} ms after (before: refused at 8 s)`)
  // Then typed: after the click.
  r = await hands(p, [{ kind: 'type', text: 'abc' }], { other })
  assert.equal(await p.evaluate(() => document.querySelector('#i').value), 'abc')
  // Keys on a frozen page: all handed over at once, in order (each part waited for the page before).
  p.evaluate(() => { const e = Date.now() + 3000; while (Date.now() < e); }).catch(() => {})
  await sleep(150)
  const k0 = Date.now()
  r = await hands(p, [{ kind: 'key', key: 'End' }, { kind: 'key', key: 'x' }, { kind: 'key', key: 'Y', shift: true }, { kind: 'key', key: 'a', ctrl: true }, { kind: 'key', key: 'C' }], { other, waitMs: 200 })
  assert.equal(r.sent, 5); assert.equal(r.taken, null); assert.ok(Date.now() - k0 < 800, `keys answered in ${Date.now() - k0} ms`)
  for (let i = 0; i < 40 && (await Promise.race([p.evaluate(() => document.querySelector('#i').value), sleep(500)])) !== 'C'; i++) await sleep(150)
  assert.equal(await p.evaluate(() => document.querySelector('#i').value), 'C', 'in order: typed, all chosen, written over')
  assert.equal(handsBusy(p), false)
  clearInterval(shots); un()
})

test('the ring\'s words', async () => {
  const { stateOf, isClick } = await import('../../adal-keep-frontend/src/lib/liveClicks.js')
  assert.equal(stateOf({ ok: true, taken: 12 }), 'taken'); assert.equal(stateOf({ ok: true, taken: null }), 'waiting'); assert.equal(stateOf({ error: 'x' }), 'failed'); assert.equal(stateOf({ ok: true }), 'taken', 'an older PC')
  assert.equal(isClick({ kind: 'mouse', type: 'up' }), true); assert.equal(isClick({ kind: 'mouse', type: 'move' }), false)
})
