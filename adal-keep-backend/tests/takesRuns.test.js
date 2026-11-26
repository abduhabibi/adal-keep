/** takesRuns.test.js — no run goes to an old Companion (no /robot/now) or to a PC over 80 % busy (2026-11-26). */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseBest, takesRuns } from '../src/services/sharePower.js'

const main = { id: '', name: 'Main', cores: 2, mem_gb: 8, free_gb: 2, load: 89 }
const pc = (o) => ({ id: 'u5', name: 'DESKTOP-U5UO9NM', cores: 8, mem_gb: 16, free_gb: 8, lan: true, answers: true, at: Date.now(), ...o })

test('an old Companion and a busy PC get no run; a free new one does', () => {
  assert.equal(chooseBest({ from: '', pcs: [main, pc({ answers: false })] }).help, false)
  assert.equal(chooseBest({ from: '', pcs: [main, pc({ load: 82 })] }).help, false)
  const c = chooseBest({ from: '', pcs: [main, pc({ load: 20 })] })
  assert.equal(c.help, true); assert.equal(c.to, 'u5')
})

test('off switches: ADAL_OLD_COMPANIONS=1, ADAL_BUSY_PC', () => {
  assert.equal(takesRuns(pc({ answers: false }), { ADAL_OLD_COMPANIONS: '1' }), true)
  assert.equal(takesRuns(pc({ load: 82 }), { ADAL_BUSY_PC: '90' }), true)
  assert.equal(takesRuns(main), true)
})
