/**
 * tasheerFast.test.js — Tasheer's group scheduling lists (VISA Type → VSC Center → Number of Applicants, each loading
 * the next from the server) in a mock, real Chrome: the waits end when the page has asked its questions, the 1.5 s
 * of before at most. Off (ADAL_PASTE_ALL=0) and on: the same choices; times printed.
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
const PAGE = `<!doctype html><h3>Group Scheduling</h3><label>VISA Type *</label><select id=group_scheduling_visatype><option value="">Select</option><option value=w>Work</option><option value=v>Visit</option></select>
<label>VSC Center *</label><select id=group_scheduling_vscId><option value="">Select</option></select>
<label>Number of Applicants *</label><select id=scheduling_numberOfApplicants><option value="">Select</option></select><script>
chosen = {}
const fill = (id, xs) => { const s = document.getElementById(id); s.replaceChildren(new Option('Select', ''), ...xs.map(x => new Option(x, x))) }
for (const s of document.querySelectorAll('select')) s.addEventListener('change', () => { chosen[s.id] = s.options[s.selectedIndex].text })
group_scheduling_visatype.onchange = () => fetch('/vsc').then(r => r.json()).then(x => fill('group_scheduling_vscId', x))
group_scheduling_vscId.onchange = () => fetch('/n').then(r => r.json()).then(x => fill('scheduling_numberOfApplicants', x))
</script>`

test('Tasheer group scheduling: the same choices, sooner', { skip: !CHROME && 'no Chrome', timeout: 90000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-tasheer-'))
  const srv = http.createServer((q, r) => {
    if (q.url === '/vsc') return setTimeout(() => r.end(JSON.stringify(['Addis Ababa', 'Dire Dawa'])), 250)
    if (q.url === '/n') return setTimeout(() => r.end(JSON.stringify(['1', '2', '3', '4', '5'])), 250)
    r.setHeader('content-type', 'text/html'); r.end(PAGE)
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-first-run', '--disable-gpu'] })
  t.after(async () => { await b.close().catch(() => {}); srv.close(); rmTmp(tmp); delete process.env.ADAL_PASTE_ALL })
  const { pickScheduling } = await import('../src/services/tasheer.js')
  const page = await b.newPage()
  const run = async (on) => {
    process.env.ADAL_PASTE_ALL = on ? '1' : '0'
    await page.goto(`http://127.0.0.1:${srv.address().port}/`)
    const t0 = Date.now(), logs = []
    const left = await pickScheduling(page, { onLog: async (l, m) => { logs.push(m) }, isCancelled: () => false }, 3)
    return { ms: Date.now() - t0, left, chosen: await page.evaluate(() => chosen) }
  }
  const off = await run(false), on = await run(true)
  console.log(`Tasheer group scheduling, mock: ${off.ms} → ${on.ms} ms`)
  assert.deepEqual(on.chosen, off.chosen); assert.deepEqual(on.left, [])
  assert.deepEqual(on.chosen, { group_scheduling_visatype: 'Work', group_scheduling_vscId: 'Addis Ababa', scheduling_numberOfApplicants: '3' })
  assert.ok(on.ms < off.ms * 0.6, `${off.ms} → ${on.ms}`)
})
