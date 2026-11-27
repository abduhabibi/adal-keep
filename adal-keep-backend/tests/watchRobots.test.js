/** watchRobots.test.js — "Watch robots": the robots' window on screen and back, the same browser, sign-ins kept (2026-11-27). */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { spawn } from 'child_process'

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => fs.existsSync(p))
const PORT = 9400 + Math.floor(Math.random() * 400)
process.env.BRAVE_CDP_URL = `http://127.0.0.1:${PORT}`
process.env.ADAL_ROBOTS_IN_APP = '1'
process.env.ADAL_SHOW_WINDOWS = '1'      // a window to move (this test's browser is headless all the same)
process.env.ADAL_NO_BROWSER_START = '1'

test('Watch robots: on screen, out of sight again, nothing restarted, the sign-in kept', { skip: !CHROME && 'no Chrome here' }, async (t) => {
  // A site that signs in with a cookie.
  const site = http.createServer((req, res) => {
    if (req.url === '/in') { res.setHeader('Set-Cookie', 'who=adal; Max-Age=3600'); res.end('in') }
    else res.end(`<title>Site</title>${req.headers.cookie || 'none'}`)
  })
  await new Promise(r => site.listen(0, '127.0.0.1', r))
  const sitePort = site.address().port
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-watch-'))
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-sandbox', '--disable-gpu',
    '--window-position=-32000,-32000', '--window-size=1366,900', 'about:blank'], { stdio: 'ignore' })
  t.after(() => { chrome.kill('SIGKILL'); site.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break } catch { await new Promise(r => setTimeout(r, 200)) } }

  const { openBrowserIfAny, outOfSight } = await import('../src/services/browser.js')
  const w = await import('../src/services/watchRobots.js')
  const browser = await openBrowserIfAny()
  assert.ok(browser, 'connected')
  const [page] = await browser.pages()
  await page.goto(`http://127.0.0.1:${sitePort}/in`)
  await page.goto(`http://127.0.0.1:${sitePort}/`)
  const cdp = await page.createCDPSession()
  const bounds = async () => (await cdp.send('Browser.getWindowForTarget')).bounds
  // Headless keeps a window inside the screen: put it where Adal Browser keeps it.
  const { windowId } = await cdp.send('Browser.getWindowForTarget')
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000 } })
  if ((await bounds()).left > -10000) return t.skip('this headless browser does not keep a window off screen')
  assert.equal(await outOfSight(page), true)
  const pid = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl

  const on = await w.setWatch(true)
  assert.equal(on.watching, true)
  assert.equal(on.windows, 1)
  const b1 = await bounds()
  assert.ok(b1.left > -10000 && b1.windowState !== 'minimized', `on screen: ${JSON.stringify(b1)}`)
  assert.equal(w.watchingNow(), true)
  // Still the robots' window: its tab is reused, never a second one.
  assert.equal(await outOfSight(page), true)
  assert.deepEqual(await w.watchState(), { on: true, watching: true, can: true })

  const back = await w.setWatch(false)
  assert.equal(back.watching, false)
  assert.equal(back.windows, 1)
  const b2 = await bounds()
  assert.ok(b2.left < -10000, `out of sight: ${JSON.stringify(b2)}`)
  assert.equal(w.watchingNow(), false)

  // The same browser, the same tab, still signed in.
  assert.equal((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl, pid)
  await page.reload()
  assert.match(await page.content(), /who=adal/)
  await cdp.detach().catch(() => {})
  browser.disconnect()
})

test('Watch robots: switched off → no button, nothing moves', async () => {
  const w = await import('../src/services/watchRobots.js')
  process.env.ADAL_WATCH_ROBOTS = '0'
  try {
    assert.deepEqual(await w.watchState(), { on: false, why: 'off' })
    assert.deepEqual(await w.setWatch(true), { on: false, why: 'off' })
  } finally { delete process.env.ADAL_WATCH_ROBOTS }
})

test('Watch robots: the routes go to Adal Robots', async () => {
  const { passedTo } = await import('../src/services/robotsLink.js')
  assert.ok(passedTo('GET', '/automations/watch-robots'))
  assert.ok(passedTo('POST', '/automations/watch-robots'))
})
