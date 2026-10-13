/**
 * domPaste.test.js — regression tests for the text-injection API mismatch.
 *
 * THE BUG THIS GUARDS
 * -------------------
 * `setReactSelect()` called `page.keyboard.insertText(...)`. That is a
 * Playwright-only API; this project drives Chromium through **puppeteer-core**,
 * whose Keyboard exposes `sendCharacter()` instead. Every police-clearance run
 * therefore died with:
 *
 *     TypeError: page.keyboard.insertText is not a function
 *
 * and it died at "Destination Country" — the FIRST field of the passport
 * modal — *after* the payment slip had already been submitted to LMIS.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { insertTextCompat } from '../src/services/domPaste.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Build a fake page whose keyboard implements only the listed methods, so we
 * can simulate either driver.
 */
function fakePage(methods) {
  const calls = []
  const keyboard = {}
  if (methods.includes('sendCharacter')) {
    keyboard.sendCharacter = async (ch) => { calls.push(['sendCharacter', ch]) }
  }
  if (methods.includes('insertText')) {
    keyboard.insertText = async (t) => { calls.push(['insertText', t]) }
  }
  if (methods.includes('type')) {
    keyboard.type = async (t) => { calls.push(['type', t]) }
  }
  return { page: { keyboard }, calls }
}

// ---------------------------------------------------------------------------
// driver compatibility
// ---------------------------------------------------------------------------

test('REGRESSION: works on a Puppeteer page (sendCharacter, no insertText)', async () => {
  const { page, calls } = fakePage(['sendCharacter'])

  // The old implementation called page.keyboard.insertText() unconditionally,
  // which threw exactly here.
  const ok = await insertTextCompat(page, 'Kuwait')

  assert.equal(ok, true, 'must not fail on a Puppeteer page')
  assert.deepEqual(
    calls.map(c => c[0]),
    ['sendCharacter', 'sendCharacter', 'sendCharacter', 'sendCharacter', 'sendCharacter', 'sendCharacter'],
    'one sendCharacter per character'
  )
  assert.equal(calls.map(c => c[1]).join(''), 'Kuwait')
})

test('works on a Playwright page (insertText, no sendCharacter)', async () => {
  const { page, calls } = fakePage(['insertText'])
  const ok = await insertTextCompat(page, 'Kuwait')
  assert.equal(ok, true)
  assert.deepEqual(calls, [['insertText', 'Kuwait']], 'single bulk insert')
})

test('prefers sendCharacter when BOTH are present', async () => {
  const { page, calls } = fakePage(['sendCharacter', 'insertText'])
  await insertTextCompat(page, 'ET')
  assert.deepEqual(calls.map(c => c[0]), ['sendCharacter', 'sendCharacter'])
})

test('falls back to type() when neither bulk API exists', async () => {
  const { page, calls } = fakePage(['type'])
  const ok = await insertTextCompat(page, 'Kuwait')
  assert.equal(ok, true)
  assert.deepEqual(calls, [['type', 'Kuwait']])
})

test('falls back when sendCharacter is present but throws', async () => {
  const calls = []
  const page = {
    keyboard: {
      sendCharacter: async () => { throw new Error('detached frame') },
      insertText: async (t) => { calls.push(['insertText', t]) },
    },
  }
  const ok = await insertTextCompat(page, 'Kuwait')
  assert.equal(ok, true, 'a throwing driver must not abort the fill')
  assert.deepEqual(calls, [['insertText', 'Kuwait']])
})

test('returns false instead of throwing when no keyboard API exists', async () => {
  const ok = await insertTextCompat({ keyboard: {} }, 'Kuwait')
  assert.equal(ok, false)
})

test('empty input is a no-op', async () => {
  const { page, calls } = fakePage(['sendCharacter'])
  assert.equal(await insertTextCompat(page, ''), false)
  assert.deepEqual(calls, [])
})

test('missing keyboard object is handled', async () => {
  assert.equal(await insertTextCompat({}, 'Kuwait'), false)
  assert.equal(await insertTextCompat(null, 'Kuwait'), false)
})

// ---------------------------------------------------------------------------
// source-level guard: never reintroduce the Playwright-only call
// ---------------------------------------------------------------------------

/** Strip block and line comments so doc text cannot mask (or trip) the check. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('no workflow calls the Playwright-only keyboard.insertText', () => {
  const servicesDir = path.join(__dirname, '..', 'src', 'services')
  const offenders = []

  for (const file of fs.readdirSync(servicesDir)) {
    if (!file.endsWith('.js')) continue
    if (file.endsWith('.bak')) continue
    const src = stripComments(fs.readFileSync(path.join(servicesDir, file), 'utf8'))
    if (/keyboard\s*\.\s*insertText\s*\(/.test(src)) offenders.push(file)
  }

  assert.deepEqual(
    offenders,
    [],
    'use insertTextCompat() from domPaste.js — keyboard.insertText() does not exist on Puppeteer'
  )
})

test('no service uses a Playwright-only API (the project runs on Puppeteer)', () => {
  const servicesDir = path.join(__dirname, '..', 'src', 'services')

  // These exist ONLY on Playwright. `page` in every workflow is a Puppeteer
  // page (services/browser.js connects through puppeteer-core), so calling any
  // of them throws `TypeError: ... is not a function` at runtime — which is
  // precisely how `keyboard.insertText` broke the whole police-certificate
  // upload step.
  const playwrightOnly = [
    ['keyboard.insertText', /keyboard\s*\.\s*insertText\s*\(/],
    ['waitForTimeout', /\.\s*waitForTimeout\s*\(/],
    ['page.locator', /\.\s*locator\s*\(/],
    ['page.route', /\.\s*route\s*\(/],
    ['setInputFiles', /\.\s*setInputFiles\s*\(/],
    ['getByRole', /\.\s*getByRole\s*\(/],
    ['getByText', /\.\s*getByText\s*\(/],
    ['getByLabel', /\.\s*getByLabel\s*\(/],
  ]

  const offenders = []
  for (const file of fs.readdirSync(servicesDir)) {
    if (!file.endsWith('.js') || file.endsWith('.bak')) continue
    const src = stripComments(fs.readFileSync(path.join(servicesDir, file), 'utf8'))
    for (const [name, re] of playwrightOnly) {
      if (re.test(src)) offenders.push(`${file}: ${name}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'use the Puppeteer equivalents (e.g. insertTextCompat() from domPaste.js)'
  )
})
