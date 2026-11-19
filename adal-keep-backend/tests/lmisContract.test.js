/**
 * lmisContract.test.js — the LMIS contract robot (asked on 2026-11-19).
 *
 * The job order of the Saudi office that chose her is picked (two equally good
 * ones: a person chooses), and a job order with fewer than 50 places left is
 * reported to the agency once, never on every run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { pickJobOrder, warnLowRemaining, LOW_REMAINING } from '../src/services/lmisContract.js'
import { WORKFLOWS } from '../src/services/workflows.js'

const ORDERS = [
  'JOB0000011129 - Essam Alahmadi Recruitment Office',
  'JOB0000011244 - TAWSSUT FOR RECRUITMENT',
  'JOB0000101949 - Essam Alahmadi Recruitment Office',
]

test('the job order of her Musaned office; two equal ones are left for a person', () => {
  assert.equal(pickJobOrder(ORDERS, 'Tawssut for recruitment'), ORDERS[1])
  assert.equal(pickJobOrder(ORDERS, 'Essam Alahmadi Recruitment Office'), null) // two of them
  assert.equal(pickJobOrder(ORDERS, ''), null)
  assert.equal(pickJobOrder(ORDERS, 'Some Other Office'), null)
})

/** A tiny stand-in for knex's settings table. */
function fakeDb() {
  const rows = new Map()
  const db = (table) => {
    assert.equal(table, 'settings')
    return {
      where: (_k, key) => ({ first: async () => (rows.has(key) ? { key, value: rows.get(key) } : undefined) }),
      insert: async ({ key, value }) => { rows.set(key, value) },
    }
  }
  return { db, rows }
}

test('fewer than 50 places left: the agency is told once per job order', async () => {
  const { db, rows } = fakeDb()
  const told = []
  const ctx = { db, notify: async (title) => told.push(title), log: () => {} }

  assert.equal(await warnLowRemaining(ctx, ORDERS[1], LOW_REMAINING), false) // 50 is not under 50
  assert.equal(await warnLowRemaining(ctx, ORDERS[1], 49), true)
  assert.equal(await warnLowRemaining(ctx, ORDERS[1], 12), false) // already told
  assert.equal(await warnLowRemaining(ctx, ORDERS[0], 3), true) // another job order
  assert.equal(told.length, 2)
  assert.ok(rows.has('lmis_low_remaining_JOB0000011244'))
  assert.match(told[0], /49 left/)
})

test('the LMIS contract robot is listed, so its button shows on the profile', () => {
  assert.equal(WORKFLOWS.lmis_contract?.id, 'lmis_contract')
  assert.match(WORKFLOWS.lmis_contract.target, /contract-process\/placed-labors/)
})
