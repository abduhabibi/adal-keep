/**
 * liveStream.test.js — a robot's tab seen live (2026-11-25: the expanded view stayed on "Opening…", a still page
 * was photographed every second, the form was empty). One stream, each piece only when something changed: first
 * picture at once, a still page sends and costs nothing, a blink is 9 bytes, a slow line gets only the changed
 * parts, it goes on by itself when the tab closes and comes back, and it passes every hop.
 * A headless Chrome of the test's own. Skipped without one.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { findChrome, rmTmp } from './helpers/chrome.js'

const CHROME = findChrome()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-live-'))
process.env.ADAL_NO_BROWSER_START = '1'
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
process.env.SECRETS_PATH = path.join(tmp, 'secrets.enc')
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'vault.key')
process.env.ADAL_SPACES_FILE = path.join(tmp, 'spaces.json')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const L = await import('../src/services/liveStream.js')
const { pieces } = await import('../../adal-keep-frontend/src/lib/livePieces.js')
const until = async (fn, ms, what) => { for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await sleep(20) } assert.fail(`timed out: ${what}`) }
const u32 = (a) => new DataView(a.buffer, a.byteOffset).getUint32(0)

test('the pieces: cut anywhere, they come out whole and in order', () => {
  const all = Buffer.concat([L.message('J', '{"state":"live"}'), L.message('P', Buffer.from([0, 0, 0, 1]), Buffer.alloc(5000, 7)), L.message('K'), L.message('R', Buffer.from([0, 0, 0, 1]))])
  for (const step of [1, 3, 5, 777, 1e6]) {
    const got = []
    const feed = pieces((k, b) => got.push([k, b.length]))
    for (let i = 0; i < all.length; i += step) feed(new Uint8Array(all.subarray(i, i + step)))
    assert.deepEqual(got, [['J', 16], ['P', 5004], ['K', 0], ['R', 4]])
  }
})

test('a viewer: the newest picture only, one it has is not sent again, and what did not change is not said again', async () => {
  const out = []
  let full = false
  const v = L.viewer({ write: (b) => { out.push(b) ; return true }, full: () => full })
  const pic = (n) => Buffer.alloc(60000, n)
  await v.show(pic(1)); await v.show(pic(2)); await v.show(pic(1)); await v.show(pic(2))
  assert.deepEqual(out.map(b => [String.fromCharCode(b[4]), b.length]), [['P', 60009], ['P', 60009], ['R', 9], ['R', 9]], 'a blinking cursor: 9 bytes a blink')
  full = true
  await v.show(pic(3)); await v.show(pic(4))
  assert.equal(out.length, 4, 'its line is full: nothing piles up')
  full = false
  await v.drained()
  assert.equal(out.length, 5); assert.equal(out[4][9], 4, 'the newest is what comes')
  assert.equal(v.say({ state: 'live', url: 'a' }), true); assert.equal(v.say({ state: 'live', url: 'a' }), false)
})

test('a slow line gets only the parts that changed', { skip: !(await import('sharp').then(() => true, () => false)) && 'no sharp' }, async () => {
  const sharp = (await import('sharp')).default
  const W = 640, H = 448
  const page = (f) => { const d = Buffer.alloc(W * H * 3, 200); if (f) for (let y = 130; y < 140; y++) d.fill(10, (y * W + 70) * 3, (y * W + 110) * 3); return sharp(d, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 50 }).toBuffer() }
  const out = []
  const { tileMaker } = await import('../src/services/liveTiles.js')
  const v = L.viewer({ write: (b) => { out.push(b); return true }, full: () => false, tiles: () => tileMaker() })
  v.speed(300e3, 5000)                                    // 60 KB/s
  assert.equal(v.slow, true)
  const a = await page(false), b = await page(true)
  await v.show(a); await v.show(b)
  assert.deepEqual(out.map(x => String.fromCharCode(x[4])), ['P', 'T'])
  const n = out[1].readUInt32BE(5), list = JSON.parse(out[1].subarray(9, 9 + n))
  assert.deepEqual(list.map(({ x, y, w, h }) => [x, y, w, h]), [[64, 128, 64, 64]])
  assert.ok(out[1].length < out[0].length)
  await v.show(b)
  assert.equal(out.length, 2, 'the same picture: nothing')
  const fast = L.viewer({ write: () => true, full: () => false, tiles: () => tileMaker() })
  fast.speed(3e6, 1000)
  assert.equal(fast.slow, false, 'the office network: whole pictures')
})

test('in a real browser', { skip: !CHROME && 'no Chrome', timeout: 110000 }, async (t) => {
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-first-run', '--disable-gpu', '--window-size=1366,900'], defaultViewport: null })
  let page = null, over = false, looked = 0
  const FORM = '<title>Sign in</title><body style="background:#eef"><h1>Sign in</h1><input id=u value=nuzla style="caret-color:transparent"><input type=password><p id=n>0</p></body>'
  const open = async () => { const p = await browser.newPage(); await p.setContent(FORM); return p }
  const tabOf = async () => (page && !page.isClosed() ? page : null)
  const main = http.createServer((req, res) => L.serveLive(req, res, { tabOf, ended: async () => over, onOpen: () => { looked++ } }))
  await new Promise(r => main.listen(0, '127.0.0.1', r))
  // A hop that keeps the last 4 KB until more comes (adal-companion.exe before 2026-11-25).
  const holding = http.createServer((req, res) => {
    const up = http.request({ port: main.address().port, path: req.url, headers: { 'x-adal-pc': 'k' } }, (r) => {
      res.writeHead(200)
      let held = Buffer.alloc(0)
      r.on('data', d => { held = Buffer.concat([held, d]); if (held.length > 4096) { res.write(held.subarray(0, held.length - 4096)); held = held.subarray(held.length - 4096) } })
      r.on('end', () => res.end(held))
    })
    up.on('error', () => res.destroy()); res.on('close', () => up.destroy()); up.end()
  })
  await new Promise(r => holding.listen(0, '127.0.0.1', r))
  const watchers = []
  const watch = async (port = main.address().port) => {
    const ac = new AbortController(), w = { got: [], bytes: 0, t0: Date.now(), states: [], pics: [], ac }
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal })
    const feed = pieces((k, b) => { w.got.push(k); if (k === 'P' || k === 'R') { w.first ||= Date.now() - w.t0; w.pics.push([k, u32(b), Date.now()]) } if (k === 'J') w.states.push(JSON.parse(Buffer.from(b).toString())) })
    ;(async () => { const rd = r.body.getReader(); try { for (;;) { const { value, done } = await rd.read(); if (done) break; w.bytes += value.length; feed(value) } } catch {} })()
    watchers.push(w)
    return w
  }
  t.after(async () => { for (const w of watchers) w.ac.abort(); main.closeAllConnections(); holding.closeAllConnections(); main.close(); holding.close(); await browser.close().catch(() => {}); rmTmp(tmp) })

  await t.test('no tab yet: it says so, and goes on by itself when the tab comes', async () => {
    const w = await watch()
    await until(() => w.states.some(s => s.state === 'opening'), 3000, 'opening')
    page = await open()
    await until(() => w.first, 5000, 'the first picture')
    await until(() => w.states.some(s => s.state === 'live' && s.title === 'Sign in'), 5000, 'its title')
    assert.ok(looked >= 1, 'a person looks (the form is made fresh)')
    w.ac.abort()
  })
  await t.test('the first picture: under a second; a second view at once, from the picture there is', async () => {
    await sleep(500)
    const a = await watch(); await until(() => a.first, 3000, 'a picture')
    const b = await watch(); await until(() => b.first, 3000, 'a picture')
    console.log(`first picture: ${a.first} ms, the second view: ${b.first} ms`)
    assert.ok(a.first < 1000 && b.first < 1000)
    b.ac.abort(); a.ac.abort()
  })
  await t.test('a page that stands still sends nothing; a change comes at once', async () => {
    const w = await watch(); await until(() => w.first, 3000, 'a picture')
    await sleep(2500)
    const n = w.pics.length, bytes = w.bytes
    await sleep(6500)                                   // (longer than its own look every 5 s)
    assert.equal(w.pics.length, n, 'no picture'); assert.ok(w.bytes - bytes < 60, `${w.bytes - bytes} bytes`)
    const t0 = Date.now()
    await page.evaluate(() => { document.querySelector('#n').textContent = 'changed' })
    await until(() => w.pics.length > n, 2000, 'the change')
    console.log(`still for 6.5 s: ${w.bytes - bytes > 0 ? 'only "still here"' : 0}; a change shown after ${Date.now() - t0} ms`)
    assert.ok(Date.now() - t0 < 1000)
    w.ac.abort()
  })
  await t.test('a blinking cursor: the two pictures are sent once', async () => {
    const w = await watch(); await until(() => w.first, 3000, 'a picture')
    await page.evaluate(() => { const u = document.querySelector('#u'); u.style.caretColor = ''; u.focus() })
    await sleep(1500)
    const from = w.pics.length
    await sleep(4000)
    const blink = w.pics.slice(from)
    if (blink.length) assert.ok(blink.filter(p => p[0] === 'P').length <= 1, JSON.stringify(blink))
    await page.evaluate(() => document.activeElement.blur())
    w.ac.abort()
  })
  await t.test('the tab closes and another comes: the same view goes on', async () => {
    const w = await watch(); await until(() => w.first, 3000, 'a picture')
    const n = w.pics.length
    await page.close()
    await until(() => w.states.some(s => s.state === 'opening'), 4000, 'it says the tab closed')
    page = await open()
    await until(() => w.pics.length > n, 5000, 'the new tab\'s picture')
    w.ac.abort()
  })
  await t.test('through a hop that holds back the last 4 KB: the picture of a still page comes whole', async () => {
    const w = await watch(holding.address().port)
    await until(() => w.first, 3000, 'the first picture through it')
    assert.ok(w.first < 1500, `${w.first} ms`)
    w.ac.abort()
  })
  await t.test('the run is over: said, not a blank', async () => {
    await page.close(); over = true
    const w = await watch()
    await until(() => w.states.some(s => s.state === 'gone' && s.text), 6000, 'gone')
    w.ac.abort()
  })
})
