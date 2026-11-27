/**
 * problems.mjs — Admin's "Problems" view (the owner, 2026-11-27): every PC's own report
 * ("/_tower/report" in its keep_meta, sent every 5 minutes by pcReport.js), by agency and PC:
 * what is new since yesterday, how often, the runs that failed and where, the slowest steps,
 * and a PC short of memory, disk, processor or internet. Read-only.
 */
const BRANCH_RE = /\s·\s*branch PC \d{6}$/
const isId = (s) => /^[0-9a-f-]{36}$/i.test(String(s || ''))
const DAY = 86400e3

/** What is wrong with one PC's machine, in words. */
export function machineWarnings(r) {
  const w = [], s = r?.sys || {}
  if (s.disk_free_mb != null && s.disk_free_mb < 3 * 1024) w.push(`disk almost full (${(s.disk_free_mb / 1024).toFixed(1)} GB free)`)
  if (s.ram_free_mb != null && s.ram_free_mb < 500) w.push(`memory short (${s.ram_free_mb} MB free)`)
  if (s.cpu_busy != null && s.cpu_busy >= 90) w.push(`processor busy (${s.cpu_busy}%)`)
  if (r?.net?.mbps != null && r.net.mbps < 1) w.push(`slow internet (${r.net.mbps} Mbit/s)`)
  if (r?.net?.ok === false) w.push('internet not working at the last look')
  return w
}

/** One PC's problems from its report. */
export function pcProblems(r, now = Date.now()) {
  const errors = (r.errors || []).map(e => ({ ...e, new: Date.parse(e.first) > now - DAY }))
  const stale = !(Date.parse(r.at) > now - 20 * 60e3)
  const warnings = machineWarnings(r)
  if (stale) warnings.unshift(`no report for ${Math.round((now - Date.parse(r.at)) / 60e3) || '?'} min (off, or no internet)`)
  const fresh = errors.filter(e => e.new).length
  return {
    at: r.at, stale, version: r.version || null, role: r.role || null, name: r.pc_name, pc_number: r.pc_number || null,
    sys: r.sys || null, net: r.net || null, warnings,
    errors: errors.sort((a, b) => (b.new - a.new) || (b.today - a.today) || (a.last < b.last ? 1 : -1)),
    runs_failed: r.runs_failed || [], slow_steps: r.slow_steps || [],
    score: fresh * 3 + (r.runs_failed || []).length * 2 + warnings.length * 2 + errors.reduce((n, e) => n + (e.today ? 1 : 0), 0),
    new_count: fresh, today_count: errors.reduce((n, e) => n + (e.today || 0), 0),
  }
}

export function problemsApi({ rest }) {
  async function names(ids) {
    if (!ids.length) return { ag: new Map(), dev: new Map() }
    const list = ids.join(',')
    const [ags, devs] = await Promise.all([
      rest('GET', `agencies?id=in.(${list})&select=id,name`).catch(() => []),
      rest('GET', `keep_devices?user_id=in.(${list})&select=user_id,agency_id,name`).catch(() => []),
    ])
    const ag = new Map((ags || []).map(a => [a.id, a]))
    const dev = new Map((devs || []).map(d => [d.user_id, d]))
    const parents = [...new Set([...dev.values()].map(d => d.agency_id))].filter(id => !ag.has(id))
    if (parents.length) for (const a of await rest('GET', `agencies?id=in.(${parents.join(',')})&select=id,name`).catch(() => []) || []) ag.set(a.id, a)
    return { ag, dev }
  }
  async function problems() {
    const rows = (await rest('GET', `keep_meta?key=eq.${encodeURIComponent('/_tower/report')}&select=agency_id,data,updated_at`)) || []
    const { ag, dev } = await names([...new Set(rows.map(r => r.agency_id))].filter(isId))
    const now = Date.now()
    const agencies = new Map()
    for (const r of rows) {
      if (!r.data) continue
      const d = dev.get(r.agency_id)
      const name = String((d ? ag.get(d.agency_id) : null)?.name || ag.get(r.agency_id)?.name || 'Unknown agency').replace(BRANCH_RE, '')
      const a = agencies.get(name) || { name, pcs: [] }
      a.pcs.push({ id: r.agency_id, ...pcProblems(r.data, now) })
      agencies.set(name, a)
    }
    const out = [...agencies.values()].map(a => ({ ...a, score: a.pcs.reduce((n, p) => n + p.score, 0), new_count: a.pcs.reduce((n, p) => n + p.new_count, 0), pcs: a.pcs.sort((x, y) => y.score - x.score) }))
    return { at: new Date(now).toISOString(), agencies: out.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name)) }
  }
  return { 'GET /api/fleet/problems': async () => problems() }
}
