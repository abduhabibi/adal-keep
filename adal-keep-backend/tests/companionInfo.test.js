// /api/companion/info is asked by every Companion while it looks for its main PC: it must answer at once
// even when the database is starved (2026-11-22: ~13 s on a swamped PC).
import test from 'node:test'
import assert from 'node:assert/strict'

const { _companyName } = await import('../src/routes/verification.js')

test('the company name comes from the database, kept for when it is slow', async () => {
  assert.equal(await _companyName(() => ({ first: async () => ({ name: 'Nuzla' }) })), 'Nuzla')
  const t0 = Date.now()
  const stuck = () => ({ first: () => new Promise(() => {}) })   // the connection never comes
  assert.equal(await _companyName(stuck), 'Nuzla', 'the last name known answers')
  assert.ok(Date.now() - t0 < 1500, 'did not wait for the database')
  assert.equal(await _companyName(() => ({ first: async () => { throw new Error('locked') } })), 'Nuzla')
})
