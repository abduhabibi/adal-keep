#!/usr/bin/env node
/**
 * The whole test suite in two passes (2026-11-22: tests that start their own Chrome failed when run beside
 * each other and the other tests on a busy PC — the same tests passed alone):
 *   1. every test that needs no browser, in parallel;
 *   2. the tests that start a browser (any test file that mentions puppeteer, Chromium/Chrome or BRAVE_CDP_URL),
 *      one file at a time.
 * Exit code 0 only when both passes are green. Prints which test files failed.
 *   node scripts/run-tests.mjs [--reporter=spec|dot]
 */
import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const BACK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TESTS = path.join(BACK, 'tests')
const reporter = (process.argv.find(a => a.startsWith('--reporter=')) || '--reporter=dot').slice(11)

const files = fs.readdirSync(TESTS).filter(f => f.endsWith('.test.js')).sort()
// Also one at a time: the tests that start an Adal Admin panel (its server, a fake Supabase): side by side they get in each other's way.
const needsBrowser = (f) => /puppeteer|chromium|google-chrome|BRAVE_CDP_URL|adal-admin/i.test(fs.readFileSync(path.join(TESTS, f), 'utf8'))
const browser = files.filter(needsBrowser), plain = files.filter(f => !browser.includes(f))

const run = (list, extra) => spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, ...extra, ...list.map(f => path.join('tests', f))], { cwd: BACK, stdio: 'inherit', timeout: 20 * 60 * 1000, env: { ADAL_ROBOTS_IN_APP: '1', ...process.env } }).status === 0

console.log(`== tests: ${plain.length} files in parallel, then ${browser.length} browser files one at a time (${browser.join(', ')})`)
const a = run(plain, [])
const b = run(browser, ['--test-concurrency=1'])
if (!a || !b) { console.error(`✗ failed pass: ${[!a && 'parallel', !b && 'browser (serial)'].filter(Boolean).join(' and ')}`); process.exit(1) }
console.log('✓ all tests passed')
