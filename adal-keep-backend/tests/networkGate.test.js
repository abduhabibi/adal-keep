import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-gate-'))
process.env.ADAL_PC_ACCESS_FILE = path.join(dir, 'pc-access.json')
const { networkGate, isOwnNetwork, statusOf, admitSignedIn, setSuspended, isSuspended, list } = await import('../src/services/networkGate.js')
const { allowedFrom } = await import('../src/services/cloudSync.js')

const req = (ip, p = '/api/profiles', key = '') => ({ path: p, method: 'GET', headers: { host: '192.168.1.5:4000', ...(key ? { 'x-adal-pc': key } : {}) }, socket: { remoteAddress: ip } })
const run = (r) => { let code = 200, body = null; const res = { status(c) { code = c; return this }, json(b) { body = b; return this } }; let passed = false; networkGate(r, res, () => { passed = true }); return { code: passed ? 200 : code, body } }

test('the office network alone is not enough: a Companion gets in with the PC number (its key)', () => {
  for (const ip of ['192.168.1.20', '::ffff:192.168.137.4', '10.0.0.7', '172.20.1.3', '100.101.5.6']) {
    assert.equal(isOwnNetwork(req(ip)), true, ip)
    assert.equal(run(req(ip)).code, 401, ip)
    assert.equal(statusOf(req(ip)).state, 'none', ip)
  }
  const { key } = admitSignedIn(req('192.168.1.20'), 'Desk 2', 'PC number')
  assert.equal(run(req('192.168.1.20', '/api/profiles', key)).code, 200)
  assert.equal(statusOf(req('192.168.1.20', '/api/profiles', key)).state, 'approved')
})

test('a suspended Companion is cut off at once and allowed again', () => {
  const { id, key } = admitSignedIn(req('192.168.1.21'), 'Desk 3', 'PC number')
  const r = () => req('192.168.1.21', '/api/profiles', key)
  assert.equal(run(r()).code, 200)
  setSuspended(id, true)
  const out = run(r())
  assert.equal(out.code, 403)
  assert.equal(out.body.suspended, true)
  assert.equal(isSuspended(r()), true)
  assert.equal(statusOf(r()).state, 'suspended')
  assert.equal(list().find(p => p.id === id).suspended > 0, true)
  // the open calls stay open (health, the number page…)
  assert.equal(run(req('192.168.1.21', '/api/health', key)).code, 200)
  setSuspended(id, false)
  assert.equal(run(r()).code, 200)
})

test('a computer on the internet is still kept out', () => {
  for (const ip of ['41.204.3.9', '8.8.8.8', '172.32.0.1']) {
    assert.equal(isOwnNetwork(req(ip)), false, ip)
    assert.equal(run(req(ip)).code, 401, ip)
  }
})

test('through the online link a Companion may do what a phone may not, except managing devices and the main PC', () => {
  assert.equal(allowedFrom('Pixel 8 · 1/11/2026', 'POST', '/backup/run'), false)
  assert.equal(allowedFrom('Pixel 8 · 1/11/2026', 'POST', '/pc-access/devices/suspend'), false)
  assert.equal(allowedFrom('Companion · Desk 2', 'POST', '/backup/run'), true)
  assert.equal(allowedFrom('Companion · Desk 2', 'POST', '/trash/empty'), true)
  assert.equal(allowedFrom('Companion · Desk 2', 'POST', '/main-pc'), false)
  assert.equal(allowedFrom('Companion · Desk 2', 'POST', '/pc-access/devices/suspend'), false)
  assert.equal(allowedFrom('Pixel 8', 'GET', '/backup'), true)
  assert.equal(allowedFrom('Pixel 8', 'POST', '/chat/send'), true)
})
