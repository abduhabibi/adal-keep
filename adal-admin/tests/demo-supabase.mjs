/**
 * A pretend Supabase for Adal Keep Admin: six agencies, their PCs' beats,
 * tickets, robot counts, releases, receipts, chats — all in memory, nothing
 * leaves this PC. Used by tests/sweep.mjs (every button, headless) and to
 * look at the panel without touching a real agency:
 *
 *   node adal-admin/tests/demo-supabase.mjs 4190    → http://127.0.0.1:4190
 *
 * Enough of PostgREST for server.mjs / tower.mjs / home.mjs: eq / in / is
 * filters, order, limit, POST (upsert on_conflict), PATCH, DELETE; Storage
 * objects and list.
 */
import http from 'node:http'
import crypto from 'node:crypto'

const DAY = 86400000, MIN = 60000
const iso = (ms) => new Date(ms).toISOString()
const day = (n) => new Date(Date.now() - n * DAY).toLocaleDateString('en-CA')

export function demoData(now = Date.now()) {
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const AG = [
    { n: 1, name: 'Adal Test agency', pc: '100001', age: 120, on: true },
    { n: 2, name: 'Habesha Recruitment', pc: '200002', age: 200, on: true },
    { n: 3, name: 'Selam Overseas Employment', pc: '300003', age: 15, on: true },
    { n: 4, name: 'Abay Manpower', pc: '400004', age: 60, on: false },
    { n: 5, name: 'Lucy Foreign Employment', pc: '500005', age: 400, on: true },
    { n: 6, name: 'Tana Agency', pc: '600006', age: 5, on: true },
  ]
  const ADMIN = id(999)
  const agencies = [{ id: ADMIN, name: 'Adal Keep', is_admin: true, pc_number: null, banned: false, created_at: iso(now - 500 * DAY), last_seen: iso(now) }]
  const keep_meta = [], keep_devices = [], unlock_requests = [], conversations = [], messages = [], members = [], agency_config = [], agency_signups = []
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', OLD = '0f9e8d7c6b5a49382716f5e4d3c2b1a098765432'
  const names = ['Hiwot Alemu', 'Meron Tadesse', 'Selamawit Bekele', 'Tigist Haile', 'Bethlehem Girma', 'Mahlet Assefa', 'Rahel Worku', 'Saron Desta', 'Liya Kebede', 'Eden Mulugeta', 'Hana Yohannes', 'Kalkidan Abebe']
  const ROBOTS = ['musaned_contract', 'wafid_book', 'lmis_register', 'enjaz_visa']
  let pid = 1
  for (const a of AG) {
    const aid = id(a.n)
    agencies.push({ id: aid, name: a.name, pc_number: a.pc, banned: false, is_admin: false, created_at: iso(now - a.age * DAY), last_seen: iso(now - (a.on ? 20e3 : 3 * DAY)) })
    const pcAt = a.on ? iso(now - 15e3) : iso(now - 3 * DAY)
    keep_meta.push({ agency_id: aid, key: '/_pc', data: { at: pcAt, pc: a.pc }, updated_at: pcAt })
    const profiles = names.slice(0, 4 + a.n).map((nm, i) => ({ id: pid++, full_name: nm, passport_number: `EP${String(1000000 + a.n * 1000 + i)}`, phone: `+2519${String(10000000 + a.n * 111 + i).slice(0, 8)}`, stage: ['musaned', 'medical', 'visa', 'ticket'][i % 4] }))
    keep_meta.push({ agency_id: aid, key: '/profiles', data: profiles, updated_at: iso(now) })
    keep_meta.push({ agency_id: aid, key: '/employees', data: [{ name: 'Owner', role: 'admin' }, { name: 'Office staff', role: 'office' }, { name: 'Data entry', role: 'data_entry' }].slice(0, 1 + (a.n % 3)), updated_at: iso(now) })
    const failed = a.n === 4 ? 7 : a.n % 3
    keep_meta.push({ agency_id: aid, key: '/_summary', updated_at: iso(now - 2 * MIN), data: {
      at: iso(now - 2 * MIN), version: a.n === 4 ? OLD : SHA, plan: 'premium',
      ceo: { agency: a.name, name: `CEO of ${a.name.split(' ')[0]}`, phone: `+25191100${a.n}${a.n}${a.n}` },
      agents: [{ name: 'Al Riyadh office', number: '9665000000' + a.n }], agent_limit: 3, reasons: [],
      profiles: profiles.length, chosen: Math.floor(profiles.length / 2), stages: { Musaned: 2, Medical: 1 + a.n % 2, Visa: 1 },
      runs: { running: a.on ? 1 : 0, pending: a.n % 2, paused: a.n === 2 ? 3 : 0, failed7d: failed },
      waiting: a.n === 2 ? [{ id: 1, profile_id: profiles[0].id, name: profiles[0].full_name, workflow: 'musaned_contract', reason: 'Needs the employer OTP', at: iso(now - 40 * MIN) }] : [],
      failed: Array.from({ length: failed }, (_, i) => ({ id: 10 + i, profile_id: profiles[i % profiles.length].id, name: profiles[i % profiles.length].full_name, workflow: ROBOTS[i % 4], reason: 'The site did not answer', at: iso(now - (i + 1) * 3 * 3600e3) })),
      tasks: { open: a.n % 4, latest: [] }, medicals: a.n === 3 ? [{ id: profiles[1].id, name: profiles[1].full_name, days: 5 }] : [],
      has: { employees: 1 + (a.n % 3), brokers: 2, checklists: 3, cv_templates: ['Classic', 'Gulf'] },
    } })
    const robots = {}
    for (const [i, r] of ROBOTS.entries()) {
      const d = {}
      for (let k = 0; k < 10; k++) d[day(k)] = { done: (a.n + i + k) % 5 + (k === 0 ? 2 : 0), failed: (a.n === 4 && k < 3) ? 2 : (k + i) % 7 === 0 ? 1 : 0 }
      robots[r] = { done: 40, failed: 4, other: 1, secs: 4000, d }
    }
    keep_meta.push({ agency_id: aid, key: '/_stats', updated_at: iso(now - 10 * MIN), data: { v: 1, profiles: profiles.length, added: { [day(0)]: 1, [day(1)]: 2, [day(3)]: a.n }, cvs: {}, moves: { [day(1)]: 3 }, stages: { musaned: { n: 2, avg_days: 4 + a.n } }, robots } })
    keep_meta.push({ agency_id: aid, key: '/_diag', updated_at: iso(now - 5 * MIN), data: { at: iso(now - 5 * MIN), autoUndo: a.n === 5 ? [{ pc: 'LUCY-FRONT', sha: SHA.slice(0, 7), from: SHA.slice(0, 7), to: OLD.slice(0, 7), reason: 'The server did not start within 90 s', at: iso(now - 50 * MIN), status: 'rolled-back' }] : [] } })
    // The PCs: the main one, and a Companion for some agencies.
    const pcs = [{ uid: aid, name: `${a.name.split(' ')[0].toUpperCase()}-MAIN`, role: 'main' }]
    if (a.n === 2 || a.n === 5) pcs.push({ uid: id(100 + a.n), name: a.n === 5 ? 'LUCY-FRONT' : 'HABESHA-DESK2', role: 'companion' })
    for (const p of pcs) {
      if (p.uid !== aid) keep_devices.push({ user_id: p.uid, agency_id: aid, name: p.name, revoked: false, created_at: iso(now - 30 * DAY) })
      const beatAt = !a.on ? now - 3 * DAY : a.n === 6 && p.role === 'main' ? now - 4 * MIN : now - 30e3
      keep_meta.push({ agency_id: p.uid, key: '/_tower/beat', updated_at: iso(beatAt), data: {
        v: 1, at: iso(beatAt), agency: a.name, role: p.role, pc_name: p.name, pc_number: p.role === 'main' ? a.pc : null, employee: 'Office staff',
        version: a.n === 4 || p.name === 'LUCY-FRONT' ? OLD : SHA, os: 'Windows_NT 10.0.19045',
        cpu: { cores: a.n === 3 ? 2 : 8, model: 'Intel Core i5', load: [0.4, a.n === 3 ? 4.1 : 0.6, 0.5] }, ram: { total_mb: 8192, free_mb: a.n === 3 ? 310 : 2900, node_mb: 240 },
        disk_free_mb: a.n === 6 ? 2100 : 80000, net: { rtt_ms: 120, mbps: 8, ok: 0.95 }, net_type: 'wifi',
        robots: { running: a.on ? 1 : 0, waiting: a.n % 2, paused: 0 }, held: null, uptime_min: 300,
        last_error: a.n === 3 ? { at: iso(now - 20 * MIN), line: 'ECONNRESET musaned.gov.sa' } : null,
        crashes: a.n === 3 ? [{ source: 'frontend', message: 'Minified React error #310', where: 'SettingsPage', count: 3, first: iso(now - 5 * 3600e3), last: iso(now - 30 * MIN), version: SHA.slice(0, 7) }] : [],
      } })
    }
    if (a.n === 2 || a.n === 3) keep_meta.push({ agency_id: aid, key: '/_tower/tickets', updated_at: iso(now - 30 * MIN), data: { tickets: [
      { id: crypto.randomUUID(), at: iso(now - (a.n === 2 ? 25 : 90) * MIN), status: 'open', replies: [], text: a.n === 2 ? 'The Musaned robot stops at the contract page every time.' : 'How do I add a new employee?', who: 'Office staff', page: '/profiles', agency: a.name, pc_name: pcs[0].name, pc_number: a.pc, version: SHA, log: null, shot: null },
      ...(a.n === 2 ? [{ id: crypto.randomUUID(), at: iso(now - 2 * DAY), status: 'closed', replies: [{ id: 'r1', from: 'Adal support', text: 'Fixed in the new version.', at: iso(now - DAY) }], text: 'CV photo is blurry', who: 'Owner', page: '/cv', agency: a.name, pc_name: pcs[0].name, pc_number: a.pc, version: OLD }] : []),
    ] } })
    const conv = crypto.randomUUID()
    conversations.push({ id: conv, kind: 'admin', key: `admin:${aid}`, last_message_at: iso(now - a.n * 3600e3) })
    messages.push({ id: messages.length + 1, conversation_id: conv, sender_id: aid, body: `Hello Adal, ${a.name} here.`, image_path: null, created_at: iso(now - a.n * 3600e3) })
    agency_config.push({ agency_id: aid, version: a.n, updated_at: iso(now - DAY), config: { agency_email: `office@${a.name.split(' ')[0].toLowerCase()}.et`, lmis_sms_number: '+2519110000' + a.n, features: { remote_setup: a.n % 2 === 0, companion_full: a.n === 5 }, staff_roles: [{ name: 'Office', perms: {} }] } })
    if (a.n === 6) agency_signups.push({ agency_id: aid, name: a.name, phone: '+251911000666', status: 'new', created_at: iso(now - 2 * DAY), note: null })
  }
  conversations.push({ id: crypto.randomUUID(), kind: 'group', key: 'group', last_message_at: iso(now - DAY) })
  unlock_requests.push({ id: 1, agency_id: id(3), pc_number: '300003', image_path: 'receipts/r1.png', status: 'pending', note: null, created_at: iso(now - 2 * 3600e3), decided_at: null })
  unlock_requests.push({ id: 2, agency_id: id(5), pc_number: '500005', image_path: 'receipts/r2.png', status: 'approved', note: 'confirmed:telebirr CK1', created_at: iso(now - 20 * DAY), decided_at: iso(now - 20 * DAY) })
  const release = (sha, msg, at, rollout) => ({ manifest: { sha, short: sha.slice(0, 7), message: msg, published_at: iso(at), size: 57e6, app_delta: { patch: { size: 6e6 } }, rollout, everyone_at: rollout?.everyone_at }, signature: 'demo' })
  const latest = release(SHA, 'Help button, control tower, one plan', now - 3 * 3600e3, { test: [id(1)], pct: 10, pct_at: iso(now - 3600e3), everyone_at: iso(now + 3600e3), stopped: false })
  const storage = new Map([
    ['adal-updates/release/latest.json', JSON.stringify(latest)],
    [`adal-updates/release/${SHA}.json`, JSON.stringify(latest)],
    [`adal-updates/release/${OLD}.json`, JSON.stringify(release(OLD, 'Run history, office health', now - 4 * DAY, null))],
    ['adal-updates/release/early.json', JSON.stringify({ agencies: [id(1)] })],
  ])
  return { tables: { agencies, keep_meta, keep_devices, unlock_requests, conversations, messages, members, agency_config, agency_signups, keep_calls: [], agency_invites: [], install_codes: [], keep_secrets: [] }, storage, ADMIN }
}

// ------------------------------------------------------------- PostgREST --
const unq = (v) => v.replace(/^"|"$/g, '')
function match(row, k, expr) {
  const [op, ...rest] = expr.split('.'); const v = rest.join('.')
  const cell = row[k]
  if (op === 'eq') return String(cell) === v || (v === 'true' && cell === true) || (v === 'false' && (cell === false || cell == null))
  if (op === 'neq') return String(cell) !== v
  if (op === 'in') return v.replace(/^\(|\)$/g, '').split(',').map(unq).includes(String(cell))
  if (op === 'is') return v === 'null' ? cell == null : String(cell) === v
  if (op === 'gt') return String(cell) > v
  if (op === 'lt') return String(cell) < v
  if (op === 'gte') return String(cell) >= v
  if (op === 'not') return !match(row, k, rest.join('.'))
  return true
}
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict'])

export function demoSupabase(seed = demoData()) {
  const { tables, storage } = seed
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks)
    const u = new URL(req.url, 'http://x')
    const json = (v, code = 200) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
    const p = decodeURIComponent(u.pathname)
    if (p.startsWith('/storage/v1/object/list/')) {
      const bucket = p.slice('/storage/v1/object/list/'.length)
      const { prefix = '' } = JSON.parse(raw.toString() || '{}')
      return json([...storage.keys()].filter(k => k.startsWith(`${bucket}/${prefix}`)).map(k => ({ name: k.slice(bucket.length + 1 + prefix.length), created_at: iso(Date.now()) })))
    }
    if (p.startsWith('/storage/v1/object/')) {
      const k = p.replace(/^\/storage\/v1\/object\/(sign\/|public\/|authenticated\/)?/, '')
      if (req.method === 'POST' || req.method === 'PUT') { storage.set(k, raw); return json({ Key: k }) }
      if (req.method === 'DELETE') { storage.delete(k); return json({}) }
      if (!storage.has(k)) return json({ message: 'Object not found' }, 404)
      return res.writeHead(200, { 'Content-Type': /\.png$/.test(k) ? 'image/png' : 'application/json' }).end(storage.get(k))
    }
    if (p === '/realtime/v1/api/broadcast') return json({})
    if (p.startsWith('/auth/v1/admin/users')) return json({ id: crypto.randomUUID() })
    if (!p.startsWith('/rest/v1/')) return json({ message: 'not here' }, 404)
    const t = p.slice(9).split('/')[0]
    const list = tables[t] ||= []
    const filters = [...u.searchParams].filter(([k]) => !RESERVED.has(k))
    const hit = (r) => filters.every(([k, v]) => match(r, k, v))
    if (req.method === 'GET') {
      let out = list.filter(hit)
      const order = u.searchParams.get('order')
      if (order) { const [col, dir] = order.split(','.charAt(0))[0].split('.'); out = [...out].sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : 1) * (dir === 'desc' ? -1 : 1)) }
      if (u.searchParams.get('limit')) out = out.slice(0, Number(u.searchParams.get('limit')))
      return json(out)
    }
    const body = raw.length ? JSON.parse(raw.toString()) : null
    if (req.method === 'POST') {
      const rows = Array.isArray(body) ? body : [body]
      const conflict = (u.searchParams.get('on_conflict') || '').split(',').filter(Boolean)
      for (const r of rows) {
        const i = conflict.length ? list.findIndex(x => conflict.every(c => String(x[c]) === String(r[c]))) : -1
        if (i >= 0) list[i] = { ...list[i], ...r }
        else list.push({ ...(t === 'messages' || t === 'keep_calls' || t === 'unlock_requests' ? { id: list.length + 1, created_at: iso(Date.now()) } : {}), ...r })
      }
      return json(rows)
    }
    if (req.method === 'PATCH') { for (const r of list) if (hit(r)) Object.assign(r, body); return json([]) }
    if (req.method === 'DELETE') { tables[t] = list.filter(r => !hit(r)); return json([]) }
    json({}, 405)
  })
  return { server, tables, storage }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const port = Number(process.argv[2] || 4190)
  demoSupabase().server.listen(port, '127.0.0.1', () => console.log(`demo Supabase on http://127.0.0.1:${port}`))
}
