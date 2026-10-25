/**
 * Where she is, in two tracks that share the start:
 *   LMIS:    CV → Musaned → Wafid → LMIS contract
 *   Embassy: CV → Musaned → Wafid → Tasheer → Insurance → Enjaz · Visa
 * A step with a run behind it opens AI Actions when clicked.
 */
import { useEffect, useState } from 'react'
import api from '../services/api'

const LOOK = {
  done:   { dot: 'bg-emerald-500 text-white', icon: '✓', text: 'text-emerald-700 dark:text-emerald-300', line: 'bg-emerald-400' },
  active: { dot: 'bg-amber-400 text-white animate-pulse', icon: '•', text: 'text-amber-700 dark:text-amber-300', line: 'bg-slate-200 dark:bg-slate-700' },
  failed: { dot: 'bg-red-500 text-white', icon: '!', text: 'text-red-600 dark:text-red-400', line: 'bg-slate-200 dark:bg-slate-700' },
  todo:   { dot: 'bg-slate-100 ring-1 ring-slate-300 text-slate-500 dark:bg-slate-700 dark:text-slate-300', icon: '', text: 'text-slate-500', line: 'bg-slate-200 dark:bg-slate-700' },
  soon:   { dot: 'bg-white dark:bg-slate-900 border-2 border-dashed border-slate-300 dark:border-slate-600 text-slate-400', icon: '', text: 'text-slate-400', line: 'bg-slate-200 dark:bg-slate-700' },
}

function Track({ title, steps }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-2">{title}</p>
      <ol className="flex items-start">
        {steps.map((s, i) => {
          const l = LOOK[s.state] || LOOK.todo
          return (
            <li key={s.key} className="relative flex-1 min-w-0">
              {/* the line to the next step */}
              {i < steps.length - 1 && <span className={`absolute top-3.5 left-1/2 w-full h-0.5 ${l.line}`} />}
              <button type="button" title={s.note || s.title}
                onClick={() => s.workflow && document.getElementById('ai-actions')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className={`relative w-full flex flex-col items-center text-center px-0.5 ${s.workflow ? 'cursor-pointer' : 'cursor-default'}`}>
                <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold bg-clip-padding ${l.dot}`}>{l.icon || i + 1}</span>
                <span className={`mt-1 text-[11px] font-semibold leading-tight break-words ${l.text}`}>{s.title}</span>
                {s.note && <span className="text-[10px] text-slate-400 leading-tight break-words">{s.note}</span>}
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export default function ProfileJourney({ profileId }) {
  const [j, setJ] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => api.get(`/profiles/${profileId}/journey`).then(r => alive && setJ(r.data)).catch(() => {})
    load()
    const t = setInterval(load, 15000)
    return () => { alive = false; clearInterval(t) }
  }, [profileId])
  if (!j) return null
  return (
    <section className="panel p-4 space-y-4 divide-y divide-slate-100 dark:divide-slate-700/50">
      <Track title="🏛 LMIS" steps={j.lmis} />
      <div className="pt-4"><Track title="🇸🇦 Embassy" steps={j.embassy} /></div>
    </section>
  )
}
