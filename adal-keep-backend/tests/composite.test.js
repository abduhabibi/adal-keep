import test from 'node:test'
import assert from 'node:assert/strict'
import { pickParts, apart, insideOf } from '../src/services/composite.js'

// The boxes JEV gave for a real combined picture (passport | photo | standing photo).
const real = { passport: { left: .01, top: .03, right: .55, bottom: .98, confidence: .46 }, photo: { left: .54, top: .03, right: .66, bottom: .25, confidence: .67 }, fullbody: { left: .62, top: .04, right: .87, bottom: .97, confidence: .73 } }

test('a combined picture gives its three parts, and no part shows a piece of another', () => {
  const p = pickParts(real, 950, 625)
  assert.ok(p.passport && p.photo && p.fullbody)
  const cut = apart(p)
  assert.ok(cut.fullbody.left >= real.photo.right, 'the standing photo starts after the head photo')
  assert.ok(cut.passport.right <= real.photo.left, 'the passport ends before the head photo')
  assert.ok(cut.photo.left <= real.photo.left && cut.photo.right >= real.photo.right, 'the small photo keeps all of itself')
})

test('a single passport (its printed photo inside it) is not split', () => {
  const one = { passport: { left: 0, top: 0, right: 1, bottom: 1, confidence: .9 }, photo: { left: .05, top: .5, right: .3, bottom: .9, confidence: .8 }, fullbody: null }
  assert.equal(pickParts(one, 1400, 1000), null)
})

test('a wide "full body" box is not a standing photo; a photo inside the standing one is not its own', () => {
  const p = pickParts({ passport: real.passport, photo: { left: .7, top: .05, right: .8, bottom: .2, confidence: .7 }, fullbody: { left: .6, top: .0, right: 1, bottom: .3, confidence: .7 } }, 1000, 600)
  assert.equal(p.fullbody, null)
  assert.ok(insideOf({ left: .7, top: .1, right: .8, bottom: .2 }, { left: .6, top: 0, right: .9, bottom: 1 }) > 0.9)
})
