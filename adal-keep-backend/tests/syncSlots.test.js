// Two PCs with one slot make the same row ids: a girl's row went over another's (2026-11-25, two
// PCs of an office both "slot 1"). A PC coming in never gets a used slot; two that meet, one moves.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { makePC, syncPair, dump, scratch } from './helpers/syncPCs.js'
import { SyncNode } from '../src/services/sync/node.js'

process.env.ADAL_SYNC_ID = path.join(scratch('id'), 'sync-id.json')
const quiet = { info() {}, warn() {} }
let clock = Date.now()
const nodeOf = async (name, slot, pcId) => {
  const pc = await makePC(name, { slot, pcId, now: () => clock })
  const node = new SyncNode({ engine: pc.engine, safeDir: pc.safe, key: `key-${name}`, port: 1, name, addresses: () => [], mainURL: () => '', log: quiet, now: () => clock })
  node.onSlot = (s) => { pc.app.client.config.syncSlot = s; node.moved = s }
  return { pc, node, close: async () => { node.stop(); await pc.close() } }
}

test('a PC that came with its own slot 1 gets a free one when it joins', async () => {
  const main = await nodeOf('SlotMain', 1, 'aaaaaaaaaaaa')
  try {
    await main.node.start({ timers: false, claim: true })
    await main.pc.db.raw(`INSERT INTO sync_pcs (pc_id, name, slot, key_hash, joined_at) VALUES ('bbbbbbbbbbbb', 'U5', 1, 'h', '2026-11-24T08:00:00.000Z')`)
    const j = await main.node.admit({ pc_id: 'bbbbbbbbbbbb', name: 'U5', key: 'k' })
    assert.notEqual(j.slot, 1)
    assert.equal((await main.node.admit({ pc_id: 'bbbbbbbbbbbb', name: 'U5', key: 'k' })).slot, j.slot, 'again: its own')
    assert.notEqual((await main.node.admit({ pc_id: 'cccccccccccc', name: 'third', key: 'k3' })).slot, j.slot)
  } finally { await main.close() }
})

test('two PCs that both run as slot 1 meet: the later one moves, the first stays, new rows have different ids', async () => {
  const a = await nodeOf('SlotA', 1, 'aaaaaaaaaaaa'), b = await nodeOf('SlotB', 1, 'bbbbbbbbbbbb')
  try {
    await a.node.start({ timers: false, claim: true })
    clock += 60_000
    await b.node.start({ timers: false, claim: false })
    await syncPair(a.pc, b.pc)
    await a.node.selfRow(); await b.node.selfRow()
    assert.equal(a.node.moved, undefined); assert.equal(a.pc.engine.slot, 1)
    assert.equal(b.node.moved, 2); assert.equal(b.pc.engine.slot, 2)
    await syncPair(a.pc, b.pc)
    await a.node.selfRow(); await b.node.selfRow()
    assert.equal(b.pc.engine.slot, 2, 'it stays there')
    await Promise.all([...Array(40).keys()].flatMap(i => [a.pc.app('profiles').insert({ full_name: `A${i}` }), b.pc.app('profiles').insert({ full_name: `B${i}` })]))
    await syncPair(a.pc, b.pc)
    assert.equal((await dump(a.pc, 'profiles')).length, 80)
    assert.deepEqual(await dump(a.pc, 'profiles'), await dump(b.pc, 'profiles'))
  } finally { await a.close(); await b.close() }
})

test('off switch: as before', async () => {
  process.env.ADAL_SLOT_CHECK = '0'
  const main = await nodeOf('SlotOff', 1, 'aaaaaaaaaaaa')
  try {
    await main.node.start({ timers: false, claim: true })
    await main.pc.db.raw(`INSERT INTO sync_pcs (pc_id, name, slot, key_hash) VALUES ('bbbbbbbbbbbb', 'U5', 1, 'h')`)
    assert.equal((await main.node.admit({ pc_id: 'bbbbbbbbbbbb', name: 'U5', key: 'k' })).slot, 1)
  } finally { delete process.env.ADAL_SLOT_CHECK; await main.close() }
})
