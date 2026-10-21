import { useEffect, useState } from 'react'
import api from '../services/api'

/** Owner view: how much of Adal Keep each person uses (from the daily tutor). */
export default function TutorAdoption() {
  const [rows, setRows] = useState(null)
  useEffect(() => {
    api.get('/tutor/adoption').then(r => setRows(r.data)).catch(() => setRows([]))
  }, [])
  if (!rows?.length) return null

  return (
    <section className="panel p-5">
      <h2 className="font-bold text-slate-900 dark:text-white">🎓 የስርዓቱ አጠቃቀም · Feature use</h2>
      <p className="text-xs text-slate-500 mt-0.5">ከዕለታዊ አስተማሪው · from the daily tutor</p>
      <div className="mt-4 space-y-3">
        {rows.map(p => {
          const pct = Math.round(100 * p.used / p.total)
          return (
            <div key={p.who} className="rounded-xl border border-slate-200 dark:border-slate-700 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold text-sm text-slate-800 dark:text-slate-100">{p.name}</span>
                <span className="text-xs text-slate-500">{p.used} / {p.total} ባህሪያት · features</span>
                {p.streak > 0 && <span className="text-xs font-semibold text-orange-600 dark:text-orange-400">🔥 {p.streak}</span>}
                {p.last_active && <span className="text-[11px] text-slate-400 ml-auto">{new Date(p.last_active).toLocaleDateString()}</span>}
              </div>
              <div className="h-1.5 mt-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-teal-500 to-indigo-500" style={{ width: `${pct}%` }} />
              </div>
              {p.never.length > 0 && (
                <p className="text-[11px] text-slate-500 mt-2">
                  ገና ያልሞከሩት · Never tried: {p.never.join(' · ')}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
