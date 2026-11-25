/** packAnswers.test.js — big answers really go packed (for nine days none was: two backspace characters in a regex). */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import http from 'http'
import express from 'express'
import { packAnswers } from '../src/services/packAnswers.js'
import { answerCache } from '../src/services/answerCache.js'

const app = express()
app.use(packAnswers)
app.get('/api/sync/x', (q, r) => r.json({ t: 'x'.repeat(9000) }))
app.get('/api/big', (q, r) => r.status(q.query.s || 200).json({ t: 'ab'.repeat(9000) }))
app.get('/api/small', (q, r) => r.json({ ok: 1 }))
app.use(answerCache()); app.get('/api/dashboard', (q, r) => r.json({ t: 'y'.repeat(40000) }))
const s = app.listen(0); test.after(() => s.close())
const raw = (p, enc = 'gzip, deflate') => new Promise((ok, no) => http.get({ port: s.address().port, path: p, headers: enc ? { 'accept-encoding': enc } : {} }, r => { let n = 0; r.on('data', d => { n += d.length }); r.on('end', () => ok({ n, e: r.headers['content-encoding'], s: r.statusCode })) }).on('error', no))

test('big = packed; small, not asked for, or between the PCs = as it is; the status stays', async () => {
  const b = await raw('/api/big'); assert.equal(b.e, 'gzip'); assert.ok(b.n < 500)
  assert.equal((await raw('/api/big', null)).e, undefined); assert.equal((await raw('/api/big', 'br')).e, undefined)
  assert.equal((await raw('/api/small')).e, undefined); assert.equal((await raw('/api/sync/x')).e, undefined)
  assert.deepEqual((({ s, e }) => [s, e])(await raw('/api/big?s=409')), [409, 'gzip'])
  const d = await raw('/api/dashboard'); assert.equal(d.e, 'gzip')                            // the kept lists: packed once, not twice
  assert.equal((await (await fetch(`http://127.0.0.1:${s.address().port}/api/dashboard`)).json()).t.length, 40000)
  assert.equal((await (await fetch(`http://127.0.0.1:${s.address().port}/api/big`)).json()).t.length, 18000)
  process.env.ADAL_PACK = '0'; try { assert.equal((await raw('/api/big')).e, undefined) } finally { delete process.env.ADAL_PACK }
})

test('no source file holds a backspace character (a \\b that became one)', () => {
  const root = path.join(import.meta.dirname, '../..')
  const files = execFileSync('git', ['ls-files', '*.js', '*.jsx', '*.mjs', '*.go'], { cwd: root, encoding: 'utf8', maxBuffer: 1e8 }).split('\n').filter(Boolean)
  assert.deepEqual(files.filter(f => { try { return fs.readFileSync(path.join(root, f), 'latin1').includes('\x08') } catch { return false } }), [])
})
