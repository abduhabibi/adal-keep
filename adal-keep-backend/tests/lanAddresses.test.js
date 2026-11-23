// The office network only (2026-11-23): Main advertised its Tailscale address 100.89.x and a
// Companion timed out copying a photo from it. Never Tailscale / link-local; the same subnet first.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { getLanAddresses, lanOrder, lanUsable } from '../src/services/discovery.js'
import { netDown } from '../src/services/updateChannel.js'

test('Tailscale and link-local addresses are never advertised or used', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({
    Wifi: [{ address: '192.168.1.12', family: 'IPv4', internal: false, mac: 'aa:bb:cc:dd:ee:ff' }],
    Tailscale: [{ address: '100.89.50.99', family: 'IPv4', internal: false, mac: '00:00:00:00:00:00' }],
    Other: [{ address: '169.254.10.1', family: 'IPv4', internal: false, mac: '11:22:33:44:55:66' }],
  }))
  assert.deepEqual(getLanAddresses(), ['192.168.1.12'])
  assert.deepEqual(getLanAddresses({ withTailscale: true }), ['192.168.1.12', '100.89.50.99'])
  assert.equal(lanUsable('100.89.50.99'), false)
  assert.equal(lanUsable('169.254.1.1'), false)
  assert.equal(lanUsable('10.86.25.95'), true)
  assert.deepEqual(lanOrder(['100.89.50.99', '10.86.25.95', '192.168.1.3'], ['192.168.1.12']), ['192.168.1.3', '10.86.25.95'])
})

test('no route out (ENETUNREACH) is told apart from a slow line', () => {
  assert.equal(netDown(Object.assign(new Error('fetch failed'), { cause: { code: 'ENETUNREACH' } })), true)
  assert.equal(netDown(new Error('fetch failed (ENOTFOUND abc.supabase.co)')), true)
  assert.equal(netDown(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), false)
})
