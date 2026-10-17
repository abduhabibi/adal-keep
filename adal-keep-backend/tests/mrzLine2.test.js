/**
 * mrzLine2.test.js — OCR reads one "<" filler too many or too few in MRZ
 * line 2. The two final check digits must stay at the end, or a clear
 * passport is rejected as "unreadable" (the new "PQ" Ethiopian passports
 * with an empty personal number were). Made-up data only.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTD3, fitLine2 } from '../src/services/mrz.js'

const W = [7, 3, 1]
const val = (c) => (c === '<' ? 0 : /\d/.test(c) ? +c : c.charCodeAt(0) - 55)
const cd = (s) => String([...s].reduce((t, c, i) => t + val(c) * W[i % 3], 0) % 10)

// A valid line 2: number, birth date, expiry, personal number "0", checks.
const pno = 'EX1234567', dob = '950317', exp = '310805', per = '0'.padEnd(14, '<')
const head = pno + cd(pno) + 'ETH' + dob + cd(dob) + 'F' + exp + cd(exp)
const perCd = cd(per)
const LINE2 = head + per + perCd + cd(head.slice(0, 10) + head.slice(13, 20) + head.slice(21) + per + perCd)
const LINE1 = 'PQETHABEBE<<SARA<KEBEDE'.padEnd(44, '<')

test('a correct line 2 verifies', () => {
  assert.equal(LINE2.length, 44)
  assert.equal(parseTD3(`${LINE1}\n${LINE2}`).overall_verified, true)
})

test('one filler too many (45 chars) still verifies', () => {
  const ocr = LINE2.slice(0, 29) + '<' + LINE2.slice(29)
  assert.equal(ocr.length, 45)
  assert.equal(fitLine2(ocr), LINE2)
  const r = parseTD3(`${LINE1}\n${ocr}`)
  assert.equal(r.overall_verified, true)
  assert.equal(r.passport_number, 'EX1234567')
  assert.equal(r.given_names, 'SARA KEBEDE')
})

test('one filler too few (43 chars) still verifies', () => {
  const ocr = LINE2.slice(0, 30) + LINE2.slice(31)
  assert.equal(ocr.length, 43)
  assert.equal(parseTD3(`${LINE1}\n${ocr}`).overall_verified, true)
})

test('a wrong digit is still rejected', () => {
  const bad = LINE2.slice(0, 43) + String((+LINE2[43] + 1) % 10)
  assert.equal(parseTD3(`${LINE1}\n${bad}`).overall_verified, false)
  const badLong = bad.slice(0, 29) + '<' + bad.slice(29)
  assert.equal(parseTD3(`${LINE1}\n${badLong}`).overall_verified, false)
})
