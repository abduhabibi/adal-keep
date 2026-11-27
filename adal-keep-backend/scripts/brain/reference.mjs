/**
 * The REFERENCE brain: the contract of docs/CLAIMS.md (brain-test) as small, readable code, so the five scenarios are proven to be sound.
 * Each PC has its own database (the real automation_queue table from migration 021 + run_claims + results), its own timers and alive flag.
 * PCs talk only through `link`, which can be cut. A PC that is not alive does nothing (no lease renewal, no run, no answer).
 */
import knex from 'knex'

export const LEASE_MS = 500, TICK_MS = 40
const key = (girl, wf) => `${girl}:${wf}`

export async function makeReferenceBrain({ site, now = Date.now, broken = '' } = {}) {   // broken: 'no-claims' | 'auto-retry' (the test proves its scenarios catch these)
  const pcs = new Map(), cuts = new Set()
  const pair = (a, b) => [a, b].sort().join('|')
  const reach = (a, b) => pcs.get(a)?.alive && pcs.get(b)?.alive && !cuts.has(pair(a, b))
  const peersOf = (n) => [...pcs.keys()].filter(x => x !== n && reach(n, x))

  async function makePC(name, { strength, main = false, runMs = 400 }) {
    const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    const quiet = { log: console.log, warn: console.warn }; console.log = console.warn = () => {}   // (the old migration talks)
    try { await (await import('../../src/migrations/021_automation_queue.js')).up(db) } finally { console.log = quiet.log; console.warn = quiet.warn }
    await db.schema.createTable('run_claims', t => { t.string('key').primary(); t.string('pc'); t.integer('run_id'); t.integer('lease_until'); t.string('state') })
    await db.schema.createTable('results', t => { t.string('key').primary(); t.string('status'); t.string('pc'); t.integer('at') })
    const pc = { name, strength, main, runMs, db, alive: true, running: new Set(), outbox: [], timer: null }
    pcs.set(name, pc)
    pc.timer = setInterval(() => tick(pc).catch((e) => { if (process.env.BRAIN_DEBUG) console.error('tick', name, e.message) }), TICK_MS)
    return pc
  }
  const claimsOf = (pc) => pc.db('run_claims')

  // ---- what a PC does every tick
  async function tick(pc) {
    if (!pc.alive || pc.busy) return
    pc.busy = true
    try {
      const t = now()
      // 1. renew the leases of its own running runs
      for (const k of pc.running) await claimsOf(pc).where({ key: k, pc: pc.name }).update({ lease_until: t + LEASE_MS })
      // 2. learn the claims of every reachable PC; a claim past its lease is EXPIRED (nothing restarts it)
      for (const p of peersOf(pc.name)) for (const c of await claimsOf(pcs.get(p)).select()) {
        const mine = await claimsOf(pc).where({ key: c.key }).first()
        if (!mine) await claimsOf(pc).insert(c)
        else if (c.lease_until > mine.lease_until || (c.state !== 'running' && mine.state === 'running')) await claimsOf(pc).where({ key: c.key }).update(c)
      }
      for (const c of await claimsOf(pc).where({ state: 'running' }).where('lease_until', '<', t)) {
        await claimsOf(pc).where({ key: c.key }).update({ state: 'expired' })
        await pc.db('automation_queue').where({ workflow_id: c.key.split(':')[1], profile_id: Number(c.key.split(':')[0]) }).whereIn('status', ['running', 'pending']).update({ status: 'stopped', pause_reason: `stopped — ${c.pc} went away` })
        if (broken === 'auto-retry') await pc.db('automation_queue').insert({ profile_id: Number(c.key.split(':')[0]), workflow_id: c.key.split(':')[1], status: 'pending', context: JSON.stringify({ pinned: true }), created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      }
      // 3. results go to Main when it is reachable
      if (!pc.main) for (const m of [...pcs.values()].filter(x => x.main && reach(pc.name, x.name))) {
        for (const r of await pc.db('results').select()) { const had = await m.db('results').where({ key: r.key }).first(); if (!had || had.at < r.at) { await m.db('results').where({ key: r.key }).del(); await m.db('results').insert(r) } }
      }
      // 4. the next row of its own queue
      const row = await pc.db('automation_queue').where({ status: 'pending' }).orderBy('id').first()
      if (row) await start(pc, row)
    } finally { pc.busy = false }
  }

  async function start(pc, row) {
    const k = key(row.profile_id, row.workflow_id)
    const ctx = JSON.parse(row.context || '{}')
    // who runs it: the strongest live PC reachable, unless a person pinned it here
    let target = pc
    if (!ctx.pinned) for (const p of peersOf(pc.name)) if (pcs.get(p).strength > target.strength) target = pcs.get(p)
    if (target !== pc) {
      await pc.db('automation_queue').where({ id: row.id }).update({ status: 'handed', pause_reason: `handed to ${target.name}` })
      await target.db('automation_queue').insert({ profile_id: row.profile_id, workflow_id: row.workflow_id, status: 'pending', context: JSON.stringify({ ...ctx, from: pc.name, pinned: true }), created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      return
    }
    // the claim: refused when any reachable PC (or this PC) holds a live one for her
    const t = now()
    const live = async (p) => (await claimsOf(p).where({ key: k, state: 'running' }).where('lease_until', '>', t).first())
    for (const p of [pc, ...peersOf(pc.name).map(n => pcs.get(n))]) {
      const c = await live(p)
      if (c && broken !== 'no-claims') { await pc.db('automation_queue').where({ id: row.id }).update({ status: 'skipped', pause_reason: `${c.pc} is running her` }); return }
    }
    await claimsOf(pc).where({ key: k }).del()
    await claimsOf(pc).insert({ key: k, pc: pc.name, run_id: row.id, lease_until: t + LEASE_MS, state: 'running' })
    for (const p of peersOf(pc.name)) { const q = pcs.get(p); await claimsOf(q).where({ key: k }).del(); await claimsOf(q).insert({ key: k, pc: pc.name, run_id: row.id, lease_until: t + LEASE_MS, state: 'running' }) }
    await pc.db('automation_queue').where({ id: row.id }).update({ status: 'running', started_at: new Date().toISOString() })
    pc.running.add(k)
    run(pc, row, k).catch(() => {})
  }

  async function run(pc, row, k) {
    const go = (phase) => fetch(`${site.base}/${phase}?girl=${row.profile_id}&pc=${pc.name}`).catch(() => {})
    await go('start')
    for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, pc.runMs / 4)); if (!pc.alive) return }   // a dead PC stops here: no end, no writes
    await go('end')
    pc.running.delete(k)
    await claimsOf(pc).where({ key: k }).update({ state: 'done' })
    await pc.db('automation_queue').where({ id: row.id }).update({ status: 'done', finished_at: new Date().toISOString() })
    await pc.db('results').where({ key: k }).del(); await pc.db('results').insert({ key: k, status: 'done', pc: pc.name, at: now() })
  }

  // ---- the adapter the scenarios use
  return {
    name: 'reference',
    async addPC(name, o) { return makePC(name, o) },
    /** A person starts a run in a PC's window. pinned: "run it on this PC". */
    async enqueue(name, girl, { wf = 'musaned_check_chosen', pinned = false } = {}) {
      const [id] = await pcs.get(name).db('automation_queue').insert({ profile_id: girl, workflow_id: wf, status: 'pending', context: JSON.stringify({ pinned }), created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      return id
    },
    async off(name) { pcs.get(name).alive = false },
    async on(name) { pcs.get(name).alive = true },
    cut(a, b) { cuts.add(pair(a, b)) }, heal(a, b) { cuts.delete(pair(a, b)) },
    async rows(name) { return pcs.get(name).db('automation_queue').select() },
    async claims(name) { return claimsOf(pcs.get(name)).select() },
    async results(name) { return pcs.get(name).db('results').select() },
    async close() {
      for (const p of pcs.values()) { clearInterval(p.timer); p.alive = false }
      for (const p of pcs.values()) { for (let i = 0; i < 100 && p.busy; i++) await new Promise(r => setTimeout(r, 20)); await new Promise(r => setTimeout(r, 120)); await p.db.destroy().catch(() => {}) }   // (a run's last write may still be on its way)
    },
  }
}
