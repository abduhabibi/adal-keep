import { lazy, Suspense, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import api from '../services/api'
import Icon from './shared/Icon'

const BrowserView = lazy(() => import('./BrowserView').catch(() => { location.reload(); return new Promise(() => {}) }))

/**
 * The sidebar's Browsers ("Adal Browser", asked on 2026-11-21): every robot
 * browser working now on any PC of the office — its site, the girl, the PC and
 * how it is doing. They all work out of sight; a click opens it live here,
 * driven with this mouse and keyboard.
 */
export default function BrowsersSection({ collapsed = false }) {
  const [list, setList] = useState([])
  const [open, setOpen] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => api.get('/browsers').then(r => { if (alive) setList(Array.isArray(r.data) ? r.data : []) }).catch(() => {})
    load()
    const t = setInterval(load, 4000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const need = list.filter(b => b.needs_you).length
  return (
    <div className={`pt-3 mt-3 border-t ak-side-sep ${collapsed ? 'px-0' : ''}`}>
      <div className={`flex items-center gap-2 px-3 pb-1 text-[11px] font-bold uppercase tracking-wide opacity-70 ${collapsed ? 'justify-center px-0' : ''}`} title="Browsers">
        <Icon name="monitor" size={14} />
        {!collapsed && <span className="truncate">Browsers</span>}
        {need > 0 && <span className="ml-auto rounded-full bg-amber-500 px-1.5 text-[10px] text-white">{need}</span>}
      </div>
      {!list.length && !collapsed && <p className="px-3 py-1 text-[11px] opacity-60">No robot is working now</p>}
      <ul className="space-y-0.5">
        {list.map(b => (
          <li key={b.key}>
            <button type="button" onClick={() => setOpen(b.key)}
              title={`${b.site} · ${b.girl || ''} · ${b.pc} · ${b.task || b.status}`}
              className={`ak-side-link w-full text-left ${collapsed ? 'justify-center px-0' : ''}`}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${b.needs_you ? 'bg-amber-500 animate-pulse' : b.status === 'Working' || b.status === 'Copying' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              {!collapsed && (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">{b.site}{b.girl ? ` · ${b.girl}` : ''}</span>
                  <span className="block truncate text-[11px] opacity-70">{b.pc} · {b.needs_you ? (b.task || 'Needs you') : b.status}</span>
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {open && createPortal(<Suspense fallback={null}><BrowserView runId={open} title={list.find(b => b.key === open)?.site} onClose={() => setOpen(null)} /></Suspense>, document.body)}
    </div>
  )
}
