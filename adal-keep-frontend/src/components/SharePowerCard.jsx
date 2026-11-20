/**
 * Settings → "PCs working together": every Adal Keep PC in the office, how
 * strong it is now, and how many robots it is running. A weak or busy PC's robots and CV
 * PDFs are done by the strongest one, out of sight there, and watched here
 * (backend services/sharePower.js).
 */
import { useEffect, useState } from 'react'
import api from '../services/api'
import Card from './shared/Card'

export default function SharePowerCard() {
  const [list, setList] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => api.get('/system/share-power').then(r => alive && setList(r.data || [])).catch(() => alive && setList(false))
    load()
    const t = setInterval(load, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  if (list === false) return null
  const strongest = (list || []).filter(p => !p.weak).sort((a, b) => b.score - a.score)[0]
  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1" translate="no">PCs working together</h2>
      <p className="text-sm text-slate-500 mb-3" translate="no">
        A slow or busy PC's robots and CVs are done by the strongest PC here, out of sight there, and you watch them on your screen.
      </p>
      {list === null ? <p className="text-sm text-slate-400">…</p> : (
        <ul className="grid gap-2 sm:grid-cols-2 text-sm" translate="no">
          {list.map(p => (
            <li key={p.id || 'here'} className={`rounded-xl px-3 py-2.5 border ${p.weak ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20' : 'border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20'}`}>
              <div className="flex items-center gap-2">
                <b className="truncate">{p.name}{p.here ? ' (this PC)' : ''}</b>
                {strongest && strongest.id === p.id && list.length > 1 && <span className="ml-auto rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-bold text-white">strongest</span>}
              </div>
              <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                {p.mem_gb != null ? `${p.mem_gb} GB · ${p.free_gb} GB free · ` : ''}{p.cores} cores{p.load != null ? ` · ${p.load}% busy` : ''}{p.battery ? ' · on battery' : ''}
              </div>
              <div className="text-xs mt-1 font-semibold">
                {p.runs ? `${p.runs} robot${p.runs > 1 ? 's' : ''} running` : 'No robots running'} · {p.weak ? 'others help it' : 'helps the others'}
              </div>
            </li>
          ))}
        </ul>
      )}
      {list?.length === 1 && <p className="text-xs text-slate-500 mt-2" translate="no">Only this PC right now. Every Adal Companion on the office network shows up here and helps.</p>}
    </Card>
  )
}
