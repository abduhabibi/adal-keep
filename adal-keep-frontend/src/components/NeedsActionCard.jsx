import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { onDataChange } from '../lib/changes'
import { useDestination, goesTo } from '../lib/destination'

// "Needs action today" (backend services/needsAction.js): the girls with
// something due or overdue today — missing documents, medical dates, stuck
// robots, Musaned waiting… One tap opens her profile. Drawn at once from what
// this device saw last, then filled in when the PC (or the online copy) answers.

const KEY = 'ak-dash-needs'
const readLast = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch { return null } }
const ICON = { docs: '📄', medical: '🔋', appt: '📅', stuck: '⚠️', chosen: '⏳', musaned: '🟢', result: '🩺' }

export default function NeedsActionCard() {
  const [data, setData] = useState(readLast)
  const [all, setAll] = useState(false)
  // The destination country picked in the top bar.
  const [dest] = useDestination()

  useEffect(() => {
    let live = true
    const load = () => api.get('/needs-action').then(({ data: d }) => {
      if (!live || !d || !Array.isArray(d.profiles)) return
      setData(d)
      try { localStorage.setItem(KEY, JSON.stringify(d)) } catch {}
    }).catch(() => {})
    load()
    const off = onDataChange(['profiles', 'automation_queue', 'files', 'profile_fields'], load, 5000)
    return () => { live = false; off?.() }
  }, [])

  if (!data) return (
    <div className="ak-stat flex-col gap-2" aria-hidden="true">
      <span className="ak-skel h-4 w-40" /><span className="ak-skel h-4 w-64" />
    </div>
  )
  const list = data.profiles.filter(p => goesTo(dest, p))
  if (!list.length) return null
  const shown = all ? list : list.slice(0, 8)
  const late = list.filter(p => p.overdue).length

  return (
    <section className="ak-stat flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <span className="ak-stat-value tabular-nums">{list.length}</span>
        <span className="ak-stat-label flex-1">ዛሬ መደረግ ያለባቸው</span>
        {late > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300">{late} overdue</span>}
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {shown.map(p => (
          <li key={p.profile_id}>
            <Link to={`/profiles/${p.profile_id}`} className="flex items-start gap-3 py-2 hover:opacity-80">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${p.overdue ? 'bg-red-500' : 'bg-amber-400'}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold" translate="no">{p.name}</span>
                <span className="block text-xs ak-muted" translate="no">
                  {p.items.map((i, n) => <span key={n} className={`mr-2 inline-block ${i.overdue ? 'text-red-600 dark:text-red-400' : ''}`}>{ICON[i.kind] || '•'} {i.text}</span>)}
                </span>
              </span>
              <span className="mt-1 text-slate-400">›</span>
            </Link>
          </li>
        ))}
      </ul>
      {list.length > 8 && (
        <button type="button" onClick={() => setAll(a => !a)} className="self-start text-xs font-semibold text-indigo-600 dark:text-indigo-400">
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}
    </section>
  )
}
