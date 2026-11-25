/**
 * Adal Keep Admin → Lock / Unlock, an agency's details, notes and the notice of a
 * new registration (adal-admin/registry.mjs), on the pretend Supabase with throw-away keys.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let demo
const call = async (p, body) => { const r = await fetch(demo.base + p, { method: body ? 'POST' : 'GET', headers: { cookie: demo.cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) } }
const sb = async (method, p, body) => { const r = await fetch(`${demo.sb}${p}`, { method, headers: { apikey: 'demo', Authorization: 'Bearer demo', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return r.json().catch(() => null) }
const licence = async (pc) => (await sb('GET', `/storage/v1/object/adal-updates/licenses/${pc}.json`))?.license
before(async () => {
  demo = await (await import(pathToFileURL(path.join(REPO, 'adal-admin', 'tests', 'demo.mjs')).href)).startDemo()
  demo.sb = `http://127.0.0.1:${demo.fake.server.address().port}`
})
after(() => demo?.stop())
const PC = '500005'

test('Lock and Unlock: signed, the paid time and features stay, who and when kept; a second lock keeps its date', async () => {
  await call('/api/plans/save', { pc: PC, add_paid_days: 100, features: { wafid: 'off' }, note: 'hello' })
  const before = await licence(PC)
  assert.ok(before?.paid_until > Date.now())
  const r = await call('/api/lock', { pc: PC, locked: true, note: 'not paid' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const l = await licence(PC)
  assert.equal(l.suspended.note, 'not paid')
  assert.deepEqual([l.paid_until, l.features, l.note], [before.paid_until, before.features, 'hello'])
  await call('/api/lock', { pc: PC, locked: true, note: 'again' })
  assert.equal((await licence(PC)).suspended.at, l.suspended.at)
  // Paid days given meanwhile do not unlock: only Unlock does.
  await call('/api/plans/save', { pc: PC, add_paid_days: 30 })
  assert.ok((await licence(PC)).suspended)
  await call('/api/lock', { pc: PC, locked: false })
  const u = await licence(PC)
  assert.equal('suspended' in u, false)
  assert.ok(u.paid_until > before.paid_until); assert.ok(Date.parse(u.at) >= Date.parse(l.at), 'the newer one: the PC takes it')
  const { json: d } = await call(`/api/agency/details?pc=${PC}`)
  assert.deepEqual(d.locks.map(x => x.action), ['unlock', 'lock', 'lock'])
  assert.ok(d.locks.every(x => x.by && x.at && x.pcs.includes(PC)))
  assert.equal((await call('/api/lock', { pc: PC })).status, 500, 'lock or unlock must be said')
  assert.equal((await call('/api/lock', { pc: '999999', locked: true })).status, 500)
})

test('only that agency is locked; another agency\'s licence is not touched', async () => {
  const all = (await call('/api/overview')).json.mains.filter(m => m.pc_number !== PC)
  const was = await Promise.all(all.map(m => licence(m.pc_number)))
  await call('/api/lock', { pc: PC, locked: true })
  assert.deepEqual(await Promise.all(all.map(m => licence(m.pc_number))), was)
  await call('/api/lock', { pc: PC, locked: false })
})

test('a licence that cannot be trusted is never written over', async () => {
  const file = await sb('GET', `/storage/v1/object/adal-updates/licenses/${PC}.json`)
  const bad = { ...file, license: { ...file.license, paid_until: 1 } }
  await sb('POST', `/storage/v1/object/adal-updates/licenses/${PC}.json`, bad)
  const r = await call('/api/lock', { pc: PC, locked: true })
  assert.equal(r.status, 500); assert.match(r.json.error, /not signed by Adal/)
  assert.equal((await licence(PC)).paid_until, 1, 'left as it was')
  await sb('POST', `/storage/v1/object/adal-updates/licenses/${PC}.json`, file)
})

test('details: registration, PCs, phones, plan, payments, counts; notes are kept; what is not collected is said', async () => {
  await call('/api/agency/notes', { pc: PC, notes: 'pays by telebirr' })
  const { status, json: d } = await call(`/api/agency/details?pc=${PC}`)
  assert.equal(status, 200, JSON.stringify(d))
  assert.ok(Date.parse(d.registered_at) < Date.now())
  assert.equal(d.pc_number, PC); assert.equal(d.notes, 'pays by telebirr')
  assert.ok(d.pcs.length >= 1 && d.pcs[0].name && d.pcs.some(p => p.role === 'main'))
  assert.equal(d.mains + d.companions, d.pcs.length)
  assert.ok(!d.phones.some(x => d.pcs.some(p => p.name === x.name)), 'a Companion is not counted as a phone')
  for (const k of ['girls', 'employees', 'plan', 'paid_until', 'phones', 'payments', 'receipts', 'last_seen', 'version']) assert.ok(k in d, k)
  assert.ok(d.not_collected.some(x => /Windows user/.test(x)))
})

test('a new registration is told once, with its PC number, until seen; what was there before is not', async () => {
  assert.deepEqual((await call('/api/registrations')).json.fresh, [])
  const id = '00000000-0000-4000-8000-00000000abcd'
  await sb('POST', '/rest/v1/agencies', { id, name: 'Nile New', pc_number: '777777', banned: false, is_admin: false, created_at: new Date().toISOString(), last_seen: new Date().toISOString() })
  const { fresh } = (await call('/api/registrations')).json
  assert.deepEqual(fresh.map(x => [x.name, x.pc_number, x.kind]), [['Nile New', '777777', 'new agency']])
  assert.equal((await call('/api/registrations')).json.fresh.length, 1, 'still there until seen')
  await call('/api/registrations/seen', { ids: [id] })
  assert.deepEqual((await call('/api/registrations')).json.fresh, [])
})

test('a broken registry.mjs: Admin opens without it, Lock says so', async () => {
  const fs = await import('fs'), os = await import('os')
  const src = path.join(REPO, 'adal-admin'), at = fs.mkdtempSync(path.join(os.tmpdir(), 'adm-broken-'))
  fs.cpSync(src, path.join(at, 'adal-admin'), { recursive: true, filter: (p) => !/\.env$|\.sessions\.json$|keep-app|cv-collection/.test(p) })
  fs.symlinkSync(path.join(REPO, 'adal-keep-backend'), path.join(at, 'adal-keep-backend'), 'junction')
  fs.writeFileSync(path.join(at, 'adal-admin', 'registry.mjs'), 'this is not javascript (')
  const d = await (await import(pathToFileURL(path.join(at, 'adal-admin', 'tests', 'demo.mjs')).href)).startDemo()
  try {
    const h = { cookie: d.cookie, 'Content-Type': 'application/json' }
    assert.equal((await fetch(d.base + '/api/overview', { headers: h })).status, 200)
    assert.equal((await fetch(d.base + `/api/agency?pc=${PC}`, { headers: h })).status, 200)
    assert.equal((await fetch(d.base + '/api/lock', { method: 'POST', headers: h, body: '{}' })).status, 404)
    const r = await fetch(d.base + '/api/plans/save', { method: 'POST', headers: h, body: JSON.stringify({ pc: PC, suspend: true }) })
    assert.match((await r.json()).error, /nothing was changed/)
  } finally { d.stop(); fs.rmSync(at, { recursive: true, force: true }) }
})
