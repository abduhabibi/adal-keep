import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The PC side of branch links (services/branchLinks.js) against a fake
// Supabase: what the sender is told for a wrong / expired / used code, the
// notification "<Agency> wants to link as your branch" (once), the profile
// summaries pulled again only from what changed, unlink forgetting them, and
// a plain word when branch-links.sql was not run yet.
// (The rules themselves are tested in Postgres: branchLinksSql.test.js.)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-branch-'))
process.env.ADAL_CHAT_SESSION_FILE = path.join(dir, 'chat.json')
process.env.SUPABASE_URL = 'http://cloud.test'
process.env.SUPABASE_ANON_KEY = 'anon'
fs.writeFileSync(process.env.ADAL_CHAT_SESSION_FILE, JSON.stringify({
  email: 'a@b', password: 'p', user_id: 'me-1', access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3600_000,
}))

const B_ID = '00000000-0000-0000-0000-00000000000b'
const REQ = '11111111-1111-1111-1111-111111111111'
const calls = []
let verifyAnswer = 'wrong', missing = false
let profileRows = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), body = opts.body ? JSON.parse(opts.body) : null
  calls.push({ u, body })
  const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  if (u.includes('/rpc/join_agency')) return ok(null)
  if (u.includes('/rest/v1/agencies')) return ok([{ id: 'me-1', name: 'Adal Nuzla Addis', banned: false }])
  if (missing && u.includes('/rpc/keep_branch')) return new Response(JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.keep_branch_list without parameters in the schema cache' }), { status: 404 })
  if (u.includes('/rpc/keep_branch_verify')) return ok(verifyAnswer)
  if (u.includes('/rpc/keep_branch_confirm')) return ok('042917')
  if (u.includes('/rpc/keep_branch_inbox')) return ok([{ id: REQ, agency_id: B_ID, name: 'Adal Nuzla Adama', city: 'Adama', status: 'pending', created_at: new Date().toISOString() }])
  if (u.includes('/rpc/keep_branch_outbox')) return ok([])
  if (u.includes('/rpc/keep_branch_list')) return ok([{ agency_id: B_ID, name: 'Adal Nuzla Adama', city: 'Adama', since: '2026-11-23T10:00:00Z', i_share: true, they_share: true }])
  if (u.includes('/rpc/keep_branch_profiles')) return ok(profileRows.filter(r => !body.p_since || r.updated_at > body.p_since))
  if (u.includes('/rpc/keep_branch_search')) return ok([{ id: B_ID, name: 'Adal Nuzla Adama', city: 'Adama', linked: false }])
  return ok(null)
}

// Just enough of knex for the settings and notifications this uses.
const tables = { settings: [], notifications: [], companies: [{ name: 'Adal Nuzla Addis' }] }
const db = (t) => {
  const rows = tables[t] || (tables[t] = [])
  let where = null
  const q = {
    where(w) { where = w; return q },
    first: async () => rows.find(r => !where || Object.entries(where).every(([k, v]) => r[k] === v)) || null,
    insert: async (row) => { rows.push(row); return [rows.length] },
    update: async (patch) => { rows.filter(r => !where || Object.entries(where).every(([k, v]) => r[k] === v)).forEach(r => Object.assign(r, patch)); return 1 },
    select() { return q },
  }
  return q
}

const B = await import('../src/services/branchLinks.js')
test.after(() => { globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }) })

test('search: name and city only', async () => {
  assert.deepEqual(await B.search(db, 'nu'), [{ id: B_ID, name: 'Adal Nuzla Adama', city: 'Adama', linked: false }])
  assert.deepEqual(await B.search(db, 'n'), [])   // two letters at least, nothing asked
})

test('the sender is told why a code did not work', async () => {
  for (const [answer, words] of [['wrong', /not right/], ['expired', /older than 10 minutes/], ['used', /already used/], ['too_many', /Connect again/], ['not_yet', /Yes, it is me/]]) {
    verifyAnswer = answer
    await assert.rejects(B.verify(db, REQ, '123456'), (e) => e.status === 400 && words.test(e.message), answer)
  }
  await assert.rejects(B.verify(db, REQ, '12345'), /6 digits/)
  await assert.rejects(B.verify(db, 'not-an-id', '123456'), /Not a known/)
  verifyAnswer = 'linked'
  assert.deepEqual(await B.verify(db, REQ, '123 456'), { linked: true })
  assert.equal(calls.filter(c => c.u.includes('keep_branch_verify')).pop().body.p_code, '123456')
})

test('"Yes, it is me" gives the code', async () => {
  const r = await B.yes(db, REQ)
  assert.equal(r.code, '042917')
  assert.ok(new Date(r.until) > new Date())
})

test('a request to link: one notification, once', async () => {
  await B.watchInbox(db)
  await B.watchInbox(db)
  assert.equal(tables.notifications.length, 1)
  assert.equal(tables.notifications[0].type, 'branch_link')
  assert.equal(tables.notifications[0].title, '🔗 Adal Nuzla Adama wants to link as your branch')
})

test('profile summaries: then only what changed; unlink forgets them', async () => {
  profileRows = [
    { id: 1, name: 'Almaz Test', passport: 'EP111', stage: 'medical', status: 'active', updated_at: '2026-11-23T10:00:00Z', deleted: false },
    { id: 2, name: 'Hana Test', passport: 'EP222', stage: 'visa', status: 'active', updated_at: '2026-11-23T10:05:00Z', deleted: false },
  ]
  await B.refreshAll(db)
  let r = await B.profiles(db, B_ID)
  assert.deepEqual(r.profiles.map(p => p.name), ['Hana Test', 'Almaz Test'])
  profileRows.push({ id: 1, name: 'Almaz Test', passport: 'EP111', stage: 'visa', status: 'active', updated_at: '2026-11-23T11:00:00Z', deleted: false },
    { id: 2, name: 'Hana Test', updated_at: '2026-11-23T11:01:00Z', deleted: true })
  r = await B.profiles(db, B_ID, { fresh: true })
  assert.deepEqual(r.profiles.map(p => [p.name, p.stage]), [['Almaz Test', 'visa']])
  assert.equal(calls.filter(c => c.u.includes('keep_branch_profiles')).pop().body.p_since, '2026-11-23T10:05:00Z')
  const st = await B.state(db)
  assert.equal(st.links[0].profiles, 1)
  assert.equal(st.inbox[0].name, 'Adal Nuzla Adama')
  await B.unlink(db, B_ID)
  assert.equal(calls.filter(c => c.u.includes('keep_branch_unlink')).pop().body.p_other, B_ID)
  assert.equal((await B.state(db)).links[0].profiles, null)
})

test('city saved here and online', async () => {
  await B.setCity(db, '  Adama  ')
  assert.equal(tables.settings.find(s => s.key === 'agency_city').value, 'Adama')
  assert.equal(calls.filter(c => c.u.includes('keep_set_city')).pop().body.p_city, 'Adama')
})

test('SQL not run yet: a plain word, not a server error', async () => {
  missing = true
  await assert.rejects(B.state(db), (e) => e.status === 503 && /branch-links\.sql/.test(e.message))
  missing = false
})
