/**
 * waitingStage.test.js — WhatsApp = "send her CV to agents": a girl with no CV is
 * told to make it first; once Selected she is off the WhatsApp page and carries
 * no badge for the steps before it; the tab counts equal the lists.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { phaseOf, stepMarks, needsCvFirst, inWaitingPhase } from '../../adal-keep-frontend/src/lib/phase.js'
import { inWaitingPhase as backendWaiting } from '../src/routes/automations.js'

const noCv = { cv: 'todo', musaned: 'waiting' }
const withCv = { cv: 'done', musaned: 'waiting' }

test('a CV-skipped girl on WhatsApp must make her CV first', () => {
  assert.equal(phaseOf(noCv, {}), 'waiting')
  assert.ok(needsCvFirst(noCv, {}))
  assert.deepEqual(stepMarks(noCv, {}).skipped, ['CV'])
  assert.ok(!needsCvFirst(withCv, {}))
})

test('Selected: not on WhatsApp, no earlier badges', () => {
  const sel = { cv: 'todo', musaned: 'todo', selected: 'done', wafid: 'todo' }
  assert.equal(phaseOf(sel, {}), 'selected')
  assert.ok(!inWaitingPhase(sel, {}) && !backendWaiting(sel, {}))
  assert.ok(!needsCvFirst(sel, {}))
  assert.deepEqual(stepMarks(sel, {}).skipped, [])
  // Further on: Selected itself skipped still shows, CV/Musaned never.
  const fit = { cv: 'todo', musaned: 'todo', selected: 'todo', wafid: 'done' }
  assert.deepEqual(stepMarks(fit, { status: 'medical_fit' }).skipped, ['Selected'])
})

test('counts equal the lists, and WhatsApp agrees with the backend', () => {
  const girls = [[noCv, {}], [withCv, {}], [{ cv: 'todo', musaned: 'done', selected: 'done' }, {}], [{ cv: 'done', musaned: 'done', selected: 'done', wafid: 'todo' }, {}]]
  const counts = {}
  for (const [s, p] of girls) { const k = phaseOf(s, p); counts[k] = (counts[k] || 0) + 1 }
  assert.equal(counts.waiting, 2)
  assert.equal(counts.selected, 2)
  for (const [s, p] of girls) assert.equal(phaseOf(s, p) === 'waiting', backendWaiting(s, p))
})

test('the status track: before Selected is done, never open or red', async () => {
  const { journeyOf } = await import('../src/routes/automations.js')
  const j = journeyOf({ chosen_at: '2026-11-01', musaned_stage: 'EPRO APPROVAL' }, {}, false)
  const st = Object.fromEntries(j.embassy.map(s => [s.key, s.state]))
  assert.equal(st.cv, 'done'); assert.equal(st.musaned, 'done'); assert.equal(st.selected, 'done')
  const w = journeyOf({}, {}, false)
  assert.equal(w.embassy.find(s => s.key === 'cv').state, 'todo')
})
