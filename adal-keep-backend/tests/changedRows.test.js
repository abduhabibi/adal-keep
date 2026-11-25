/** changedRows.test.js — a window that has a list gets only the rows that changed (2026-11-25: one field of one girl = 1.8 MB again). */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import express from 'express'
import { made, since, versionOf, _reset } from '../src/services/changedRows.js'
import { answerCache, forget } from '../src/services/answerCache.js'

const P = '/api/profiles/list'
// The window's side (lib/changedOnly.js), its plain part.
const src = fs.readFileSync(new URL('../../adal-keep-frontend/src/lib/changedOnly.js', import.meta.url), 'utf8')
const { merged } = await import('data:text/javascript,' + encodeURIComponent(src.slice(src.indexOf('export const LISTS'), src.indexOf('const has = '))))

test('one row changed: one row sent; nothing changed: nothing; a new one and a gone one', () => {
  _reset()
  const a = [...Array(300)].map((_, i) => ({ id: i + 1, full_name: 'Girl ' + i, skills: 'x'.repeat(200) }))
  made(P, a)
  const v1 = versionOf(P)
  assert.deepEqual(JSON.parse(since(P, v1)), { $v: v1, $count: 300 })
  made(P, structuredClone(a)); assert.equal(versionOf(P), v1)          // made again the same: no new version
  const b = structuredClone(a); b[7].full_name = 'Sara'; b.splice(20, 1); b.unshift({ id: 999, full_name: 'New' })
  made(P, b)
  const d = JSON.parse(since(P, v1))
  assert.deepEqual(d.$set.map(r => r.id).sort((x, y) => x - y), [8, 999]); assert.deepEqual(d.$gone, [21]); assert.equal(d.$count, 300)
  assert.ok(since(P, v1).length < 700)
  const now = merged(P, a, d)
  assert.equal(now.length, 300); assert.equal(now[0].id, 999); assert.equal(now.find(r => r.id === 8).full_name, 'Sara'); assert.ok(!now.some(r => r.id === 21))
  assert.equal(now.find(r => r.id === 5), a[4])                          // an unchanged row is the same object: not drawn again
  assert.deepEqual([...now].sort((x, y) => x.id - y.id), [...b].sort((x, y) => x.id - y.id))
  // Back again after it was gone, and from an older version too.
  const c = structuredClone(b); c.push({ id: 21, full_name: 'Back' }); made(P, c)
  assert.deepEqual(JSON.parse(since(P, v1)).$gone, []); assert.ok(JSON.parse(since(P, v1)).$set.some(r => r.id === 21))
})

test('what does not fit gets the whole list: another PC or a restart, rubbish, most of it changed, a row twice', () => {
  _reset()
  const a = [...Array(100)].map((_, i) => ({ id: i + 1, n: 1 }))
  made(P, a); const v = versionOf(P)
  for (const h of ['00000000.1', 'x', '', null, v.replace(/\d+$/, '99'), '1'.repeat(400)]) assert.equal(since(P, h), null, String(h))
  made(P, a.map(r => ({ ...r, n: 2 }))); assert.equal(since(P, v), null)
  made(P, [...a, a[0]]); assert.equal(versionOf(P), null)
  process.env.ADAL_CHANGED_ROWS = '0'
  try { made(P, a); assert.equal(versionOf(P), null) } finally { delete process.env.ADAL_CHANGED_ROWS }
})

test('a list inside an answer (stages): its other parts only when they changed', () => {
  _reset()
  const S = '/api/automations/stages'
  const body = { stages: [['a', 'A']], profiles: [{ profile_id: 1, stage: 'cv' }, { profile_id: 2, stage: 'cv' }] }
  made(S, body); const v = versionOf(S)
  const next = { stages: [['a', 'A']], profiles: [{ profile_id: 1, stage: 'lmis' }, { profile_id: 2, stage: 'cv' }] }
  made(S, next); const d = JSON.parse(since(S, v))
  assert.equal(d.$rest, undefined); assert.equal(d.$set.length, 1)
  assert.deepEqual(merged(S, body, d), next)
  made(S, { ...next, stages: [['b', 'B']] })
  assert.deepEqual(merged(S, body, JSON.parse(since(S, v))), { ...next, stages: [['b', 'B']] })
})

test('a count that does not come out: not trusted', () => {
  assert.equal(merged(P, [{ id: 1 }], { $v: 'x', $count: 5, $set: [], $gone: [] }), null)
})

test('served: whole first with its version, then only the change; a window that does not ask gets it as ever', async () => {
  _reset(); forget(P)
  let rows = [...Array(50)].map((_, i) => ({ id: i + 1, name: 'n' + i }))
  const app = express(); app.use(answerCache()); app.get(P, (q, r) => r.json(rows))
  const s = app.listen(0), url = `http://127.0.0.1:${s.address().port}${P}`
  const get = async (have) => { const r = await fetch(url, have ? { headers: { 'X-Adal-Have': have } } : {}); return { v: r.headers.get('x-adal-v'), b: await r.json() } }
  const first = await get('0')
  assert.equal(first.b.length, 50); assert.ok(first.v)
  assert.deepEqual((await get(first.v)).b, { $v: first.v, $count: 50 })
  rows = rows.map(r => r.id === 3 ? { ...r, name: 'changed' } : r); forget(P)
  const d = await get(first.v)
  assert.deepEqual(d.b.$set, [{ id: 3, name: 'changed' }])
  const plain = await get(); assert.equal(plain.b.length, 50); assert.equal(plain.b[2].name, 'changed'); assert.equal(plain.v, null)
  s.close()
})
