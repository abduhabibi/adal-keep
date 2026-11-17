// The phone reads passports itself (frontend src/lib/passportHere.js): its MRZ
// rules are a copy of the PC's (src/services/mrz.js) and must stay the same.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'

const copy = new URL('../../adal-keep-frontend/src/lib/mrz.js', import.meta.url)
const text = new URL('../../adal-keep-frontend/src/lib/passportText.js', import.meta.url)
const there = fs.existsSync(copy) && fs.existsSync(text)
const norm = (s) => s.replace(/\r\n/g, '\n')

test('the phone\'s MRZ rules are the PC\'s', { skip: !there && 'frontend not here' }, () => {
  assert.equal(norm(fs.readFileSync(copy, 'utf8')), norm(fs.readFileSync(new URL('../src/services/mrz.js', import.meta.url), 'utf8')))
})

test('the phone takes only verified bottom lines, and finds the place under its label', { skip: !there && 'frontend not here' }, async () => {
  const T = await import(text)
  // The ICAO sample passport (Utopia, ERIKSSON ANNA MARIA).
  const l1 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<'
  const l2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'
  const m = T.mrzIn(`noise line here\n${l1}\n${l2}`)
  assert.ok(m)
  const f = T.fieldsOf(m)
  assert.equal(f.passport_number, 'L898902C3')
  assert.equal(f.first_name, 'ANNA'); assert.equal(f.middle_name, 'MARIA'); assert.equal(f.last_name, 'ERIKSSON')
  assert.equal(f.date_of_birth, '1974-08-12')
  assert.equal(T.mrzIn(`${l1}\n${l2.replace('7408122', '7408123')}`), null)
  const box = (x0, y0) => ({ x0, y0, x1: x0 + 300, y1: y0 + 30 })
  assert.equal(T.placeFromLines([
    { text: 'Date of Birth 12 AUG 74', bbox: box(400, 10) },
    { text: 'Place of Birth', bbox: box(400, 60) },
    { text: 'ADDIS ABABA ETH', bbox: box(410, 100) },
  ]), 'ADDIS ABABA')
  assert.equal(T.placeFromLines([{ text: 'nothing', bbox: box(0, 0) }]), '')
})
