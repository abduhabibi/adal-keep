/**
 * stages.test.js — the Profiles page's stages (asked on 2026-11-19): Waiting is
 * the WhatsApp stage, no Unfit tab (an UNFIT girl stays on Wafid), and LMIS
 * (the contract) comes after Wafid FIT until it is done, then the EPRO.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { FIRST, phaseOf } from '../../adal-keep-frontend/src/lib/phase.js'
import { shows, stagesOf } from '../../adal-keep-frontend/src/lib/stageActions.js'

test('the stage tabs: WhatsApp, LMIS, no Unfit', () => {
  const keys = FIRST.map(([k]) => k)
  assert.deepEqual(keys, ['cv', 'musaned', 'waiting', 'selected', 'wafid', 'lmis', 'epro'])
  assert.equal(FIRST.find(([k]) => k === 'waiting')[1], 'WhatsApp')
})

test('where a girl is', () => {
  assert.equal(phaseOf({}, {}), 'cv')
  assert.equal(phaseOf({ cv: 'done', musaned: 'waiting' }, {}), 'waiting')
  // UNFIT before the EPRO: on Wafid.
  assert.equal(phaseOf({ cv: 'done', musaned: 'done', selected: 'done' }, { status: 'medical_rejected' }), 'wafid')
  // FIT: LMIS until the contract is done (FMOL), then the EPRO.
  const fit = { cv: 'done', musaned: 'done', selected: 'done', wafid: 'done' }
  assert.equal(phaseOf(fit, { status: 'medical_fit' }), 'lmis')
  assert.equal(phaseOf({ ...fit, fmol: 'done' }, { status: 'medical_fit' }), 'epro')
})

test('the buttons of each stage', () => {
  assert.ok(shows('lmis_contract', 'lmis'))
  assert.ok(!shows('lmis_contract', 'cv'))
  assert.ok(shows('wafid_book', 'selected'))
  assert.ok(!stagesOf('wafid_check').includes('unfit'))
})
