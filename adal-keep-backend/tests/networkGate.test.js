import test from 'node:test'
import assert from 'node:assert/strict'
import { networkGate, isOwnNetwork, statusOf } from '../src/services/networkGate.js'

const req = (ip, path = '/api/profiles') => ({ path, method: 'GET', headers: { host: '192.168.1.5:4000' }, socket: { remoteAddress: ip } })
const run = (r) => { let code = 200; const res = { status(c) { code = c; return this }, json() { return this } }; let passed = false; networkGate(r, res, () => { passed = true }); return passed ? 200 : code }

test('a computer on the office network, the hotspot or Tailscale is in at once — no approval, no number', () => {
  for (const ip of ['192.168.1.20', '::ffff:192.168.137.4', '10.0.0.7', '172.20.1.3', '100.101.5.6']) {
    assert.equal(isOwnNetwork(req(ip)), true, ip)
    assert.equal(run(req(ip)), 200, ip)
    assert.equal(statusOf(req(ip)).state, 'approved', ip)
  }
})

test('a computer on the internet is still kept out', () => {
  for (const ip of ['41.204.3.9', '8.8.8.8', '172.32.0.1']) {
    assert.equal(isOwnNetwork(req(ip)), false, ip)
    assert.equal(run(req(ip)), 401, ip)
  }
})
