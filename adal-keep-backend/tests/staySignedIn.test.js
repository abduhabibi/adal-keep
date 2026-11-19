// A Companion let in with the main PC's number stays in — days, restarts,
// new addresses, a cleared window — until it logs out or the main PC suspends it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-stay-'))
const FILE = path.join(dir, 'pc-access.json')
process.env.ADAL_PC_ACCESS_FILE = FILE
const gate = await import('../src/services/networkGate.js')
const { networkGate, admitSignedIn, setSuspended, remove, statusOf, list, companionSuspended } = gate

const req = (ip, key = '', { cookie = false, p = '/api/profiles', host = `${ip}:4000` } = {}) => ({
  path: p, method: 'GET', socket: { remoteAddress: ip },
  headers: { host, ...(key && !cookie ? { 'x-adal-pc': key } : {}), ...(key && cookie ? { cookie: `adal_pc=${encodeURIComponent(key)}` } : {}) },
})
const run = (r) => { let code = 200, body = null; const res = { status(c) { code = c; return this }, json(b) { body = b; return this } }; let passed = false; networkGate(r, res, () => { passed = true }); return { code: passed ? 200 : code, body } }

// Days pass: Date.now moves on, nothing else changes.
const realNow = Date.now
let shift = 0
Date.now = () => realNow() + shift
test.after(() => { Date.now = realNow })
const days = (n) => { shift += n * 86400000 }

const CID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'

test('a Companion stays in for years: its key never runs out, the last-seen time keeps up', () => {
  const { key } = admitSignedIn(req('192.168.1.30'), 'Desk 5', 'PC number', { cid: CID })
  for (const step of [1, 2, 7, 30, 90, 365, 3 * 365]) {
    days(step)
    assert.equal(run(req('192.168.1.30', key)).code, 200, `after ${step} more days`)
    assert.equal(run(req('192.168.1.30', key, { cookie: true })).code, 200, `cookie, after ${step} more days`)
    assert.equal(statusOf(req('192.168.1.30', key)).state, 'approved')
  }
  const pc = list().find(p => p.name === 'Desk 5')
  assert.ok(Date.now() - pc.last_seen < 11 * 60000)
})

test('the Companion moves to a new address (DHCP, Tailscale): the same key works', () => {
  const { key } = admitSignedIn(req('192.168.1.31'), 'Desk 6', 'PC number')
  days(3)
  assert.equal(run(req('192.168.1.77', key)).code, 200)
  assert.equal(run(req('100.90.1.2', key)).code, 200)
  assert.equal(run(req('10.0.0.9', key, { cookie: true })).code, 200)
})

test('the main PC on a new address, the window cleared: back in with the number at the same place on the list', () => {
  const before = list().filter(p => p.name === 'Desk 5').length
  // A new origin has no cookie and no key: it would be asked for the number…
  assert.equal(run(req('192.168.1.30')).body?.pc_access, true)
  // … so the window comes in by itself with its own id: the same computer, another key.
  const again = admitSignedIn(req('192.168.1.30'), 'Desk 5', 'PC number', { cid: CID })
  assert.equal(again.again, true)
  assert.equal(list().filter(p => p.name === 'Desk 5').length, before)
  assert.equal(run(req('192.168.1.30', again.key)).code, 200)
})

test('a restart (or an update) of the main PC keeps every Companion in', async () => {
  const { key } = admitSignedIn(req('192.168.1.32'), 'Desk 7', 'PC number')
  // A fresh copy of the module reads only the file, as a restarted server would.
  const fresh = await import(`../src/services/networkGate.js?restart=${realNow()}`)
  const r = req('192.168.1.32', key)
  let code = 200; const res = { status(c) { code = c; return this }, json() { return this } }; let passed = false
  fresh.networkGate(r, res, () => { passed = true })
  assert.equal(passed ? 200 : code, 200)
})

test('a list cut short (a power cut while it was written) does not log everyone out', () => {
  const { key } = admitSignedIn(req('192.168.1.33'), 'Desk 8', 'PC number')
  const whole = fs.readFileSync(FILE, 'utf8')
  fs.writeFileSync(FILE, whole.slice(0, Math.floor(whole.length / 2)))
  assert.equal(run(req('192.168.1.33', key)).code, 200)
  // And the next write does not make an empty list for good.
  admitSignedIn(req('192.168.1.34'), 'Desk 9', 'PC number')
  assert.equal(run(req('192.168.1.33', key)).code, 200)
  assert.ok(JSON.parse(fs.readFileSync(FILE, 'utf8')).pcs.length >= 2)
  assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.tmp')))
})

test('a suspension still works at once — on every key, and the number cannot bring it back', () => {
  const first = admitSignedIn(req('192.168.1.40'), 'Desk 10', 'PC number', { cid: 'ffffeeeeddddccccbbbbaaaa99998888' })
  const second = admitSignedIn(req('192.168.1.40'), 'Desk 10', 'PC number', { cid: 'ffffeeeeddddccccbbbbaaaa99998888' })
  assert.equal(first.id, second.id)
  setSuspended(first.id, true)
  for (const k of [first.key, second.key]) {
    const out = run(req('192.168.1.40', k))
    assert.equal(out.code, 403)
    assert.equal(out.body.suspended, true)
  }
  assert.equal(companionSuspended({ cid: 'ffffeeeeddddccccbbbbaaaa99998888' }), true)
  assert.equal(admitSignedIn(req('192.168.1.99'), 'Desk 10', 'PC number', { cid: 'ffffeeeeddddccccbbbbaaaa99998888' }).suspended, true)
  days(30)
  assert.equal(run(req('192.168.1.40', first.key)).code, 403)
  setSuspended(first.id, false)
  assert.equal(run(req('192.168.1.40', first.key)).code, 200)
  assert.equal(run(req('192.168.1.40', second.key)).code, 200)
})

test('"Log out of this main PC" ends it at once, every key; joining again is a new place', () => {
  const a = admitSignedIn(req('192.168.1.50'), 'Desk 11', 'PC number', { cid: '0123456789abcdef0123456789abcdef' })
  const b = admitSignedIn(req('192.168.1.50'), 'Desk 11', 'PC number', { cid: '0123456789abcdef0123456789abcdef' })
  remove(a.id)
  assert.equal(run(req('192.168.1.50', a.key)).code, 401)
  assert.equal(run(req('192.168.1.50', b.key)).code, 401)
  assert.equal(statusOf(req('192.168.1.50', b.key)).state, 'removed')
  const c = admitSignedIn(req('192.168.1.50'), 'Desk 11', 'PC number', { cid: '0123456789abcdef0123456789abcdef' })
  assert.notEqual(c.id, a.id)
  assert.equal(run(req('192.168.1.50', c.key)).code, 200)
})

test('the list shown on the main PC carries no keys', () => {
  for (const p of list()) { assert.equal(p.key, undefined); assert.equal(p.keys, undefined); assert.equal(p.cid, undefined) }
})
