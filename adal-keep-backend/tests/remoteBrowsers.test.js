/**
 * remoteBrowsers.test.js — a robot started on an Adal Companion works in that
 * PC's browser (asked on 2026-11-19). The Companion is known by its key or its
 * address; uploads in its browser send the file there first; the main PC's own
 * browser is unchanged.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { registerDevice, deviceLive, deviceForRequest, liveDevices, patchProto, _resetForTest, _rememberForTest } from '../src/services/remoteBrowsers.js'

const TOKEN = 'a'.repeat(32)

test('a Companion is known by its key, or by its address', () => {
  _resetForTest()
  assert.deepEqual(registerDevice({ id: 'pc1', name: 'Front desk' }, '::ffff:192.168.1.20', { token: 'short' }), { ok: false, error: 'bad token' })
  assert.equal(registerDevice({ id: 'pc1', name: 'Front desk' }, '::ffff:192.168.1.20', { token: TOKEN, port: 47810 }).ok, true)
  assert.ok(deviceLive('pc1'))
  assert.ok(!deviceLive('pc1', Date.now() + 4 * 60e3))       // not heard from for 4 minutes: gone
  assert.equal(deviceForRequest({ id: 'pc1' }, '192.168.1.20'), 'pc1')
  assert.equal(deviceForRequest({ id: 'other-key' }, '192.168.1.20'), 'pc1')   // its window's own key
  assert.equal(deviceForRequest({ id: 'other-key' }, '192.168.1.99'), '')
  assert.equal(deviceForRequest(null, '192.168.1.20'), '')                   // not an approved PC
  assert.equal(deviceForRequest({ id: 'x' }, '127.0.0.1'), '')               // the main PC itself
  assert.equal(liveDevices()[0].token, undefined)                            // never shown
})

test('an upload in a Companion\'s browser sends the file there first; the main PC\'s is unchanged', async () => {
  _resetForTest()
  const got = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      got.push({ url: req.url, token: req.headers['x-adal-robot'], body })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ path: 'C:\\AdalKeepCompanion\\robot-files\\f1\\passport.jpg' }))
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  registerDevice({ id: 'pc1' }, '127.0.0.1', { token: TOKEN, port })
  const d = { id: 'pc1', ip: '127.0.0.1', port, token: TOKEN, name: 'Front desk' }

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-')), 'passport.jpg')
  fs.writeFileSync(file, 'JPEG')
  const remoteBrowser = {}, mainBrowser = {}
  _rememberForTest(remoteBrowser, d)
  const calls = []
  class Handle { constructor(b) { this.b = b } get frame() { return { page: () => ({ browser: () => this.b }) } } async uploadFile(...p) { calls.push(p) } }
  patchProto(Handle.prototype)

  await new Handle(mainBrowser).uploadFile(file)
  assert.deepEqual(calls[0], [file])                                         // main PC: as before
  await new Handle(remoteBrowser).uploadFile(file)
  assert.deepEqual(calls[1], ['C:\\AdalKeepCompanion\\robot-files\\f1\\passport.jpg'])
  assert.equal(got.length, 1)
  assert.match(got[0].url, /^\/robot\/file\?name=passport\.jpg$/)
  assert.equal(got[0].token, TOKEN)
  assert.equal(got[0].body, 'JPEG')
  srv.close()
})

test('ADAL_LAN_ROBOTS=0 keeps every run on this PC; moves and CV PDFs go to another only with =1', async (t) => {
  const { freeStrongDevice } = await import('../src/services/remoteBrowsers.js')
  const { helperForPdf, placeTransition } = await import('../src/services/sharePower.js')
  const { lanRobots } = await import('../src/services/sharePower.js')
  t.after(() => { delete process.env.ADAL_LAN_ROBOTS })
  process.env.ADAL_LAN_ROBOTS = '0'
  assert.equal(lanRobots(), false)
  assert.equal(freeStrongDevice(), '')
  delete process.env.ADAL_LAN_ROBOTS
  assert.equal(lanRobots(), true)
  assert.equal(await helperForPdf(), null, 'a CV PDF is made here')
  assert.deepEqual(await placeTransition('https://example.org', { from: '' }), { to: '' })
})

test('a run nobody pressed goes to the strongest free Companion', async () => {
  const { freeStrongDevice } = await import('../src/services/remoteBrowsers.js')
  _resetForTest()
  assert.equal(freeStrongDevice(), '')
  registerDevice({ id: 'weak' }, '192.168.1.21', { token: TOKEN, cores: 4 })
  registerDevice({ id: 'strong' }, '192.168.1.22', { token: TOKEN, cores: 16 })
  assert.equal(freeStrongDevice(), 'strong')
  assert.equal(freeStrongDevice(new Set(['strong'])), 'weak')                 // busy with a run: the next one
  assert.equal(freeStrongDevice(new Set(), Date.now() + 4 * 60e3), '')        // gone quiet: none
})
