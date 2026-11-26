/**
 * insuranceFast.test.js — the insurance certificate in a mock of FetaP's form (a Vue modal: boxes named by their
 * placeholder, lists by their first option, a list that asks the server for the next), real Chrome. Pasting off
 * (ADAL_PASTE_ALL=0) and on: the same values in the form, the run still stops for a person, nothing pressed after.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-ins-'))
Object.assign(process.env, { BRAVE_CDP_URL: 'http://127.0.0.1:9', ADAL_NO_BROWSER_START: '1', JEV_ENABLED: 'false', SECRETS_PATH: path.join(tmp, 's'), ACCOUNT_VAULT_KEY: path.join(tmp, 'v'), ADAL_SPACES_FILE: path.join(tmp, 'sp') })

const sel = (first, opts) => `<select><option value="">${first}</option>${opts.map((o, i) => `<option value="${i + 1}">${o}</option>`).join('')}</select>`
const box = (ph) => `<input placeholder="${ph}">`
const PAGE = `<!doctype html><title>Draft Certificates</title><h2>Draft Certificates</h2><div id=nc style="cursor:pointer;display:inline-block">+ New certificate</div>
<div class="modal-parent hidden"><div>${sel('Insurance Branch', ['Bole', 'Piassa'])}${box('Number Of Insured')}${sel('Title', ['Mr.', 'Ms.'])}${box('First Name')}${box('Father Name')}${box('Grand Father Name')}
${sel('Gender', ['Male', 'Female'])}<input type=date><input type=date>${box('Passport Number')}${box('Labor ID')}${box('Phone')}${box('Email')}${box('Woreda')}${box('Sub city')}
${sel('Region', ['Addis Ababa', 'Oromia'])}${sel('Country Of Destination', ['Saudi Arabia', 'Kuwait'])}<button id=am onclick="pressed++">Add Member</button><button onclick="pressed++">Request Certificate</button></div></div>
<style>.hidden{display:none}</style><script>
pressed = 0; model = {}
nc.onclick = () => setTimeout(() => document.querySelector('.modal-parent').classList.remove('hidden'), 150)
for (const e of document.querySelectorAll('.modal-parent input, .modal-parent select')) e.addEventListener('input', () => { model[e.placeholder || e.options?.[0]?.text || e.type + [...document.querySelectorAll('input[type=date]')].indexOf(e)] = e.tagName === 'SELECT' ? e.options[e.selectedIndex].text : e.value })
// Choosing a region asks the server for its zones (a list that loads the next).
document.querySelectorAll('select')[4].addEventListener('change', () => fetch('/api/zones').then(r => r.text()).then(t => { model.zones = t }))
</script>`

test('insurance certificate: the same form, sooner; nothing pressed', { skip: !CHROME && 'no Chrome', timeout: 120000 }, async (t) => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k`, '-out', `${tmp}/c`, '-days', '2', '-subj', '/CN=f'], { stdio: 'ignore' })
  const srv = https.createServer({ key: fs.readFileSync(`${tmp}/k`), cert: fs.readFileSync(`${tmp}/c`) }, (q, r) => {
    if (q.url.startsWith('/api/zones')) return setTimeout(() => r.end('Bole,Kirkos'), 150)
    r.setHeader('content-type', 'text/html'); r.end(PAGE)
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const b = await (await import('puppeteer-core')).default.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'p'), args: ['--no-first-run', '--disable-gpu', '--ignore-certificate-errors', `--host-resolver-rules=MAP agency.niscofetap.com 127.0.0.1:${srv.address().port}`] })
  t.after(async () => { await b.close().catch(() => {}); srv.close(); srv.closeAllConnections(); rmTmp(tmp); delete process.env.ADAL_PASTE_ALL })
  const { runInsuranceCertificate } = await import('../src/services/insuranceCertificate.js')
  const profile = { full_name: 'HIWOT GETACHEW ZENEBE', first_name: 'HIWOT', middle_name: 'GETACHEW', last_name: 'ZENEBE', gender: 'Female', date_of_birth: '1999-12-19', passport_number: 'EP1234567', labor_id: 'L-55', phone_number: '251911223344', zone_subcity: 'Kolfe', destination_country: 'Saudi Arabia' }
  const run = async (on) => {
    process.env.ADAL_PASTE_ALL = on ? '1' : '0'
    const page = await b.newPage()
    const told = [], logs = []
    const t0 = Date.now()
    const r = await runInsuranceCertificate(page, { profile, profileName: 'HIWOT', insurance: { insurance_branch: 'Bole', agency_email: 'agency.office@example.com', insurance_woreda: '05' }, onLog: async (l, m) => { logs.push(m) }, notify: async (title) => { told.push(title) }, noteProfile: async () => {}, isCancelled: () => false })
    const ms = Date.now() - t0
    const form = await page.evaluate(() => ({ model, pressed }))
    await page.close()
    return { ms, r, form, told, logs }
  }
  const off = await run(false), on = await run(true)
  console.log(`insurance certificate, mock: ${off.ms} → ${on.ms} ms`)
  assert.deepEqual(on.form, off.form, 'the same form')
  assert.equal(on.form.pressed, 0, 'nothing pressed'); assert.equal(on.form.model['First Name'], 'HIWOT'); assert.equal(on.form.model['Sub city'], 'Kolfe'); assert.equal(on.form.model.zones, 'Bole,Kirkos', 'the next list came')
  assert.equal(on.r.pauseReason, 'awaiting-insurance-save'); assert.equal(on.told.length, 1)
  assert.deepEqual(on.logs.filter(l => /^✓/.test(l)), off.logs.filter(l => /^✓/.test(l)))
  assert.ok(on.ms < off.ms * 0.6, `${off.ms} → ${on.ms}`)
})
