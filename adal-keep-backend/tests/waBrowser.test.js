import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { spawn } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { liveEndpoint, launchKept, backoffMs } from '../src/services/waBrowser.js'

// The hidden WhatsApp browser (2026-11-24): on this PC a new one started every
// couple of minutes, because every restart of Adal Keep closed it (and every
// stop of the service waited 15 s for a SIGKILL). Now it is found again after a
// restart and used on; when it keeps dying it is started later and later.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adal-wa-'))

test('dying again and again: later and later, never a loop', () => {
  const now = 1_000_000_000
  assert.equal(backoffMs([], now), 3_000)
  assert.equal(backoffMs([now], now), 3_000)
  assert.equal(backoffMs([now - 60_000, now], now), 30_000)
  assert.equal(backoffMs([now - 120_000, now - 60_000, now], now), 120_000)
  assert.equal(backoffMs([1, 2, 3, 4, 5].map(i => now - i * 1000), now), 300_000)
  assert.equal(backoffMs([now - 11 * 60_000, now], now), 3_000)   // an old one does not count
})

test('the browser from before is found by its own port file — never another one on that port', async (t) => {
  const dir = tmp()
  const srv = http.createServer((req, res) => res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.address().port}/devtools/browser/abc-1` })))
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  t.after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const port = srv.address().port
  assert.equal(await liveEndpoint(dir), null)   // no file: nothing from before
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/abc-1`)
  assert.equal(await liveEndpoint(dir), `ws://127.0.0.1:${port}/devtools/browser/abc-1`)
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/other-2`)
  assert.equal(await liveEndpoint(dir), null)   // another browser took that port
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), `1\n/devtools/browser/abc-1`)
  assert.equal(await liveEndpoint(dir), null)   // nothing answers
})

const exe = (() => { try { return ['/usr/bin/brave-browser', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(f => fs.existsSync(f)) } catch { return null } })()
test('a real headless browser outlives its starter and is used again', { skip: !exe && 'no browser on this PC' }, async (t) => {
  const dir = tmp()
  const ws = await launchKept({ exe, dir, args: ['--disable-gpu', '--mute-audio', '--no-first-run'] })
  const { default: puppeteer } = await import('puppeteer')
  t.after(async () => {
    const again = await liveEndpoint(dir)
    if (again) await (await puppeteer.connect({ browserWSEndpoint: again })).close().catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  })
  assert.match(ws, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//)
  // Adal Keep "restarts": it lets go of the browser; the browser stays, the same one.
  let b = await puppeteer.connect({ browserWSEndpoint: ws })
  const page = await b.newPage(); await page.goto('data:text/html,<title>kept</title>')
  await b.disconnect()
  assert.equal(await liveEndpoint(dir), ws)
  b = await puppeteer.connect({ browserWSEndpoint: await liveEndpoint(dir) })
  assert.ok((await Promise.all((await b.pages()).map(p => p.title()))).includes('kept'))
  // Released on purpose: it really closes.
  await b.close()
  for (let i = 0; i < 20 && await liveEndpoint(dir); i++) await new Promise(r => setTimeout(r, 250))
  assert.equal(await liveEndpoint(dir), null)
})

test('a stop of the service ends Adal Keep at once (it waited 15 s for a SIGKILL)', async () => {
  const script = `import { startFeatureUse } from ${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'src', 'services', 'featureUse.js')).href)}
    startFeatureUse({ raw: async () => {} }); setInterval(() => {}, 1000); console.log('up')`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise(r => child.stdout.once('data', r))
  const t0 = Date.now()
  child.kill('SIGTERM')
  const code = await new Promise(r => child.once('exit', (c) => r(c)))
  assert.equal(code, 143)
  assert.ok(Date.now() - t0 < 3500, `took ${Date.now() - t0} ms`)
})
