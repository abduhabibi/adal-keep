import { Suspense, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import api from '../services/api'
import Icon from './shared/Icon'
import { lazyPart } from '../lib/pageCode'
import toast from 'react-hot-toast'

const BrowserView = lazyPart(() => import('./BrowserView'))

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
  // "Watch robots" (backend services/watchRobots.js): the robots' own window on screen, a second click
  // sends it back. Only on this click; the button is not there when switched off (ADAL_WATCH_ROBOTS=0).
  const [watch, setWatch] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.get('/automations/watch-robots').then(r => setWatch(r.data)).catch(() => setWatch(null)) }, [])
  const toggle = () => {
    if (busy) return
    setBusy(true)
    api.post('/automations/watch-robots', { watch: !watch?.watching }).then(r => {
      setWatch(r.data)
      if (r.data?.why) toast(r.data.why)
      else if (r.data?.watching) toast.success(r.data.windows ? 'The robots\' window is on your screen. Click again to put it away.' : 'The robots\' window is already on your screen.')
      else toast.success('The robots\' window is out of sight again. It keeps working.')
    }).catch(e => toast.error(e?.response?.data?.robots === 'off' ? 'Adal Robots is not running on this PC.' : 'Could not move the robots\' window.')).finally(() => setBusy(false))
  }
  return (
    <div className={`pt-3 mt-3 border-t ak-side-sep ${collapsed ? 'px-0' : ''}`}>
      <div className={`flex items-center gap-2 px-3 pb-1 text-[11px] font-bold uppercase tracking-wide opacity-70 ${collapsed ? 'justify-center px-0' : ''}`} title="Browsers">
        <Icon name="monitor" size={14} />
        {!collapsed && <span className="truncate">Browsers</span>}
        {need > 0 && <span className="ml-auto rounded-full bg-amber-500 px-1.5 text-[10px] text-white">{need}</span>}
      </div>
      {watch?.on && watch.can && (
        <button type="button" onClick={toggle} disabled={busy} title={watch.watching ? 'Put the robots\' window away' : 'Show the robots\' window on this screen'}
          className={`ak-side-link w-full text-left ${collapsed ? 'justify-center px-0' : ''} ${watch.watching ? 'font-semibold' : ''}`}>
          <Icon name="eye" size={14} />
          {!collapsed && <span className="truncate text-[13px]">{watch.watching ? 'Stop watching robots' : 'Watch robots'}</span>}
        </button>
      )}
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
