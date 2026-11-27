// The online copy's batch has each key once (Main, 2026-11-27: 114 rounds refused by Postgres with a key twice).
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.SUPABASE_URL = ''
process.env.SUPABASE_ANON_KEY = ''
const { oncePerKey } = await import('../src/services/cloudSync.js')

test('a key twice: one row, the last one read', () => {
  const rows = [{ agency_id: 'a', key: '/dashboard', data: 1 }, { agency_id: 'a', key: '/profiles/7', data: 2 }, { agency_id: 'a', key: '/dashboard', data: 3 }]
  assert.deepEqual(oncePerKey(rows, 'agency_id,key'), [rows[1], rows[2]])
})

test('different agencies, or no repeat: unchanged', () => {
  const rows = [{ agency_id: 'a', key: '/x' }, { agency_id: 'b', key: '/x' }]
  assert.equal(oncePerKey(rows, 'agency_id,key'), rows)
})

test('off: ADAL_CLOUD_DEDUPE=0 sends the rows as they are', () => {
  process.env.ADAL_CLOUD_DEDUPE = '0'
  const rows = [{ agency_id: 'a', key: '/x' }, { agency_id: 'a', key: '/x' }]
  try { assert.equal(oncePerKey(rows, 'agency_id,key'), rows) } finally { delete process.env.ADAL_CLOUD_DEDUPE }
})
