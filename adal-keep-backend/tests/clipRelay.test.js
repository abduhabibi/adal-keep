/** The double-C crop on a Companion: its picture reaches its own window on the main PC's pages, and no other PC's. */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import express from 'express'

process.env.ADAL_BEHIND_COMPANION = '1'   // another computer = another loopback address
const { default: appRouter } = await import('../src/routes/app.js')
const { _resetRelay } = await import('../src/services/clipRelay.js')
const { changed } = await import('../src/services/changes.js')

const app = express()
app.use((req, res, next) => { const id = req.headers['x-test-pc']; if (id) req.pcAccess = { id }; next() })
app.use('/api', appRouter)
const server = app.listen(0, '0.0.0.0')
await new Promise(r => server.once('listening', r))
const port = server.address().port
const opts = (p, ip, pc, o = {}) => ({ host: '127.0.0.1', port, path: '/api' + p, localAddress: ip === '127.0.0.1' ? ip : ip.replace(/^192/, '127'), headers: { 'x-adal-real-ip': ip, ...(pc ? { 'x-test-pc': pc } : {}), ...o.headers }, method: o.method || 'GET', agent: false })
const call = (p, ip, pc, o = {}) => new Promise((ok, no) => {
  const r = http.request(opts(p, ip, pc, o), (res) => { const b = []; res.on('data', d => b.push(d)); res.on('end', () => ok({ s: res.statusCode, b: Buffer.concat(b) })) })
  r.on('error', no); r.end(o.body)
})
const page = (ip, pc) => new Promise((ok) => {
  const got = { text: '' }
  const r = http.request(opts('/changes', ip, pc), (res) => { res.setEncoding('utf8'); res.on('data', d => { got.text += d }); setTimeout(() => ok(got), 60) })
  got.close = () => r.destroy(); r.on('error', () => {}); r.end()
})
const wait = async (fn) => { for (let i = 0; i < 60 && !fn(); i++) await new Promise(r => setTimeout(r, 25)); return fn() }
const post = (ip, pc, state, body) => call(`/app/clip${state ? `?state=${state}` : ''}`, ip, pc, { method: 'POST', body, headers: body ? { 'content-type': 'image/png' } : {} })
const A = '192.168.1.20', B = '192.168.1.21', PNG = Buffer.from('\x89PNG-picture', 'latin1')

test('its own window gets it (also when its window holds another key), another PC never', async () => {
  const a = await page(A, 'window-a'), b = await page(B, 'b')
  assert.deepEqual(JSON.parse((await post(A, 'server-a', 'hook')).b), { ok: true, pages: 1 })
  assert.ok(await wait(() => /event: clips\ndata: {"hook":true}/.test(a.text)))
  await post(A, 'server-a', 'cropping'); await post(A, 'server-a', '', PNG)
  const id = await wait(() => /"clip":"(pc\d+)"/.exec(a.text)?.[1])
  assert.match(a.text, /"state":"cropping"/)
  assert.doesNotMatch(b.text, /clip|hook/)
  const mine = await call(`/app/clips/${id}`, A, 'window-a')
  assert.equal(mine.s, 200); assert.deepEqual(mine.b, PNG)
  assert.equal((await call(`/app/clips/${id}`, B, 'b')).s, 404)
  assert.equal((await call(`/app/clips/${id}`, B, '')).s, 404)
  // The changes themselves come as before, unnamed.
  changed('profiles'); assert.ok(await wait(() => /\ndata: {"v":\d+,"tables":\["profiles"\]}/.test(b.text)))
  await post(A, 'server-a', 'nohook'); assert.ok(await wait(() => /"hook":false/.test(a.text)))
  a.close(); b.close(); _resetRelay()
})

test('not let in: refused; no page open: not kept; switched off: refused', async () => {
  assert.equal((await post(A, '', 'hook')).s, 403)
  assert.deepEqual(JSON.parse((await post(A, 'server-a', '', PNG)).b), { ok: true, pages: 0 })
  process.env.ADAL_CLIP_RELAY = '0'
  assert.equal((await post(A, 'server-a', 'hook')).s, 403)
  const a = await page(A, 'x'); assert.doesNotMatch(a.text, /clips/); a.close()
  delete process.env.ADAL_CLIP_RELAY
  _resetRelay()
})

test('the Companion: sends the picture only while its window is open there, "cropping" first; an older main PC is left alone', async () => {
  const seen = []; let pages = 1, code = 200
  const main = http.createServer((q, r) => { const b = []; q.on('data', d => b.push(d)); q.on('end', () => { seen.push([q.url, q.headers['x-adal-pc'], Buffer.concat(b).length]); r.writeHead(code, { 'content-type': 'application/json' }); r.end(JSON.stringify({ ok: true, pages })) }) }).listen(0)
  // As a Companion, in a process of its own (its data folder is made up).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'))
  fs.mkdirSync(path.join(dir, 'data'))
  fs.writeFileSync(path.join(dir, 'data', 'main-pc.json'), JSON.stringify({ mode: 'companion', main_url: `http://127.0.0.1:${main.address().port}`, pc_key: 'K' }))
  const { spawn } = await import('node:child_process')
  const back = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  fs.cpSync(path.join(back, 'src'), path.join(dir, 'src'), { recursive: true })
  fs.copyFileSync(path.join(back, 'package.json'), path.join(dir, 'package.json'))
  fs.symlinkSync(fs.realpathSync(path.join(back, 'node_modules')), path.join(dir, 'node_modules'), 'junction')
  const root = path.join(dir, 'src', 'services')
  const go = (what) => new Promise((ok) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `const { relayClip } = await import(${JSON.stringify(pathToFileURL(root + '/clipRelay.js').href)}); ${what}; process.exit(0)`], { cwd: dir, env: { ...process.env, ADAL_BEHIND_COMPANION: '' } })
    let e = ''; p.stderr.on('data', d => { e += d }); p.on('exit', () => ok(e))
  })
  try {
    const picture = "await relayClip({ state: 'cropping' }); await relayClip({ png: Buffer.from('PIC'), state: '' })"
    const err = await go(picture)
    assert.deepEqual(seen, [['/api/app/clip?state=cropping', 'K', 0], ['/api/app/clip', 'K', 3]], err)
    seen.length = 0; pages = 0; await go(picture); assert.equal(seen.length, 1, 'no window open there: the picture stays here')
    seen.length = 0; pages = 1; code = 403; await go(picture); assert.equal(seen.length, 1, 'an older main PC')
    seen.length = 0; code = 200; await go(`process.env.ADAL_CLIP_RELAY = '0'; ${picture}`); assert.equal(seen.length, 0)
  } finally { main.close() }
})

test.after(() => { server.close(); server.closeAllConnections?.() })
