import test from 'node:test'
import assert from 'node:assert/strict'
import { decide, watched } from '../src/services/placement.js'

test('a head photo put into Passport moves to Photo; a standing one to Full Body Photo', () => {
  assert.deepEqual(decide('Passport', { choice: 'photo', confidence: 0.9 }), { act: 'move', to: 'Photo' })
  assert.deepEqual(decide('Passport', { choice: 'fullbody', confidence: 0.8 }), { act: 'move', to: 'Full Body Photo' })
})

test('nothing ever moves out of Photo or Full Body Photo (a face cut from the passport looks like a passport)', () => {
  assert.equal(decide('Photo', { choice: 'passport', confidence: 0.99 }).act, 'stay')
  assert.equal(decide('Photo', { choice: 'fullbody', confidence: 0.9 }).act, 'stay')
  assert.equal(decide('Full Body Photo', { choice: 'photo', confidence: 0.9 }).act, 'stay')
})

test('the right box, an unsure answer or something else: it stays', () => {
  assert.equal(decide('Passport', { choice: 'passport', confidence: 0.99 }).act, 'stay')
  assert.equal(decide('Passport', { choice: 'photo', confidence: 0.5 }).act, 'stay')
  assert.equal(decide('Photo', { choice: 'other', confidence: 0.99 }).act, 'stay')
  assert.equal(decide('Photo', null).act, 'stay')
})

test('several things in one picture are split; only the three picture boxes are watched', () => {
  assert.equal(decide('Passport', { choice: 'several', confidence: 0.8 }).act, 'split')
  assert.ok(watched('Passport') && watched('Photo') && watched('Full Body Photo'))
  assert.ok(!watched('Contract') && !watched('CV'))
})
