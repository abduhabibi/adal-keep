/**
 * noWindows.test.js — no visible browser window on Linux (the owner, 2026-11-23: "stop this
 * brave window opening again and again and never do it in any way"). The app's browsers are
 * headless there, and no test, fixture or script starts a browser with a window.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const BACK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { noWindows, headlessHere, headlessArgs } = await import('../src/services/noWindows.js')

test('on Linux every browser Adal Keep starts is headless', { skip: process.platform !== 'linux' }, async () => {
  const before = process.env.ADAL_SHOW_WINDOWS
  delete process.env.ADAL_SHOW_WINDOWS
  assert.equal(noWindows(), true)
  assert.equal(headlessHere(), true)
  assert.deepEqual(headlessArgs(), ['--headless=new'])
  const { _browserArgs } = await import('../src/services/browser.js')
  assert.ok(_browserArgs.includes('--headless=new'), 'Adal Browser is started headless')
  if (before !== undefined) process.env.ADAL_SHOW_WINDOWS = before
})

// Every file that starts a browser: none with a window.
function files(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...files(p))
    else if (/\.(m?js|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}

test('no code, test, fixture or script launches a browser with a window', () => {
  const bad = []
  for (const f of [...files(path.join(BACK, 'src')), ...files(path.join(BACK, 'tests')), ...files(path.join(BACK, 'scripts'))]) {
    if (f.endsWith('noWindows.test.js')) continue
    const src = fs.readFileSync(f, 'utf8')
    if (/headless\s*:\s*false/.test(src)) bad.push(`${path.relative(BACK, f)}: headless: false`)
    // A browser started by hand in a test must say --headless itself.
    if (f.includes(`${path.sep}tests${path.sep}`) && /spawn\(\s*(CHROME|chrome|exe|BRAVE|brave)\b/.test(src) && !/--headless/.test(src)) bad.push(`${path.relative(BACK, f)}: spawns a browser without --headless`)
  }
  assert.deepEqual(bad, [])
})
