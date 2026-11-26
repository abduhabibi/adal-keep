/** clipboardRead.test.js — the Paste button's help from this PC: its own clipboard only, pictures and PDFs only (2026-11-26). */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import { readClipboard, MAX } from '../src/services/clipboardRead.js'
import clipboardRouter from '../src/routes/clipboard.js'

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-clip-'))
test.after(() => fs.rmSync(T, { recursive: true, force: true }))
const put = (n, b = 'x') => { const p = path.join(T, n); fs.writeFileSync(p, b); return p }

test('files copied in Explorer: pictures and PDFs come, the rest is named', async () => {
  const a = put('passport.JPG', 'jpg'), b = put('slip.pdf', 'pdf'), c = put('notes.docx', 'doc')
  const r = await readClipboard({ ask: async () => ({ kind: 'paths', paths: [a, b, c, path.join(T, 'gone.png')] }) })
  assert.equal(r.kind, 'files')
  assert.deepEqual(r.files.map(f => [f.name, f.type, String(f.data)]), [['passport.JPG', 'image/jpeg', 'jpg'], ['slip.pdf', 'application/pdf', 'pdf']])
  assert.deepEqual(r.refused, ['notes.docx', 'gone.png'])
  assert.deepEqual(await readClipboard({ ask: async () => ({ kind: 'paths', paths: [c] }) }), { kind: 'not-documents', refused: ['notes.docx'] })
})

test('a copied picture (a screenshot): one PNG, its temporary file removed; text, nothing, not Windows', async () => {
  const p = put('shot.png', 'png')
  const r = await readClipboard({ ask: async () => ({ kind: 'image', path: p }) })
  assert.deepEqual(r.files.map(f => [f.name, f.type]), [['Pasted picture.png', 'image/png']])
  await new Promise(r => setTimeout(r, 50)); assert.equal(fs.existsSync(p), false)
  for (const kind of ['text', 'none', 'other']) assert.equal((await readClipboard({ ask: async () => ({ kind }) })).kind, kind)
  assert.equal((await readClipboard({ ask: null })).kind, 'unsupported')
  const big = path.join(T, 'big.pdf'); fs.writeFileSync(big, Buffer.alloc(MAX + 1))
  assert.deepEqual((await readClipboard({ ask: async () => ({ kind: 'paths', paths: [big] }) })).refused, ['big.pdf (too big)'])
})

test('served: only to a window on this PC; off: turned off', async () => {
  const app = express()
  app.use((q, r, n) => { if (q.headers['x-far']) { const real = q.socket; Object.defineProperty(q, 'socket', { value: new Proxy(real, { get: (t, k) => k === 'remoteAddress' ? '192.168.1.20' : Reflect.get(t, k) }), configurable: true }) } n() })
  app.use('/api', clipboardRouter({ read: async () => ({ kind: 'files', refused: [], files: [{ name: 'a.png', type: 'image/png', data: Buffer.from('PNG') }] }) }))
  const s = app.listen(0, '127.0.0.1'); await new Promise(r => s.once('listening', r)); const u = `http://127.0.0.1:${s.address().port}/api`
  const here = await (await fetch(`${u}/app/clipboard`)).json()
  assert.equal(Buffer.from(here.files[0].data, 'base64').toString(), 'PNG')
  const far = await fetch(`${u}/app/clipboard`, { headers: { 'x-far': '1' } })
  assert.equal(far.status, 403); assert.equal((await far.json()).code, 'not-here')
  assert.equal((await (await fetch(`${u}/app/paste`, { headers: { 'x-far': '1' } })).json()).here, false)
  assert.equal((await (await fetch(`${u}/app/paste`)).json()).on, true)
  process.env.ADAL_PASTE_BUTTON = '0'
  try { assert.equal((await (await fetch(`${u}/app/paste`)).json()).on, false); assert.equal((await fetch(`${u}/app/clipboard`)).status, 404) } finally { delete process.env.ADAL_PASTE_BUTTON }
  s.closeAllConnections(); s.close()
})
