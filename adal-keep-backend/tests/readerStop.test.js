// Stopping an OCR reader never strands a read: queued reads finish first, a read after the stop starts a new worker,
// and a filed passport's background work can be waited for (the leak seen at the end of passportOnly.test.js).
import test from 'node:test'
import assert from 'node:assert/strict'

const SAMPLE = new URL('./fixtures/sample-passport.jpg', import.meta.url).pathname
const Q = await import('../src/services/quickMrz.js')
const V = await import('../src/services/passportVisual.js')
const unhandled = []
process.on('unhandledRejection', (e) => unhandled.push(e))

test('the bottom-lines reader: stop with reads waiting → all of them finish; a read afterwards works', async () => {
  const reads = [Q.quickMrz(SAMPLE), Q.quickMrz(SAMPLE), Q.quickMrz(SAMPLE)]
  const stopped = Q.stopMrzReader()                    // asked while the reads are still queued
  const got = await Promise.all(reads)
  await stopped
  assert.deepEqual(got.map(r => r?.fields?.passport_number), ['L898902C3', 'L898902C3', 'L898902C3'])
  const again = await Q.quickMrz(SAMPLE)               // a new worker is started by itself
  assert.equal(again?.fields?.passport_number, 'L898902C3')
  await Q.stopMrzReader(); await Q.stopMrzReader()     // stopping twice, or when nothing runs, is fine
})

test('the page reader: the same', async () => {
  const q = { turn: 0, fields: { date_of_birth: '1974-08-12', date_of_expiry: '2012-04-15' } }
  const reads = [V.readVisual(SAMPLE, q), V.readVisual(SAMPLE, q)]
  const stopped = V.stopVisualReader()
  const got = await Promise.all(reads)
  await stopped
  assert.deepEqual(got.map(r => r?.place_of_birth), ['ADDIS ABABA', 'ADDIS ABABA'])
  assert.equal((await V.readVisual(SAMPLE, q))?.date_of_issue, '2007-04-16')
  await V.stopVisualReader()
})

test('nothing was left unhandled', async () => {
  await new Promise(r => setTimeout(r, 300))
  assert.deepEqual(unhandled.map(e => String(e?.message || e)), [])
})
