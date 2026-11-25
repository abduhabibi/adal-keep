/**
 * pageScripts.test.js — what Adal Keep puts into the robots' pages never keeps itself going and rests when the page
 * rests (2026-11-25: a label script held 98 % of a core for hours). Real headless Chrome of the test's own; the
 * page's work is read from the browser (Performance.getMetrics). Skipped without Chrome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findChrome, rmTmp } from './helpers/chrome.js'

const CHROME = findChrome()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-scripts-'))
process.env.ADAL_NO_BROWSER_START = '1'
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
process.env.SECRETS_PATH = path.join(tmp, 'secrets.enc')
process.env.ACCOUNT_VAULT_KEY = path.join(tmp, 'vault.key')
process.env.ADAL_SPACES_FILE = path.join(tmp, 'spaces.json')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('scripts in the pages', { skip: !CHROME && 'no Chrome', timeout: 110000 }, async (t) => {
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-first-run', '--disable-gpu'], protocolTimeout: 15000 })
  t.after(async () => { await browser.close().catch(() => {}); rmTmp(tmp) })
  const { labelTab } = await import('../src/services/robotCheck.js')
  const W = await import('../src/services/musanedWorkflow.js')
  const { setupTab } = await import('../src/services/tabManager.js')
  const answers = (p) => Promise.race([p.evaluate(() => true), sleep(4000).then(() => false)])
  /** The page's own work (tasks) in the next `ms`, of a core. */
  const work = async (p, ms = 3000) => {
    const c = await p.createCDPSession(); await c.send('Performance.enable')
    const at = async () => (await c.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration').value
    const a = await at(), t0 = Date.now(); await sleep(ms); const z = await at()
    await c.detach(); return (z - a) / ((Date.now() - t0) / 1000)
  }

  await t.test('a site that keeps putting its own title back: the label gives in, the page rests', async () => {
    const p = await browser.newPage()
    await p.goto('data:text/html,<title>Site</title><body>x</body>')
    // At once (its own observer), the hardest there is: the older label and this one fought in one endless turn.
    await p.evaluate(() => { window.sets = 0; new MutationObserver(() => { if (document.title !== 'Site') { window.sets++; document.title = 'Site' } }).observe(document.head, { subtree: true, childList: true, characterData: true }) })
    await labelTab(p, 'nuzla')
    assert.equal(await answers(p), true, 'the page answers')
    assert.ok(await work(p) < 0.1)
    await sleep(6000)
    const a = await p.evaluate(() => window.sets); await sleep(3000)
    assert.equal(await p.evaluate(() => window.sets), a, 'the label gave in')
    assert.ok(a <= 8, `${a} tries`)
    await p.close()
  })

  await t.test('no title, an empty title, a blank page, a title set late: labelled, at rest', async () => {
    for (const html of ['<body>x</body>', '<title></title><body>x</body>', '<title>  </title><body>x</body>', '<title>Later</title><body>x</body>']) {
      const p = await browser.newPage()
      await labelTab(p, '  nuzla  x ')
      assert.equal(await answers(p), true)
      await p.goto(`data:text/html,${encodeURIComponent(html)}`)
      await p.evaluate(() => { document.title = ''; document.head.append(document.createElement('title')) })
      await sleep(1300)
      assert.equal(await answers(p), true)
      assert.match(await p.evaluate(() => document.title), /^\[nuzla x\]/)
      assert.ok(await work(p, 1500) < 0.05)
      await p.close()
    }
  })

  await t.test('an older Adal Keep\'s observer still in the page is taken away', async () => {
    const p = await browser.newPage()
    await p.goto('data:text/html,<title>A</title><body>x</body>')
    await p.evaluate(() => { window.old = 0; window.__adalLabelObs = new MutationObserver(() => { window.old++ }); window.__adalLabelObs.observe(document.head, { subtree: true, childList: true }) })
    await labelTab(p, 'nuzla')
    await p.evaluate(() => { window.old = 0; document.title = 'B' })
    await sleep(1300)
    assert.equal(await p.evaluate(() => window.old), 0)
    assert.equal(await p.evaluate(() => document.title), '[nuzla] B')
    await p.close()
  })

  await t.test('"already registered": a message shown for a moment is kept; on a still page the watch costs nothing', async () => {
    const p = await browser.newPage()
    const ROWS = Array.from({ length: 3000 }, (_, i) => `<tr><td>row ${i}</td><td>candidate name</td><td>EP${i}</td></tr>`).join('')
    await p.setContent(`<title>M</title><body><table>${ROWS}</table><iframe srcdoc="<p>in a frame</p>"></iframe></body>`)
    // The older one, for the numbers: every 250 ms the whole page's text.
    await p.evaluate(() => { window.oldWatch = setInterval(() => { /x{9}/.test(document.body?.innerText || '') }, 250) })
    const before = await work(p)
    await p.evaluate(() => clearInterval(window.oldWatch))
    await W.watchAlreadyRegistered(p)
    const after = await work(p)
    console.log(`"already registered" watch on a page of 3000 rows: ${(before * 100).toFixed(1)} % of a core → ${(after * 100).toFixed(1)} %`)
    assert.ok(after < 0.02 && after < before, `${after}`)
    await p.evaluate(() => { const d = document.createElement('div'); d.setAttribute('role', 'alert'); d.textContent = 'This candidate has already been added to your list'; document.body.append(d); setTimeout(() => d.remove(), 500) })
    await sleep(900)
    assert.equal((await W.readAlreadyRegistered(p, 100))?.kind, 'ours')
    assert.equal(await p.evaluate(() => window.__adalAlreadyWatch), null, 'it lets go once it saw it')
    // The next candidate: armed again. A message only made visible (it was in the page, hidden).
    await p.evaluate(() => { const d = document.createElement('div'); d.id = 'h'; d.style.display = 'none'; d.innerHTML = '<b>HANA</b> already <i>exists!</i> Kindly contact EPRO to delete this candidate'; document.body.append(d) })
    await W.watchAlreadyRegistered(p)
    await sleep(400)
    assert.equal(await p.evaluate(() => window.__adalAlready), null, 'a hidden one is not a message')
    await p.evaluate(() => { const h = document.querySelector('#h'); h.style.display = 'block'; setTimeout(() => h.remove(), 500) })
    await sleep(900)
    assert.equal((await W.readAlreadyRegistered(p, 100))?.kind, 'other')
    assert.equal(await p.frames()[1].evaluate(() => typeof window.__adalAlreadyWatch), 'undefined', 'not in the frames')
    await p.close()
  })

  await t.test('SAVED: seen once, then the watch is off', async () => {
    const p = await browser.newPage()
    await p.setContent('<form><button>Save</button></form><div id="x"></div>')
    await W.watchForSaved(p)
    await p.evaluate(() => { document.querySelector('form').append('saved') })
    await sleep(100)
    assert.equal(await W.savedOnPage(p), false, 'the form\'s own words are not it')
    await p.evaluate(() => { document.querySelector('#x').textContent = 'Candidate saved successfully' })
    await sleep(100)
    assert.equal(await W.savedOnPage(p), true)
    await p.evaluate(() => { window.__adalSaved = false; document.querySelector('#x').textContent = 'saved' })
    await sleep(100)
    assert.equal(await W.savedOnPage(p), false, 'off')
    await p.close()
  })

  await t.test('a tab used by many runs carries one name script, not one for each', async () => {
    const p = await browser.newPage()
    let added = 0, gone = 0
    const add = p.evaluateOnNewDocument.bind(p), rm = p.removeScriptToEvaluateOnNewDocument.bind(p)
    p.evaluateOnNewDocument = (f, ...a) => { if (/adal-run-/.test(String(f))) added++; return add(f, ...a) }
    p.removeScriptToEvaluateOnNewDocument = (id) => { gone++; return rm(id) }
    for (let i = 1; i <= 6; i++) { await setupTab(p, { runId: i }); await sleep(50) }
    assert.deepEqual([added, gone], [6, 5])
    await p.goto('data:text/html,<body>x</body>')
    assert.equal(await p.evaluate(() => window.name), 'adal-run-6')
    await p.close()
  })

  await t.test('the live view of a page that never stands still: at most some 14 pictures a second', async () => {
    const { watchFrames, isWatched } = await import('../src/services/liveFrames.js')
    const p = await browser.newPage()
    await p.setViewport({ width: 1366, height: 900 })
    await p.setContent('<body><h1 id=n>0</h1><div style="width:400px;height:400px;background:linear-gradient(red,blue);animation:s 1s linear infinite"></div><style>@keyframes s{to{transform:rotate(360deg)}}</style><script>let i=0;(function f(){document.querySelector("#n").textContent=++i;requestAnimationFrame(f)})()</script></body>')
    let n = 0
    const stop = await watchFrames(p, () => n++)
    assert.equal(isWatched(p), true)
    await sleep(1000); n = 0
    await sleep(4000)
    console.log(`live view of an animated page: ${(n / 4).toFixed(1)} pictures a second`)
    assert.ok(n / 4 <= 15 && n / 4 >= 3, `${n / 4}`)
    stop()
    assert.equal(isWatched(p), false)
    await p.close()
  })
})
