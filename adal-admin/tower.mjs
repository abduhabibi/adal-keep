/**
 * Adal Keep Admin — the control tower (Fleet tab). Every agency PC sends a
 * beat each minute into its own keep_meta row "/_tower/beat"
 * (adal-keep-backend/src/services/tower.js). Commands go into the PC's
 * "/_tower/cmds" row, each signed with Adal's tower key — the PC runs only
 * what this key signed, for its own account, before it expires, once — and
 * its answers come back in "/_tower/acks". No new tables: keep_meta and the
 * private "keep" bucket (collected logs) only.
 *
 * The key: ~/.adal-keep/tower-signing.pem (Ed25519; ADAL_TOWER_KEY = another
 * path). Never commit it, never make a new one: the public half is in every
 * PC (tower.js TOWER_PUBLIC_KEY).
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export const KINDS = {
  restart: 'Restart Adal Keep',
  cancel_runs: 'Cancel all robot runs',
  collect_logs: 'Collect logs',
  self_check: 'Run a self-check',
  update_now: 'Update now',
  suspend: 'Suspend robots',
  resume: 'Resume robots',
  support_note: 'Support note',
}
const TEST_AGENCY = /^\s*(adal\s+)?test\s+agency\b|\badal\s*test\b/i
const BRANCH_RE = /\s·\s*branch PC \d{6}$/
const KEYS = ['/_tower/beat', '/_tower/acks', '/_tower/flag', '/_tower/cmds']
const isId = (s) => /^[0-9a-f-]{36}$/i.test(String(s || ''))

let keyCache = null
function signingKey() {
  if (keyCache) return keyCache
  const file = process.env.ADAL_TOWER_KEY || path.join(os.homedir(), '.adal-keep', 'tower-signing.pem')
  if (!fs.existsSync(file)) throw new Error(`The tower key is missing (${file}). Commands cannot be signed on this PC.`)
  keyCache = crypto.createPrivateKey(fs.readFileSync(file))
  return keyCache
}
export function signEnvelope(obj, key = signingKey()) {
  const payload = JSON.stringify(obj)
  return { payload, sig: crypto.sign(null, Buffer.from(payload), key).toString('base64') }
}
const openEnvelope = (env) => { try { return JSON.parse(env?.payload || 'null') } catch { return null } }
// Only what Adal's key signed counts (an agency can write its own rows: a forged command there is shown, never trusted).
let pubCache = null
function signedByAdal(env) {
  try {
    pubCache ||= crypto.createPublicKey(signingKey())
    return crypto.verify(null, Buffer.from(String(env?.payload)), pubCache, Buffer.from(String(env?.sig), 'base64'))
  } catch { return false }
}

/** green / amber / red, and why. */
export function healthOf(beat, now = Date.now()) {
  if (!beat?.at) return { light: 'red', why: ['never seen'] }
  const age = now - Date.parse(beat.at)
  if (age > 10 * 60e3) return { light: 'red', why: [`no beat for ${Math.round(age / 60e3)} min`] }
  const why = []
  if (age > 2.5 * 60e3) why.push(`last beat ${Math.round(age / 60e3)} min ago`)
  if (beat.disk_free_mb != null && beat.disk_free_mb < 3072) why.push(`disk ${(beat.disk_free_mb / 1024).toFixed(1)} GB free`)
  if (beat.ram?.free_mb != null && beat.ram.free_mb < 400) why.push(`RAM ${beat.ram.free_mb} MB free`)
  if (beat.cpu?.load?.[1] != null && beat.cpu.cores && beat.cpu.load[1] > beat.cpu.cores * 1.5) why.push(`load ${beat.cpu.load[1]}`)
  if (beat.held) why.push('robots suspended')
  if (beat.net && beat.net.ok != null && beat.net.ok < 0.7) why.push('weak internet')
  if ((beat.crashes || []).some(c => now - Date.parse(c.last) < 3600e3)) why.push('crash in the last hour')
  return { light: why.length ? 'amber' : 'green', why }
}

export function towerApi({ rest, sb }) {
  async function rows(keys = KEYS) {
    return await rest('GET', `keep_meta?key=in.(${keys.map(k => `"${k}"`).join(',')})&select=agency_id,key,data,updated_at`) || []
  }
  async function namesOf(ids) {
    if (!ids.length) return { ag: new Map(), dev: new Map() }
    const list = ids.join(',')
    const [ags, devs] = await Promise.all([
      rest('GET', `agencies?id=in.(${list})&select=id,name,pc_number,banned`).catch(() => []),
      rest('GET', `keep_devices?user_id=in.(${list})&select=user_id,agency_id,name`).catch(() => []),
    ])
    const ag = new Map((ags || []).map(a => [a.id, a]))
    const dev = new Map((devs || []).map(d => [d.user_id, d]))
    const parents = [...new Set([...dev.values()].map(d => d.agency_id))].filter(id => !ag.has(id))
    if (parents.length) for (const a of await rest('GET', `agencies?id=in.(${parents.join(',')})&select=id,name,pc_number,banned`).catch(() => []) || []) ag.set(a.id, a)
    return { ag, dev }
  }

  /** Every PC with a beat, grouped by agency. */
  async function fleet() {
    const all = await rows()
    const by = new Map()
    for (const r of all) {
      const pc = by.get(r.agency_id) || { id: r.agency_id }
      pc[r.key.slice(8)] = r.data
      by.set(r.agency_id, pc)
    }
    const ids = [...by.keys()].filter(isId)
    const { ag, dev } = await namesOf(ids)
    const now = Date.now()
    const pcs = [...by.values()].filter(p => p.beat).map(p => {
      const d = dev.get(p.id)
      const own = ag.get(p.id)
      const parent = d ? ag.get(d.agency_id) : null
      const agency = String(parent?.name || own?.name || p.beat.agency || 'Unknown agency').replace(BRANCH_RE, '')
      const flag = signedByAdal(p.flag) ? openEnvelope(p.flag) : null
      const cmds = p.cmds?.cmds || []
      const forged = cmds.filter(e => !signedByAdal(e)).length
      const pending = cmds.filter(signedByAdal).map(openEnvelope).filter(c => c && Date.parse(c.expires_at) > now && !(p.acks?.acks || []).some(a => a.id === c.id))
      return {
        id: p.id, agency, agency_id: d?.agency_id || p.id,
        name: p.beat.pc_name, pc_number: p.beat.pc_number || own?.pc_number || null, role: d ? 'companion' : p.beat.role,
        beat: p.beat, ...healthOf(p.beat, now),
        open: flag?.on === true ? 'opened' : TEST_AGENCY.test(agency) ? 'test agency' : 'off',
        acks: (p.acks?.acks || []).slice(0, 8), forged,
        pending: pending.map(c => ({ id: c.id, kind: c.kind, issued_at: c.issued_at, expires_at: c.expires_at })),
      }
    })
    const agencies = new Map()
    for (const pc of pcs) {
      const a = agencies.get(pc.agency) || { name: pc.agency, pcs: [] }
      a.pcs.push(pc)
      agencies.set(pc.agency, a)
    }
    const rank = { red: 0, amber: 1, green: 2 }
    const out = [...agencies.values()].map(a => ({ ...a, light: a.pcs.map(p => p.light).sort((x, y) => rank[x] - rank[y])[0], pcs: a.pcs.sort((x, y) => rank[x.light] - rank[y.light] || String(x.name).localeCompare(String(y.name))) }))
    return { at: new Date().toISOString(), agencies: out.sort((x, y) => rank[x.light] - rank[y.light] || x.name.localeCompare(y.name)) }
  }

  /** Crash reports of every PC, grouped by message: counts per agency and version. */
  async function crashes() {
    const f = await fleet()
    const groups = new Map()
    for (const a of f.agencies) for (const pc of a.pcs) for (const c of pc.beat.crashes || []) {
      const k = `${c.source}|${String(c.message).replace(/0x[0-9a-f]+|\d+/gi, '#').slice(0, 200)}`
      const g = groups.get(k) || { source: c.source, message: c.message, where: c.where, count: 0, pcs: 0, agencies: {}, versions: {}, first: c.first, last: c.last }
      g.count += c.count || 1; g.pcs++
      g.agencies[a.name] = (g.agencies[a.name] || 0) + (c.count || 1)
      const v = c.version || pc.beat.version || '?'
      g.versions[v] = (g.versions[v] || 0) + (c.count || 1)
      if (c.first < g.first) g.first = c.first
      if (c.last > g.last) g.last = c.last
      groups.set(k, g)
    }
    return [...groups.values()].sort((x, y) => (x.last < y.last ? 1 : -1)).slice(0, 100)
  }

  async function sendCommand({ target, kind, args = {}, hours = 24 }) {
    if (!isId(target)) throw new Error('bad PC')
    if (!KINDS[kind]) throw new Error('unknown command')
    if (kind === 'support_note' && !String(args.text || '').trim()) throw new Error('Type the note first.')
    const now = Date.now()
    const cmd = {
      id: crypto.randomUUID(), target, kind,
      args: kind === 'support_note' ? { text: String(args.text).slice(0, 1000) } : kind === 'suspend' ? { note: String(args.note || '').slice(0, 200) } : {},
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + Math.min(72, Math.max(0.1, Number(hours) || 24)) * 3600e3).toISOString(),
    }
    const env = signEnvelope(cmd)
    const [row] = await rest('GET', `keep_meta?agency_id=eq.${target}&key=eq.${encodeURIComponent('/_tower/cmds')}&select=data`) || []
    // The newest 10 that have not expired stay (the PC remembers which ran).
    const keep = (row?.data?.cmds || []).filter(e => signedByAdal(e) && Date.parse(openEnvelope(e)?.expires_at) > now).slice(-9)
    await rest('POST', 'keep_meta?on_conflict=agency_id,key', [{ agency_id: target, key: '/_tower/cmds', data: { at: cmd.issued_at, cmds: [...keep, env] }, updated_at: cmd.issued_at }],
      { Prefer: 'resolution=merge-duplicates,return=minimal' })
    return { id: cmd.id, kind, message: `${KINDS[kind]}: sent. The PC does it within about 20 seconds when it is on.` }
  }

  /** Open (or close) the tower for agencies: a signed flag in each of their accounts' rows. */
  async function setOpen({ ids = [], all = false, on = true }) {
    const every = (await rest('GET', 'agencies?is_admin=eq.false&select=id,name')) || []
    let targets = ids.filter(isId)
    if (all) targets = every.map(a => a.id)
    else if (targets.length) {
      // Each agency with all its PCs: its branch PCs ("Name · branch PC 123456") and Companions (keep_devices).
      const names = new Set(every.filter(a => targets.includes(a.id)).map(a => a.name))
      const devs = (await rest('GET', `keep_devices?agency_id=in.(${targets.join(',')})&select=user_id`).catch(() => [])) || []
      targets = [...new Set([...targets, ...every.filter(a => names.has(String(a.name).replace(BRANCH_RE, ''))).map(a => a.id), ...devs.map(d => d.user_id)])]
    }
    const at = new Date().toISOString()
    const list = targets.map(id => ({ agency_id: id, key: '/_tower/flag', data: signEnvelope({ target: id, on: !!on, issued_at: at }), updated_at: at }))
    for (let i = 0; i < list.length; i += 200) await rest('POST', 'keep_meta?on_conflict=agency_id,key', list.slice(i, i + 200), { Prefer: 'resolution=merge-duplicates,return=minimal' })
    return { ok: true, count: list.length, message: `${on ? 'Opened' : 'Closed'} for ${list.length} account(s). PCs see it within 10 minutes.` }
  }

  /** A collected log (keep/<account>/_support/logs/…) as text. */
  async function readLog(object) {
    if (!/^[0-9a-f-]{36}\/_support\/logs\/[\w.-]+\.txt\.gz$/i.test(String(object || ''))) throw new Error('bad log')
    const url = `${String(process.env.SUPABASE_URL).replace(/\/+$/, '')}/storage/v1/object/keep/${object}`
    const r = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } })
    if (!r.ok) throw new Error(`log not found (${r.status})`)
    const text = zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8')
    return { object, text: text.length > 3e6 ? text.slice(-3e6) : text }
  }

  return {
    'GET /api/fleet': async () => fleet(),
    'GET /api/fleet/crashes': async () => crashes(),
    'GET /api/fleet/kinds': async () => {
      let ready = true, why = null
      try { signingKey() } catch (e) { ready = false; why = e.message }
      return { kinds: KINDS, ready, why }
    },
    'POST /api/fleet/command': async (q, b) => {
      const targets = Array.isArray(b.targets) ? b.targets : [b.target]
      const out = []
      for (const t of targets.slice(0, 200)) out.push(await sendCommand({ target: t, kind: b.kind, args: b.args || {}, hours: b.hours }))
      return { ok: true, sent: out.length, message: out.length === 1 ? out[0].message : `${KINDS[b.kind]}: sent to ${out.length} PCs.` }
    },
    'POST /api/fleet/open': async (q, b) => setOpen({ ids: b.ids || [], all: !!b.all, on: b.on !== false }),
    'GET /api/fleet/log': async (q) => readLog(q.object),
  }
}
