#!/usr/bin/env node
/**
 * robot-bench.mjs — robot vs a person, seconds per job (2026-11-23, for the pitch "our robots do the
 * agency's government-site work faster than a person").
 *
 *   node scripts/robot-bench.mjs [--json]
 *
 * Nothing reaches a real government site: the sites' host names are mapped to a mock on this PC
 * (Chromium --host-resolver-rules), and the line is slowed to an office line in Ethiopia with Chrome's
 * own network emulation (150 ms each way, 4 Mbit/s down, 1 Mbit/s up). The pages are as heavy as the
 * portals' (an Angular app, its fonts and pictures, a late chunk, the site's background polling and
 * trackers) and the server answers after the portals' usual wait. The page loads are MEASURED in a real
 * headless Chromium; what a person does with hands and eyes is the keystroke-level model (KLM:
 * point+click 1.1 s, a screen read 1.5 s, typing 0.3 s a character, a file picked 6 s, a value copied
 * into Adal Keep 3 s). One headless browser, one job at a time, well under 2 minutes in all.
 *
 * Three ways per job:
 *   person   — a person in a normal browser: every page whole (pictures, fonts), waits until it is drawn.
 *   before   — the robot before 2026-11-23 (pictures blocked; fonts loaded; every page until the whole
 *              site is quiet (networkidle2); its fixed sleeps; typing with delays; a new connection to
 *              Adal Browser at every look (7 s on Main, measured: b07b135); the first page 2 x 180 s when
 *              it does not come).
 *   now      — the robot now: pictures, fonts and trackers blocked; each page ends on its own signal
 *              (the row, the box); the portal's own data calls in the signed-in tab where it has them
 *              (siteApi.js / musanedImport / scanListByApi); kept answers (robotCache.js).
 */
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'

const CHROME = process.env.BENCH_CHROME || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(f => fs.existsSync(f))
if (!CHROME) { console.error('No Chrome/Chromium on this PC (BENCH_CHROME=/path/to/chrome)'); process.exit(2) }
const JSON_OUT = process.argv.includes('--json')

// ── the line and the person ─────────────────────────────────────────────────
// The line: BENCH_MS (each way) and BENCH_MBIT (down; up is a quarter), e.g. BENCH_MS=300 BENCH_MBIT=1 for a slow office line.
const LINE = { offline: false, latency: Number(process.env.BENCH_MS) || 150, downloadThroughput: (Number(process.env.BENCH_MBIT) || 4) * 1e6 / 8, uploadThroughput: Math.max(0.25, (Number(process.env.BENCH_MBIT) || 4) / 4) * 1e6 / 8 }
const KLM = { click: 1.1, read: 1.5, char: 0.3, file: 6, copy: 3 }
const CONNECT_BEFORE = 7   // s: a new CDP connection + port check at every look on Main (b07b135, measured live)

// ── the mock portals ────────────────────────────────────────────────────────
const KB = 1024
const blob = (n) => Buffer.alloc(n, 'a')
const STATIC = {
  '/app.js': { type: 'application/javascript', body: Buffer.from(`/*${'x'.repeat(1400 * KB)}*/`), wait: 80 },
  '/chunk.js': { type: 'application/javascript', body: Buffer.from(`/*${'x'.repeat(280 * KB)}*/`), wait: 80 },
  '/app.css': { type: 'text/css', body: Buffer.from(`/*${'x'.repeat(180 * KB)}*/ body{font-family:F1}`), wait: 80 },
  '/f1.woff2': { type: 'font/woff2', body: blob(110 * KB), wait: 60 },
  '/f2.woff2': { type: 'font/woff2', body: blob(95 * KB), wait: 60 },
  '/f3.woff2': { type: 'font/woff2', body: blob(120 * KB), wait: 60 },
}
for (let i = 0; i < 6; i++) STATIC[`/img${i}.png`] = { type: 'image/png', body: blob(55 * KB), wait: 60 }
const TTFB_HTML = 450, TTFB_API = 380

function page(title, inner = '') {
  return `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="/app.css">
<style>@font-face{font-family:F1;src:url(/f1.woff2)}@font-face{font-family:F2;src:url(/f2.woff2)}@font-face{font-family:F3;src:url(/f3.woff2)}
h1{font-family:F1}p{font-family:F2}b{font-family:F3}</style>
<script src="/app.js"></script>
<script async src="http://www.google-analytics.com/a.js"></script></head>
<body><h1>${title}</h1><p>.</p><b>.</b>${[0, 1, 2, 3, 4, 5].map(i => `<img src="/img${i}.png" width="20">`).join('')}
<div id="app"></div>
<script>
  // The app draws after its late chunk, like the portals' Angular pages.
  setTimeout(() => { const s = document.createElement('script'); s.src = '/chunk.js'; s.onload = () => {
    document.getElementById('app').innerHTML = ${JSON.stringify(inner)}; document.body.dataset.ready = '1' }; document.head.appendChild(s) }, 250)
  // The site's background polling (notifications), never quiet for long.
  setInterval(() => fetch('/api/notifications').catch(() => {}), 1200)
</script></body></html>`
}
const INNER = {
  form: '<input id="q"><textarea id="t"></textarea><button id="go">Search</button><table id="rows"></table>',
  row: '<table id="rows"><tr><td class="app-table-value">EP1234567</td><td><a id="view" href="#">VIEW</a></td></tr></table>',
  record: '<div id="her">Candidate EP1234567</div>',
}
const API = {
  '/api/hrpool': { content: [{ id: 11, passportNumber: 'EP1234567' }] },
  '/api/hrpool/11': { id: 11, fullName: 'X', birthDate: '2000-01-01', religion: 'Muslim', maritalStatus: 'Single', education: 'x', experience: [] },
  '/api/search/employment': { content: Array.from({ length: 20 }, (_, i) => ({ id: i, passport: `EP${i}`, status: 'NEW', contract: `C${i}` })) },
  '/api/notifications': { n: 0 },
  '/api/labour': { ok: true },
  '/api/appointments': { slots: [{ at: '2026-12-01T09:00' }] },
}

function serve() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (/google-analytics/.test(req.headers.host || '')) { res.end(''); return }
    const st = STATIC[u.pathname]
    if (st) { setTimeout(() => { res.writeHead(200, { 'content-type': st.type, 'cache-control': 'max-age=3600' }); res.end(st.body) }, st.wait); return }
    if (u.pathname.startsWith('/api/')) {
      const key = Object.keys(API).sort((a, b) => b.length - a.length).find(k => u.pathname.startsWith(k))
      const ph = /\/photo\//.test(u.pathname)
      setTimeout(() => {
        res.writeHead(200, { 'content-type': ph ? 'image/jpeg' : 'application/json', 'access-control-allow-origin': '*' })
        res.end(ph ? blob(60 * KB) : JSON.stringify(API[key] || {}))
      }, TTFB_API)
      return
    }
    const kind = u.pathname.split('/')[1] || 'form'
    setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(page(kind, INNER[kind] || INNER.form)) }, TTFB_HTML)
  })
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)))
}

// ── one way of working: a fresh tab (cold cache), the line slowed ──────────
async function tabFor(browser, mode) {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  p.setDefaultTimeout(180000); p.setDefaultNavigationTimeout(180000)   // a slow line (BENCH_MBIT=1) takes its time
  const cdp = await p.target().createCDPSession()
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', LINE)
  const bytes = { n: 0, reqs: 0 }
  cdp.on('Network.loadingFinished', (e) => { bytes.n += e.encodedDataLength || 0; bytes.reqs++ })
  if (mode !== 'person') {
    await p.setRequestInterception(true)
    p.on('request', (r) => {
      const t = r.resourceType()
      const block = t === 'image' || t === 'media' || /google-analytics/.test(r.url()) || (mode === 'now' && t === 'font')
      if (block && !p.__allowImages) r.abort().catch(() => {}); else r.continue().catch(() => {})
    })
  }
  return { p, ctx, bytes, close: () => ctx.close().catch(() => {}) }
}

const SITE = 'http://tawtheeq.musaned.com.sa'
const secs = (t0) => (Date.now() - t0) / 1000
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** One page, waited for the way each mode waits. Returns measured seconds. */
async function open(t, mode, url, signal = '#app *') {
  const t0 = Date.now()
  if (mode === 'person') { await t.p.goto(url, { waitUntil: 'load' }); await t.p.waitForSelector(signal) }
  else if (mode === 'before') await t.p.goto(url, { waitUntil: 'networkidle2', timeout: 180000 })
  else { await t.p.goto(url, { waitUntil: 'domcontentloaded' }); await t.p.waitForSelector(signal) }
  return secs(t0)
}
/** The portal's own data call in the signed-in tab (in parallel when there are several). */
async function api(t, paths) {
  const t0 = Date.now()
  await t.p.evaluate((ps) => Promise.all(ps.map(x => fetch(x).then(r => r.arrayBuffer()))), paths)
  return secs(t0)
}

// ── the jobs: every path each way walks ─────────────────────────────────────
// Each returns { measured, modelled } seconds: measured = pages and calls, modelled = hands, eyes, sleeps.
const JOBS = [
  {
    id: 'musaned_import', name: 'Musaned: Add from Musaned (passport → her HR Pool record into Adal Keep)',
    async person(t) { let m = 0; m += await open(t, 'person', `${SITE}/form`); m += await open(t, 'person', `${SITE}/row`); m += await open(t, 'person', `${SITE}/record`)
      return { m, k: 3 * KLM.read + 3 * KLM.click + 9 * KLM.char + 8 * KLM.copy } },
    async before(t) { let m = 0; m += await open(t, 'before', `${SITE}/form`); m += await open(t, 'before', `${SITE}/row`); m += await open(t, 'before', `${SITE}/record`)
      return { m, k: CONNECT_BEFORE + 0.7 + 9 * 0.1 + 4.3 } },        // filter-box sleep, typing delay 100 ms, the file's sleeps
    async now(t) { let m = 0; m += await open(t, 'now', `${SITE}/form`, '#q')   // the signed-in tab (kept warm) is already there: counted once
      m += await api(t, ['/api/hrpool?passportNumber=EP1234567', ]); m += await api(t, ['/api/hrpool/11', '/api/hrpool/11/photo/PASSPORT', '/api/hrpool/11/photo/PERSONAL'])
      return { m, k: 0 } },
  },
  {
    id: 'musaned_check_chosen', name: 'Musaned: check if chosen (her passport on the Employment Requests list)',
    async person(t) { let m = await open(t, 'person', `${SITE}/form`); m += await open(t, 'person', `${SITE}/row`)
      return { m, k: 2 * KLM.read + 2 * KLM.click + 9 * KLM.char } },
    async before(t) { let m = await open(t, 'before', `${SITE}/form`); m += await open(t, 'before', `${SITE}/row`)
      return { m, k: CONNECT_BEFORE + 0.7 + 9 * 0.04 + 1.0 + 0.8 } },  // sleep 700, delay 40, sleep 1000, idle 800
    async now(t) { let m = await open(t, 'now', `${SITE}/form`, '#q'); m += await api(t, ['/api/search/employment?page=0'])
      return { m, k: 0 } },
  },
  {
    id: 'musaned_contract', name: 'Musaned: open her contract and save its PDF',
    async person(t) { let m = await open(t, 'person', `${SITE}/form`); m += await open(t, 'person', `${SITE}/row`); m += await open(t, 'person', `${SITE}/record`)
      return { m, k: 3 * KLM.read + 4 * KLM.click + 9 * KLM.char + KLM.file } },
    async before(t) { let m = await open(t, 'before', `${SITE}/form`); m += await open(t, 'before', `${SITE}/row`); m += await open(t, 'before', `${SITE}/record`)
      return { m, k: CONNECT_BEFORE + 6.5 } },                           // the contract path's sleeps (musanedContracts.js)
    async now(t) { let m = await open(t, 'now', `${SITE}/form`, '#q'); m += await api(t, ['/api/search/employment?page=0']); m += await open(t, 'now', `${SITE}/record`, '#her')
      return { m, k: 1.5 } },                                            // sleeps left on the PDF step
  },
  {
    id: 'lmis_add_labour', name: 'LMIS: add her as labour (form, 4 uploads; stops before the final Add)',
    async person(t) { let m = 0; for (const p of ['form', 'form', 'record']) m += await open(t, 'person', `${SITE}/${p}`)
      return { m, k: 3 * KLM.read + 14 * KLM.click + 120 * KLM.char + 4 * KLM.file } },
    async before(t) { let m = 0; for (const p of ['form', 'form', 'record']) m += await open(t, 'before', `${SITE}/${p}`)
      return { m, k: CONNECT_BEFORE + 15.1 + 120 * 0.05 } },             // lmisWorkflow sleeps, typing delay
    async now(t) { let m = 0; for (const p of ['form', 'form', 'record']) m += await open(t, 'now', `${SITE}/${p}`, p === 'record' ? '#her' : '#q')
      return { m, k: 15.1 + 120 * 0.05 } },                              // same sleeps and typing: not changed yet (needs live runs)
  },
  {
    id: 'tasheer_schedule', name: 'Tasheer: find an appointment',
    async person(t) { let m = 0; for (const p of ['form', 'form', 'row']) m += await open(t, 'person', `${SITE}/${p}`)
      return { m, k: 3 * KLM.read + 6 * KLM.click + 30 * KLM.char } },
    async before(t) { let m = 0; for (const p of ['form', 'form', 'row']) m += await open(t, 'before', `${SITE}/${p}`)
      return { m, k: CONNECT_BEFORE + 21.0 * 0.5 } },                     // about half of tasheer.js's sleeps on this path
    async now(t) { let m = 0; for (const p of ['form', 'form', 'row']) m += await open(t, 'now', `${SITE}/${p}`, p === 'row' ? '#rows' : '#q')
      return { m, k: 21.0 * 0.5 } },
  },
  {
    id: 'transition_copy', name: 'Transitions: copy one candidate from the old system',
    async person(t) { let m = 0; for (const p of ['row', 'record']) m += await open(t, 'person', `${SITE}/${p}`)
      return { m, k: 2 * KLM.read + 2 * KLM.click + 15 * KLM.copy + 2 * KLM.file } },
    async before(t) { let m = 0; for (const p of ['row', 'record']) m += await open(t, 'before', `${SITE}/${p}`)
      return { m, k: CONNECT_BEFORE + 4.5 } },
    async now(t) { const m = await open(t, 'now', `${SITE}/record`, '#her')
      return { m, k: 4.5 } },
  },
]

// ── run ─────────────────────────────────────────────────────────────────────
const puppeteer = (await import('puppeteer-core')).default
const srv = await serve()
const port = srv.address().port
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-bench-'))
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, userDataDir: tmp,
  args: [`--host-resolver-rules=MAP tawtheeq.musaned.com.sa 127.0.0.1:${port}, MAP www.google-analytics.com 127.0.0.1:${port}`, '--no-first-run', '--disable-gpu'],
})
const rows = []
const started = Date.now()
try {
  for (const job of JOBS) {
    const row = { id: job.id, name: job.name }
    for (const mode of ['person', 'before', 'now']) {
      const t = await tabFor(browser, mode)
      // A person and the robot now start in a tab that is already open and signed in on the site (cache warm);
      // the robot before opened its page from cold each run (a new tab, a new connection).
      if (mode !== 'before') { await t.p.goto(`${SITE}/form`, { waitUntil: 'load' }); t.bytes.n = 0; t.bytes.reqs = 0 }
      const { m, k } = await job[mode](t)
      row[mode] = { secs: Math.round((m + k) * 10) / 10, measured: Math.round(m * 10) / 10, modelled: Math.round(k * 10) / 10, kb: Math.round(t.bytes.n / KB), requests: t.bytes.reqs }
      await t.close()
    }
    row.faster = Math.round((row.person.secs / row.now.secs) * 10) / 10
    rows.push(row)
  }
} finally {
  await browser.close().catch(() => {})
  srv.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (JSON_OUT) console.log(JSON.stringify({ line: LINE, rows, secs: secs(started) }, null, 2))
else {
  const pad = (s, n) => String(s).padEnd(n), lp = (s, n) => String(s).padStart(n)
  console.log(`Robot vs person (mock portals on a ${LINE.latency} ms / ${LINE.downloadThroughput * 8 / 1e6} Mbit/s line; pages measured in headless Chromium, hands by KLM)\n`)
  console.log(pad('job', 22) + lp('person s', 10) + lp('before s', 10) + lp('now s', 8) + lp('now×', 7) + lp('KB person/before/now', 24))
  for (const r of rows) console.log(pad(r.id, 22) + lp(r.person.secs, 10) + lp(r.before.secs, 10) + lp(r.now.secs, 8) + lp(r.faster + '×', 7) + lp(`${r.person.kb}/${r.before.kb}/${r.now.kb}`, 24))
  console.log(`\n(${Math.round(secs(started))} s in all; failure path before: the first Musaned page 2 × 180 s = up to 360 s; now one try of 60 s)`)
}
