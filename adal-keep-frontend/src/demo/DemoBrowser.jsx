import { useEffect, useState } from 'react'
import { demoDb, onRunsChange, resetDemo } from './server'

/**
 * Demo only. On the real system each run works in its own Brave tab; here a
 * small window shows what that tab is doing, one tab per run. Plus a thin
 * banner saying this is the demo, with a reset.
 */
const SITE = {
  lmis: { name: 'LMIS-style portal', head: 'bg-[#1e3a5f]' },
  musaned: { name: 'Musaned-style portal', head: 'bg-[#14532d]' },
}

export function DemoBanner() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-1.5 text-xs font-medium bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
      <span>Demo — everyone and every number here is made up. Open a profile and press Musaned or Police Certificate.</span>
      <button
        type="button"
        className="underline font-semibold"
        onClick={() => { resetDemo(); window.location.href = '/' }}
      >
        Reset demo
      </button>
    </div>
  )
}

export default function DemoBrowser() {
  const [, tick] = useState(0)
  const [active, setActive] = useState(null)
  const [open, setOpen] = useState(true)
  useEffect(() => onRunsChange(() => tick(n => n + 1)), [])

  const runs = demoDb().runs.filter(r => r.view && r.status !== 'cancelled').slice(-4)
  if (!runs.length) return null
  const shown = runs.find(r => r.id === active) || runs[runs.length - 1]
  const v = shown.view
  const site = SITE[v.site] || SITE.lmis

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="fixed left-3 bottom-3 z-40 rounded-full px-3 py-1.5 text-xs font-semibold shadow-lg bg-slate-800 text-white">
        ▣ Show the run tabs ({runs.length})
      </button>
    )
  }

  return (
    <div className="fixed left-3 bottom-3 z-40 w-[min(420px,calc(100vw-24px))] rounded-xl overflow-hidden shadow-2xl border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-800">
      <div className="flex items-center gap-1 px-2 pt-2 overflow-x-auto">
        {runs.map(r => (
          <button key={r.id} type="button" onClick={() => setActive(r.id)}
            className={`shrink-0 px-2.5 py-1 rounded-t-lg text-[11px] font-semibold ${r.id === shown.id ? 'bg-white text-slate-900' : 'text-slate-500 dark:text-slate-300'}`}>
            {r.status === 'running' && <span className="inline-block w-1.5 h-1.5 mr-1 rounded-full bg-teal-500 animate-pulse" />}
            Run #{r.id} · {r.workflow_id === 'musaned_add_candidate' ? 'Musaned' : 'Police'}
          </button>
        ))}
        <button type="button" onClick={() => setOpen(false)} className="ml-auto px-2 text-slate-500 dark:text-slate-300 text-sm" title="Hide">—</button>
      </div>
      <div className="bg-white text-slate-900">
        <div className="px-3 py-1.5 border-b border-slate-200">
          <div className="rounded-full bg-slate-100 px-3 py-1 font-mono text-[11px] text-slate-500 truncate">{v.url} <span className="text-amber-700">(simulation)</span></div>
        </div>
        <div className={`${site.head} text-white px-3 py-2 text-sm font-semibold flex justify-between`}>
          <span>{v.title}</span><span className="text-[10px] font-normal opacity-80">{site.name}</span>
        </div>
        <div className="max-h-64 overflow-y-auto p-3 grid grid-cols-2 gap-2">
          {v.fields.map(f => (
            <div key={f.label} className={f.label === 'Skills' ? 'col-span-2' : ''}>
              <div className="text-[10px] text-slate-500">{f.label}</div>
              <div className={`rounded-md border px-2 py-1 text-xs min-h-[26px] transition-colors ${
                f.state === 'loading' ? 'border-amber-300 bg-amber-50 text-amber-700 italic'
                : f.state === 'readonly' ? 'border-slate-200 bg-slate-50'
                : 'border-teal-300 bg-teal-50'}`}>
                {f.state === 'photo'
                  ? <img src={`/api/files/${shown.profile_id * 100 + 21}/thumbnail`} alt="" className="h-14 rounded" />
                  : f.value}
              </div>
            </div>
          ))}
          {!v.fields.length && <div className="col-span-2 text-xs text-slate-400 py-6 text-center">Loading the page…</div>}
        </div>
        {v.banner && (
          <div className={`mx-3 mb-3 rounded-md px-2.5 py-2 text-xs font-medium ${v.banner.kind === 'done' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-900'}`}>
            {v.banner.kind === 'done' ? '✓ ' : '⏸ '}{v.banner.text}
          </div>
        )}
      </div>
    </div>
  )
}
