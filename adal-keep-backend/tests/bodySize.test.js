import test from 'node:test'
import assert from 'node:assert/strict'
import { heightFor, weightFor, withBodySize, unset } from '../src/services/bodySize.js'

test('height 155.0–165.0 and weight 55.0–65.0 with one decimal, the same for the same girl, typed values kept', () => {
  const hs = new Set(), ws = new Set()
  for (let i = 0; i < 2000; i++) {
    const p = { passport_number: `EP${1000000 + i}` }
    const h = heightFor(p), w = weightFor(p)
    assert.match(h, /^\d{3}\.\d$/); assert.match(w, /^\d{2}\.\d$/)
    assert.ok(+h >= 155 && +h <= 165, h); assert.ok(+w >= 55 && +w <= 65, w)
    hs.add(h); ws.add(w)
  }
  assert.ok(hs.size > 80 && ws.size > 80)                                   // spread over the range, not one number
  assert.equal(heightFor({ passport_number: 'EP1' }), heightFor({ passport_number: 'ep1' }))
  assert.deepEqual(withBodySize({ passport_number: 'EP1', height: '160', weight: 'Normal' }).height, '160')
  assert.notEqual(withBodySize({ passport_number: 'EP1', weight: 'Normal' }).weight, 'Normal')
  assert.ok(unset('Normal') && unset('') && unset(null) && unset('--') && !unset('58'))
})
