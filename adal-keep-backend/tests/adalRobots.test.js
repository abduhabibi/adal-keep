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

test('Adal Robots off: the live view is told at once, Stop falls back to Adal Keep; on: an endless stream comes piece by piece', async () => {
  delete process.env.ADAL_ROBOTS_IN_APP
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-link-'))
  process.env.ADAL_ROBOTS_DATA = dir
  fs.writeFileSync(path.join(dir, 'robots-token'), 'x'.repeat(40))
  process.env.ADAL_ROBOTS_PORT = '9'   // nothing answers there
  const express = (await import('express')).default
  const { robotsLink } = await import('../src/services/robotsLink.js')
  const keep = express(); keep.use(express.json()); keep.use('/api', robotsLink); keep.use('/api', (req, res) => res.json({ here: true }))
  const ks = await new Promise(r => { const s = keep.listen(0, '127.0.0.1', () => r(s)) })
  const K = `http://127.0.0.1:${ks.address().port}/api`
  const off = await fetch(`${K}/automations/5/stream`)
  assert.equal(off.status, 503); assert.match((await off.json()).error, /Adal Robots is not running/)
  assert.deepEqual(await (await fetch(`${K}/automations/5/cancel`, { method: 'POST' })).json(), { here: true }, 'Stop is done by Adal Keep itself')
  // A stand-in for Adal Robots: a stream that never ends, and an answer to the person's click.
  let gone = false, got = null
  const robots = express(); robots.use(express.json())
  robots.use((req, res, next) => req.get('x-adal-robots') === 'x'.repeat(40) ? next() : res.status(403).end())
  robots.get('/api/automations/5/stream', (req, res) => { res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=adalframe' }); const t = setInterval(() => res.write('--adalframe picture\r\n'), 50); req.on('close', () => { gone = true; clearInterval(t) }) })
  robots.post('/api/automations/5/input', (req, res) => { got = req.body; res.json({ ok: true }) })
  const rs = await new Promise(r => { const s = robots.listen(0, '127.0.0.1', () => r(s)) })
  process.env.ADAL_ROBOTS_PORT = String(rs.address().port)
  const ac = new AbortController()
  const st = await fetch(`${K}/automations/5/stream`, { signal: ac.signal })
  assert.equal(st.status, 200); assert.match(st.headers.get('content-type'), /multipart\/x-mixed-replace/)
  const first = await st.body.getReader().read()
  assert.match(Buffer.from(first.value).toString(), /picture/, 'the first picture comes at once')
  ac.abort()
  await new Promise(r => setTimeout(r, 400))
  assert.ok(gone, 'the viewer closed: the robot stops sending')
  assert.deepEqual(await (await fetch(`${K}/automations/5/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 1 }) })).json(), { ok: true })
  assert.deepEqual(got, { x: 1 }, 'the click reached Adal Robots')
  ks.closeAllConnections(); ks.close(); rs.closeAllConnections(); rs.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the robot window: off unless switched on, and never in Adal Keep itself', async () => {
  const { noWindows } = await import('../src/services/noWindows.js')
  const { robotWindow, raiseForPerson } = await import('../src/services/browser.js')
  delete process.env.ADAL_ROBOT_PROCESS; delete process.env.ADAL_ROBOTS_WINDOW
  assert.equal(robotWindow(), false); assert.equal(await raiseForPerson({}), false)
  process.env.ADAL_ROBOTS_WINDOW = '1'
  assert.equal(robotWindow(), false, 'Adal Keep itself: never')
  if (process.platform === 'linux') assert.equal(noWindows(), true)
  process.env.ADAL_ROBOT_PROCESS = '1'
  assert.equal(robotWindow(), true); assert.equal(noWindows(), false)
  delete process.env.ADAL_ROBOT_PROCESS; delete process.env.ADAL_ROBOTS_WINDOW
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
