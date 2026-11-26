/**
 * mofaFast.test.js — Enjaz's Pay Visa Fees search in a mock, real Chrome (every visa.mofa.gov.sa request is answered
 * in the test; an already signed-in page, no sign-in form, no captcha): the waits end when the page has loaded and when
 * it says paid / not found, the 2.5 / 1 / 4 s of before at most. Off (ADAL_PASTE_ALL=0) and on: the same answer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findChrome, rmTmp } from './helpers/chrome.js'
const CHROME = findChrome()
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
process.env.ADAL_NO_BROWSER_START = '1'
const JQ = `<script>window.jQuery = { active: 0 }</script>`
const HOME = `<!doctype html>${JQ}<p>Welcome Agency</p><a href="/Payment/GetApp">Pay Visa Fees</a>`
const PAY = `<!doctype html>${JQ}<p>Welcome Agency</p><label>Application Number</label><input id=a><label>Passport Number</label><input id=p>
<button onclick="jQuery.active = 1; setTimeout(() => { out.textContent = a.value === 'E123456789' && p.value === 'EP1234567' ? 'This application has been paid' : 'No data found'; jQuery.active = 0 }, 300)">Search</button><div id=out></div>`

test('Enjaz Pay Visa Fees: the same answer, sooner', { skip: !CHROME && 'no Chrome', timeout: 90000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-mofa-'))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-first-run', '--disable-gpu'] })
  t.after(async () => { await b.close().catch(() => {}); rmTmp(tmp); delete process.env.ADAL_PASTE_ALL })
  const { runMofaPay } = await import('../src/services/mofaVisa.js')
  const page = await b.newPage()
  await page.setRequestInterception(true)
  const asked = []
  page.on('request', (q) => {
    const u = new URL(q.url()); asked.push(u.host)
    if (u.host !== 'visa.mofa.gov.sa') return q.abort()
    q.respond({ status: 200, contentType: 'text/html', body: /\/Payment\/GetApp/i.test(u.pathname) ? PAY : HOME })
  })
  const run = async (on) => {
    process.env.ADAL_PASTE_ALL = on ? '1' : '0'
    const notes = [], t0 = Date.now()
    const r = await runMofaPay(page, { profileName: 'Test', profile: { visa_application_number: 'E123456789', passport_number: 'EP1234567' }, onLog: async () => {}, notify: async () => {}, noteProfile: async (n) => notes.push(n), isCancelled: () => false })
    return { ms: Date.now() - t0, r, notes }
  }
  const off = await run(false), on = await run(true)
  console.log(`Enjaz Pay Visa Fees, mock: ${off.ms} → ${on.ms} ms`)
  assert.equal(off.r.done, true); assert.equal(on.r.done, true)
  assert.deepEqual(on.notes, off.notes)
  assert.ok(asked.every(h => h === 'visa.mofa.gov.sa'))
  assert.ok(on.ms < off.ms * 0.6, `${off.ms} → ${on.ms}`)
})
