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
  const [all, setAll] = useState(false)
  useEffect(() => {
    let alive = true
    const load = () => api.get(`/profiles/${profileId}/days`).then(r => alive && setD(r.data)).catch(() => {})
    load()
    const off = onDataChange(['profiles', 'automation_queue'], load, 5000)
    return () => { alive = false; off() }
  }, [profileId])
  if (!d) return null
  const days = all ? d.days : d.days.slice(0, 7)
  return (
    <section className="panel p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">📅 Day by day</h2>
        <FmolBadge fmol={d.fmol} stage={d.musaned_stage} />
        {d.musaned_stage && <span className="text-xs text-slate-500">Musaned: {d.musaned_stage}</span>}
        <span className="ml-auto text-[11px] text-slate-400">{d.checked_at ? `Musaned looked at ${new Date(d.checked_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ` : ''}checked by itself every 2 hours</span>
      </div>
      {!d.days.length ? <p className="text-sm text-slate-500">Her first day is kept within the hour.</p> : (
        <ol className="space-y-1.5">
          {days.map(x => (
            <li key={x.day} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-100 px-3 py-1.5 dark:border-slate-800">
              <span className="w-24 shrink-0 text-xs font-semibold text-slate-700 dark:text-slate-200">{dayName(x.day)}</span>
              <span className="flex items-center gap-1" title={ORDER.map(k => `${TITLES[k]}: ${x.steps?.[k] || '—'}`).join('\n')}>
                {ORDER.map(k => <span key={k} className={`h-2.5 w-2.5 rounded-full ${DOT[x.steps?.[k]] || DOT.todo}`} title={`${TITLES[k]}: ${x.steps?.[k] || '—'}`} />)}
              </span>
              {x.musaned_stage && <span className="text-[11px] text-indigo-700 dark:text-indigo-300">{x.musaned_stage}</span>}
              <span className="min-w-0 flex-1 text-xs text-slate-600 dark:text-slate-300">
                {x.changes.length ? x.changes.join(' · ') : x.first ? 'first day kept' : 'no change'}
              </span>
            </li>
          ))}
        </ol>
      )}
      {d.days.length > 7 && <button type="button" onClick={() => setAll(a => !a)} className="mt-2 text-xs font-semibold text-teal-700 hover:underline dark:text-teal-300">{all ? 'Show the last 7 days' : `Show all ${d.days.length} days`}</button>}
    </section>
  )
}
