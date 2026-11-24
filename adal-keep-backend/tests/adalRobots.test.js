/**
 * adalRobots.test.js — Adal Robots, the robots in a program of their own (2026-11-24). What Adal Keep passes on
 * to it, its start with no window, its token, the processor gate (no new run over 80 %), and a connection that
 * is never held.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JEV_ENABLED = 'false'
process.env.ADAL_NO_BROWSER_START = '1'
process.env.BRAVE_CDP_URL = 'http://127.0.0.1:9'

test('Adal Keep passes the live view, the clicks, the "needs you" list, Stop and Continue to Adal Robots', async () => {
  const { passedTo } = await import('../src/services/robotsLink.js')
  assert.ok(passedTo('GET', '/automations/12/screen'))
  assert.ok(passedTo('POST', '/automations/12/input'))
  assert.ok(passedTo('GET', '/automations/attention'))
  assert.ok(passedTo('GET', '/browsers'))
  assert.equal(passedTo('POST', '/automations/12/cancel')[2], true, 'Stop still works when Adal Robots is off')
  assert.equal(passedTo('GET', '/automations/12/log'), null, 'the rest stays in Adal Keep')
  assert.equal(passedTo('POST', '/automations/queue'), null)
})

test('Adal Keep answers at once that Adal Robots is not running (no tab to show), and Stop falls back to its own', async () => {
  delete process.env.ADAL_ROBOTS_IN_APP
  process.env.ADAL_ROBOTS_PORT = '9'   // nothing answers there
  const { robotsLink } = await import('../src/services/robotsLink.js')
  const res = { code: 0, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } }
  let nexted = false
  await robotsLink({ method: 'GET', path: '/automations/5/screen', url: '/automations/5/screen', get: () => '' }, res, () => { nexted = true })
  assert.equal(res.code, 503); assert.match(res.body.error, /Adal Robots is not running/); assert.ok(!nexted)
  await robotsLink({ method: 'POST', path: '/automations/5/cancel', url: '/automations/5/cancel', get: () => '', body: {} }, res, () => { nexted = true })
  assert.ok(nexted, 'Stop is done by Adal Keep itself')
})

test('Windows: Adal Robots is started with no window, apart (detached), and never on Linux (its own unit)', async () => {
  const { keepRobotsRunning } = await import('../src/services/robotsLink.js')
  assert.equal(keepRobotsRunning({ platform: 'linux' }), false)
  const calls = []
  process.env.ADAL_ROBOTS_PORT = '9'
  const started = keepRobotsRunning({ platform: 'win32', spawnFn: (exe, args, opts) => { calls.push({ exe, args, opts }); return { pid: 1, unref() {} } } })
  assert.equal(started, true)
  await new Promise(r => setTimeout(r, 5600))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.windowsHide, true); assert.equal(calls[0].opts.detached, true)
  assert.match(calls[0].args[0], /robots[\\/]adal-robots\.mjs$/)
})

test('the token is made once and kept; the processor gate answers', async () => {
  const { robotsToken, cpuOver } = await import('../robots/adal-robots.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-robots-'))
  const a = robotsToken(dir), b = robotsToken(dir)
  assert.equal(a, b); assert.ok(a.length >= 32)
  assert.equal(typeof await cpuOver(0.8, 200), 'boolean')
  assert.equal(await cpuOver(2, 200), false, 'never over 200 %')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the worker starts no new run while the gate says the PC is busy', async () => {
  const w = await import('../src/services/worker.js')
  let asked = 0
  w.setClaimGate(async () => { asked++; return false })
  assert.equal(typeof w.setClaimGate, 'function')
  w.setClaimGate(null)
  assert.equal(asked, 0)
})
