import test from 'node:test'
import assert from 'node:assert/strict'

const DAY = 86400000

test('suspend: a licence that is not suspended is signed exactly as before', async () => {
  const { signedPart, canonical } = await import('../src/services/plans.js')
  const l = { pc: '123455', plan: 'basic', paid_until: 5, at: '2026-11-19T00:00:00.000Z' }
  assert.equal('suspended' in signedPart(l), false)
  assert.equal(canonical(signedPart({ ...l, suspended: null })), canonical(signedPart(l)))
  const s = signedPart({ ...l, suspended: { at: '2026-11-19T01:00:00.000Z', note: 'call Adal' } })
  assert.deepEqual(s.suspended, { at: '2026-11-19T01:00:00.000Z', note: 'call Adal' })
})

test('suspend: a suspended PC is locked whatever it paid, and opens again when allowed', async () => {
  const P = await import('../src/services/plans.js')
  const S = await import('../src/services/subscription.js')
  const now = Date.now()
  const paid = { installation_date: now - 99 * DAY, paid_until: now + 30 * DAY, paid_proof: S.paidProof(S.pcNumber(), now + 30 * DAY) }
  assert.equal(S.computeMode(paid), 'active')
  P.__setLicenseForTest({ pc: S.pcNumber(), plan: 'premium', paid_until: now + 99 * DAY, suspended: { at: new Date().toISOString(), note: 'unpaid' } })
  assert.equal(S.computeMode(paid), 'locked')
  const st = S.statusPayload(paid)
  assert.equal(st.mode, 'locked')
  assert.equal(st.suspended, true)
  assert.equal(st.suspendNote, 'unpaid')
  assert.equal(P.planPayload().suspended, true)
  P.__setLicenseForTest({ pc: S.pcNumber(), plan: 'premium', paid_until: now + 99 * DAY })
  assert.equal(S.computeMode(paid), 'active')
  assert.equal(S.statusPayload(paid).suspended, false)
  P.__setLicenseForTest(null)
})
