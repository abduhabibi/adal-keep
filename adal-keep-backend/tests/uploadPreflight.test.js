/**
 * uploadPreflight.test.js — the gate that stops a half-submitted police
 * certificate.
 *
 * `stepUploadDocuments()` submits the payment slip to LMIS before it touches
 * the passport. So any file problem discovered later leaves LMIS holding a
 * partial request, and each retry re-uploads the slip. The pre-flight check
 * makes the workflow refuse to start instead.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  preflightUploads,
  SLIP_MAX_MB,
  PASSPORT_MAX_MB,
  PHOTO_MAX_MB,
} from '../src/services/uploadPreflight.js'

const MB = 1024 * 1024

let tmpDir
test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-preflight-'))
})
test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** Create a file of `mb` megabytes and return its path. */
function makeFile(name, mb) {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, Buffer.alloc(Math.round(mb * MB), 1))
  return p
}

function makeCtx(overrides = {}) {
  return {
    slipPath: makeFile('slip.pdf', 0.5),
    passportPath: makeFile('passport.pdf', 1.1),
    photoPath: makeFile('photo.png', 0.07),
    ...overrides,
  }
}

test('passes when every file exists and fits the LMIS limits', () => {
  const res = preflightUploads(makeCtx())
  assert.equal(res.ok, true)
  assert.deepEqual(res.problems, [])
})

test('reports a missing file', () => {
  const ctx = makeCtx({ passportPath: path.join(tmpDir, 'nope.pdf') })
  const res = preflightUploads(ctx)
  assert.equal(res.ok, false)
  assert.equal(res.problems.length, 1)
  assert.match(res.problems[0], /Passport: file missing on disk/)
})

test('reports a missing slot (no path at all)', () => {
  const res = preflightUploads({ slipPath: null, passportPath: null, photoPath: null })
  assert.equal(res.ok, false)
  assert.equal(res.problems.length, 3)
  assert.ok(res.problems.every(p => /no file attached/.test(p)))
})

test('rejects a passport over the 2MB LMIS limit', () => {
  const ctx = makeCtx({ passportPath: makeFile('big-passport.pdf', PASSPORT_MAX_MB + 0.5) })
  const res = preflightUploads(ctx)
  assert.equal(res.ok, false)
  assert.match(res.problems.join(' '), /Passport: 2\.50MB exceeds LMIS 2MB limit/)
})

test('rejects a photo over the 2MB LMIS limit', () => {
  const ctx = makeCtx({ photoPath: makeFile('big-photo.png', PHOTO_MAX_MB + 1) })
  const res = preflightUploads(ctx)
  assert.equal(res.ok, false)
  assert.match(res.problems.join(' '), /Photo: 3\.00MB exceeds LMIS 2MB limit/)
})

test('rejects a slip over the 5MB LMIS limit', () => {
  const ctx = makeCtx({ slipPath: makeFile('big-slip.pdf', SLIP_MAX_MB + 1) })
  const res = preflightUploads(ctx)
  assert.equal(res.ok, false)
  assert.match(res.problems.join(' '), /Payment slip: 6\.00MB exceeds LMIS 5MB limit/)
})

test('a file exactly at the limit is allowed', () => {
  const ctx = makeCtx({ passportPath: makeFile('exact.pdf', PASSPORT_MAX_MB) })
  const res = preflightUploads(ctx)
  assert.equal(res.ok, true, 'the limit is inclusive')
})

test('rejects an empty file', () => {
  const ctx = makeCtx({ photoPath: makeFile('empty.png', 0) })
  const res = preflightUploads(ctx)
  assert.equal(res.ok, false)
  assert.match(res.problems.join(' '), /Photo: file is empty/)
})

test('collects EVERY problem rather than stopping at the first', () => {
  const ctx = {
    slipPath: null,
    passportPath: makeFile('oversize.pdf', PASSPORT_MAX_MB + 1),
    photoPath: path.join(tmpDir, 'gone.png'),
  }
  const res = preflightUploads(ctx)
  assert.equal(res.ok, false)
  assert.equal(res.problems.length, 3)
})

test('handles a null ctx without throwing', () => {
  const res = preflightUploads(null)
  assert.equal(res.ok, false)
  assert.equal(res.problems.length, 3)
})
