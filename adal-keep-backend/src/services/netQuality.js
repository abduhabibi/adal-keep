/**
 * netQuality.js — how good this PC's internet is for the robots (asked on
 * 2026-11-21: "pick the PC that will finish fastest … its internet speed and
 * reliability"). Every 10 minutes, while no robot works (the robot comes first
 * on the line), the portals and Supabase are asked for their first page: how
 * long the answer takes (latency), how fast its bytes come (throughput), and
 * whether it came at all (reliability). The Companions measure themselves the
 * same way (adal-companion netprobe.go) and say it with their strength.
 */
const HOSTS = [
  'https://www.musaned.com.sa/',
  'https://visa.mofa.gov.sa/',
  'https://lmis.gov.et/',
  'https://wafid.com/',
]
const KEEP = 12              // the last 12 probes (2 hours) count
const MAX_BYTES = 512 * 1024
let samples = []             // { at, ok, ms, bytes }
let timer = null

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }

/** { rtt_ms, mbps, ok } from samples: the median answer time, the median speed of big answers, the share that answered. */
export function summarize(list = samples) {
  if (!list.length) return null
  const good = list.filter(s => s.ok)
  const speeds = good.filter(s => s.bytes >= 20_000 && s.ms > 0).map(s => (s.bytes * 8) / (Math.max(1, s.ms - (s.first || 0)) / 1000) / 1e6)
  return {
    rtt_ms: median(good.map(s => s.first || s.ms)),
    mbps: speeds.length ? Math.round(median(speeds) * 10) / 10 : null,
    ok: Math.round((good.length / list.length) * 100) / 100,
  }
}

/** One look at every host (fetchFn: for the tests). */
export async function probeOnce({ fetchFn = fetch, hosts = null, now = Date.now } = {}) {
  const list = hosts || [...HOSTS, process.env.SUPABASE_URL ? `${String(process.env.SUPABASE_URL).replace(/\/+$/, '')}/auth/v1/health` : null].filter(Boolean)
  const out = []
  for (const url of list) {
    const t0 = now()
    try {
      const r = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'cache-control': 'no-cache' } })
      const first = now() - t0
      let bytes = 0
      if (r.body?.getReader) {
        const rd = r.body.getReader()
        while (bytes < MAX_BYTES) { const { done, value } = await rd.read(); if (done) break; bytes += value?.length || 0 }
        rd.cancel().catch(() => {})
      }
      out.push({ at: t0, ok: r.status < 500, ms: now() - t0, first, bytes })
    } catch {
      out.push({ at: t0, ok: false, ms: now() - t0, first: 0, bytes: 0 })
    }
  }
  return out
}

/** This PC's internet now (null before its first look). */
export const ownNet = () => summarize(samples)

export function _setSamplesForTest(list) { samples = list }

/** Every 10 minutes; `busy()` true: a robot works, the look waits. Off in the tests and with ADAL_NO_NET_PROBE=1. */
export function startNetProbe({ every = 10 * 60e3, busy = () => false } = {}) {
  if (timer || process.env.ADAL_NO_NET_PROBE === '1' || process.env.NODE_ENV === 'test') return
  const look = async () => {
    try {
      if (await busy()) return
      samples = [...samples, ...(await probeOnce())].slice(-KEEP * HOSTS.length)
    } catch {}
  }
  setTimeout(look, 30_000).unref?.()
  timer = setInterval(look, every)
  timer.unref?.()
}
