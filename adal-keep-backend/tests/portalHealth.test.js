import test from 'node:test'
import assert from 'node:assert/strict'
import { checkPortals } from '../src/services/portalHealth.js'

const portals = [{ key: 'a', name: 'A', url: 'https://a/' }, { key: 'b', name: 'B', url: 'https://b/' }]
const answer = (status) => ({ status, body: null })

test('a firewall answer counts as up; a server error twice counts as down', async () => {
  const r = await checkPortals({ portals, retryMs: 1, fetchFn: async (u) => answer(u.includes('a') ? 403 : 503) })
  assert.deepEqual(r.portals.map(p => [p.key, p.ok]), [['a', true], ['b', false]])
  assert.match(r.portals[1].why, /503/)
})

test('a portal that answers on the second try is up', async () => {
  let n = 0
  const r = await checkPortals({ portals, retryMs: 1, fetchFn: async (u) => { if (u.includes('b') && !n++) throw new Error('reset'); return answer(200) } })
  assert.ok(r.portals.every(p => p.ok))
})

test('nothing answers: it is the internet, one line', async () => {
  const r = await checkPortals({ portals, retryMs: 1, fetchFn: async () => { throw new Error('ENOTFOUND') } })
  assert.deepEqual(r.portals.map(p => p.key), ['internet'])
})
