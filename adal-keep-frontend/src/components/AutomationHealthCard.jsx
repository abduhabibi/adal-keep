/**
 * Settings → Health: each robot's last success, its last failure with the
 * reason, and a dot. View only: made from the runs and states the PC already
 * keeps (GET /api/system/automation-health). It starts nothing.
 */
import { useEffect, useState } from 'react'
import api from '../services/api'
import Card from './shared/Card'
import Icon from './shared/Icon'
import Segmented from './shared/Segmented'

const ICON = { whatsapp: 'chat', backup: 'backup', online: 'link' }
const DOT = {
  green: ['bg-emerald-500', 'Working'],
  amber: ['bg-amber-400', 'Look at it'],
  red: ['bg-red-500', 'Not working'],
  grey: ['bg-slate-300 dark:bg-slate-600', 'Not used yet'],
}

const when = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso), mins = Math.round((Date.now() - d.getTime()) / 60000)
  const rel = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`
  return <span title={d.toLocaleString()}>{rel}</span>
}

export default function AutomationHealthCard() {
  const [s, setS] = useState(null)
  const [err, setErr] = useState('')
  const [show, setShow] = useState('all')
  useEffect(() => {
    let on = true
    const load = () => api.get('/system/automation-health').then(r => { if (on) { setS(r.data); setErr('') } }).catch(e => on && setErr(e?.response?.data?.error || e.message))
    load()
    const t = setInterval(load, 60000)
    return () => { on = false; clearInterval(t) }
  }, [])
  const all = s?.items || []
  const bad = all.filter(i => i.dot === 'red' || i.dot === 'amber')
  const list = show === 'attention' ? bad : all

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><Icon name="pulse" />Health</h2>
      <p className="text-sm text-slate-500 mb-3" translate="no">
        When each robot last worked and last failed. {s?.at ? `Updated ${new Date(s.at).toLocaleTimeString()}.` : ''}
      </p>
      <div className="mb-3" translate="no">
        <Segmented size="sm" options={[{ id: 'all', label: 'All' }, { id: 'attention', label: 'Needs a look', badge: bad.length || null }]} value={show} onChange={setShow} />
      </div>
      {err && <p className="text-sm text-red-600 mb-2" translate="no">{err}</p>}
      {!s && !err && <p className="text-sm text-slate-500" translate="no">Loading…</p>}
      {s && !list.length && <p className="text-sm text-emerald-700 dark:text-emerald-300" translate="no">Everything is working.</p>}
      <ul className="divide-y divide-slate-200/70 dark:divide-slate-700/60" translate="no">
        {list.map(i => {
          const [dot, label] = DOT[i.dot] || DOT.grey
          return (
            <li key={i.key} className="py-2.5 flex items-start gap-3">
              <span className="ak-tile flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"><Icon name={ICON[i.key] || 'robot'} size={18} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot}`} title={label} aria-label={label} />
                  <b className="text-sm">{i.name}</b>
                  {i.running > 0 && <span className="text-xs text-teal-700 dark:text-teal-300">working now</span>}
                  {i.note && <span className="text-xs text-slate-500 truncate">· {i.note}</span>}
                </div>
                <div className="text-xs text-slate-500 mt-0.5 grid gap-x-4 sm:grid-cols-2">
                  <span>Last worked: {when(i.last_ok)}</span>
                  <span>Last failed: {when(i.last_fail)}</span>
                </div>
                {i.why && <div className={`text-xs mt-0.5 ${i.dot === 'green' ? 'text-slate-500' : 'text-red-700 dark:text-red-300'}`}>Why: {i.why}</div>}
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
