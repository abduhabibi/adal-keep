import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

// A chat read on one window is read on every window: one row on the chat
// server (members.last_read_id), never moved back, and every window is told.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-chat-read-'))
process.env.ADAL_CHAT_SESSION_FILE = path.join(dir, 'chat.json')
process.env.SUPABASE_URL = 'http://chat.test'
process.env.SUPABASE_ANON_KEY = 'anon'
fs.writeFileSync(process.env.ADAL_CHAT_SESSION_FILE, JSON.stringify({
  email: 'a@b', password: 'p', user_id: 'me-1', access_token: 't', refresh_token: 'r', expires_at: Date.now() + 3600_000,
}))

const calls = []
let lastRead = 5
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url), method = opts.method || 'GET'
  calls.push({ method, u })
  const ok = (data) => new Response(data === null ? '' : JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
  if (u.includes('/rpc/join_agency')) return ok(null)
  if (u.includes('/rest/v1/agencies')) return ok([{ id: 'me-1', name: 'T', banned: false }])
  if (u.includes('/rpc/my_conversations')) return ok([{ id: 'c1', unread: Math.max(0, 9 - lastRead), last_message_at: 'x' }])
  if (u.includes('/rest/v1/messages') && u.includes('limit=1')) return ok([{ id: 9 }])
  if (u.includes('/rest/v1/messages')) return ok([{ id: 9 }, { id: 8 }])
  if (u.includes('/rest/v1/members') && method === 'PATCH') {
    const want = JSON.parse(opts.body).last_read_id
    const lt = Number(u.match(/last_read_id\.lt\.(\d+)/)?.[1])
    if (lt === want && lastRead < want) lastRead = want
    return ok(null)
  }
  return ok(null)
}
const db = (t) => ({ first: async () => (t === 'companies' ? { name: 'T' } : null) })

test.after(() => { globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }) })

test('a hidden window fetches without reading; looking reads it for everyone', async () => {
  const chat = await import('../src/services/chatCloud.js')
  const { onChanged } = await import('../src/services/changes.js')
  const heard = []
  const off = onChanged(c => heard.push(c.tables))

  assert.equal((await chat.conversations(db))[0].unread, 4)
  await chat.messages(db, 'c1', 0, null, { read: false })
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 0)
  assert.equal(lastRead, 5)

  await chat.messages(db, 'c1', 0, null)
  const patch = calls.find(c => c.method === 'PATCH')
  assert.match(patch.u, /agency_id=eq\.me-1/)
  assert.match(patch.u, /or=\(last_read_id\.is\.null,last_read_id\.lt\.9\)/)   // never back
  assert.equal(lastRead, 9)
  // The kept list is forgotten: the next ask has the server's number.
  assert.equal((await chat.conversations(db))[0].unread, 0)

  await new Promise(r => setTimeout(r, 900))
  assert.ok(heard.some(t => t.includes('chat')), 'every window is told "chat"')
  off()
})

test('marking read with no message id reads up to the newest; an older id never moves it back', async () => {
  const chat = await import('../src/services/chatCloud.js')
  lastRead = 3
  const r = await chat.markRead(db, 'c1')
  assert.equal(r.read_up_to, 9)
  assert.equal(lastRead, 9)
  await chat.markRead(db, 'c1', 4)
  assert.equal(lastRead, 9)
})
