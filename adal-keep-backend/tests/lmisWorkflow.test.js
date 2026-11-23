/**
 * lmisWorkflow.test.js — the LMIS police-certificate robot end to end (asked on
 * 2026-11-23: it had never been tested that way). In a headless Chrome of its
 * own (own temp profile; never the PC's Adal Browser) whose lmis.gov.et is a
 * MOCK served on 127.0.0.1 (https, self-signed; every other host resolves to
 * nothing, so the real LMIS is never reached). The tab is set up the way run
 * tabs are (tabManager.setupTab: file dialogs caught, desktop size).
 *  1. Search: an unknown labor ID → "Code Not Found" told and the step stops;
 *     her labor ID → her card's Add pressed and the request form opens.
 *  2. Uploads (payment slip by the window's own file input; passport and photo
 *     through the file chooser): "Add/Submit only after Upload Complete" — the
 *     mock keeps the button pressable but logs every press with the upload's
 *     state; no press may come before Upload Complete, and the window closes.
 *  3. stepVerifyForm reads the form; stepNotifyHumanSubmit tells a person and
 *     the robot NEVER presses "Submit Request".
 *  4. Sign-in: name and password typed, Sign In pressed once; the SMS code is
 *     asked of a person (never typed by the robot on its own) and only the code
 *     the person gives goes in.
 *  5. runFullWorkflow over the whole mock with a fake ctx (as worker.js builds it).
 * Skipped when this PC has no Chrome or no openssl.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import https from 'https'
import { execFileSync } from 'child_process'

const CHROME = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(f => fs.existsSync(f))
const OPENSSL = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-lmis-'))
// This test's own files only: never the PC's secrets, JEV keys or browser.
process.env.SECRETS_PATH = path.join(tmp, 'secrets.enc')
process.env.JEV_CLASSIFY = 'false'
process.env.ADAL_NO_BROWSER_START = '1'
process.env.ADAL_BROWSER_PROFILE = path.join(tmp, 'never')
process.env.LMIS_LOGIN_WAIT_MS = '60000'
process.env.LMIS_LOGIN_STATE_WAIT_MS = '30000'
const L = await import('../src/services/lmisWorkflow.js')
const { setupTab } = await import('../src/services/tabManager.js')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const PROFILE = {
  id: 7, full_name: 'Almaz Kebede Tesfaye', labor_id: 'LB-2024-778899', order_id: 'FT24110ABCD',
  passport_number: 'EP1234567', passport_issue_date: '2024-01-10', date_of_birth: '12 MAR 1998',
  place_of_birth: 'Addis Ababa', destination_country: 'Saudi Arabia',
}
const LOGIN = { phone: '0911000000', password: 'Lmis-pass1', code: '123456' }
const UPLOAD_MS = { slip: 2500, passport: 3000, photo: 4000 }

// ── The mock LMIS app (runs in the page; served as /app.js) ─────────────────
function mockApp(cfg) {
  const root = document.getElementById('root')
  const ev = (type, data = {}) => fetch('/__ev', { method: 'POST', body: JSON.stringify({ type, at: Date.now(), ...data }), keepalive: true }).catch(() => {})
  const signedIn = () => document.cookie.split('; ').includes('sess=1')
  const h = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild }
  const X = '<button class="x"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1L13 13M13 1L1 13" stroke="#000" stroke-width="2"/></svg></button>'
  const NAV = '<nav><b>LMIS Ethiopia — Labour Market Information System</b><a href="/new-agency/dashboard" data-spa>Dashboard</a><a href="/new-agency/police-certificate" data-spa>Police Certificate</a><a href="/auth">Logout</a></nav>'
  const INTRO = 'Request and track police certificates for the labors of your agency. A request needs the labor\'s payment slip, ' +
    'the passport data page and a passport photo. Requests are reviewed by the Federal Police within five working days; ' +
    'the certificate is then shown here and sent to the labor\'s phone. Payments are made at the Commercial Bank of Ethiopia ' +
    'or through Telebirr, and the transaction number on the slip must be given with the request. Only the agency that ' +
    'registered the labor can request her certificate. For help call the LMIS support line.'

  function route() {
    const p = location.pathname
    if (p.startsWith('/auth')) { if (signedIn()) return location.replace('/new-agency/dashboard'); return renderLogin() }
    if (!signedIn()) return location.replace('/auth')
    if (p === '/new-agency/police-certificate') return renderPolice()
    root.innerHTML = NAV + '<main><h2>Dashboard</h2><p>Welcome back. Your agency has 12 labors in process.</p></main>'
  }
  window.addEventListener('popstate', route)
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-spa]')
    if (a) { e.preventDefault(); history.pushState({}, '', new URL(a.href).pathname); route() }
  })

  function renderLogin() {
    root.innerHTML = '<main><h2>Welcome to LMIS</h2><div id="form"><input name="username" placeholder="Phone Number"><br>' +
      '<input type="password" name="password" placeholder="Password"><br><button id="signin">Sign In</button></div></main>'
    document.getElementById('signin').onclick = () => {
      const user = document.querySelector('[name=username]').value, pw = document.querySelector('[name=password]').value
      ev('signin', { user, pw })
      if (user !== cfg.login.phone || pw !== cfg.login.password) return
      setTimeout(() => {
        document.getElementById('form').innerHTML = '<p>Enter the verification code we sent to your phone</p>' +
          Array.from({ length: 6 }, () => '<input class="otp" type="text" maxlength="1" style="width:30px">').join('') +
          '<br><button id="verify">Verify</button>'
        document.querySelectorAll('.otp').forEach(i => i.addEventListener('input', () => ev('codeInput')))
        document.getElementById('verify').onclick = () => {
          const code = [...document.querySelectorAll('.otp')].map(i => i.value).join('')
          ev('verify', { code })
          if (code === cfg.login.code) { document.cookie = 'sess=1; path=/'; setTimeout(() => { location.href = '/new-agency/dashboard' }, 300) }
        }
      }, 800)
    }
  }

  function renderPolice() {
    root.innerHTML = NAV + '<main><div class="spinner" style="width:40px;height:40px">…</div></main>'
    setTimeout(() => {
      if (location.pathname !== '/new-agency/police-certificate') return
      root.innerHTML = NAV + '<main><h2>Police Certificate</h2><p>' + INTRO + '</p><button id="addnew">Add New</button>' +
        '<table><tr><th>Labor</th><th>Status</th></tr><tr><td>Hiwot Alemu</td><td>Approved</td></tr></table></main>'
      document.getElementById('addnew').onclick = openRequest
      if (!sessionStorage.getItem('alertShown')) { sessionStorage.setItem('alertShown', '1'); showAlert() }
    }, 1200)
  }

  function showAlert() {
    const ov = h('<div class="overlay" id="alert"><div class="box" style="width:640px;height:420px"><div><span>SYSTEM ALERT</span></div>' + X +
      '<h3>Attention</h3><p>LMIS Version 3 is now live. Some pages have moved.</p></div></div>')
    document.body.appendChild(ov)
    ov.querySelector('.x').onclick = () => { ev('alertClosed'); ov.remove() }
  }

  function openRequest() {
    ev('addNew')
    const ov = h('<div class="overlay" id="req"><div class="box req"><div class="title">Add Police Certificate Request</div>' + X +
      '<div>Labor Information</div><div class="field"><input id="lid" placeholder="Search labor id"> <button id="search">Search</button></div>' +
      '<div id="result"></div></div></div>')
    document.body.appendChild(ov)
    ov.querySelector('.x').onclick = () => { ev('requestClosed'); ov.remove() }
    ov.querySelector('#search').onclick = () => {
      const v = ov.querySelector('#lid').value.trim()
      ev('search', { v })
      setTimeout(() => {
        const r = ov.querySelector('#result')
        if (v !== cfg.labor.labor_id) { r.innerHTML = '<p class="err">Code Not Found</p>'; return }
        r.innerHTML = '<div class="card"><b>' + cfg.labor.name + '</b> Labor ID: ' + cfg.labor.labor_id + ' · Passport ' + cfg.labor.passport + ' <button id="cardadd">Add</button></div>'
        r.querySelector('#cardadd').onclick = () => { ev('cardAdd'); showForm(r) }
      }, 800)
    }
  }

  const row = (k, name, btn) => '<div class="row" id="row-' + k + '"><div class="rh">' + name + '</div><span class="st">Required</span><button class="go">' + btn + '</button></div>'
  function showForm(r) {
    r.innerHTML = '<div>' + cfg.labor.name + ' — ' + cfg.labor.labor_id + '</div><div class="rows">' +
      row('slip', 'Payment Slip', 'Upload') + row('passport', 'Passport', 'Add') + row('photo', 'Photo', 'Add') +
      '</div><button id="submitreq">Submit Request</button>'
    r.querySelector('#row-slip .go').onclick = () => instructions('Payment Instructions', 'Pay 500 birr at CBE and keep the slip.', 'I Understand — Continue', slipWindow)
    r.querySelector('#row-passport .go').onclick = passportWindow
    r.querySelector('#row-photo .go').onclick = () => instructions('Labor Passport Photo Upload Instructions', 'White background, face in the middle, no glasses.', 'I Agree, Continue', photoWindow)
    r.querySelector('#submitreq').onclick = () => ev('submitRequest')
  }
  const markDone = (k) => { const el = document.getElementById('row-' + k); el.querySelector('.st').textContent = 'Uploaded ✓'; el.querySelector('.go').remove() }

  function instructions(title, text, button, next) {
    const ov = h('<div class="overlay"><div class="box win"><div class="title">' + title + '</div>' + X + '<p>' + text + '</p><button class="ok">' + button + '</button></div></div>')
    document.body.appendChild(ov)
    ov.querySelector('.ok').onclick = () => { ev('instructionsOk', { title }); ov.remove(); next() }
  }

  // An upload window: the file goes up ("Uploading n%") and only then shows
  // "Upload Complete". Its button can be pressed at any time; a press before
  // Upload Complete is logged and ignored (as LMIS does).
  function uploadWindow({ key, title, fields = '', withInput, button, ms, collect = () => ({}) }) {
    const ov = h('<div class="overlay" id="win-' + key + '"><div class="box win"><div class="title">' + title + '</div>' + X + fields +
      '<div class="drop">' + (withInput ? '<input type="file" class="filepond--browser" style="opacity:0;position:absolute;width:1px;height:1px">' : '') +
      '<span>Drag &amp; Drop your file or </span><span class="browse">Browse</span><div class="status"></div></div>' +
      '<button class="cancel">Cancel</button> <button class="ok">' + button + '</button></div></div>')
    document.body.appendChild(ov)
    const st = { status: 'idle' }
    const status = ov.querySelector('.status')
    const start = (input) => {
      const f = input.files[0]
      if (!f || st.status !== 'idle') return
      st.status = 'uploading'
      ev('fileAttached', { win: key, name: f.name, how: input.dataset.how || 'input' })
      let pct = 0
      status.textContent = f.name + ' — Uploading 0% · tap to cancel'
      const iv = setInterval(() => { pct = Math.min(95, pct + 10); status.textContent = f.name + ' — Uploading ' + pct + '% · tap to cancel' }, 300)
      setTimeout(() => { clearInterval(iv); st.status = 'complete'; ev('uploadComplete', { win: key }); status.textContent = f.name + ' — Upload Complete · tap to undo' }, ms)
    }
    const pre = ov.querySelector('input[type=file]')
    if (pre) pre.addEventListener('change', () => start(pre))
    ov.querySelector('.browse').onclick = () => {
      let input = ov.querySelector('input[type=file]')
      if (!input) {   // this dropzone makes its file input only when Browse is clicked
        input = h('<input type="file" style="display:none">')
        input.dataset.how = 'chooser'
        ov.querySelector('.drop').appendChild(input)
        input.addEventListener('change', () => start(input))
      } else input.dataset.how = 'chooser'
      input.click()
    }
    ov.querySelector('.cancel').onclick = () => { ev('cancel', { win: key }); ov.remove() }
    ov.querySelector('.x').onclick = () => { ev('closedX', { win: key }); ov.remove() }
    ov.querySelector('.ok').onclick = () => {
      const complete = st.status === 'complete'
      ev('button', { win: key, label: button, complete, values: collect(ov) })
      if (!complete) return
      setTimeout(() => { ov.remove(); markDone(key); ev('saved', { win: key }) }, 500)
    }
  }

  const val = (ov, sel) => ov.querySelector(sel).value
  function slipWindow() {
    uploadWindow({ key: 'slip', title: 'Upload Police Certificate Payment Slip', withInput: true, button: 'Add', ms: cfg.ms.slip,
      fields: '<div class="field"><label>Reason *</label><input class="reason" placeholder="Reason the labor is going abroad"></div>' +
        '<div class="field"><label>Transaction Number *</label><input class="txn" placeholder="Transaction number"></div>',
      collect: (ov) => ({ reason: val(ov, '.reason'), txn: val(ov, '.txn') }) })
  }
  function passportWindow() {
    uploadWindow({ key: 'passport', title: 'Upload Passport Document', withInput: false, button: 'Submit', ms: cfg.ms.passport,
      fields: '<div class="field"><label>Destination Country *</label><div class="rs__control"><div class="rs__single-value">Select...</div>' +
        '<input class="rs__input" autocomplete="off" style="width:140px;border:0"></div><div class="rs__menu"></div></div>' +
        '<div class="field"><label>Passport Number *</label><input class="pnum" placeholder="EP1234567"></div>' +
        '<div class="field"><label>Passport Issue Date *</label><input type="date" class="pissue"></div>' +
        '<div class="field"><label>Passport Issued Place *</label><input class="pplace"></div>' +
        '<div class="field"><label>Place Of Birth *</label><input class="pob"></div>' +
        '<div class="field"><label>Date Of Birth *</label><input type="date" class="dob"></div>',
      collect: (ov) => ({ dest: ov.querySelector('.rs__single-value').textContent, number: val(ov, '.pnum'), issue: val(ov, '.pissue'),
        place: val(ov, '.pplace'), pob: val(ov, '.pob'), dob: val(ov, '.dob') }) })
    // A react-select: typing asks the "server" for options; Enter takes the first.
    const ov = document.getElementById('win-passport')
    const inp = ov.querySelector('.rs__input'), menu = ov.querySelector('.rs__menu')
    let t = 0
    inp.addEventListener('input', () => {
      clearTimeout(t)
      t = setTimeout(() => {
        const q = inp.value.toLowerCase()
        menu.innerHTML = q ? cfg.countries.filter(c => c.toLowerCase().includes(q)).map(c => '<div class="rs__option">' + c + '</div>').join('') : ''
      }, 400)
    })
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      const first = menu.querySelector('.rs__option')
      if (first) { ov.querySelector('.rs__single-value').textContent = first.textContent; inp.value = ''; menu.innerHTML = '' }
    })
  }
  function photoWindow() {
    uploadWindow({ key: 'photo', title: 'Upload Photo', withInput: false, button: 'Submit', ms: cfg.ms.photo })
  }

  route()
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>LMIS</title><style>
body{font-family:sans-serif;margin:0;background:#fafafa}
nav{height:50px;background:#036;color:#fff;display:flex;gap:20px;align-items:center;padding:0 20px}
nav a{color:#fff}
main{padding:20px}
.overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center}
.box{background:#fff;padding:16px;overflow:auto;position:relative}
.req{width:900px;height:640px}
.win{width:640px;min-height:420px}
.title{font-size:20px;font-weight:bold;margin-bottom:10px}
.field{margin:6px 0}
.rows{min-height:200px;margin:10px 0}
.row{height:56px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #ddd}
.x{position:absolute;top:8px;right:8px;width:28px;height:28px;border:0;background:#eee}
.rs__control{border:1px solid #999;min-height:34px;width:320px;display:flex;align-items:center;gap:6px}
.drop{border:2px dashed #aaa;padding:20px;margin:8px 0;position:relative}
.browse{text-decoration:underline;cursor:pointer}
</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`

// A tiny PDF (LMIS takes the slip and passport as PDF) and a small JPEG photo.
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'

test('LMIS police-certificate robot on a mock LMIS', { skip: (!CHROME && 'no Chrome on this PC') || (!OPENSSL && 'no openssl'), timeout: 290000 }, async (t) => {
  const { selfSigned } = await import('./helpers/mockPortal.js')
  const slipPath = path.join(tmp, 'slip.pdf'), passportPath = path.join(tmp, 'passport.pdf'), photoPath = path.join(tmp, 'photo.jpg')
  fs.writeFileSync(slipPath, PDF); fs.writeFileSync(passportPath, PDF)
  const sharp = (await import('sharp')).default
  await sharp({ create: { width: 200, height: 250, channels: 3, background: '#88aacc' } }).jpeg().toFile(photoPath)

  const events = []
  const cfg = { login: LOGIN, labor: { labor_id: PROFILE.labor_id, name: PROFILE.full_name, passport: PROFILE.passport_number }, ms: UPLOAD_MS,
    countries: ['Kuwait', 'Saudi Arabia', 'Qatar', 'Jordan', 'Lebanon'] }
  const server = https.createServer(selfSigned(tmp), (req, res) => {
    const u = new URL(req.url, 'https://lmis.gov.et')
    if (u.hostname !== 'lmis.gov.et' && req.headers.host !== 'lmis.gov.et') { res.writeHead(404); return res.end() }
    if (u.pathname === '/__ev' && req.method === 'POST') {
      let b = ''; req.on('data', c => { b += c }); req.on('end', () => { try { events.push(JSON.parse(b)) } catch {} res.writeHead(204); res.end() })
      return
    }
    if (u.pathname === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(`(${mockApp.toString()})(${JSON.stringify(cfg)})`) }
    if (u.pathname === '/__test/signin') { res.writeHead(302, { 'set-cookie': 'sess=1; Path=/', location: '/new-agency/police-certificate' }); return res.end() }
    if (u.pathname === '/favicon.ico') { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(tmp, 'profile'), acceptInsecureCerts: true,
    args: ['--no-first-run', '--no-default-browser-check', '--ignore-certificate-errors',
      // lmis.gov.et is the mock; nothing else resolves (the real LMIS is never reached).
      `--host-resolver-rules=MAP lmis.gov.et 127.0.0.1:${port}, MAP * ~NOTFOUND`] })
  const contexts = []
  t.after(async () => {
    for (const c of contexts) await c.close().catch(() => {})
    await browser.close().catch(() => {})
    server.close(); server.closeAllConnections?.()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  // A run tab of its own browser space (as the worker's run tabs are set up).
  const runTab = async (runId) => {
    const c = await browser.createBrowserContext()
    contexts.push(c)
    const page = await c.newPage()
    await setupTab(page, { runId })
    return page
  }
  const mkCtx = (over = {}) => {
    const logs = [], notes = [], asks = []
    const ctx = {
      runId: 9001, profileId: PROFILE.id, workflowId: 'police_certificate', profileName: PROFILE.full_name, profile: PROFILE,
      login_value: LOGIN.phone, login_password: LOGIN.password, account_name: 'Test agency', labor_id: PROFILE.labor_id,
      destination_country: PROFILE.destination_country, slipPath, passportPath, photoPath,
      onLog: (level, msg) => { logs.push(`${level}: ${msg}`) },
      notify: async (title, body, level, opts) => { notes.push({ title, body, level, opts }) },
      askCaptcha: (image, answer, opts) => { asks.push({ image, answer, opts, at: Date.now() }) },
      isCancelled: () => false,
      ...over,
    }
    return { ctx, logs, notes, asks }
  }
  const of = (type, win) => events.filter(e => e.type === type && (!win || e.win === win))
  const waitFor = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await fn()) return true; return false }

  await t.test('preflight: a missing file stops the run before LMIS is opened', async () => {
    const { ctx, logs } = mkCtx({ photoPath: path.join(tmp, 'nope.jpg') })
    const fake = { url: () => 'about:blank' }
    const r = await L.runFullWorkflow(fake, ctx)
    assert.equal(r.ok, false); assert.equal(r.step, 'preflight')
    assert.match(r.error, /missing the photo file/)
    assert.ok(logs.some(l => /missing the photo/.test(l)))
  })

  await t.test('1a. search: an unknown labor ID → "Code Not Found", told, the step stops', async () => {
    events.length = 0
    const page = await runTab(9002)
    await page.goto('https://lmis.gov.et/__test/signin', { waitUntil: 'domcontentloaded' })
    const { ctx, notes, logs } = mkCtx({ runId: 9002, labor_id: 'LB-0000-000000' })
    await L.stepDirectNavigate(page, ctx)
    assert.equal(of('alertClosed').length, 1, 'the SYSTEM ALERT was closed\n' + logs.join('\n'))
    await L.stepAddNew(page, ctx)
    await assert.rejects(L.stepSearchAndFindWorker(page, ctx), /Code Not Found/)
    assert.deepEqual(of('search').map(e => e.v), ['LB-0000-000000'])
    assert.ok(notes.some(n => /Code Not Found/.test(n.title) && /LB-0000-000000/.test(n.body)), JSON.stringify(notes))
    assert.equal(of('cardAdd').length, 0)
    await page.close()
  })

  await t.test('1b–3. her card opened, slip/passport/photo uploaded (Add only after Upload Complete), form checked, a person submits', async () => {
    events.length = 0
    const page = await runTab(9003)
    await page.goto('https://lmis.gov.et/__test/signin', { waitUntil: 'domcontentloaded' })
    const { ctx, notes, logs } = mkCtx({ runId: 9003 })
    const dump = () => logs.join('\n')
    await L.stepDirectNavigate(page, ctx)
    await L.stepAddNew(page, ctx)
    await L.stepSearchAndFindWorker(page, ctx)
    assert.deepEqual(of('search').map(e => e.v), [PROFILE.labor_id])
    assert.equal(of('cardAdd').length, 1, 'her card\'s Add pressed once')
    assert.ok(logs.some(l => /sections visible: slip=true passport=true photo=true/.test(l)), dump())

    await L.stepUploadDocuments(page, ctx)
    assert.deepEqual(ctx.__sectionOk, { slip: true, passport: true, photo: true }, dump())
    // Each file went in once: the slip by the window's own input, passport and photo through the chooser.
    assert.deepEqual(of('fileAttached').map(e => [e.win, e.name, e.how]),
      [['slip', 'slip.pdf', 'input'], ['passport', 'passport.pdf', 'chooser'], ['photo', 'photo.jpg', 'chooser']])
    for (const win of ['slip', 'passport', 'photo']) {
      const done = of('uploadComplete', win)
      const presses = of('button', win)
      assert.equal(done.length, 1, `${win}: Upload Complete shown`)
      assert.equal(presses.filter(p => !p.complete).length, 0, `${win}: never pressed before Upload Complete\n${dump()}`)
      assert.ok(presses.length >= 1 && presses.every(p => p.at >= done[0].at), `${win}: pressed after Upload Complete`)
      assert.equal(of('saved', win).length, 1, `${win}: saved`)
      assert.equal(of('closedX', win).length + of('cancel', win).length, 0, `${win}: not thrown away`)
    }
    assert.equal(await page.$$eval('.overlay', els => els.filter(e => e.id !== 'req').length), 0, 'every upload window closed')
    assert.equal(await page.$('#req') !== null, true, 'the request form is still open')
    // What was typed in the windows.
    const slip = of('button', 'slip').at(-1).values, pass = of('button', 'passport').at(-1).values
    assert.deepEqual(slip, { reason: 'WORK', txn: PROFILE.order_id })
    assert.deepEqual(pass, { dest: 'Saudi Arabia', number: 'EP1234567', issue: '2024-01-10', place: 'Ethiopia', pob: 'Addis Ababa', dob: '1998-03-12' })
    assert.deepEqual(of('instructionsOk').map(e => e.title), ['Payment Instructions', 'Labor Passport Photo Upload Instructions'])

    // 3. The form is read; a person is told to submit; Submit Request is never pressed.
    const form = await L.readPoliceForm(page)
    assert.equal(form.requestOpen, true)
    assert.deepEqual(Object.fromEntries(Object.entries(form.rows).map(([k, v]) => [k, v.state])), { slip: 'done', passport: 'done', photo: 'done' })
    await L.stepVerifyForm(page, ctx)
    assert.ok(logs.some(l => /form complete/.test(l)), dump())
    await L.stepNotifyHumanSubmit(page, ctx)
    const last = notes.at(-1)
    assert.match(last.title, /ready for final submit/)
    assert.match(last.body, /click "Submit Request" yourself/)
    assert.match(last.body, /JEV did not check this form/, 'the person is told JEV did not look (JEV is off here)')
    await sleep(500)
    assert.equal(of('submitRequest').length, 0, 'the robot never presses Submit Request')
    assert.equal(of('requestClosed').length, 0, 'the request form was never closed')
    await page.close()
  })

  await t.test('3b. stepVerifyForm: a section still "Required" is done again before the person is told', async () => {
    events.length = 0
    const page = await runTab(9004)
    await page.goto('https://lmis.gov.et/__test/signin', { waitUntil: 'domcontentloaded' })
    const { ctx, logs } = mkCtx({ runId: 9004 })
    await L.stepDirectNavigate(page, ctx)
    await L.stepAddNew(page, ctx)
    await L.stepSearchAndFindWorker(page, ctx)
    // Nothing uploaded yet: the check finds all three missing and does them.
    await L.stepVerifyForm(page, ctx)
    assert.ok(logs.some(l => /photo is not in the form — doing it again/.test(l)), logs.join('\n'))
    assert.deepEqual(of('saved').map(e => e.win), ['slip', 'passport', 'photo'])
    assert.equal(of('button').filter(p => !p.complete).length, 0)
    assert.equal(of('submitRequest').length, 0)
    await page.close()
  })

  await t.test('4. sign-in: the SMS code is left to a person; only the code given goes in', async () => {
    events.length = 0
    const page = await runTab(9005)
    const { ctx, notes, asks, logs } = mkCtx({ runId: 9005 })
    const p = L.stepLogin(page, ctx)
    let err = null
    p.catch(e => { err = e })
    assert.ok(await waitFor(() => asks.length > 0 || err, 40000), 'a person is asked for the code\n' + logs.join('\n'))
    assert.equal(err, null)
    assert.equal(asks.length, 1)
    assert.equal(asks[0].image, null)
    assert.equal(asks[0].opts.title, 'Type the LMIS SMS code'); assert.equal(asks[0].opts.label, 'Code')
    assert.ok(notes.some(n => /type the LMIS SMS code/.test(n.title) && n.opts?.login === page), 'the person is told')
    assert.deepEqual(of('signin').map(e => [e.user, e.pw]), [[LOGIN.phone, LOGIN.password]])
    // The robot waits: nothing typed in the code boxes, Verify not pressed, Sign In not pressed again.
    await sleep(3000)
    assert.equal(of('codeInput').length, 0, 'no code typed by the robot')
    assert.equal(of('verify').length, 0, 'Verify not pressed')
    assert.equal(of('signin').length, 1, 'Sign In pressed once')
    assert.deepEqual(await page.$$eval('.otp', els => els.map(e => e.value).join('')), '')
    // The person types the code in the notification: it goes in and the run carries on.
    await asks[0].answer(LOGIN.code)
    await p
    assert.deepEqual(of('verify').map(e => e.code), [LOGIN.code])
    assert.match(page.url(), /lmis\.gov\.et\/new-agency\/dashboard/)
    assert.ok(logs.some(l => /logged in/.test(l)))
    await page.close()
  })

  await t.test('5. runFullWorkflow over the whole mock (fake ctx as worker.js builds it)', async () => {
    events.length = 0
    const page = await runTab(9006)
    const { ctx, notes, asks, logs } = mkCtx({ runId: 9006 })
    // The person answers the SMS code when asked.
    const person = (async () => {
      if (await waitFor(() => asks.length > 0, 60000)) { await sleep(500); await asks[0].answer(LOGIN.code) }
    })()
    const r = await L.runFullWorkflow(page, ctx)
    await person
    assert.equal(r.ok, true, `${r.step}: ${r.error}\n${logs.join('\n')}`)
    assert.equal(of('signin').length, 1); assert.deepEqual(of('verify').map(e => e.code), [LOGIN.code])
    assert.equal(of('alertClosed').length, 1)
    assert.deepEqual(of('saved').map(e => e.win), ['slip', 'passport', 'photo'])
    assert.equal(of('button').filter(p => !p.complete).length, 0, 'no Add/Submit before Upload Complete')
    assert.equal(of('submitRequest').length, 0, 'the robot never presses Submit Request')
    assert.ok(logs.some(l => /in the LMIS app to \/new-agency\/police-certificate/.test(l)), 'to the police page inside the app')
    assert.match(notes.at(-1).title, /ready for final submit/)
    await page.close()
  })
})
