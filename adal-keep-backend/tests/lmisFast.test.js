/**
 * lmisFast.test.js — LMIS's Destination Country list (a react-select whose choices come from the server as you type)
 * in a mock, real Chrome: the waits end when the list shows the value first and when it has closed, the 0.5 / 1.5 /
 * 0.6 s of before at most. Off (ADAL_PASTE_ALL=0) and on: the same choice; times printed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { findChrome, rmTmp } from './helpers/chrome.js'
const CHROME = findChrome()
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
process.env.ADAL_NO_BROWSER_START = '1'
const PAGE = `<!doctype html><div id=modal style="width:500px;height:300px"><h3>Upload Passport Document</h3>
<div><label>Destination Country</label><div class="select__control" style="width:300px;height:30px;border:1px solid"><span id=shown></span><input id=q></div></div>
<div id=menu></div></div><script>
let typed = 0
q.oninput = () => { const v = q.value, n = ++typed; menu.innerHTML = '<div class="select__option">Loading...</div>'
  fetch('/c?q=' + encodeURIComponent(v)).then(r => r.json()).then(xs => { if (n === typed) menu.innerHTML = xs.map(x => '<div class="select__option" style="height:20px">' + x + '</div>').join('') }) }
q.onkeydown = (e) => { if (e.key !== 'Enter') return; const o = menu.querySelector('.select__option'); if (o && !/Loading/.test(o.textContent)) { shown.textContent = o.textContent; q.value = ''; menu.innerHTML = '' } }
</script>`

test('LMIS destination country: the same choice, sooner', { skip: !CHROME && 'no Chrome', timeout: 90000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-lmis-'))
  const all = ['Saudi Arabia', 'Sudan', 'Qatar', 'Kuwait']
  const srv = http.createServer((q, r) => {
    if (q.url.startsWith('/c')) { const v = decodeURIComponent(q.url.split('q=')[1] || '').toLowerCase(); return setTimeout(() => r.end(JSON.stringify(all.filter(x => x.toLowerCase().includes(v)))), 300) }
    r.setHeader('content-type', 'text/html'); r.end(PAGE)
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-first-run', '--disable-gpu'] })
  t.after(async () => { await b.close().catch(() => {}); srv.close(); rmTmp(tmp); delete process.env.ADAL_PASTE_ALL })
  const { setReactSelect } = await import('../src/services/lmisWorkflow.js')
  const page = await b.newPage()
  const run = async (on) => {
    process.env.ADAL_PASTE_ALL = on ? '1' : '0'
    await page.goto(`http://127.0.0.1:${srv.address().port}/`)
    const t0 = Date.now()
    const ok = await setReactSelect(page, 'Upload Passport Document', 'Destination Country', 'Saudi Arabia')
    return { ms: Date.now() - t0, ok, shown: await page.evaluate(() => shown.textContent) }
  }
  const off = await run(false), on = await run(true)
  console.log(`LMIS destination country, mock: ${off.ms} → ${on.ms} ms`)
  assert.equal(off.ok, true); assert.equal(on.ok, true)
  assert.equal(on.shown, 'Saudi Arabia'); assert.equal(off.shown, 'Saudi Arabia')
  assert.ok(on.ms < off.ms * 0.6, `${off.ms} → ${on.ms}`)
})
