/**
 * fileOnDemand.test.js — a photo listed here whose file is still on another PC
 * (asked on 2026-11-23): fetched at once from the agency's other PCs, once at a time.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { fetchMissing, _reset } = await import('../src/services/fileOnDemand.js')

function fakeNode({ have = false, peers = [{ pc_id: 'b', name: 'PC-B' }], body = Buffer.from('jpeg bytes'), fail = null } = {}) {
  const n = { calls: 0, put: [], docs: { has: () => have || n.put.length > 0, put: async (name, buf) => { n.put.push([name, buf.toString()]) }, listCache: 1 } }
  n.others = async () => peers
  n.reach = async (pc) => `http://${pc.pc_id}`
  n.call = async (url, method, p) => { n.calls++; await new Promise(r => setTimeout(r, 20)); if (fail) throw Object.assign(new Error('nope'), { status: fail }); assert.equal(p, '/doc/uploads%2F7%2F8%2Fa.jpg'); return body }
  return n
}

test('a file not here yet is fetched from another PC; two asks at once fetch it once', async () => {
  _reset()
  const node = fakeNode()
  const [a, b] = await Promise.all([fetchMissing({ path: 'uploads/7/8/a.jpg' }, { node }), fetchMissing({ path: 'uploads/7/8/a.jpg' }, { node })])
  assert.equal(a, true); assert.equal(b, true)
  assert.equal(node.calls, 1)
  assert.deepEqual(node.put, [['uploads/7/8/a.jpg', 'jpeg bytes']])
})

test('no PC has it: false, and not asked again for a minute; a file already here is not fetched', async () => {
  _reset()
  const node = fakeNode({ fail: 404 })
  assert.equal(await fetchMissing({ path: 'uploads/7/8/a.jpg' }, { node }), false)
  assert.equal(await fetchMissing({ path: 'uploads/7/8/a.jpg' }, { node }), false)
  assert.equal(node.calls, 1)
  const here = fakeNode({ have: true })
  assert.equal(await fetchMissing({ path: 'uploads/7/8/a.jpg' }, { node: here }), true)
  assert.equal(here.calls, 0)
  // No sync node (a PC alone): nothing to ask.
  assert.equal(await fetchMissing({ path: 'uploads/7/8/b.jpg' }, { node: null }), false)
})
