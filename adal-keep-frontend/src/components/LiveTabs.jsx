import { useEffect, useState } from 'react'
import api from '../services/api'

/**
 * The robot browser's tabs, above the live view: each site a tab is open on (Musaned, Wafid, …) and each run; a click
 * shows that one, from the one shared stream. Nothing is drawn when there is only the one.
 */
export default function LiveTabs({ current, onPick }) {
  const [list, setList] = useState([])
  useEffect(() => {
    let alive = true, t
    // (Not a repeating refresh: those wait for a change of the data, main.jsx; a tab that opens is none.)
    const load = () => (document.hidden ? Promise.resolve() : api.get('/browsers?tabs=1', { adalNoCache: true }).then(r => { if (alive) setList(Array.isArray(r.data) ? r.data : []) }).catch(() => {})).finally(() => { if (alive) t = setTimeout(load, 3000) })
    load()
    return () => { alive = false; clearTimeout(t) }
  }, [])
  const here = list.some(b => b.key === String(current))
  if (list.length < (here ? 2 : 1)) return null
  return (
    <div data-testid="live-tabs" role="tablist" className="flex gap-1 overflow-x-auto border-b border-slate-200 px-1.5 pt-1 dark:border-slate-800">
      {list.map(b => {
        const on = b.key === String(current)
        const what = [b.site, b.girl || b.account].filter(Boolean).join(' · ')
        return (
          <button key={b.key} type="button" role="tab" aria-selected={on} onClick={() => !on && onPick(b.key)} title={`${what}${b.task ? ` — ${b.task}` : ''}`}
            className={`flex max-w-[13rem] shrink-0 items-center gap-1.5 rounded-t-lg border border-b-0 px-2.5 py-1 text-xs ${on ? 'border-slate-300 bg-white font-semibold dark:border-slate-600 dark:bg-slate-800' : 'border-transparent bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-900 dark:text-slate-300'}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${b.needs_you ? 'bg-amber-500 animate-pulse' : b.idle ? 'bg-slate-400' : 'bg-emerald-500'}`} />
            <span className="truncate">{what}</span>
          </button>
        )
      })}
    </div>
  )
}
