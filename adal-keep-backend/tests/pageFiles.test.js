/** pageFiles.test.js — the window's files: a missing one is 404 (never the app's page), an older build's are still there (2026-11-25: blank pages, reloads). */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import { pageFiles, keepPageFiles } from '../src/services/pageFiles.js'

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-pages-'))
test.after(() => fs.rmSync(T, { recursive: true, force: true }))
const build = (n, files) => { const d = path.join(T, n, 'assets'); fs.mkdirSync(d, { recursive: true }); for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, k), v); return path.join(T, n) }
async function serve(dir, kept) {
  const app = express()
  app.use('/assets', pageFiles(dir, { kept }))
  app.get('*', (q, r) => r.send('<!doctype html>the app'))
  const s = app.listen(0)
  return { get: async (p, gzip = true) => { const r = await fetch(`http://127.0.0.1:${s.address().port}${p}`, { headers: gzip ? {} : { 'accept-encoding': 'identity' } }); return { s: r.status, t: await r.text(), type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control'), enc: r.headers.get('content-encoding') } }, close: () => s.close() }
}

test('an update under an open window: its old files still come; a file nobody has is 404', async () => {
  const kept = path.join(T, 'kept')
  const v1 = build('v1', { 'Profiles-a.js': 'export default 1', 'x.png': 'png' }), v2 = build('v2', { 'Profiles-b.js': 'export default 2' })
  assert.equal((await keepPageFiles(v1, { kept })).kept, 2)
  assert.equal((await keepPageFiles(v1, { kept })).kept, 0)          // once
  const s = await serve(v2, kept)
  const a = await s.get('/assets/Profiles-a.js'), b = await s.get('/assets/Profiles-b.js')
  assert.equal(a.t, 'export default 1'); assert.match(a.type, /javascript/); assert.equal(a.enc, 'gzip'); assert.match(a.cache, /immutable/)
  assert.equal(b.t, 'export default 2'); assert.equal((await s.get('/assets/Profiles-b.js', false)).t, 'export default 2')
  assert.equal((await s.get('/assets/x.png')).s, 200)
  const none = await s.get('/assets/Gone-z.js')
  assert.equal(none.s, 404); assert.equal(none.cache, 'no-store'); assert.doesNotMatch(none.t, /the app/)
  assert.match((await s.get('/profiles')).t, /the app/)
  s.close()
})

test('nothing outside its folders; off: only this build; files unused for a month go', async () => {
  const kept = path.join(T, 'kept2'), v1 = build('v3', { 'a.js': 'A' }), v2 = build('v4', { 'b.js': 'B' })
  fs.writeFileSync(path.join(T, 'secret.js'), 'SECRET')
  await keepPageFiles(v1, { kept, now: Date.now() - 40 * 86400000 })
  const s = await serve(v2, kept)
  for (const p of ['/assets/..%2f..%2fsecret.js', '/assets/%2e%2e/%2e%2e/secret.js', '/assets/', '/assets/%zz']) assert.doesNotMatch((await s.get(p)).t, /SECRET/)
  assert.equal((await s.get('/assets/a.js')).s, 200)
  process.env.ADAL_PAGES_KEPT = '0'
  try { assert.equal((await s.get('/assets/a.js')).s, 404); assert.equal((await keepPageFiles(v2, { kept })).kept, 0) } finally { delete process.env.ADAL_PAGES_KEPT }
  assert.deepEqual(await keepPageFiles(v2, { kept }), { kept: 1, gone: 1 })
  assert.equal((await s.get('/assets/a.js')).s, 404)
  s.close()
})
