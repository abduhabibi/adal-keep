// A profile made on a phone with the PC off has the phone's own number (below
// 0): when the PC carries out the phone's requests, its real number (and her
// field's real number) is put in its place.
import test from 'node:test'
import assert from 'node:assert/strict'
import { realPath } from '../src/services/cloudSync.js'

// A knex stand-in with two tables.
function fakeDb(tables) {
  return (name) => {
    let rows = tables[name] || []
    const q = {
      where: (w) => { rows = rows.filter(r => Object.entries(w).every(([k, v]) => r[k] === v)); return q },
      orderBy: () => q,
      first: async () => rows[0] || null,
    }
    return q
  }
}
const db = fakeDb({
  cloud_sync: [{ key: 'ref:profile:-111', hash: '42' }, { key: 'ref:checklist:-5', hash: '9' }],
  profile_fields: [{ id: 700, profile_id: 42, name: 'Photo' }, { id: 701, profile_id: 42, name: 'Passport' }],
})

test('her requests go to her real profile and field', async () => {
  assert.equal(await realPath(db, { path: '/profiles/-111' }), '/profiles/42')
  assert.equal(await realPath(db, { path: '/profiles/-111/fields/-3/upload', field_name: 'Passport' }), '/profiles/42/fields/701/upload')
  assert.equal(await realPath(db, { path: '/profiles/12/fields/88/upload' }), '/profiles/12/fields/88/upload')
  assert.equal(await realPath(db, { path: '/checklists/-5/profiles' }), '/checklists/9/profiles')
  const cv = { path: '/cv/generate', body: { profile_id: -111, template_id: 1 } }
  assert.equal(await realPath(db, cv), '/cv/generate')
  assert.equal(cv.body.profile_id, 42)
})

test('a profile not made yet waits (an error the phone sees)', async () => {
  await assert.rejects(realPath(db, { path: '/profiles/-999/fields/-1/upload', field_name: 'Photo' }), /not made/)
})
