/**
 * domSelect.test.js — unit tests for the pure DOM-selection logic.
 *
 * These cover the mistakes that made the police-clearance workflow attach the
 * wrong file. The central regression is "document order": scanning
 * `querySelectorAll('*')` and taking the first element containing the modal
 * title returns an ANCESTOR (body / #root), never the dialog.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  area,
  isUsableDialog,
  pickBestDialog,
  scoreFileInput,
  pickFileInput,
  confirmsUpload,
  pickOption,
} from '../src/services/domSelect.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const rect = (width, height) => ({ width, height, top: 0, left: 0 })

/** A page-level container — the thing the old locator mistook for a modal. */
const pageContainer = (idx, text) => ({
  idx,
  tag: 'BODY',
  text,
  rect: rect(1280, 800),
  zIndex: 0,
  visible: true,
  isDialog: false,
  hasControl: true,
  fullViewport: true,
})

/** A real Bootstrap/Radix style modal. */
const dialog = (idx, text, { w = 600, h = 500, z = 1050, hasControl = true } = {}) => ({
  idx,
  tag: 'DIV',
  text,
  rect: rect(w, h),
  zIndex: z,
  visible: true,
  isDialog: true,
  hasControl,
  fullViewport: false,
})

// ---------------------------------------------------------------------------
// area / isUsableDialog
// ---------------------------------------------------------------------------

test('area returns 0 for degenerate rects', () => {
  assert.equal(area(null), 0)
  assert.equal(area(rect(0, 500)), 0)
  assert.equal(area(rect(500, 0)), 0)
  assert.equal(area(rect(10, 20)), 200)
})

test('isUsableDialog rejects page-level containers and invisible elements', () => {
  assert.equal(isUsableDialog(pageContainer(0, 'Upload Passport Document')), false)
  assert.equal(isUsableDialog({ ...dialog(1, 'x'), visible: false }), false)
  assert.equal(isUsableDialog({ ...dialog(2, 'x'), rect: rect(10, 10) }), false)
  assert.equal(isUsableDialog(dialog(3, 'x')), true)
})

// ---------------------------------------------------------------------------
// pickBestDialog — the core regression
// ---------------------------------------------------------------------------

test('REGRESSION: the page container must never win over the real dialog', () => {
  // Exactly the DOM shape from the LMIS police-certificate screen: <body>
  // matches the title text and comes FIRST in document order.
  const candidates = [
    pageContainer(0, 'Upload Passport Document Passport Number ...'),
    dialog(1, 'Upload Passport Document Passport Number ...'),
  ]

  const chosen = pickBestDialog(candidates, 'Upload Passport Document')

  // The old implementation took candidates[0] (the body) and then handed back
  // the first file input on the page — the Payment Slip slot.
  assert.equal(chosen, 1, 'must pick the dialog, not the document body')
})

test('prefers the real dialog even when nested ancestors are present', () => {
  const candidates = [
    pageContainer(0, 'Upload Passport Document'),
    { ...pageContainer(1, 'Upload Passport Document'), fullViewport: false, isDialog: false },
    dialog(2, 'Upload Passport Document', { w: 900, h: 700 }),
    dialog(3, 'Upload Passport Document', { w: 300, h: 200 }),
  ]
  // Pass 1 (isDialog) → smallest of the two dialogs.
  assert.equal(pickBestDialog(candidates, 'Upload Passport Document'), 3)
})

test('breaks area ties by higher z-index (topmost dialog wins)', () => {
  const candidates = [
    dialog(0, 'Upload Photo', { z: 100 }),
    dialog(1, 'Upload Photo', { z: 900 }),
  ]
  assert.equal(pickBestDialog(candidates, 'Upload Photo'), 1)
})

test('ignores dialogs that do not contain the title', () => {
  const candidates = [
    dialog(0, 'Upload Police Certificate Payment Slip'),
    dialog(1, 'Upload Passport Document'),
  ]
  assert.equal(pickBestDialog(candidates, 'Upload Passport Document'), 1)
  assert.equal(pickBestDialog(candidates, 'Upload Photo'), -1)
})

test('requireControl skips a wrapper that has no form control', () => {
  const candidates = [
    dialog(0, 'Upload Passport Document', { hasControl: false, w: 200, h: 150 }),
    dialog(1, 'Upload Passport Document', { hasControl: true }),
  ]
  assert.equal(pickBestDialog(candidates, 'Upload Passport Document', { requireControl: true }), 1)
})

test('returns -1 when nothing matches', () => {
  assert.equal(pickBestDialog([], 'Upload Passport Document'), -1)
  assert.equal(pickBestDialog(null, 'Upload Passport Document'), -1)
})

// ---------------------------------------------------------------------------
// file input selection
// ---------------------------------------------------------------------------

test('picks the input whose accept matches the file extension', () => {
  const inputs = [
    { idx: 0, accept: 'application/pdf', visible: true, rect: rect(300, 120) },
    { idx: 1, accept: 'image/*', visible: true, rect: rect(300, 120) },
  ]
  assert.equal(pickFileInput(inputs, '/tmp/passport.jpg'), 1)
  assert.equal(pickFileInput(inputs, '/tmp/slip.pdf'), 0)
})

test('wildcard accept is usable but loses to an explicit match', () => {
  const inputs = [
    { idx: 0, accept: '', visible: true, rect: rect(10, 10) },
    { idx: 1, accept: 'image/png', visible: true, rect: rect(10, 10) },
  ]
  assert.equal(pickFileInput(inputs, '/tmp/photo.png'), 1)
})

test('hidden (display:none) file inputs are still selectable', () => {
  // FilePond renders a 0x0 input behind a "Browse" label. Visibility must not
  // veto the choice — the caller already scoped the search to the dialog.
  const inputs = [
    { idx: 0, accept: 'application/pdf', visible: false, rect: rect(0, 0) },
  ]
  assert.equal(pickFileInput(inputs, '/tmp/passport.pdf'), 0)
})

test('falls back to the first input when no accept attribute matches', () => {
  const inputs = [
    { idx: 0, accept: 'image/png', visible: true, rect: rect(10, 10) },
    { idx: 1, accept: 'image/gif', visible: true, rect: rect(10, 10) },
  ]
  // A PDF matches neither, but inside one dialog we still must upload.
  assert.equal(pickFileInput(inputs, '/tmp/passport.pdf'), 0)
})

test('pickFileInput returns -1 for an empty list', () => {
  assert.equal(pickFileInput([], '/tmp/passport.pdf'), -1)
})

test('scoreFileInput ranks explicit ext > mime > wildcard', () => {
  const pdf = '/tmp/x.pdf'
  assert.ok(scoreFileInput({ idx: 0, accept: '.pdf', rect: rect(9, 9), visible: true }, pdf) >
            scoreFileInput({ idx: 1, accept: 'application/pdf', rect: rect(9, 9), visible: true }, pdf))
  assert.ok(scoreFileInput({ idx: 1, accept: 'application/pdf', rect: rect(9, 9), visible: true }, pdf) >
            scoreFileInput({ idx: 2, accept: '', rect: rect(9, 9), visible: true }, pdf))
})

// ---------------------------------------------------------------------------
// upload read-back
// ---------------------------------------------------------------------------

test('confirmsUpload accepts the Upload Complete marker', () => {
  assert.equal(confirmsUpload('Some text Upload Complete', 'passport.pdf').ok, true)
  assert.equal(confirmsUpload('Tap to undo', 'passport.pdf').ok, true)
})

test('confirmsUpload matches the filename even when separators are mangled', () => {
  assert.equal(confirmsUpload('File: passport.png 1.2 MB', 'passport.png').ok, true)
  assert.equal(confirmsUpload('passport_png', 'passport.png').ok, true)
})

test('confirmsUpload rejects a file that is not present', () => {
  const res = confirmsUpload('Upload something here', 'passport.pdf')
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'filename-not-found')
})

test('confirmsUpload does not accept a DIFFERENT file', () => {
  // The wrong-slot symptom: slip uploaded where the passport should be.
  assert.equal(confirmsUpload('CBEBirr_Receipt.pdf uploaded', 'passport.pdf').ok, false)
})

// ---------------------------------------------------------------------------
// dropdown options
// ---------------------------------------------------------------------------

test('pickOption prefers exact, then prefix, then substring', () => {
  const options = [
    { idx: 0, text: 'Saudi Arabia' },
    { idx: 1, text: 'Kuwait' },
    { idx: 2, text: 'Kuwait City' },
  ]
  assert.equal(pickOption(options, 'Kuwait'), 1, 'exact match wins')
  assert.equal(pickOption(options, 'kuwait'), 1, 'case-insensitive')
  assert.equal(pickOption(options, 'Kuw'), 1, 'prefix match')
})

test('pickOption returns -1 when nothing matches', () => {
  assert.equal(pickOption([{ idx: 0, text: 'Saudi Arabia' }], 'Kuwait'), -1)
  assert.equal(pickOption([], 'Kuwait'), -1)
  assert.equal(pickOption([{ idx: 0, text: 'Kuwait' }], ''), -1)
})
