/**
 * What keeps this PC busy: GET /api/system/diag (read-only numbers, no
 * personal data). Requests per route over the last 5 minutes, how long they
 * took, the event-loop delay, CPU, memory and the database queue.
 */
import os from 'os'
import { monitorEventLoopDelay } from 'perf_hooks'

const loop = monitorEventLoopDelay({ resolution: 50 })
loop.enable()
const WINDOW = 5 * 60 * 1000
let hits = [] // { at, key, ms, from }

export function diagMiddleware(req, res, next) {
  const t0 = performance.now()
  res.on('finish', () => {
    const key = `${req.method} ${req.originalUrl.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id').replace(/[0-9a-f]{16,}/gi, ':key')}`
    hits.push({ at: Date.now(), key, ms: performance.now() - t0, from: req.socket?.remoteAddress || '' })
    if (hits.length > 20000) hits = hits.slice(-10000)
  })
  next()
}

let cpuPrev = process.cpuUsage(), cpuAt = Date.now(), cpuPct = 0
setInterval(() => {
  const u = process.cpuUsage(cpuPrev), now = Date.now()
  cpuPct = Math.round((u.user + u.system) / 1000 / (now - cpuAt) * 100)
  cpuPrev = process.cpuUsage(); cpuAt = now
}, 5000).unref()

export function diagReport(db) {
  setTimeout(() => loop.reset(), 0)
  const since = Date.now() - WINDOW
  hits = hits.filter(h => h.at >= since)
  const by = new Map()
  for (const h of hits) {
    const r = by.get(h.key) || { route: h.key, count: 0, total_ms: 0, max_ms: 0 }
    r.count++; r.total_ms += h.ms; r.max_ms = Math.max(r.max_ms, h.ms)
    by.set(h.key, r)
  }
  const callers = {}
  for (const h of hits) callers[h.from] = (callers[h.from] || 0) + 1
  const pool = db?.client?.pool
  return {
    uptime_min: Math.round(process.uptime() / 60),
    node_cpu_pct: cpuPct,
    pc: { cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model, load: os.loadavg(), free_mb: Math.round(os.freemem() / 1048576), total_mb: Math.round(os.totalmem() / 1048576) },
    node_mem_mb: Math.round(process.memoryUsage().rss / 1048576),
    // Delay beyond the 50 ms sampling step: 0 = never blocked.
    event_loop_lag_ms: { mean: Math.max(0, Math.round(loop.mean / 1e6) - 50), p99: Math.max(0, Math.round(loop.percentile(99) / 1e6) - 50), max: Math.max(0, Math.round(loop.max / 1e6) - 50) },
    db_pool: pool ? { used: pool.numUsed?.(), free: pool.numFree?.(), waiting: pool.numPendingAcquires?.() } : null,
    requests_5min: hits.length,
    callers,
    routes: [...by.values()].map(r => ({ ...r, total_ms: Math.round(r.total_ms), avg_ms: Math.round(r.total_ms / r.count), max_ms: Math.round(r.max_ms) }))
      .sort((a, b) => b.total_ms - a.total_ms).slice(0, 40),
  }
}
