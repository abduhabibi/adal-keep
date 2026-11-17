import test from 'node:test'
import assert from 'node:assert/strict'
import { stepNow, STEP_ROBOTS } from '../src/routes/automations.js'

const journey = (states) => ({ embassy: ['cv', 'musaned', 'selected', 'wafid', 'epro', 'insurance'].map(key => ({ key, title: key, state: states[key] || 'todo' })) })

test('step by step: CV, Musaned, chosen, Wafid FIT, EPRO, then the choices', () => {
  assert.equal(stepNow({}, journey({})).key, 'cv')
  assert.equal(stepNow({}, journey({ cv: 'done' })).key, 'musaned')
  assert.equal(stepNow({}, journey({ cv: 'done', musaned: 'waiting' })).key, 'selected')
  assert.equal(stepNow({}, journey({ cv: 'done', musaned: 'done', selected: 'done' })).key, 'wafid')
  assert.equal(stepNow({ status: 'medical_fit' }, journey({ cv: 'done', musaned: 'done', selected: 'done' })).key, 'epro')
  assert.equal(stepNow({ status: 'medical_fit' }, journey({ cv: 'done', musaned: 'done', selected: 'done', epro: 'done' })).key, 'choices')
})

test('the furthest step reached counts: an older profile is not sent back to its CV', () => {
  assert.equal(stepNow({}, journey({ musaned: 'done', selected: 'done' })).key, 'wafid')
})

test('an UNFIT girl stays at Wafid, marked', () => {
  const s = stepNow({ status: 'medical_rejected' }, journey({ cv: 'done', musaned: 'done', selected: 'done', wafid: 'failed' }))
  assert.deepEqual([s.key, s.unfit], ['wafid', true])
})

test('each step allows only its robots; after EPRO everything', () => {
  assert.ok(!STEP_ROBOTS.cv.includes('insurance_certificate'))
  assert.ok(STEP_ROBOTS.epro.includes('musaned_epro_approve'))
  assert.equal(STEP_ROBOTS.choices, undefined)
})
