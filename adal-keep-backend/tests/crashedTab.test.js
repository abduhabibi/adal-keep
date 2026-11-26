/**
 * crashedTab.test.js — 2026-11-26: a waiting sign-in page set to rest behind another tab crashed now and then, and the
 * run waited 10 minutes on a dead page ("a run stops working when I leave the live view"). Real Chrome.
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

test('a run tab that crashes counts as closed at once; resting no longer hides the page', { skip: !CHROME && 'no Chrome', timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-crashed-'))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: tmp, defaultViewport: null, args: ['--no-first-run', '--disable-gpu', '--window-size=1366,900'] })
  t.after(async () => { await Promise.race([b.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]); try { b.process()?.kill('SIGKILL') } catch {}; rmTmp(tmp) })
  const tm = await import('../src/services/tabManager.js'), { rester } = await import('../src/services/restPage.js'), { waitForTick } = await import('../src/services/robotCheck.js')
  const { browserLost } = await import('../src/services/lostBrowser.js'), { stillThere } = await import('../src/services/instantScreen.js')
  const p = await tm.openRunTab(b, 41, { workflowId: 'musaned_check_chosen' })
  await p.goto('data:text/html,' + encodeURIComponent('<form><input type=password></form><div class="g-recaptcha"></div>'))
  const other = await b.newPage(); await other.goto('about:blank'); await other.bringToFront()
  // Resting behind another tab: the page stays a page that is seen (nothing is switched in it any more).
  const r = rester(p, { afterMs: 0 }); await r.pause(30); await r.pause(30)
  assert.equal(r.resting, true)
  assert.equal(await p.evaluate(() => document.visibilityState), 'visible')
  await r.end()
  // Its process crashes while the run waits for the tick.
  const t0 = Date.now(), logs = []
  const waiting = waitForTick(p, { onForm: () => p.evaluate(() => !!document.querySelector('input[type=password]')), submit: async () => {}, log: (m) => logs.push(m), timeoutMs: 60000 })
  setTimeout(() => p.createCDPSession().then(s => s.send('Page.crash')).catch(() => {}), 500)
  assert.equal(await waiting, 'timeout')
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms (10 minutes before)`)
  assert.ok(logs.some(l => /tab is gone/.test(l)))
  assert.equal(tm.tabOfRun(41), null, 'its tab counts as closed: the next start opens a fresh one')
  assert.throws(() => stillThere(p), (e) => browserLost(null, e.message), 'lost before anything was sent: back in line')
  for (let i = 0; i < 20 && !p.isClosed(); i++) await new Promise(r => setTimeout(r, 200))
  assert.equal((await b.pages()).some(x => x === p), false, 'the dead tab is closed')
  const q = await tm.openRunTab(b, 41, { workflowId: 'musaned_check_chosen' })
  assert.notEqual(q, p)
  assert.equal(await q.evaluate(() => 1 + 1), 2)
})
