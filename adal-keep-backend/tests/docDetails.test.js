import test from 'node:test'
import assert from 'node:assert/strict'
import { _test } from '../src/services/docDetails.js'

const { clean, fromText } = _test

test('values read from a document are cleaned by their kind', () => {
  assert.equal(clean('date', '22 NOV 99'), '1999-11-22')
  assert.equal(clean('date', '1999-11-22'), '1999-11-22')
  assert.equal(clean('date', 'not a date'), null)
  assert.equal(clean('passport', 'EQ 1857942'), 'EQ1857942')
  assert.equal(clean('phone', '0912 345 678'), '0912345678')
  assert.equal(clean('int', '160 cm'), '160')
  // a visa / contract / ID number is a number, never a date or a word
  assert.equal(clean('digits', '6012345678'), '6012345678')
  assert.equal(clean('digits', '12/05/2026'), null)
  assert.equal(clean('digits', 'SPONSOR'), null)
  assert.equal(clean('digits', 'E 123456789'), '123456789')
  assert.equal(clean('digits', 'E123456789'), 'E123456789')
})

test('"Label: value" on the page, only at the start of a line or cell', () => {
  const text = 'Full Name: ERE HIMA TURUNEH\nFather name: MUHAMED ALI\nDate of Birth: 22/11/1999\n| Passport No | EQ1857942 |'
  assert.equal(fromText(text, ['full name', 'name'], 'name'), 'ERE HIMA TURUNEH')
  assert.equal(fromText('Father name: MUHAMED ALI', ['name'], 'name'), null)
  assert.equal(fromText(text, ['date of birth'], 'date'), '1999-11-22')
  assert.equal(fromText(text, ['passport no'], 'passport'), 'EQ1857942')
})
