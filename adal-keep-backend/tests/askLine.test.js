/** askLine.test.js — the window's questions to the PC wait in one line (services/api.js): refreshes never hold every connection (2026-11-25: photos waited 2–9 s for one). */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'

const src = fs.readFileSync(new URL('../../adal-keep-frontend/src/services/api.js', import.meta.url), 'utf8')
const from = src.indexOf('// The browser keeps 6 connections'), to = src.indexOf('// Every page\'s data kept on this device')
const code = src.slice(from, to).replace(/import\.meta\.env\.VITE_\w+/g, "'0'")
const tick = () => new Promise(r => setTimeout(r, 2))
function make() {
  const asked = []
  const api = { get: (url) => new Promise((ok, no) => { asked.push({ url, ok: () => ok({ data: url }), no }) }) }
  new Function('api', 'off', 'window', code)(api, () => false, {})
  return { api, asked, open: (u) => asked.find(a => a.url === u) }
}

test('2 refreshes at once, 4 in all; what a person asks goes before the waiting refreshes', async () => {
  const { api, asked, open } = make()
  const all = ['/a', '/b', '/c', '/d'].map(u => api.get(u, { adalBehind: true }))
  assert.deepEqual(asked.map(a => a.url), ['/a', '/b'])
  const mine = ['/1', '/2', '/3'].map(u => api.get(u))
  assert.deepEqual(asked.map(a => a.url), ['/a', '/b', '/1', '/2'])
  open('/a').ok(); await tick()
  assert.deepEqual(asked.map(a => a.url), ['/a', '/b', '/1', '/2', '/3'])     // not /c
  for (const u of ['/1', '/2', '/3', '/b']) open(u).ok()
  await tick(); await tick()
  open('/c').ok(); open('/d').ok()
  assert.deepEqual((await Promise.all([...all, ...mine])).map(r => r.data), ['/a', '/b', '/c', '/d', '/1', '/2', '/3'])
})

test('a person asks for what a waiting refresh asks for: one question, and it goes now; a failure frees its place', async () => {
  const { api, asked, open } = make()
  const p = ['/a', '/b', '/c'].map(u => api.get(u, { adalBehind: true }))
  const mine = api.get('/c')
  assert.deepEqual(asked.map(a => a.url), ['/a', '/b', '/c'])
  open('/a').no(new Error('off')); await assert.rejects(p[0], /off/)
  open('/c').ok(); assert.equal((await mine).data, '/c'); open('/b').ok()
  await Promise.all(p.slice(1))
  const again = api.get('/a'); await tick(); assert.equal(asked.filter(a => a.url === '/a').length, 2); asked.at(-1).ok(); await again
})

test('pictures and downloads are never in the line', () => {
  const { api, asked } = make()
  for (let i = 0; i < 9; i++) api.get('/f' + i, { responseType: 'blob' })
  assert.equal(asked.length, 9)
})
