/** uploadOnce.test.js — one paste is always enough: sent again after the PC was gone, saved once (2026-11-25). */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import multer from 'multer'

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-up-'))
process.env.ADAL_UPLOAD_IDS = path.join(T, 'ids.json')
const { uploadOnce, _forget } = await import('../src/services/uploadOnce.js')
test.after(() => fs.rmSync(T, { recursive: true, force: true }))
const wait = (ms) => new Promise(r => setTimeout(r, ms))

async function serve({ slow = 0, fail = () => false } = {}) {
  const rows = []
  const app = express()
  app.post('/up', uploadOnce, multer({ storage: multer.memoryStorage() }).single('file'), async (req, res) => {
    await wait(slow)
    if (fail()) return res.status(500).json({ error: 'no' })
    rows.push(req.file.size); res.json({ id: rows.length, size: req.file.size })
  })
  app.use((e, q, r, n) => r.status(500).json({ error: e.message }))
  const s = app.listen(0); s.port = s.address().port
  return { rows, port: s.port, close: () => new Promise(r => { s.closeAllConnections(); s.close(r) }) }
}
const send = (port, id, size = 1000) => { const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(size)]), 'a.jpg'); return fetch(`http://127.0.0.1:${port}/up`, { method: 'POST', body: fd, headers: id ? { 'X-Adal-Upload': id } : {} }).then(async r => ({ s: r.status, again: r.headers.get('x-adal-upload-again'), b: await r.json() })) }

test('the same number: once; another number or none: each', async () => {
  const s = await serve()
  const a = await send(s.port, 'number-one-1'), b = await send(s.port, 'number-one-1')
  assert.deepEqual(a.b, b.b); assert.equal(b.again, '1'); assert.equal(s.rows.length, 1)
  await send(s.port, 'number-two-2'); await send(s.port); await send(s.port)
  assert.equal(s.rows.length, 4)
  _forget()                                                                // the PC was started again
  assert.deepEqual((await send(s.port, 'number-one-1')).b, a.b); assert.equal(s.rows.length, 4)
  await s.close()
})

test('sent again while the first is still being saved: its answer, once', async () => {
  const s = await serve({ slow: 300 })
  const [a, b, c] = await Promise.all([send(s.port, 'together-1'), wait(50).then(() => send(s.port, 'together-1')), wait(90).then(() => send(s.port, 'together-1'))])
  assert.equal(s.rows.length, 1); assert.deepEqual(a.b, b.b); assert.deepEqual(a.b, c.b)
  await s.close()
})

test('the line broke half way: the next try is saved; a failure is tried again', async () => {
  let no = true
  const s = await serve({ fail: () => no })
  // Half a file, then the line breaks.
  await new Promise((ok) => {
    const r = http.request({ port: s.port, method: 'POST', path: '/up', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': 100000, 'x-adal-upload': 'broken-line-1' } })
    r.on('error', () => ok()); r.write('--x\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\n\r\n' + 'y'.repeat(5000)); setTimeout(() => r.destroy(), 60); r.on('close', ok)
  })
  await wait(50)
  assert.equal((await send(s.port, 'broken-line-1')).s, 500)
  no = false
  assert.equal((await send(s.port, 'broken-line-1')).s, 200); assert.equal(s.rows.length, 1)
  await s.close()
})

// The window's side (lib/uploads.js), without its page.
const src = fs.readFileSync(new URL('../../adal-keep-frontend/src/lib/uploads.js', import.meta.url), 'utf8').replace(/^import api.*$/m, 'const api = {}')
const { sendFiles, uploadsOf } = await import('data:text/javascript,' + encodeURIComponent(src))
const file = (n = 10, type = 'application/pdf') => Object.assign(new Blob([new Uint8Array(n)], { type }), { name: 'a' })
const net = () => new Error('Network Error'), http_ = (status, data = {}) => Object.assign(new Error('x'), { response: { status, data } })

test('the window: gone for three tries, then saved; the same number each time; shown meanwhile', async () => {
  let n = 0; const ids = []
  const p = sendFiles({ key: 'g/1', url: '/u', files: [file()], waits: [1, 1, 1, 1], post: async (u, d, c) => { ids.push(c.headers['X-Adal-Upload']); assert.equal(uploadsOf('g/1').length, 1); if (++n < 4) throw n === 2 ? http_(503) : net(); return { data: 'ok' } } })
  assert.equal(uploadsOf('g/1')[0].state, 'saving')
  assert.equal((await p).data, 'ok'); assert.equal(new Set(ids).size, 1); assert.equal(n, 4); assert.equal(uploadsOf('g/1').length, 0)
})

test('the window: refused = said at once, not sent again; given up = Try again saves it', async () => {
  let n = 0
  await assert.rejects(sendFiles({ key: 'g/2', url: '/u', files: [file()], waits: [1, 1], post: async () => { n++; throw http_(400, { error: 'Too big' }) } }))
  assert.equal(n, 1); assert.equal(uploadsOf('g/2')[0].state, 'failed'); assert.equal(uploadsOf('g/2')[0].why, 'Too big')
  let off = true, saved = 0
  await assert.rejects(sendFiles({ key: 'g/3', url: '/u', files: [file()], waits: [1], onSaved: () => { saved++ }, post: async () => { if (off) throw net(); return { data: 1 } } }))
  off = false; uploadsOf('g/3')[0].retry(); await wait(20)
  assert.equal(saved, 1); assert.equal(uploadsOf('g/3').length, 0)
})

test('the window: the same picture pasted twice while it is being saved is sent once', async () => {
  let n = 0; const f = file(77)
  const post = async () => { n++; await wait(30); return { data: 1 } }
  await Promise.all([sendFiles({ key: 'g/4', url: '/u', files: [f], post }), sendFiles({ key: 'g/4', url: '/u', files: [f], post })])
  assert.equal(n, 1)
})

test('the window\'s X: no more tries; arrived = saved and shown, not arrived = not saved', async () => {
  // Not arrived: the PC never had it.
  let tries = 0
  const p1 = sendFiles({ key: 'x/1', url: '/u', files: [file()], waits: [5, 5, 5], post: (u, d, c) => new Promise((_, no) => { tries++; c.signal.addEventListener('abort', () => no(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))) }), ask: async () => ({ state: 'none' }) })
  await wait(10)
  assert.equal(await uploadsOf('x/1')[0].stop(), 'not saved')
  await assert.rejects(p1, (e) => e.stopped === true)
  await wait(40); assert.equal(tries, 1); assert.equal(uploadsOf('x/1').length, 0)
  // Arrived, its answer late: the saved answer is used.
  let shown = null
  const p2 = sendFiles({ key: 'x/2', url: '/u', files: [file()], onSaved: (r) => { shown = r.data }, post: (u, d, c) => new Promise((_, no) => c.signal.addEventListener('abort', () => no(new Error('canceled')))), ask: async () => ({ state: 'saved', status: 200, body: { files: [{ id: 7 }] } }) })
  p2.catch(() => {})
  await wait(10)
  assert.equal(await uploadsOf('x/2')[0].stop(), 'saved'); assert.deepEqual(shown, { files: [{ id: 7 }] })
  // Still being saved: waited for, then saved.
  let n = 0
  const p3 = sendFiles({ key: 'x/3', url: '/u', files: [file()], sleep: () => wait(1), post: (u, d, c) => new Promise((_, no) => c.signal.addEventListener('abort', () => no(new Error('canceled')))), ask: async () => (++n < 3 ? { state: 'saving' } : { state: 'saved', status: 200, body: {} }) })
  p3.catch(() => {})
  await wait(10)
  assert.equal(await uploadsOf('x/3')[0].stop(), 'saved'); assert.equal(n, 3)
})
