/**
 * Adal Keep Admin — the Overview, the global search, one agency's whole page,
 * the Releases page and the live stream. Read-only: every action still goes
 * through the endpoints that were there (server.mjs, tower.mjs).
 *
 *   GET /api/home            "is everything OK?" — agencies, PCs, robots today,
 *                            tickets, renewals, revenue, the release and its stage
 *   GET /api/search?q=       agencies, PCs, candidates (each agency's online
 *                            profile list), tickets
 *   GET /api/agency/more     PCs, staff, licence + payments, setup, tickets,
 *                            robots and version of one agency (?pc= or ?id=)
 *   GET /api/releases        the published releases, the rollout stage, which
 *                            PC runs which version, the PCs that went back
 *   GET /api/live            Server-Sent Events: "changed" when Supabase says
 *                            so (Realtime), or a cheap look every 4 s finds it
 */
import crypto from 'node:crypto'

const DAY = 86400000
const today = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA')
const isId = (s) => /^[0-9a-f-]{36}$/i.test(String(s || ''))

export function homeApi({ api, rest, sb, url, key }) {
  // Several windows and the 5-s refresh ask at once: one answer per few seconds.
  const memo = new Map()
  const once = (k, ms, fn) => {
    const m = memo.get(k)
    if (m && Date.now() - m.at < ms) return m.p
    const p = fn().catch(e => { memo.delete(k); throw e })
    memo.set(k, { at: Date.now(), p })
    return p
  }
  const call = (k, q = {}) => api[k] ? api[k](q, {}) : Promise.reject(new Error(`${k} missing`))
  const safe = (p, v = null) => p.catch(e => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v, error: e.message } : v))
  const work = () => once('work', 4000, () => call('GET /api/work'))
  const fleet = () => once('fleet', 4000, () => call('GET /api/fleet'))
  const tickets = () => once('tickets', 4000, () => call('GET /api/tickets'))
  const billing = () => once('billing', 15000, () => call('GET /api/billing'))
  const updates = () => once('updates', 10000, () => call('GET /api/updates'))
  const stats = () => once('stats', 30000, () => rest('GET', 'keep_meta?key=eq./_stats&select=agency_id,data,updated_at'))

  /** Robot runs per robot for the days given (each agency's newest /_stats report). */
  function robotsOf(rows, ids = null, days = 1, now = Date.now()) {
    const from = today(now - (days - 1) * DAY)
    const by = {}
    for (const r of rows || []) {
      if (ids && !ids.includes(r.agency_id)) continue
      for (const [w, v] of Object.entries(r.data?.robots || {})) {
        const o = by[w] ||= { robot: w, done: 0, failed: 0 }
        for (const [d, n] of Object.entries(v.d || {})) if (d >= from) { o.done += n.done || 0; o.failed += n.failed || 0 }
      }
    }
    const list = Object.values(by).filter(x => x.done + x.failed).sort((a, b) => (b.done + b.failed) - (a.done + a.failed))
    const done = list.reduce((t, x) => t + x.done, 0), failed = list.reduce((t, x) => t + x.failed, 0)
    return { done, failed, success: done + failed ? Math.round(done / (done + failed) * 100) : null, list: list.map(x => ({ ...x, success: Math.round(x.done / (x.done + x.failed) * 100) })) }
  }
  // An agency on more than one account (a new PC) has more /_stats rows: the newest of each counts once.
  const newestPerAgency = (rows, mains) => mains.map(a => (rows || []).filter(r => a.ids.includes(r.agency_id)).sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)))[0]).filter(Boolean)
  const pcsOf = (f, a) => (f?.agencies || []).flatMap(g => g.pcs).filter(p => (a.ids || [a.id]).includes(p.agency_id) || (a.ids || []).includes(p.id) || (p.pc_number && p.pc_number === a.pc_number))
  const rank = { red: 0, amber: 1, green: 2 }

  async function home() {
    const now = Date.now()
    const [w, f, t, b, u, s] = await Promise.all([safe(work(), []), safe(fleet(), { agencies: [] }), safe(tickets(), []), safe(billing(), { agencies: [] }), safe(updates(), {}), safe(stats(), [])])
    const mains = (w || []).map(a => ({ ...a, ids: a.ids || [a.id] }))
    const latest = u?.release?.sha || null
    const pcs = (f.agencies || []).flatMap(g => g.pcs.map(p => ({ ...p, agency: g.name })))
    const open = (t || []).filter(x => x.status === 'open')
    const agencies = mains.map(a => {
      const mine = pcsOf(f, a)
      const sum = a.summary || {}
      const ren = (b.agencies || []).find(x => x.pc_number === a.pc_number)?.renewal || null
      const tk = open.filter(x => a.ids.includes(x.account) || mine.some(p => p.id === x.account)).length
      const why = []
      const light = mine.length ? mine.map(p => p.light).sort((x, y) => rank[x] - rank[y])[0] : (a.pcOnline ? 'green' : 'red')
      for (const p of mine) if (p.light !== 'green') why.push(`${p.name}: ${p.why.join(', ')}`)
      if (!mine.length && !a.pcOnline) why.push(a.pcSeen ? 'PC off' : 'never seen')
      if (sum.runs?.failed7d >= 5) why.push(`${sum.runs.failed7d} robot runs failed this week`)
      if (ren && (ren.state === 'expired' || ren.state === 'suspended')) why.push(ren.state === 'expired' ? 'licence expired' : 'suspended')
      if (tk) why.push(`${tk} open ticket${tk > 1 ? 's' : ''}`)
      const version = mine.find(p => p.role === 'main')?.beat?.version || mine[0]?.beat?.version || sum.version || null
      return {
        id: a.id, ids: a.ids, name: a.name, pc_number: a.pc_number, banned: !!a.banned,
        light: why.length && light === 'green' ? 'amber' : light, why,
        online: a.pcOnline || mine.some(p => p.light !== 'red'), seen: a.pcSeen,
        pcs: mine.length, profiles: sum.profiles ?? null, waiting: sum.runs ? sum.runs.paused + sum.runs.pending : null, failed7d: sum.runs?.failed7d ?? null,
        tickets: tk, renewal: ren, version, current: !!(latest && version && String(version).startsWith(String(latest).slice(0, 7))),
      }
    }).sort((x, y) => rank[x.light] - rank[y.light] || String(x.name).localeCompare(String(y.name)))
    const rToday = robotsOf(newestPerAgency(s, mains), null, 1, now)
    const rWeek = robotsOf(newestPerAgency(s, mains), null, 7, now)
    const due = (b.agencies || []).filter(x => x.renewal && ((x.renewal.state === 'paid' && x.renewal.days <= 30) || (x.renewal.state === 'trial' && x.renewal.days <= 7) || x.renewal.state === 'expired'))
      .map(x => ({ name: x.name, pc_number: x.pc_number, ...x.renewal })).sort((x, y) => (x.days ?? -999) - (y.days ?? -999))
    const month = today(now).slice(0, 7)
    const rev = b.revenue || {}
    const onLatest = latest ? pcs.filter(p => String(p.beat?.version || '').startsWith(String(latest).slice(0, 7))).length : 0
    // What deserves a look first, most urgent first; each one says where it leads.
    const needs = []
    for (const p of pcs.filter(p => p.light === 'red' && p.beat && now - Date.parse(p.beat.at) < 3 * DAY)) needs.push({ level: 'red', text: `${p.agency} · ${p.name}: ${p.why.join(', ')}`, go: `pc/${p.id}` })
    for (const x of (t || []).filter(x => x.status === 'open').slice(0, 6)) needs.push({ level: 'amber', text: `Ticket from ${x.agency_name}: ${String(x.text || x.note || '').slice(0, 80)}`, go: `tickets/${x.id}` })
    for (const r of (b.receipts || [])) needs.push({ level: 'amber', text: `Receipt from ${r.agency} waiting for Confirm`, go: 'billing' })
    if (u?.release?.stage === 'stopped') needs.push({ level: 'red', text: `Release ${u.release.short} is stopped`, go: 'releases' })
    for (const x of (u?.undone || []).filter(x => !x.decided).slice(0, 4)) needs.push({ level: 'red', text: `${x.agencyName} · ${x.pc} went back from ${x.sha}: ${x.reason}`, go: 'releases' })
    for (const x of due.filter(x => x.state === 'expired' || (x.days ?? 99) <= 7).slice(0, 5)) needs.push({ level: x.state === 'expired' ? 'red' : 'amber', text: x.state === 'expired' ? `${x.name}: licence ended ${-x.days} d ago` : `${x.name}: ${x.state === 'trial' ? 'trial' : 'licence'} ends in ${x.days} d`, go: `agency/${x.pc_number}` })
    for (const a of agencies.filter(a => a.failed7d >= 5).slice(0, 4)) needs.push({ level: 'amber', text: `${a.name}: ${a.failed7d} robot runs failed this week`, go: `robots` })
    return {
      at: new Date(now).toISOString(),
      ok: !needs.some(n => n.level === 'red'),
      needs: needs.slice(0, 14),
      agencies: { total: agencies.length, online: agencies.filter(a => a.online).length, red: agencies.filter(a => a.light === 'red').length, amber: agencies.filter(a => a.light === 'amber').length, list: agencies },
      pcs: { total: pcs.length, green: pcs.filter(p => p.light === 'green').length, amber: pcs.filter(p => p.light === 'amber').length, red: pcs.filter(p => p.light === 'red').length, error: f.error || null },
      robots: { today: rToday, week: rWeek, waiting: mains.reduce((n, a) => n + (a.summary?.runs ? a.summary.runs.paused + a.summary.runs.pending : 0), 0), running: mains.reduce((n, a) => n + (a.summary?.runs?.running || 0), 0) },
      tickets: { open: open.length, answered: (t || []).filter(x => x.status === 'answered').length, oldest: open.length ? open[open.length - 1].at : null, latest: open.slice(0, 5).map(x => ({ id: x.id, agency: x.agency_name, text: String(x.text || x.note || '').slice(0, 120), at: x.at })) },
      renewals: { due: due.slice(0, 8), count: due.length, expired: due.filter(x => x.state === 'expired').length, receipts: (b.receipts || []).length },
      revenue: { month: rev.thisMonth ?? rev.byMonth?.[month] ?? 0, total: rev.total ?? null, price: b.price || null, error: b.error || null, months: Object.entries(rev.byMonth || {}).sort(([x], [y]) => x.localeCompare(y)).slice(-6).map(([m, n]) => ({ m, n })) },
      release: u?.release ? { ...u.release, pcs_on_it: onLatest, pcs_total: pcs.length, went_back: (u.undone || []).filter(x => String(x.sha).startsWith(String(u.release.short || '').slice(0, 7))).length } : null,
      errors: [f.error && `Fleet: ${f.error}`, b.error && `Billing: ${b.error}`, u?.error && `Updates: ${u.error}`].filter(Boolean),
    }
  }

  // Candidates: every agency's profile list from its online copy (keep_meta "/profiles"), kept 2 minutes.
  const profiles = () => once('profiles', 120000, async () => {
    const rows = await rest('GET', 'keep_meta?key=eq./profiles&select=agency_id,data').catch(() => [])
    const out = []
    for (const r of rows || []) {
      const list = Array.isArray(r.data) ? r.data : r.data?.profiles || r.data?.items || []
      for (const p of list) out.push({ agency_id: r.agency_id, id: p.id, name: p.full_name || p.name || [p.first_name, p.last_name].filter(Boolean).join(' '), passport: p.passport_number || p.passport_no || '', phone: p.phone || '', stage: p.stage || p.status || '' })
    }
    return out
  })

  async function search(q) {
    const s = String(q || '').trim().toLowerCase()
    if (s.length < 2) return { q: s, results: [] }
    const has = (...v) => v.some(x => String(x || '').toLowerCase().includes(s))
    const [w, f, t, p] = await Promise.all([safe(work(), []), safe(fleet(), { agencies: [] }), safe(tickets(), []), safe(profiles(), [])])
    const nameOf = (id) => (w || []).find(a => (a.ids || [a.id]).includes(id))
    const res = []
    for (const a of w || []) if (has(a.name, a.pc_number, a.summary?.ceo?.name, a.summary?.ceo?.phone)) res.push({ kind: 'agency', title: a.name, sub: `PC ${a.pc_number || '—'}${a.pcOnline ? ' · on' : ''}`, go: `agency/${a.pc_number || a.id}` })
    for (const g of f.agencies || []) for (const pc of g.pcs) if (has(pc.name, pc.pc_number, pc.beat?.employee, pc.beat?.version, g.name)) res.push({ kind: 'pc', title: pc.name, sub: `${g.name} · ${pc.role || 'PC'} · ${pc.light}`, light: pc.light, go: `pc/${pc.id}` })
    for (const x of p || []) if (has(x.name, x.passport, x.phone)) { const a = nameOf(x.agency_id); res.push({ kind: 'candidate', title: x.name || `#${x.id}`, sub: `${a?.name || 'agency'}${x.passport ? ' · ' + x.passport : ''}${x.stage ? ' · ' + x.stage : ''}`, go: `agency/${a?.pc_number || a?.id || x.agency_id}`, agency: a?.id || x.agency_id, profile: x.id }) }
    for (const x of t || []) if (has(x.text, x.agency_name, x.pc_name, x.pc_number, x.who)) res.push({ kind: 'ticket', title: String(x.text || x.note || 'Ticket').slice(0, 80), sub: `${x.agency_name} · ${x.status}`, go: `tickets/${x.id}` })
    const order = { agency: 0, pc: 1, ticket: 2, candidate: 3 }
    return { q: s, results: res.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, 40) }
  }

  async function more(q) {
    const w = await work()
    const a = w.find(x => x.pc_number === q.pc || x.id === q.id || (x.ids || []).includes(q.id))
    if (!a) throw new Error('No such agency')
    const ids = a.ids || [a.id]
    const [f, t, b, u, s, staff, cfg] = await Promise.all([
      safe(fleet(), { agencies: [] }), safe(tickets(), []), safe(billing(), { agencies: [] }), safe(updates(), {}), safe(stats(), []),
      rest('GET', `keep_meta?agency_id=in.(${ids.join(',')})&key=eq./employees&select=data,updated_at&order=updated_at.desc&limit=1`).catch(() => []),
      api['GET /api/agency-config'] ? api['GET /api/agency-config']({ agency: a.id }).catch(e => ({ error: e.message })) : null,
    ])
    const pcs = pcsOf(f, { ...a, ids })
    const list = Array.isArray(staff?.[0]?.data) ? staff[0].data : staff?.[0]?.data?.employees || staff?.[0]?.data?.users || []
    const bill = (b.agencies || []).find(x => x.pc_number === a.pc_number) || null
    const latest = u?.release || null
    return {
      id: a.id, name: a.name,
      pcs: pcs.map(p => ({ id: p.id, name: p.name, role: p.role, light: p.light, why: p.why, version: p.beat?.version || null, employee: p.beat?.employee || null, seen: p.beat?.at || null, open: p.open, robots: p.beat?.robots || null, ram: p.beat?.ram || null, disk_free_mb: p.beat?.disk_free_mb ?? null, cores: p.beat?.cpu?.cores ?? null, net: p.beat?.net_type || null, pending: p.pending, acks: p.acks, current: !!(latest?.sha && String(p.beat?.version || '').startsWith(String(latest.sha).slice(0, 7))) })),
      staff: list.map(e => ({ name: e.name || e.full_name || e.username || '—', role: e.role || e.staff_role || (e.is_admin ? 'admin' : ''), active: e.active !== false && e.disabled !== true })).slice(0, 60),
      billing: bill && { plan: bill.plan, renewal: bill.renewal, payments: bill.payments },
      receipts: (b.receipts || []).filter(r => ids.includes(r.agency_id)),
      setup: cfg && !cfg.error ? { version: cfg.version, on: (cfg.switches || []).filter(s => cfg.config?.features?.[s.key] ?? s.on).map(s => s.title), email: cfg.config?.agency_email || null, lmis: cfg.config?.lmis_sms_number || null, epro: !!cfg.config?.epro_signature, cv_templates: (cfg.config?.cv_templates || []).length, roles: (cfg.config?.staff_roles || []).map(r => r.name) } : cfg,
      tickets: (t || []).filter(x => ids.includes(x.account) || pcs.some(p => p.id === x.account)).slice(0, 20),
      robots: { today: robotsOf(s, ids, 1), week: robotsOf(s, ids, 7), month: robotsOf(s, ids, 30) },
      release: latest && { short: latest.short, sha: latest.sha, stage: latest.stage },
      went_back: (u?.undone || []).filter(x => ids.includes(x.agency)),
    }
  }

  // Every published release (release/<sha>.json), newest first; a manifest never changes once written.
  const manifests = new Map()
  async function releases() {
    const [u, f] = await Promise.all([safe(updates(), {}), safe(fleet(), { agencies: [] })])
    let names = []
    try {
      const list = await once('relList', 60000, () => sb('POST', '/storage/v1/object/list/adal-updates', { prefix: 'release/', limit: 100, sortBy: { column: 'created_at', order: 'desc' } }))
      names = (list || []).map(o => o.name).filter(n => /^[0-9a-f]{40}\.json$/.test(n)).slice(0, 15)
    } catch {}
    const history = []
    for (const n of names) {
      if (!manifests.has(n)) {
        try { const j = await sb('GET', `/storage/v1/object/adal-updates/release/${n}`); const m = j?.manifest || {}; manifests.set(n, { sha: m.sha, short: m.short || String(m.sha || '').slice(0, 7), message: m.message || '', published_at: m.published_at || null, size: m.size || null, rollback: !!m.rolled_back_from || /rollback/i.test(m.kind || '') }) } catch { continue }
      }
      history.push(manifests.get(n))
    }
    history.sort((x, y) => String(y.published_at).localeCompare(String(x.published_at)))
    const pcs = (f.agencies || []).flatMap(g => g.pcs.map(p => ({ id: p.id, name: p.name, agency: g.name, agency_id: p.agency_id, version: p.beat?.version || null, light: p.light, seen: p.beat?.at || null })))
    const versions = {}
    for (const p of pcs) { const v = String(p.version || 'unknown').slice(0, 7); (versions[v] ||= []).push(p) }
    return {
      release: u?.release || null, undone: u?.undone || [], error: u?.error || null,
      history: history.map(h => ({ ...h, pcs: (versions[String(h.sha || '').slice(0, 7)] || []).length })),
      versions: Object.entries(versions).map(([v, list]) => ({ v, n: list.length, pcs: list.slice(0, 30), message: history.find(h => String(h.sha || '').startsWith(v))?.message || null })).sort((x, y) => y.n - x.n),
      pcs: pcs.length,
    }
  }

  // ------------------------------------------------------------- live --
  // Every open Admin window holds one stream; "changed" tells it to look again now.
  const clients = new Set()
  const push = (what) => { const line = `data: ${JSON.stringify({ t: 'changed', what, at: Date.now() })}\n\n`; for (const c of clients) { try { c.write(line) } catch {} } }
  let stamp = null, probing = false, rt = { connected: false }
  async function probe() {
    if (probing || !clients.size) return
    probing = true
    try {
      const [m, r, msg] = await Promise.all([
        rest('GET', 'keep_meta?select=updated_at&key=in.(/_summary,/_pc,/_tower/beat,/_tower/tickets,/_tower/acks,/_tower/answers,/_diag)&order=updated_at.desc&limit=1').catch(() => []),
        rest('GET', 'unlock_requests?select=id,status&order=id.desc&limit=1').catch(() => []),
        rest('GET', 'messages?select=id&order=id.desc&limit=1').catch(() => []),
      ])
      const now = JSON.stringify([m?.[0]?.updated_at, r?.[0], msg?.[0]?.id])
      if (stamp !== null && now !== stamp) { memo.clear(); push(['probe']) }
      stamp = now
    } finally { probing = false }
  }
  setInterval(probe, 4000).unref()
  // Supabase Realtime: postgres changes of the small tables Admin shows (when they are in the publication).
  // Not keep_meta: its rows carry every agency's whole online copy; the 4-s look above notices those.
  function realtime() {
    const WS = globalThis.WebSocket
    if (!WS || !url || !key || process.env.ADMIN_REALTIME === '0') return
    let ws, beat, ref = 0
    const topic = 'realtime:adal-admin'
    const send = (t, event, payload) => ws?.readyState === 1 && ws.send(JSON.stringify({ topic: t, event, payload, ref: String(++ref), join_ref: t === topic ? '1' : undefined }))
    const open = () => {
      try { ws = new WS(`${url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${key}&vsn=1.0.0`) } catch { return setTimeout(open, 30000) }
      ws.onopen = () => {
        send(topic, 'phx_join', { config: { broadcast: { self: false }, presence: { key: '' }, private: false, postgres_changes: ['unlock_requests', 'messages', 'agencies'].map(table => ({ event: '*', schema: 'public', table })) }, access_token: key })
        beat = setInterval(() => send('phoenix', 'heartbeat', {}), 25000)
      }
      let last = 0
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data) } catch { return }
        if (m.event === 'phx_reply' && m.topic === topic) rt = { connected: m.payload?.status === 'ok', why: m.payload?.status === 'ok' ? null : JSON.stringify(m.payload?.response || {}).slice(0, 160) }
        if (m.event === 'postgres_changes') {
          const table = m.payload?.data?.table
          memo.clear()
          if (Date.now() - last > 800) { last = Date.now(); push([table]) }
        }
      }
      ws.onclose = () => { clearInterval(beat); rt = { connected: false }; setTimeout(open, 5000) }
      ws.onerror = () => {}
    }
    open()
  }
  realtime()
  function live(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write(`retry: 3000\ndata: ${JSON.stringify({ t: 'hello', realtime: rt.connected, id: crypto.randomUUID() })}\n\n`)
    clients.add(res)
    const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 20000)
    req.on('close', () => { clearInterval(ping); clients.delete(res) })
    probe()
  }

  return {
    routes: {
      'GET /api/home': async () => once('home', 2500, home),
      'GET /api/search': async (q) => search(q.q),
      'GET /api/agency/more': async (q) => more(q),
      'GET /api/releases': async () => releases(),
      'GET /api/live/status': async () => ({ clients: clients.size, realtime: rt }),
    },
    live,
    // After an action the next look must be fresh.
    forget: () => memo.clear(),
  }
}
