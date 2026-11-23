#!/usr/bin/env node
/**
 * Live isolation check against a Supabase project (run by Adal, never in the test suite):
 * two agencies A and B each sign in, A writes rows and a file, and B must see none of them.
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… A_EMAIL=… A_PASSWORD=… B_EMAIL=… B_PASSWORD=… node scripts/rls-live-check.mjs
 * Use two TEST agencies. Exit 0 only when every cross-agency read is empty / refused.
 */
const { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON, A_EMAIL, A_PASSWORD, B_EMAIL, B_PASSWORD } = process.env
if (![URL_, ANON, A_EMAIL, A_PASSWORD, B_EMAIL, B_PASSWORD].every(Boolean)) { console.error('set SUPABASE_URL, SUPABASE_ANON_KEY, A_EMAIL, A_PASSWORD, B_EMAIL, B_PASSWORD'); process.exit(2) }

async function login(email, password) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const j = await r.json(); if (!j.access_token) throw new Error(`sign-in failed for ${email}: ${j.error_description || r.status}`)
  return { token: j.access_token, id: j.user.id }
}
const call = (who, method, p, body, extra = {}) => fetch(`${URL_}${p}`, { method, headers: { apikey: ANON, authorization: `Bearer ${who.token}`, 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) })

const TABLES = ['keep_devices', 'keep_profiles', 'keep_files', 'keep_runs', 'keep_tasks', 'keep_meta', 'keep_changes', 'keep_calls', 'keep_secrets', 'keep_pairing', 'keep_join_requests', 'keep_audit', 'agency_config', 'agency_signups', 'install_codes', 'agency_invites', 'typing']
let bad = 0
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) bad++ }

const A = await login(A_EMAIL, A_PASSWORD), B = await login(B_EMAIL, B_PASSWORD)
const mark = `rls-check-${Date.now()}`
// A writes a meta row and a file in its own folder.
await call(A, 'POST', '/rest/v1/keep_meta?on_conflict=agency_id,key', [{ agency_id: A.id, key: `/${mark}`, data: { secret: mark } }], { Prefer: 'resolution=merge-duplicates,return=minimal' })
const put = await call(A, 'POST', `/storage/v1/object/keep/${A.id}/_check/${mark}`, Buffer.from(mark), { 'content-type': 'text/plain', 'x-upsert': 'true' })
check(put.ok, 'A can write its own row and file')

for (const t of TABLES) {
  const r = await call(B, 'GET', `/rest/v1/${t}?select=*&limit=50`)
  const rows = r.ok ? await r.json() : []
  const foreign = Array.isArray(rows) ? rows.filter(x => x.agency_id && x.agency_id === A.id) : []
  check(foreign.length === 0, `B reads none of A's rows in ${t}${r.ok ? '' : ` (refused ${r.status})`}`)
}
const mine = await call(B, 'GET', `/rest/v1/keep_meta?key=eq./${mark}&select=data`); check((await mine.json()).length === 0, "B cannot read A's meta row by key")
check(!(await call(B, 'GET', `/storage/v1/object/authenticated/keep/${A.id}/_check/${mark}`)).ok, "B cannot download A's file")
check(!(await call(B, 'POST', `/storage/v1/object/keep/${A.id}/_check/b-wrote-here`, Buffer.from('x'), { 'content-type': 'text/plain' })).ok, "B cannot write into A's folder")
check(!(await call(B, 'DELETE', `/storage/v1/object/keep/${A.id}/_check/${mark}`)).ok || (await call(A, 'GET', `/storage/v1/object/authenticated/keep/${A.id}/_check/${mark}`)).ok, "B cannot delete A's file")
const list = await call(B, 'POST', '/storage/v1/object/list/keep', { prefix: `${A.id}/`, limit: 20 }); const l = list.ok ? await list.json() : []
check(!l.length, "B's listing of A's folder is empty")
const wr = await call(B, 'POST', '/rest/v1/keep_meta?on_conflict=agency_id,key', [{ agency_id: A.id, key: `/${mark}-b`, data: {} }], { Prefer: 'return=minimal' })
check(!wr.ok, "B cannot write a row for A's agency")

// clean up what A wrote
await call(A, 'DELETE', `/rest/v1/keep_meta?key=eq./${mark}`); await call(A, 'DELETE', `/storage/v1/object/keep/${A.id}/_check/${mark}`)
console.log(bad ? `\n${bad} check(s) FAILED` : '\nAll isolation checks passed'); process.exit(bad ? 1 : 0)
