import { useEffect, useState } from 'react'
import api from '../services/api'

// Office health: one row per agency PC (backend services/officeHealth.js).
// The same page on the main PC and on every Companion.

const ago = (t) => {
  if (!t) return '—'
  const s = Math.max(0, (Date.now() - Date.parse(t)) / 1000)
  if (s < 90) return 'now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} days ago`
}
const wifiLabel = (w) => (w == null ? '—' : w >= 70 ? `Good ${w}%` : w >= 40 ? `Fair ${w}%` : `Weak ${w}%`)

function Cell({ label, children, bad }) {
  return (
    <div className="min-w-0">
      <p className="ak-eyebrow">{label}</p>
      <p className={`truncate text-[14px] ${bad ? 'text-red-600 dark:text-red-400 font-semibold' : ''}`}>{children}</p>
    </div>
  )
}

export default function OfficePage() {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let live = true
    const load = () => api.get('/office/health').then(r => { if (live) { setD(r.data); setErr(false) } }).catch(() => { if (live) setErr(true) })
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 20000)
    return () => { live = false; clearInterval(t) }
  }, [])
  const proof = d?.proof
  return (
    <div className="mx-auto max-w-5xl space-y-4" translate="no">
      <section className="ak-hero">
        <p className="ak-eyebrow">Office</p>
        <h1 className="ak-hero-title">Health</h1>
        {proof && <p className={`mt-1 text-[15px] ${proof.level === 'warn' ? 'text-red-600 dark:text-red-400' : ''}`}>{proof.text}{proof.behind?.length ? ` · ${proof.behind.join(' · ')}` : ''}</p>}
      </section>
      {!d && <div className="ak-skel h-24 w-full" aria-hidden="true" />}
      {err && !d && <p className="ak-muted text-sm">The main PC does not answer.</p>}
      {d?.rows?.map(r => {
        const lanBad = r.lan && r.lan.ok < r.lan.total
        const stale = r.behind_ms != null && r.behind_ms > 26 * 3600e3
        return (
          <section key={r.id || 'main'} className="ak-glass-card grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-6">
            <div className="col-span-2 flex min-w-0 items-center gap-2 md:col-span-1">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${r.online ? 'bg-emerald-500' : 'bg-slate-400'}`} aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-[15px] font-semibold">{r.name}</p>
                <p className="truncate text-[12px] ak-muted">{r.main ? 'Main PC' : r.employee && r.pc ? r.pc : 'Companion'}</p>
              </div>
            </div>
            <Cell label="Version">{r.version || '—'}</Cell>
            <Cell label="Last seen">{r.online ? 'now' : ago(r.last_seen)}</Cell>
            <Cell label="Wi-Fi" bad={r.wifi != null && r.wifi < 40}>{wifiLabel(r.wifi)}</Cell>
            <Cell label="Reaches PCs" bad={lanBad}>{!r.lan ? '—' : lanBad ? `${r.lan.ok}/${r.lan.total} · not ${r.lan.down.join(', ')}` : 'All'}</Cell>
            <Cell label={r.main ? 'Backup' : 'Copy'} bad={!r.main && stale}>{ago(r.main ? r.backup_at : r.copy_at)}</Cell>
          </section>
        )
      })}
    </div>
  )
}
