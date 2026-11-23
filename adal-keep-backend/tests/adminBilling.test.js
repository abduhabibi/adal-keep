/**
 * Adal Keep Admin → Billing and Business, end to end against a fake Supabase:
 * a payment extends the signed licence, is kept once, is told to the agency;
 * instructions are signed; the dashboard answers with counts only.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import net from 'net'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-billing-'))
const free = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })

const stored = new Map(), posted = [], patched = []
let fake, proc, base, cookie = ''
const DAY = 86400000
const AG = { id: 'ag-1', name: 'ABC Agency', pc_number: '123456', banned: false, created_at: new Date(Date.now() - 30 * DAY).toISOString(), last_seen: new Date().toISOString() }
const now = () => new Date().toISOString()
const day = (n) => new Date(Date.now() - n * DAY).toLocaleDateString('en-CA')
const STATS = { v: 1, profiles: 4, added: { [day(1)]: 3 }, cvs: {}, moves: { [day(1)]: 2 }, stages: { musaned: { n: 2, avg_days: 6 } }, robots: { wafid_book: { done: 3, failed: 1, other: 0, secs: 400, d: { [day(1)]: { done: 3, failed: 1 } } } } }

before(async () => {
  fake = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const u = decodeURIComponent(req.url)
    const json = (v, code = 200) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
    if (u.startsWith('/storage/v1/object/')) {
      const p = u.split('?')[0].replace('/storage/v1/object/', '')
      if (req.method === 'POST') { stored.set(p, body.toString()); return json({ Key: p }) }
      return stored.has(p) ? res.writeHead(200).end(stored.get(p)) : json({ message: 'not found' }, 404)
    }
    if (u.startsWith('/rest/v1/agencies')) return json(u.includes('is_admin=eq.true') ? [{ id: 'admin-id' }] : [AG])
    if (u.startsWith('/rest/v1/unlock_requests')) { if (req.method === 'PATCH') { patched.push([u, JSON.parse(body.toString())]); return json([]) } return json([{ id: 7, agency_id: 'ag-1', pc_number: '123456', image_path: 'r.png', created_at: now() }]) }
    if (u.startsWith('/rest/v1/conversations')) return json([{ id: 'conv-1' }])
    if (u.startsWith('/rest/v1/keep_meta')) return json([{ agency_id: 'ag-1', key: '/_pc', data: { at: now() }, updated_at: now() }, { agency_id: 'ag-1', key: '/_stats', data: STATS, updated_at: now() }])
    if (u.startsWith('/rest/v1/messages') && req.method === 'POST') { posted.push(JSON.parse(body.toString())); return json({}) }
    return json([])
  })
  await new Promise(ok => fake.listen(0, '127.0.0.1', ok))
  // A copy of the panel beside a link to the real backend: its .env / session files stay in tmp.
  const dir = path.join(tmp, 'adal-admin'); fs.mkdirSync(path.join(dir, 'public'), { recursive: true })
  for (const f of fs.readdirSync(path.join(REPO, 'adal-admin')).filter(f => f.endsWith('.mjs'))) fs.copyFileSync(path.join(REPO, 'adal-admin', f), path.join(dir, f))
  fs.copyFileSync(path.join(REPO, 'adal-admin', 'public', 'index.html'), path.join(dir, 'public', 'index.html'))
  fs.symlinkSync(path.join(REPO, 'adal-keep-backend'), path.join(tmp, 'adal-keep-backend'))
  const home = path.join(tmp, 'home'); fs.mkdirSync(path.join(home, '.adal-keep'), { recursive: true })
  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(path.join(home, '.adal-keep', 'update-signing.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const port = await free()
  fs.writeFileSync(path.join(dir, '.env'), `SUPABASE_URL=http://127.0.0.1:${fake.address().port}\nSUPABASE_SERVICE_KEY=test\nADAL_LICENSE_KEY=test-key\n`)
  proc = spawn(process.execPath, [path.join(dir, 'server.mjs')], { env: { ...process.env, HOME: home, USERPROFILE: home, ADMIN_PORT: String(port) }, stdio: 'ignore' })
  base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) { try { await fetch(base + '/'); break } catch { await new Promise(r => setTimeout(r, 100)) } }
  const r = await fetch(base + '/set-password', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=secret123&again=secret123' })
  cookie = (r.headers.get('set-cookie') || '').split(';')[0]
})
after(() => { proc?.kill(); fake?.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

const call = async (p, body) => {
  const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, json: await r.json() }
}

test('a payment extends the signed licence by 6 months, is recorded once and told to the agency', async () => {
  assert.ok(cookie, 'signed in')
  const r = await call('/api/billing/payment', { pc: '123456', method: 'telebirr', reference: 'CK99', amount: 30000, date: day(0) })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.ok(Math.abs(r.json.paid_until - (Date.now() + 182 * DAY)) < 60000)
  const lic = JSON.parse(stored.get('adal-updates/licenses/123456.json'))
  assert.equal(lic.license.paid_until, r.json.paid_until); assert.ok(lic.signature)
  const copy = JSON.parse(stored.get('adal-updates/billing/payments/123456.json'))
  assert.deepEqual(copy.data.payments.map(p => [p.reference, p.amount]), [['CK99', 30000]])
  assert.ok(!JSON.stringify(copy).includes('agency'))
  assert.match(posted.at(-1).body, /Payment received: 30,000 ETB/)
  // The same receipt typed again is refused (and nothing extends).
  const again = await call('/api/billing/payment', { pc: '123456', method: 'telebirr', reference: 'ck99', amount: 30000 })
  assert.equal(again.status, 500); assert.match(again.json.error, /already recorded/)
  const bad = await call('/api/billing/payment', { pc: '123456', method: 'card', amount: 5 })
  assert.match(bad.json.error, /Method/)
  assert.equal((await call('/api/billing/payment', { pc: '000000', method: 'cash', amount: 100 })).status, 500)
})

test('billing list shows the licence line and the payment; instructions are saved signed', async () => {
  const b = (await call('/api/billing')).json
  assert.equal(b.agencies.length, 1); assert.equal(b.revenue.total, 30000)
  assert.equal(b.agencies[0].payments[0].reference, 'CK99')
  const s = await call('/api/billing/instructions', { instructions: { price_etb: 30000, telebirr: { name: 'Adal', number: '0995 668 080' }, banks: [{ bank: 'CBE', account_name: 'Adal', account_number: '1000709131323' }], note: 'x'.repeat(500) } })
  assert.equal(s.json.instructions.telebirr.number, '0995668080'); assert.equal(s.json.instructions.note.length, 300)
  const f = JSON.parse(stored.get('adal-updates/billing/instructions.json'))
  assert.ok(f.signature && f.data.banks[0].account_number === '1000709131323')
})

test('business dashboard: counts, success rate, revenue — and no personal data', async () => {
  const d = (await call('/api/business?days=30')).json
  assert.equal(d.agencies.total, 1); assert.equal(d.agencies.active, 1); assert.equal(d.pcs.online, 1)
  assert.equal(d.added.total, 3); assert.equal(d.moves.total, 2)
  assert.deepEqual([d.robots[0].robot, d.robots[0].done, d.robots[0].failed, d.robots[0].success], ['wafid_book', 3, 1, 75])
  assert.equal(d.stages[0].avg_days, 6)
  // (The panel checks licences against Adal's real public key; this test signs with a throw-away one, so it reads the agency (30 days old) as ended.)
  assert.equal(d.revenue.thisMonth, 30000); assert.equal(d.agencies.expired, 1)
  assert.ok(d.hours_saved > 0)
  assert.ok(!/ABC Agency|123456/.test(JSON.stringify({ ...d, renewals: undefined })), 'only the renewals list names an agency')
})

test('a receipt from the app waits in Billing; Confirm (12 months + 1 extra PC) extends the licence and marks it confirmed', async () => {
  const b = (await call('/api/billing')).json
  assert.equal(b.receipts[0].agency, 'ABC Agency'); assert.deepEqual([b.quote.six, b.quote.twelve], [49999, 89999])
  const r = await call('/api/billing/payment', { pc: '123456', method: 'bank', reference: 'FT77', term: 12, extra_pcs: 1, receipt_id: 7 })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(r.json.payment.amount, 89999 + 2 * 2500); assert.equal(r.json.payment.periods, 2)
  assert.ok(Math.abs(r.json.paid_until - (Date.now() + 364 * DAY)) < 120000)
  const [u, body] = patched.at(-1)
  assert.match(u, /id=eq\.7/); assert.equal(body.status, 'approved'); assert.match(body.note, /^confirmed:bank FT77/)
  // USD-indexed: the instructions carry it, the next quote follows the rate.
  await call('/api/billing/instructions', { instructions: { usd: { on: true, usd_6m: 400, usd_12m: 720, usd_extra: 20, rate: 130 } } })
})
