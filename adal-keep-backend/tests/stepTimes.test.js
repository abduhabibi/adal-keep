import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { timed } from '../src/services/stepTimes.js'

const grab = async (fn) => { const lines = []; const o = console.log; console.log = (m) => lines.push(String(m)); try { await fn() } catch {} finally { console.log = o }; return lines }

test('a step logs its time and profile id only, and returns its result', async () => {
  const ctx = { runId: 7, profileId: 42, name: 'SECRET NAME' }
  const f = timed('Musaned', 'stepX', async (page, c) => { await new Promise(r => setTimeout(r, 20)); return { ok: true } })
  let res; const lines = await grab(async () => { res = await f({}, ctx) })
  assert.deepEqual(res, { ok: true })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\[steps\] run=7 profile=42 Musaned stepX 0\.\d s$/)
  assert.doesNotMatch(lines[0], /SECRET/)
})

test('a throwing step logs "failed" and still throws the same error', async () => {
  const err = new Error('boom')
  const f = timed('LMIS', 'stepY', async () => { throw err })
  let caught; const lines = await grab(async () => { try { await f({}, { runId: 1, profileId: 2 }) } catch (e) { caught = e } })
  assert.equal(caught, err)
  assert.match(lines[0], /LMIS stepY [\d.]+ s failed$/)
})

test('ADAL_STEP_TIMES=0 logs nothing', async () => {
  process.env.ADAL_STEP_TIMES = '0'
  try { const lines = await grab(() => timed('A', 'b', async () => 1)({}, {})); assert.deepEqual(lines, []) } finally { delete process.env.ADAL_STEP_TIMES }
})

test('every wrapped workflow still loads', async () => {
  for (const f of ['musanedWorkflow', 'lmisWorkflow', 'wafidWorkflow', 'mofaVisa', 'tasheer', 'insuranceCertificate']) await import(`../src/services/${f}.js`)
  assert.equal(typeof (await import('../src/services/musanedWorkflow.js')).stepClickHrPool, 'function')
})

test('the ranking script orders steps by total time per site', () => {
  const p = path.join(os.tmpdir(), `steps-${process.pid}.log`)
  fs.writeFileSync(p, ['[steps] run=1 profile=2 Musaned stepA 2.0 s', '[steps] run=2 profile=3 Musaned stepA 4.0 s', '[steps] run=1 profile=2 Musaned stepB 5.0 s failed', '[steps] run=1 profile=2 Musaned runMusanedWorkflow 30.0 s', 'noise'].join('\n'))
  try {
    const out = execFileSync('node', ['scripts/step-times.mjs', p], { encoding: 'utf8' })
    assert.ok(out.indexOf('stepA') < out.indexOf('stepB'))
    assert.match(out, /whole runs[\s\S]*runMusanedWorkflow/)
    assert.match(out, /1 failed/)
  } finally { fs.rmSync(p, { force: true }) }
})
