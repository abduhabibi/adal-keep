// A job looks only at the girls changed since its last look (changedOnly.js, from the change log).
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { makePC, syncPair, scratch } from './helpers/syncPCs.js'
import { changedGirls } from '../src/services/changedOnly.js'

process.env.ADAL_SYNC_ID = path.join(scratch('id'), 'sync-id.json')

test('first look: all; then only the changed girls, whoever changed them; nothing changed: none', async () => {
  const a = await makePC('ChgA', { slot: 1 }), b = await makePC('ChgB', { slot: 2 })
  try {
    const db = a.app
    const ids = []
    for (let i = 0; i < 5; i++) ids.push((await db('profiles').insert({ full_name: `G${i}` }))[0])
    await a.engine.stampNow()
    const look = async (name = 'job', o) => { await a.engine.stampNow(); const l = await changedGirls(db, name, o); return l }
    let l = await look(); assert.equal(l.ids, null, 'the first: all of them'); l.done()
    l = await look(); assert.deepEqual([...l.ids], []); assert.equal(l.others.size, 0); l.done()
    await db('profiles').where({ id: ids[1] }).update({ status: 'ready' })
    const [f] = await db('profile_fields').insert({ profile_id: ids[3], name: 'Photo' })
    await db('files').insert({ profile_field_id: f, path: 'x' })
    l = await look(); assert.deepEqual([...l.ids].sort(), [ids[1], ids[3]].sort())
    // Not done (the job failed): the same girls again.
    l = await look(); assert.deepEqual([...l.ids].sort(), [ids[1], ids[3]].sort()); l.done()
    l = await look(); assert.equal(l.ids.size, 0); l.done()
    // From another PC.
    await syncPair(a, b)
    await b.app('profiles').where({ id: ids[2] }).update({ notes: 'from B' })
    await syncPair(a, b)
    l = await look(); assert.deepEqual([...l.ids], [ids[2]]); l.done()
    // Something that is no girl's: told apart.
    await db('settings').insert({ key: 'k', value: '1' })
    l = await look(); assert.equal(l.ids.size, 0); assert.ok(l.others.has('settings')); l.done()
    // Each job has its own place.
    l = await look('other'); assert.equal(l.ids, null)
    // All again every 6 hours.
    l = await look('job', { now: Date.now() + 7 * 3600e3 }); assert.equal(l.ids, null)
  } finally { await a.close(); await b.close() }
})
test('off switch, and a database without a change log: everything, as before', async () => {
  const a = await makePC('ChgOff', { slot: 1 })
  try {
    await a.app('profiles').insert({ full_name: 'X' }); await a.engine.stampNow()
    ;(await changedGirls(a.app, 'x')).done()
    process.env.ADAL_CHANGED_ONLY_X = '0'
    assert.equal((await changedGirls(a.app, 'x')).ids, null)
    delete process.env.ADAL_CHANGED_ONLY_X
    await a.db.raw('DROP TABLE sync_log')
    assert.equal((await changedGirls(a.app, 'x')).ids, null)
  } finally { await a.close() }
})

test('the scanner: nothing changed, nothing read; a change: the whole scan', async () => {
  const a = await makePC('ChgScan', { slot: 1 })
  try {
    const { scanOnce } = await import('../src/services/autoScanner.js')
    await a.app.schema.alterTable('profiles', t => { for (const c of ['destination_country', 'labor_id', 'order_id', 'chosen_at', 'musaned_stage']) t.string(c) })
    await a.engine.refreshTables()
    await a.app('profiles').insert({ full_name: 'X' }); await a.engine.stampNow()
    let reads = []
    a.app.on('query', q => { if (/automation_queue/.test(q.sql)) reads.push(q.sql) })
    await scanOnce(a.app)
    await scanOnce(a.app)
    reads = []
    await scanOnce(a.app)
    assert.equal(reads.length, 0)
    await a.app('profiles').update({ status: 'ready' }); await a.engine.stampNow()
    await scanOnce(a.app)
    assert.ok(reads.length > 0)
  } finally { await a.close() }
})
