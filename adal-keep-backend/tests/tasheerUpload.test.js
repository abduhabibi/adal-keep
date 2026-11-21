/**
 * tasheerUpload.test.js — asked on 2026-11-19 after a live run stopped on
 * Tasheer's group-scheduling dialog with the Excel chosen but the grid empty
 * and Save off. In a headless Chrome of its own (own profile; never the PC's
 * Adal Browser) against a mock of that dialog served on 127.0.0.1:
 *  1. Upload Sheet is pressed, its answer awaited (rows filled after a delay,
 *     Save enabled), the consent ticked, Save pressed, the "Are you sure?"
 *     answered, the success read: the run is done.
 *  2. Tasheer refuses the Excel: its words reach the run log, and only then
 *     is the grid (Option 2) typed and saved.
 *  3. The template downloaded from the site is read: same columns → as is;
 *     its dropdown spelling (Female) is followed; a new column order is followed.
 *  4. "Concurrent Login": SUBMIT, the same name and password again, the
 *     person types only the captcha, LOGIN pressed; no captcha → LOGIN at once;
 *     never typed on a page that is not Tasheer.
 * Skipped when this PC has no Chrome.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(f => fs.existsSync(f))
const T = await import('../src/services/tasheer.js')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const GIRLS = [
  { id: 1, full_name: 'Almaz Kebede Tesfaye', gender: 'Female', passport_number: 'EP1234567', date_of_birth: '1998-03-04', passport_issue_date: '2024-01-10', passport_expiry_date: '2034-01-09', visa_application_number: 'E123456789', phone_number: '0911223344' },
  { id: 2, full_name: 'Hiwot Alemu Bekele', gender: 'F', passport_number: 'EP7654321', date_of_birth: '1999-07-21', passport_issue_date: '2023-05-02', passport_expiry_date: '2033-05-01', visa_application_number: 'E987654321', phone_number: '0922334455' },
]

// A template like Tasheer's, with its dropdowns as data validations.
function template({ head = T.TEMPLATE_HEAD, gender = '"Female,Male"' } = {}) {
  const files = T.unzip(T.tasheerXlsx([], {}, { head }))
  const gi = head.findIndex(h => /gender/i.test(h)), ni = head.findIndex(h => /national/i.test(h))
  const L = (i) => String.fromCharCode(65 + i)
  const dv = `<dataValidations count="2"><dataValidation type="list" sqref="${L(gi)}2:${L(gi)}500"><formula1>${gender}</formula1></dataValidation><dataValidation type="list" sqref="${L(ni)}2:${L(ni)}500"><formula1>hiddenSheet!$A$1:$A$245</formula1></dataValidation></dataValidations>`
  const s1 = files.get('xl/worksheets/sheet1.xml').toString().replace('<headerFooter />', `${dv}<headerFooter />`)
  return T._zip([...files.entries()].map(([n, b]) => [n, n === 'xl/worksheets/sheet1.xml' ? s1 : b.toString('utf8')]))
}

test('template: read back, compared, its spelling and order followed', () => {
  const tpl = T.readTemplate(template())
  assert.deepEqual(tpl.head, T.TEMPLATE_HEAD)
  assert.deepEqual(tpl.lists.gender, ['Female', 'Male'])
  assert.ok(tpl.lists.nationality.includes('Ethiopia'))
  const cmp = T.compareTemplate(tpl)
  assert.equal(cmp.same, true); assert.deepEqual(cmp.lacking, []); assert.deepEqual(cmp.values, [])

  // Our sheet with that layout: E.No, dates as yyyy-MM-dd serials, Female as listed.
  const out = T.unzip(T.tasheerXlsx(GIRLS, { email: 'a@b.c' }, tpl))
  const sst = [...out.get('xl/sharedStrings.xml').toString().matchAll(/<t>([^<]*)<\/t>/g)].map(m => m[1])
  const s1 = out.get('xl/worksheets/sheet1.xml').toString()
  const cell = (ref) => { const m = new RegExp(`<c r="${ref}"[^>]*?(t="s")?><v>([^<]*)</v>`).exec(s1); return m[1] ? sst[Number(m[2])] : Number(m[2]) }
  assert.equal(cell('A2'), 'E123456789'); assert.equal(cell('E2'), 'EP1234567'); assert.equal(cell('G2'), 'Ethiopia')
  assert.equal(cell('I2'), 'Female'); assert.equal(cell('I3'), 'Female')
  assert.equal(cell('F2'), Math.round((Date.UTC(1998, 2, 4) - Date.UTC(1899, 11, 30)) / 86400000))
  assert.match(out.get('xl/styles.xml').toString(), /formatCode="yyyy-MM-dd"/)
  assert.match(s1, /<c r="F2" s="2">/)   // the date style

  // Without a template: Tasheer's spelling as of 2026-11-10 (FEMALE).
  const plain = T.unzip(T.tasheerXlsx(GIRLS)).get('xl/sharedStrings.xml').toString()
  assert.match(plain, /<t>FEMALE<\/t>/)

  // A template whose columns moved: our sheet follows it.
  const moved = ['Passport Number*', 'E.No', 'Last Name*', 'First Name*', 'Gender*', 'Nationality*', 'Date of Birth*', 'Date of Issue*', 'Expiry Date*', 'Place of Issue*', 'Second Name', 'Applicant Mobile No.*', 'Email ID*', 'Remarks']
  const t2 = T.readTemplate(template({ head: moved, gender: '"MALE,FEMALE"' }))
  const c2 = T.compareTemplate(t2)
  assert.equal(c2.same, false); assert.deepEqual(c2.unknown, ['Remarks'])
  const back = T.readTemplate(T.tasheerXlsx(GIRLS, {}, t2))
  assert.deepEqual(back.head, moved)
  const o2 = T.unzip(T.tasheerXlsx(GIRLS, {}, t2))
  const sst2 = [...o2.get('xl/sharedStrings.xml').toString().matchAll(/<t>([^<]*)<\/t>/g)].map(m => m[1])
  const a2 = /<c r="A2"[^>]*><v>(\d+)<\/v>/.exec(o2.get('xl/worksheets/sheet1.xml').toString())[1]
  const e2 = /<c r="E2"[^>]*><v>(\d+)<\/v>/.exec(o2.get('xl/worksheets/sheet1.xml').toString())[1]
  assert.equal(sst2[Number(a2)], 'EP1234567'); assert.equal(sst2[Number(e2)], 'FEMALE')
})

// ── The mock dialog ────────────────────────────────────────────────────────
const HEADS = ['E No.', 'First Name', 'Second Name', 'Last Name', 'Passport Number', 'Date Of Birth', 'Nationality', 'Date Of Issue', 'Gender', 'Place Of Issue', 'Expiry Date', 'Mobile No.', 'Email ID']
function uploadPage(v, n, rows) {
  const cell = (h) => /gender/i.test(h) ? '<select><option value="">Select</option><option value="F">Female</option><option value="M">Male</option></select>'
    : /national/i.test(h) ? '<select><option value="">Select</option><option>Eritrea</option><option>Ethiopia</option></select>'
    : /date|birth|expir/i.test(h) ? '<input placeholder="dd/mm/yyyy">' : '<input>'
  const row = `<tr>${HEADS.map(h => `<td>${cell(h)}</td>`).join('')}</tr>`
  return `<!doctype html><html><head><title>Group Scheduling</title></head><body>
<div class="modal" role="dialog" style="display:block">
 <h4>Option 1</h4>
 <p>Step 1 <a href="/template.xlsx">Download Excel Template</a></p>
 <p>Step 2 Fill the template</p>
 <p>Step 3 Select File <input type="file" id="f" accept=".xlsx"></p>
 ${v === 'nobutton' ? '' : '<input type="button" class="btn" id="up" value="Upload Sheet">'}
 <div id="msg"></div>
 <h4>Option2</h4><span>Up to ${n} Applicants</span>
 <table id="grid"><thead><tr>${HEADS.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${row.repeat(n)}</tbody></table>
 <label><input type="checkbox" id="consent"> By clicking here I indicate that, I have the permission of the applicants</label>
 <button id="back">Back</button> <button id="save" disabled>Save</button>
 <div id="done"></div>
</div>
<script>
const ROWS = ${JSON.stringify(rows)}
const v = ${JSON.stringify(v)}
window.__events = []
const grid = () => [...document.querySelectorAll('#grid tbody tr')]
const check = () => { const full = grid().every(tr => tr.querySelectorAll('input')[4].value); document.getElementById('save').disabled = !full }
document.getElementById('grid').addEventListener('change', check)
document.getElementById('grid').addEventListener('input', check)
const up = document.getElementById('up')
if (up) up.onclick = () => {
  const f = document.getElementById('f').files[0]
  window.__events.push('upload:' + (f ? f.name : 'none'))
  if (!f) return alert('Please select file')
  setTimeout(() => {
    if (v === 'error') { document.getElementById('msg').innerHTML = '<div class="alert alert-danger">Invalid template: Date Of Birth must be in yyyy-MM-dd format (row 2)</div>'; return }
    grid().forEach((tr, k) => { const i = tr.querySelectorAll('input'); i[0].value = ROWS[k].eno; i[1].value = ROWS[k].first; i[4].value = ROWS[k].passport })
    check()
  }, 1500)
}
document.getElementById('save').onclick = () => {
  window.__events.push('save:' + document.getElementById('consent').checked)
  if (!confirm('Are you sure you want to save?')) return
  setTimeout(() => { document.getElementById('done').innerHTML = '<div class="alert alert-success">Appointment booked successfully. Reference No: TAS12345</div>' }, 800)
}
</script></body></html>`
}

function loginPage(withCaptcha) {
  return `<!doctype html><html><head><title>Tasheer</title></head><body>
<div id="home" style="display:none">GROUP SCHEDULING</div>
<form id="login" onsubmit="return false">
 <div id="fail" style="color:red"></div>
 <input type="text" id="user" name="username"> <input type="password" id="pw" name="password">
 ${withCaptcha ? '<img alt="captcha"> <input type="text" id="cap" name="captcha" placeholder="Enter Captcha">' : ''}
 <button id="login-btn" type="button">LOGIN</button>
</form>
<div id="concurrent" class="modal" role="dialog" style="display:none">
 <h4>Concurrent Login</h4>
 <p>You are already logged in from another location or device. The previous session must be terminated before a new one. Click 'Submit' to continue</p>
 <button id="sub" style="background:green">SUBMIT</button> <button id="close" style="background:blue">CLOSE</button>
</div>
<script>
window.__logins = []
let tries = 0
const $ = (id) => document.getElementById(id)
$('login-btn').onclick = () => {
  const cap = $('cap') ? $('cap').value : ''
  window.__logins.push({ user: $('user').value, pw: $('pw').value, cap, at: Date.now() })
  if (++tries === 1) { $('fail').textContent = 'Login failure. User is already logged in to the application'; $('concurrent').style.display = 'block'; return }
  if ($('user').value === 'agent1' && $('pw').value === 'S3cret!' && (!$('cap') || cap.length >= 4)) { $('login').style.display = 'none'; $('home').style.display = 'block' }
}
$('sub').onclick = () => { window.__submitted = Date.now(); $('concurrent').style.display = 'none'; $('user').value = ''; $('pw').value = ''; if ($('cap')) $('cap').value = '' }
</script></body></html>`
}

test('Tasheer upload page and Concurrent Login on a mock', { skip: !CHROME && 'no Chrome on this PC', timeout: 240000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-tasheer-'))
  const rows = GIRLS.map(g => T.tasheerRow(g))
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/template.xlsx') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(template()) }
    if (u.pathname === '/upload') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(uploadPage(u.searchParams.get('v'), Number(u.searchParams.get('n') || 1), rows)) }
    if (u.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(loginPage(u.searchParams.get('captcha') === '1')) }
    res.writeHead(404); res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'profile'), args: ['--no-first-run', '--no-default-browser-check'] })
  t.after(async () => { await browser.close().catch(() => {}); server.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

  const run = async (v, people) => {
    const page = await browser.newPage()
    await page.goto(`${base}/upload?v=${v}&n=${people.length}`)
    const logs = [], notes = []
    const ctx = { runId: `t-${v}`, groupTitle: 'Test', onLog: async (l, m) => { logs.push(m) }, notify: async (title, body) => { notes.push(`${title} — ${body}`) } }
    const r = await T.uploadAndSave(page, page.mainFrame(), people, {}, ctx)
    const ev = await page.evaluate(() => window.__events)
    const done = await page.$eval('#done', e => e.innerText)
    const grid = await page.$$eval('#grid tbody tr', trs => trs.map(tr => [...tr.querySelectorAll('input, select')].map(i => i.tagName === 'SELECT' ? i.options[i.selectedIndex].text : i.value)))
    await page.close()
    return { r, logs, notes, ev, done, grid }
  }

  await t.test('Upload Sheet → rows filled after a delay → consent, Save, confirmation, success', async () => {
    const { r, logs, ev, done } = await run('ok', GIRLS)
    assert.equal(r.ok, true); assert.equal(r.done, true, logs.join('\n'))
    assert.match(ev[0], /^upload:Tasheer_\d{4}-\d{2}-\d{2}_t-ok\.xlsx$/)
    assert.equal(ev.filter(e => e.startsWith('upload')).length, 1, 'Upload Sheet pressed once')
    assert.deepEqual(ev.slice(1), ['save:true'], 'saved once, with the consent ticked')
    assert.match(done, /TAS12345/)
    assert.ok(logs.some(l => /matches Tasheer's template/.test(l)), logs.join('\n'))
    assert.ok(logs.some(l => /Tasheer read the Excel: 2 of 2/.test(l)))
    assert.ok(logs.some(l => /Are you sure/.test(l)), 'the confirm pop-up is in the log')
    assert.ok(logs.some(l => /reference TAS12345/.test(l)))
  })

  await t.test('Tasheer refuses the Excel: its words are reported, then the grid is typed', async () => {
    const { r, logs, ev, grid, done } = await run('error', [GIRLS[0]])
    assert.ok(logs.some(l => /Tasheer refused the Excel: Invalid template: Date Of Birth must be in yyyy-MM-dd format/.test(l)), logs.join('\n'))
    assert.ok(logs.some(l => /filling the grid \(Option 2\)/.test(l)))
    assert.equal(grid[0][0], 'E123456789'); assert.equal(grid[0][4], 'EP1234567')
    assert.equal(grid[0][5], '04/03/1998'); assert.equal(grid[0][6], 'Ethiopia'); assert.equal(grid[0][8], 'Female')
    assert.deepEqual(ev.filter(e => e.startsWith('save')), ['save:true'])
    assert.equal(r.done, true); assert.match(done, /booked/)
  })

  await t.test('no Upload Sheet button: the grid (Option 2) is typed', async () => {
    const { r, logs, grid } = await run('nobutton', [GIRLS[1]])
    assert.ok(logs.some(l => /Upload Sheet button was not found/.test(l)), logs.join('\n'))
    assert.equal(grid[0][4], 'EP7654321'); assert.equal(r.done, true)
  })

  const login = async (captcha, { tasheer = true } = {}) => {
    const page = await browser.newPage()
    page.__adalTasheerMock = tasheer
    await page.goto(`${base}/login?captcha=${captcha ? 1 : 0}`)
    // The person's first sign-in (name, password, captcha typed; LOGIN pressed).
    await T.fillLogin(page, 'agent1', 'S3cret!')
    if (captcha) await page.type('#cap', 'XY12')
    await page.click('#login-btn')
    assert.equal(await T.concurrentShown(page), true)
    const said = []
    const p = T.afterConcurrentLogin(page, 'agent1', 'S3cret!', { say: (m) => said.push(m), graceMs: 500, captchaMs: 30000 })
    let typedAt = 0
    if (captcha && tasheer) {
      // The person types the new captcha once the form is back and filled.
      for (let i = 0; i < 60 && !(await page.$eval('#pw', e => e.value).catch(() => '')); i++) await sleep(250)
      await sleep(800)
      assert.equal((await page.evaluate(() => window.__logins)).length, 1, 'LOGIN not pressed before the captcha')
      typedAt = Date.now()
      await page.type('#cap', 'QW34', { delay: 60 })
    }
    const out = await p
    const st = await page.evaluate(() => ({ logins: window.__logins, home: document.getElementById('home').style.display, submitted: window.__submitted }))
    await page.close()
    return { out, said, st, typedAt }
  }

  await t.test('Concurrent Login with a captcha: SUBMIT, same name and password, person types captcha, LOGIN', async () => {
    const { out, st, said, typedAt } = await login(true)
    assert.equal(out, 'logged-in-pressed', said.join('\n'))
    assert.ok(st.submitted, 'SUBMIT pressed')
    assert.equal(st.logins.length, 2)
    assert.deepEqual({ ...st.logins[1], at: 0 }, { user: 'agent1', pw: 'S3cret!', cap: 'QW34', at: 0 })
    assert.ok(st.logins[1].at > typedAt, 'LOGIN after the captcha was typed')
    assert.equal(st.home, 'block')
  })

  await t.test('Concurrent Login without a captcha: LOGIN pressed at once', async () => {
    const { out, st } = await login(false)
    assert.equal(out, 'logged-in-pressed')
    assert.equal(st.logins.length, 2); assert.equal(st.logins[1].pw, 'S3cret!'); assert.equal(st.home, 'block')
  })

  await t.test('not Tasheer: the password is never typed', async () => {
    const { out, st } = await login(false, { tasheer: false })
    assert.equal(out, 'no-form'); assert.equal(st.logins.length, 1)
  })
})
