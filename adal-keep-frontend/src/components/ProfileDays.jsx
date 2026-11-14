/**
 * Profile → FMOL and "Day by day": FMOL approved or not (from Musaned's own
 * stage, read by the Musaned check every 2 hours), and her whole status per
 * day — each journey step as it was that day, and what moved from the day
 * before (backend services/profileDays.js).
 */
import { useEffect, useState } from 'react'
import api from '../services/api'
import { onDataChange } from '../lib/changes'

const TITLES = { cv: 'CV', musaned: 'Musaned', selected: 'Selected', wafid: 'Wafid', wakala: 'Wakala', epro: 'EPRO', insurance: 'Insurance', fmol: 'FMOL', embassy: 'Embassy', visa: 'Visa', arrived: 'Arrived' }
const ORDER = ['cv', 'musaned', 'selected', 'wafid', 'epro', 'insurance', 'fmol', 'embassy', 'visa', 'arrived']
const DOT = { done: 'bg-emerald-500', active: 'bg-amber-400', failed: 'bg-red-500', waiting: 'bg-sky-400', todo: 'bg-slate-200 dark:bg-slate-700', soon: 'bg-slate-200 dark:bg-slate-700' }
const dayName = (d) => { try { const x = new Date(`${d}T12:00:00`); const t = new Date(); const y = new Date(Date.now() - 864e5); return d === t.toLocaleDateString('en-CA') ? 'Today' : d === y.toLocaleDateString('en-CA') ? 'Yesterday' : x.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) } catch { return d } }

export function FmolBadge({ fmol, stage }) {
  if (fmol === 'approved') return <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300" title={stage}>✓ FMOL approved</span>
  if (fmol === 'waiting') return <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-800 dark:bg-amber-900/30 dark:text-amber-300" title={stage}>⏳ Waiting for FMOL approval</span>
  return <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300" title={stage || 'not chosen yet'}>FMOL: not yet</span>
}

export default function ProfileDays({ profileId }) {
  const [d, setD] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => api.get(`/profiles/${profileId}/days`).then(r => alive && setD(r.data)).catch(() => {})
    load()
    const off = onDataChange(['profiles', 'automation_queue'], load, 5000)
    return () => { alive = false; off() }
  }, [profileId])
  if (!d) return null
  // Sideways (asked on 2026-11-14, to save height): one tile per day, newest first; many days scroll sideways.
  return (
    <section className="panel px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">📅 Day by day</h2>
        <FmolBadge fmol={d.fmol} stage={d.musaned_stage} />
        {d.musaned_stage && <span className="text-xs text-slate-500">Musaned: {d.musaned_stage}</span>}
        <span className="ml-auto text-[11px] text-slate-400">{d.checked_at ? `Musaned looked at ${new Date(d.checked_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ` : ''}checked by itself every 2 hours</span>
      </div>
      {!d.days.length ? <p className="text-sm text-slate-500">Her first day is kept within the hour.</p> : (
        <ol className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
          {d.days.map(x => {
            const said = x.changes.length ? x.changes.join(' · ') : x.first ? 'first day kept' : 'no change'
            return (
              <li key={x.day} className="w-44 shrink-0 rounded-lg border border-slate-100 px-2.5 py-1.5 dark:border-slate-800" title={`${dayName(x.day)}: ${said}${x.musaned_stage ? `
Musaned: ${x.musaned_stage}` : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{dayName(x.day)}</span>
                  <span className="flex items-center gap-0.5">
                    {ORDER.map(k => <span key={k} className={`h-2 w-2 rounded-full ${DOT[x.steps?.[k]] || DOT.todo}`} title={`${TITLES[k]}: ${x.steps?.[k] || '—'}`} />)}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-slate-600 dark:text-slate-300">
                  {x.musaned_stage && <span className="text-indigo-700 dark:text-indigo-300">{x.musaned_stage} · </span>}{said}
                </p>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
