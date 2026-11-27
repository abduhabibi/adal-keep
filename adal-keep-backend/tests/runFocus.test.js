/**
 * runFocus.test.js — while a robot run works, the other jobs of the PC hold their internet (2026-11-26, the owner:
 * "concentrate the internet into that"); another process sees it through the file, a crashed run frees it by itself
 * within 15 s, what waited goes on within ~2 s of the end; off: ADAL_RUN_FOCUS=0.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-focus-'))
process.env.ADAL_ROBOTS_DATA = tmp
const F = await import('../src/services/runFocus.js')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('held while a run works here; what waited goes on after it', async () => {
  F._resetForTest()
  let n = 1
  F.startFocusBeacon(() => n)
  assert.equal(F.held('the online copy'), true)
  let went = 0
  F.later('the online copy', () => { went++ })
  F.later('the online copy', () => { went += 10 })          // (the last one for each job)
  n = 0
  await sleep(2500)
  assert.equal(went, 10)
  assert.equal(F.held('the online copy'), false)
  F._resetForTest()
})

test("another process: the robots' file, good for 15 s only (a crashed run frees the line)", () => {
  F._resetForTest()
  const file = path.join(tmp, 'run-focus.json')
  const now = Date.now()
  fs.writeFileSync(file, JSON.stringify({ until: now + F.FOCUS_MS, runs: 1 }))
  assert.equal(F.runsNow(now), 1); assert.equal(F.held('the backup', now), true)
  assert.equal(F.runsNow(now + F.FOCUS_MS + 1500), 0, 'not refreshed: free again')
  F._resetForTest()
  process.env.ADAL_RUN_FOCUS = '0'
  try { assert.equal(F.held('the backup', now), false) } finally { delete process.env.ADAL_RUN_FOCUS; fs.rmSync(file, { force: true }); F._resetForTest() }
})
