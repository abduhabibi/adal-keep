// The agency's PCs each work on their own copy and end up the same
// (services/sync/engine.js): field by field, deletes, merges, ids, days offline.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { makePC, syncPair, dump, scratch } from './helpers/syncPCs.js'
import { SLOTS, TIME_ID_MIN } from '../src/services/sync/ids.js'
import { Clock, parse } from '../src/services/sync/hlc.js'

process.env.ADAL_SYNC_ID = path.join(scratch('id'), 'sync-id.json')

const close = (...pcs) => Promise.all(pcs.map(p => p.close()))

test('the clock: later changes sort later, a stamp from another PC moves it on', () => {
  let t = 1000
  const a = new Clock('aaaaaaaaaaaa', '', () => t)
  const s1 = a.tick(t), s2 = a.tick(t)
  assert.ok(s2 > s1, 'same millisecond: the count goes up')
  const b = new Clock('bbbbbbbbbbbb', '', () => t)
  b.recv(s2)
  assert.ok(b.tick(t - 500) > s2, 'after seeing another PC, never behind it (even with a slow clock)')
  // A clock far ahead does not drag this one with it.
  b.recv(new Clock('cccccccccccc', '', () => t).tick(t + 365 * 86400000))
  assert.ok(parse(b.last).l <= t + 10 * 60 * 1000)
})

test('new rows on two PCs never get the same id, and stay newest-last', async () => {
  const main = await makePC('Main', { slot: 1 }), comp = await makePC('Comp', { slot: 2 })
  try {
    const ids = []
    for (let i = 0; i < 50; i++) {
      ids.push(...await main.app('profiles').insert({ full_name: `M${i}` }))
      ids.push(...await comp.app('profiles').insert({ full_name: `C${i}` }))
    }
    assert.equal(new Set(ids).size, ids.length)
    for (const id of ids) assert.ok(id >= TIME_ID_MIN && Number.isSafeInteger(id))
    assert.deepEqual(new Set(ids.map(id => id % SLOTS)), new Set([1, 2]))
    // Several in one insert.
    const before = (await main.app('profiles').max('id as m'))[0].m
    await main.app('profiles').insert([{ full_name: 'x' }, { full_name: 'y' }])
    const two = await main.app('profiles').where('id', '>', before).select('id')
    assert.equal(two.length, 2)
    await syncPair(main, comp)
    assert.equal((await dump(main, 'profiles')).length, 102)
    assert.deepEqual(await dump(main, 'profiles'), await dump(comp, 'profiles'))
  } finally { await close(main, comp) }
})

test('the same girl edited on two PCs while apart: every field kept, the same result everywhere', async () => {
  let t = Date.now()
  const now = () => t
  const main = await makePC('Main2', { slot: 1, now }), comp = await makePC('Comp2', { slot: 2, now })
  try {
    const [id] = await main.app('profiles').insert({ full_name: 'ALMAZ TESFAYE', passport_number: 'EP1111111', status: 'new' })
    await syncPair(main, comp)
    // Apart: different fields, and one field both change.
    await main.app('profiles').where({ id }).update({ phone_number: '0911000000', notes: 'main note' })
    t += 1000
    // (The triggers stamp with SQLite's own clock, not `t`: in the same millisecond the PC's id decides.)
    await new Promise(r => setTimeout(r, 5))
    await comp.app('profiles').where({ id }).update({ status: 'ready', notes: 'companion note (later)' })
    t += 1000
    await syncPair(comp, main)
    const a = await dump(main, 'profiles'), b = await dump(comp, 'profiles')
    assert.deepEqual(a, b)
    assert.equal(a[0].phone_number, '0911000000', "Main's field kept")
    assert.equal(a[0].status, 'ready', "the Companion's field kept")
    assert.equal(a[0].notes, 'companion note (later)', 'the same field: the later change')
    // Syncing again changes nothing (idempotent).
    const v = await main.engine.vector()
    await syncPair(main, comp)
    assert.deepEqual(await main.engine.vector(), v)
    assert.deepEqual(await dump(main, 'profiles'), a)
  } finally { await close(main, comp) }
})

test('a delete is a tombstone: it wins over older edits and never comes back', async () => {
  let t = Date.now()
  const now = () => t
  const a = await makePC('Del1', { slot: 1, now }), b = await makePC('Del2', { slot: 2, now }), c = await makePC('Del3', { slot: 3, now })
  try {
    const [id] = await a.app('profiles').insert({ full_name: 'TO GO' })
    await syncPair(a, b); await syncPair(b, c)
    await b.app('profiles').where({ id }).update({ notes: 'edited before the delete' })
    t += 1000
    await a.app('profiles').where({ id }).del()
    t += 1000
    await syncPair(a, c)   // c hears of the delete first
    await syncPair(b, c)   // then of the older edit (and b of the delete)
    await syncPair(a, b)
    for (const p of [a, b, c]) assert.equal((await dump(p, 'profiles')).length, 0, p.name)
  } finally { await close(a, b, c) }
})

test('the same passport made on two PCs: one girl, every field and document kept, on every PC', async () => {
  let t = Date.now()
  const now = () => t
  const main = await makePC('Mrg1', { slot: 1, now }), comp = await makePC('Mrg2', { slot: 2, now }), third = await makePC('Mrg3', { slot: 3, now })
  try {
    const [m] = await main.app('profiles').insert({ full_name: 'SARA KEBEDE', passport_number: 'EP2222222', phone_number: '0911111111' })
    const [mf] = await main.app('profile_fields').insert({ profile_id: m, name: 'Passport' })
    await main.app('files').insert({ profile_field_id: mf, path: 'main-passport.jpg' })
    await main.app('profile_days').insert({ profile_id: m, day: '2026-11-19', data: 'main' })
    t += 1000
    const [c] = await comp.app('profiles').insert({ full_name: 'SARA KEBEDE', passport_number: ' ep2222222 ', notes: 'from the Companion' })
    const [cf] = await comp.app('profile_fields').insert({ profile_id: c, name: 'Medical' })
    await comp.app('files').insert({ profile_field_id: cf, path: 'comp-medical.pdf' })
    await comp.app('profile_days').insert({ profile_id: c, day: '2026-11-19', data: 'comp' })
    await comp.app('generated_cvs').insert({ profile_id: c, filename: 'cv.pdf', pdf_path: 'cv.pdf' })
    t += 1000
    // The third PC hears from the Companion first, then from Main.
    await syncPair(comp, third)
    await syncPair(main, third)
    await syncPair(main, comp)
    await syncPair(comp, third)
    const keep = String(m < c ? m : c)
    for (const p of [main, comp, third]) {
      const girls = await dump(p, 'profiles')
      assert.equal(girls.length, 1, `${p.name}: one girl`)
      assert.equal(String(girls[0].id), keep, 'the older id stays')
      assert.equal(girls[0].phone_number, '0911111111', `${p.name}: Main's field`)
      assert.equal(girls[0].notes, 'from the Companion', `${p.name}: the Companion's field`)
      const fields = await dump(p, 'profile_fields')
      assert.equal(fields.length, 2, `${p.name}: both fields`)
      assert.ok(fields.every(f => String(f.profile_id) === keep), `${p.name}: her fields are hers`)
      assert.equal((await dump(p, 'files')).length, 2, `${p.name}: both documents`)
      const cvs = await dump(p, 'generated_cvs')
      assert.equal(String(cvs[0].profile_id), keep, `${p.name}: the CV is hers`)
      assert.equal((await dump(p, 'profile_days')).length, 1, `${p.name}: one row for the day`)
    }
    // Where the other row was already in, it is kept as it was (and every entry stays in the log).
    const kept = await comp.db.raw(`SELECT * FROM sync_conflicts WHERE kind = 'merged' AND tbl = 'profiles'`)
    assert.equal(kept.length, 1)
    assert.equal(JSON.parse(kept[0].data).notes, 'from the Companion')
    assert.deepEqual(await dump(main, 'profiles'), await dump(comp, 'profiles'))
    assert.deepEqual(await dump(main, 'profiles'), await dump(third, 'profiles'))
    assert.deepEqual(await dump(main, 'profile_fields'), await dump(third, 'profile_fields'))
    assert.deepEqual(await dump(main, 'profile_days'), await dump(comp, 'profile_days'))
    // A PC joining later gets one girl too.
    const late = await makePC('Mrg4', { slot: 4, now })
    try {
      await syncPair(comp, late)
      assert.deepEqual(await dump(late, 'profiles'), await dump(main, 'profiles'))
      assert.deepEqual(await dump(late, 'profile_fields'), await dump(main, 'profile_fields'))
    } finally { await late.close() }
  } finally { await close(main, comp, third) }
})

test('a setting made on two PCs is one setting (the newer value)', async () => {
  let t = Date.now()
  const now = () => t
  const a = await makePC('Set1', { slot: 1, now }), b = await makePC('Set2', { slot: 2, now })
  try {
    await a.app('settings').insert({ key: 'agency_name', value: 'Old name' })
    t += 1000
    await b.app('settings').insert({ key: 'agency_name', value: 'New name' })
    t += 1000
    await syncPair(a, b)
    const sa = await dump(a, 'settings'), sb = await dump(b, 'settings')
    assert.equal(sa.length, 1)
    assert.deepEqual(sa, sb)
    assert.equal(sa[0].value, 'New name')
  } finally { await close(a, b) }
})

test('a Companion starts from a copy of Main: old rows, new rows, its own queue empty', async () => {
  const dir = scratch('boot')
  const main = await makePC('Boot1', { slot: 1, schema: false, dir: path.join(dir, 'main') })
  // (Main had data before the copying existed: made with no triggers.)
  const { makeSchema } = await import('./helpers/syncPCs.js')
  await main.close()
  fs.rmSync(path.join(dir, 'main'), { recursive: true, force: true })
  const fresh = await import('knex').then(k => k.default({ client: 'sqlite3', connection: { filename: path.join(dir, 'old.sqlite') }, useNullAsDefault: true }))
  await makeSchema(fresh)
  await fresh('profiles').insert({ id: 7, full_name: 'OLD GIRL', passport_number: 'EP0000007' })
  await fresh('ingest_queue').insert({ filename: 'main-only.pdf' })
  await fresh.destroy()
  fs.mkdirSync(path.join(dir, 'm'), { recursive: true })
  fs.copyFileSync(path.join(dir, 'old.sqlite'), path.join(dir, 'm', 'data.sqlite'))
  const m = await makePC('BootM', { slot: 1, schema: false, dir: path.join(dir, 'm') })
  await m.app('profiles').insert({ full_name: 'NEW ON MAIN' })
  await m.app('profiles').where({ id: 7 }).update({ status: 'ready' })
  // The Companion's first copy: Main's database file as it is (replica.js).
  await m.db.raw('PRAGMA wal_checkpoint(TRUNCATE)')
  fs.mkdirSync(path.join(dir, 'c'), { recursive: true })
  fs.copyFileSync(m.file, path.join(dir, 'c', 'data.sqlite'))
  const c = await makePC('BootC', { slot: 2, schema: false, dir: path.join(dir, 'c') })
  try {
    assert.equal((await c.db.raw('SELECT COUNT(*) AS n FROM ingest_queue'))[0].n, 0, "Main's own queue is not the Companion's")
    await c.app('profiles').where({ id: 7 }).update({ notes: 'seen on the Companion' })
    const [nid] = await c.app('profiles').insert({ full_name: 'NEW ON COMPANION' })
    assert.equal(nid % SLOTS, 2)
    await syncPair(m, c)
    assert.deepEqual(await dump(m, 'profiles'), await dump(c, 'profiles'))
    const old = (await dump(m, 'profiles')).find(p => p.id === 7)
    assert.equal(old.status, 'ready'); assert.equal(old.notes, 'seen on the Companion'); assert.equal(old.full_name, 'OLD GIRL')
  } finally { await close(m, c) }
})

test('weeks offline with thousands of changes: it all arrives, in pieces, and the log can be trimmed', async () => {
  let t = Date.now()
  const now = () => t
  const a = await makePC('Off1', { slot: 1, now }), b = await makePC('Off2', { slot: 2, now })
  try {
    const [id] = await a.app('profiles').insert({ full_name: 'BUSY' })
    await syncPair(a, b)
    // b is away for 3 weeks; both keep working.
    for (let day = 0; day < 21; day++) {
      t += 86400000
      for (let i = 0; i < 40; i++) {
        await a.app('profiles').insert({ full_name: `A day ${day} #${i}` })
        await b.app('profiles').insert({ full_name: `B day ${day} #${i}` })
      }
      await a.app('profiles').where({ id }).update({ notes: `a ${day}` })
      await b.app('profiles').where({ id }).update({ status: `b ${day}` })
      await a.engine.stampNow(); await b.engine.stampNow()   // (each day's changes in the log by evening)
    }
    const before = await a.engine.compact()
    assert.ok(before.after < before.before, 'superseded entries trimmed')
    await syncPair(a, b)
    const da = await dump(a, 'profiles'), db2 = await dump(b, 'profiles')
    assert.equal(da.length, 1 + 21 * 80)
    assert.deepEqual(da, db2)
    const busy = da.find(p => p.id === id)
    assert.equal(busy.notes, 'a 20'); assert.equal(busy.status, 'b 20')
    // A third PC joining later, from a trimmed log, ends the same.
    const c = await makePC('Off3', { slot: 3, now })
    try { await syncPair(b, c); assert.deepEqual(await dump(c, 'profiles'), da) } finally { await c.close() }
  } finally { await close(a, b) }
})

test('an update that comes before its row waits, then goes in', async () => {
  let t = Date.now()
  const now = () => t
  const a = await makePC('Pend1', { slot: 1, now }), b = await makePC('Pend2', { slot: 2, now }), c = await makePC('Pend3', { slot: 3, now })
  try {
    const [id] = await a.app('profiles').insert({ full_name: 'LATE' })
    await syncPair(a, b)
    t += 1000
    await b.app('profiles').where({ id }).update({ notes: 'from b' })
    // c gets only b's own entries (not a's insert): through the online copy, say.
    const fromB = (await b.engine.changesSince({}, 1000)).entries.filter(e => e.origin === b.engine.pcId)
    await c.engine.apply(fromB, {})
    assert.equal((await dump(c, 'profiles')).length, 0)
    assert.equal((await c.engine.stats()).pending, 1)
    await syncPair(a, c)
    const rows = await dump(c, 'profiles')
    assert.equal(rows.length, 1); assert.equal(rows[0].notes, 'from b'); assert.equal(rows[0].full_name, 'LATE')
    assert.equal((await c.engine.stats()).pending, 0)
  } finally { await close(a, b, c) }
})
