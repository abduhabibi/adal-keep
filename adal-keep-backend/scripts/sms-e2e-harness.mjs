// The PC's side of the LMIS-SMS test with a phone (an emulator): a mock of the online link the phone app talks to (Supabase:
// sign-in + keep_calls), the PC's relay answering a call on the real routes (routes/lmisAccounts.js → services/smsCodes.js),
// and two mock LMIS sign-in pages ("PC A" for account nuzla, "PC B" for ZAD) in a headless browser. Nothing real is touched.
//   node scripts/sms-e2e-harness.mjs            (listens on :18080 for the phone, :18090 for GET /state and POST /reset, /arm/:A|B)
import http from 'http'
import express from 'express'
import { findChrome } from '../tests/helpers/chrome.js'

const events = []                                    // { t, what, ... }
const log = (what, extra = {}) => { events.push({ t: Date.now(), what, ...extra }); console.log(new Date().toISOString().slice(11, 23), what, JSON.stringify(extra)) }

// ---- the PC: the real routes, the real smsCodes, the mock LMIS pages
const S = await import('../src/services/smsCodes.js')
const lmis = (await import('../src/routes/lmisAccounts.js')).default
const pc = express(); pc.use(express.json()); pc.locals.db = null; pc.use('/api/lmis', lmis)
const pcServer = await new Promise(r => { const s = http.createServer(pc).listen(0, '127.0.0.1', () => r(s)) })
const pcBase = `http://127.0.0.1:${pcServer.address().port}/api/lmis`

const mockSite = express()
mockSite.get('/lmis/signin', (q, r) => r.send(`<!doctype html><title>mock LMIS ${q.query.pc}</title><h3>LMIS sign in — code sent by SMS</h3>
<input name="otp" id="otp" placeholder="Verification code"><button id="go" onclick="window.pressed=Date.now();document.title='PRESSED '+document.getElementById('otp').value">Verify</button>`))
const siteServer = await new Promise(r => { const s = http.createServer(mockSite).listen(0, '127.0.0.1', () => r(s)) })
const puppeteer = (await import('puppeteer-core')).default
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: 'new', args: ['--no-sandbox'] })
const pages = {}
const open = async (id) => { const p = await browser.newPage(); await p.goto(`http://127.0.0.1:${siteServer.address().port}/lmis/signin?pc=${id}`); pages[id] = p; return p }
const ACCOUNTS = { A: { name: 'nuzla', phone: '0911000000' }, B: { name: 'ZAD', phone: '0922000000' } }
let armed = new Set(['A', 'B'])                      // the PCs that "pressed Sign In" (their code box is open)
const tabsOf = (id) => ({ pages: async () => (armed.has(id) ? [pages[id]] : []) })
await open('A'); await open('B')
S._setBrowsersForTest(async () => [{ name: 'PC A', browser: tabsOf('A') }, { name: 'PC B', browser: tabsOf('B') }], async (db, page) => ACCOUNTS[Object.keys(pages).find(k => pages[k] === page)] || null)
const typed = async () => Object.fromEntries(await Promise.all(Object.keys(pages).map(async k => [k, await pages[k].evaluate(() => ({ value: document.getElementById('otp').value, pressed: window.pressed || 0 })).catch(() => null)])))

// ---- the online link the phone talks to (mock Supabase) + the PC's relay on it
const cloud = express(); cloud.use(express.json())
cloud.post('/auth/v1/token', (q, r) => { log('phone signed in', { email: q.body.email }); r.json({ access_token: 'mock-token', user: { id: 'u-phone' } }) })
cloud.post('/rest/v1/keep_calls', async (q, r) => {
  const row = q.body
  log('phone call arrived', { path: row.path, code: row.body?.code, from: row.body?.from, account: row.body?.account, sim: row.body?.sim, auth: q.headers.authorization })
  r.status(201).end()
  // the PC's relay answers a call on its own API (services/cloudSync.js runCall → local)
  const a = await fetch(`${pcBase}${row.path.replace(/^\/lmis/, '')}`, { method: row.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(row.body) }).then(x => x.json()).catch(e => ({ error: e.message }))
  log('PC answered', a)
  await S.settled()
  const t = await typed()
  log('typed', t)
})
cloud.listen(18080, '0.0.0.0')

const ctl = express(); ctl.use(express.json())
ctl.get('/state', async (q, r) => r.json({ events, typed: await typed(), codes: S.listSmsCodes() }))
ctl.post('/reset', async (q, r) => { try { events.length = 0; for (const k of Object.keys(pages)) { await pages[k].close().catch(() => {}); await open(k) } armed = new Set(['A', 'B']); r.json({ ok: true }) } catch (e) { console.log('reset', e.message); r.status(500).json({ error: e.message }) } })
ctl.post(['/arm', '/arm/:ids'], (q, r) => { armed = new Set((q.params.ids || '').split('').filter(x => 'AB'.includes(x))); r.json({ armed: [...armed] }) })
ctl.post('/clear-codes', (q, r) => r.json({ ok: true }))
ctl.listen(18090, '127.0.0.1')
log('harness ready', { phone: 'http://10.0.2.2:18080', control: 'http://127.0.0.1:18090' })
