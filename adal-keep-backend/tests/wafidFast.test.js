/**
 * wafidFast.test.js — Wafid's medical result looked up in a mock of its page, real Chrome: its waits end at the page's
 * own answer (the 1.5 s of before at most). Times off (ADAL_PASTE_ALL=0) and on are printed; the result is the same.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import https from 'https'
import { execFileSync } from 'child_process'
import { findChrome, rmTmp } from './helpers/chrome.js'
const CHROME = findChrome()
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'
process.env.ADAL_NO_BROWSER_START = '1'

const FORM = `<!doctype html><form method=post action="/en/medical-status-search/"><input type=radio name=v id=id_search_variant_0><input id=id_passport name=passport>
<select id=id_nationality name=n><option value="">--</option><option value=3>Ethiopian</option></select><input type=hidden id=id_captcha value="tok">
<button id=med-status-form-submit type=submit>Check</button></form>`
const RESULT = (pp) => `<!doctype html><div class="ui segment">✓ FIT</div><h3>Candidate Information</h3><p>Passport No ${pp}</p>`

test('Wafid result: the same answer, sooner', { skip: !CHROME && 'no Chrome', timeout: 90000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-wafid-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k`, '-out', `${tmp}/c`, '-days', '2', '-subj', '/CN=w'], { stdio: 'ignore' })
  const srv = https.createServer({ key: fs.readFileSync(`${tmp}/k`), cert: fs.readFileSync(`${tmp}/c`) }, (q, r) => {
    let body = ''; q.on('data', d => { body += d }); q.on('end', () => { r.setHeader('content-type', 'text/html'); r.end(q.method === 'POST' ? RESULT(new URLSearchParams(body).get('passport')) : FORM) })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-first-run', '--disable-gpu', '--ignore-certificate-errors', `--host-resolver-rules=MAP wafid.com 127.0.0.1:${srv.address().port}`] })
  t.after(async () => { await b.close().catch(() => {}); srv.close(); srv.closeAllConnections(); rmTmp(tmp); delete process.env.ADAL_PASTE_ALL })
  const { checkMedicalStatus } = await import('../src/services/wafidWorkflow.js')
  const page = await b.newPage()
  const time = async (on) => {
    process.env.ADAL_PASTE_ALL = on ? '1' : '0'
    const ms = []
    let r
    for (let i = 0; i < 3; i++) { const t0 = Date.now(); r = await checkMedicalStatus(page, 'EP1234567'); ms.push(Date.now() - t0) }
    return { r, ms: Math.round(ms.reduce((a, b) => a + b) / ms.length) }
  }
  const off = await time(false), on = await time(true)
  console.log(`Wafid result, mock: ${off.ms} → ${on.ms} ms a passport`)
  assert.deepEqual(on.r, off.r); assert.equal(on.r.state, 'fit')
  assert.ok(on.ms < off.ms - 800, `${off.ms} → ${on.ms}`)
})
