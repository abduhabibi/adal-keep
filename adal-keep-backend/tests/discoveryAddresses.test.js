import test from 'node:test'
import assert from 'node:assert/strict'
import { advertisedAddresses, isCgnat } from '../src/services/discovery.js'

test('discovery reply: LAN addresses only, the asker\'s network first, never Tailscale', () => {
  assert.equal(isCgnat('100.89.50.99'), true)
  assert.equal(isCgnat('100.10.1.1'), false)
  assert.deepEqual(advertisedAddresses('192.168.1.20', ['100.89.50.99', '10.0.0.4', '192.168.1.5']), ['192.168.1.5', '10.0.0.4'])
  assert.deepEqual(advertisedAddresses('', ['100.89.50.99', '169.254.3.3']), [])
})
