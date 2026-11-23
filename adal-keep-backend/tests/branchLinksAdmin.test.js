/**
 * Adal Keep Admin → Agencies → Branches (adal-admin/server.mjs /api/branch-links),
 * on the pretend Supabase (adal-admin/tests/demo.mjs): every link with both
 * names, the requests (never a code), and Unlink.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
let demo
const call = async (p, body) => {
  const r = await fetch(demo.base + p, body ? { method: 'POST', headers: { cookie: demo.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: { cookie: demo.cookie } })
  return { status: r.status, json: await r.json().catch(() => null) }
}

before(async () => { demo = await (await import(pathToFileURL(path.join(REPO, 'adal-admin', 'tests', 'demo.mjs')).href)).startDemo() })
after(() => demo?.stop())

test('Admin lists the links and requests, and can unlink', async () => {
  let { status, json } = await call('/api/branch-links')
  assert.equal(status, 200, JSON.stringify(json))
  assert.deepEqual(json.links.map(l => [l.a.name, l.b.name, l.a_shares, l.b_shares]), [['Habesha Recruitment', 'Selam Overseas Employment', true, false]])
  assert.deepEqual(json.requests.map(r => [r.from.name, r.to.name, r.status]).sort(), [['Selam Overseas Employment', 'Habesha Recruitment', 'linked'], ['Tana Agency', 'Abay Manpower', 'pending']])
  assert.ok(!JSON.stringify(json).includes('code_hash'))
  const l = json.links[0]
  assert.equal((await call('/api/branch-links/unlink', { a: l.b.id, b: l.a.id })).status, 200)
  ;({ json } = await call('/api/branch-links'))
  assert.equal(json.links.length, 0)
  assert.equal((await call('/api/branch-links/unlink', { a: 'x', b: 'y' })).status >= 400, true)
})
