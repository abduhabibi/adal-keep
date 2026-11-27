import { useCallback, useEffect, useState } from 'react'
import api from '../services/api'

/**
 * Robot history → by site (the owner, 2026-11-27): Musaned, Wafid, Enjaz, Tasheer and LMIS, each with its standing
 * tab (signed in and standing by, working, or sign in needed), its tasks waiting and working, and its last results.
 * Off on the server: ADAL_ROBOTS_BY_SITE=0 (nothing shown here).
 */
const TAB = {
  standby: ['Signed in · standing by', 'bg-emerald-100 text-emerald-800'],
  working: ['Working', 'bg-sky-100 text-sky-800'],
  'sign-in-needed': ['Sign in needed', 'bg-amber-100 text-amber-800'],
  'no-tab': ['No tab yet', 'bg-slate-100 text-slate-600'],
}
const STATUS = {
  pending: ['Waiting', 'text-slate-500'], running: ['Working', 'text-sky-700'], paused: ['Waiting for a person', 'text-amber-700'],
  done: ['Done', 'text-emerald-700'], failed: ['Failed', 'text-red-700'], cancelled: ['Cancelled', 'text-slate-500'],
}
const words = (w) => String(w || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
const time = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

function Task({ t }) {
  const [label, cls] = STATUS[t.status] || [t.status, 'text-slate-500']
  return (
    <li className="py-1.5 text-xs">
      <span className="font-medium" translate="no">{t.name || '—'}</span>
      <span className="text-slate-500"> · {words(t.workflow)}</span>
      <span className={`float-right font-semibold ${cls}`}>{label}{t.at ? ` ${time(t.at)}` : ''}</span>
      {(t.said || ((t.status === 'paused' || t.status === 'done') && t.why)) && <span className={`block truncate ${t.status === 'done' && t.why ? 'text-amber-700' : 'text-slate-400'}`} title={t.said || t.why}>{t.said || t.why}</span>}
    </li>
  )
}

export default function SiteBoards() {
  const [data, setData] = useState(null)
  const [tabs, setTabs] = useState({})
  const [robots, setRobots] = useState('')
  const [memory, setMemory] = useState(null)
  const load = useCallback(() => {
    api.get('/automations/by-site', { adalNoCache: true }).then(r => setData(r.data)).catch(() => setData({ off: true, sites: [] }))
    api.get('/automations/site-tabs', { adalNoCache: true })
      .then(r => { setTabs(Object.fromEntries((r.data?.sites || []).map(s => [s.key, s]))); setRobots(r.data?.off ? 'off' : ''); setMemory(r.data?.memory || null) })
      .catch(e => { setTabs({}); setRobots(e.response?.data?.robots === 'off' ? 'Adal Robots is not running on this PC' : '') })
  }, [])
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [load])
  if (!data || data.off) return null

  return (
    <div className="space-y-2">
      {robots && robots !== 'off' && <p className="text-xs text-amber-700">{robots}</p>}
      {memory?.critical && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">This PC is short of memory ({memory.freeMB} MB free). Close programs you do not need. The robots' site tabs stay open, so their sign-ins are kept.</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.sites.map(s => {
          const tab = tabs[s.key]
          const [label, cls] = tab ? TAB[tab.state] || [tab.state, 'bg-slate-100'] : [null, '']
          const working = s.queue.filter(t => t.status === 'running'), waiting = s.queue.filter(t => t.status !== 'running')
          return (
            <section key={s.key} className="panel rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-base font-bold">{s.name}</h2>
                {label && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>}
              </div>
              {tab?.state === 'sign-in-needed' && <p className="mt-1 text-xs text-amber-700">Sign in once in its tab (Watch robots). The robot never types the password or the code.</p>}
              <p className="mt-2 text-xs font-semibold uppercase text-slate-400">In line · {working.length} working, {waiting.length} waiting</p>
              {s.queue.length ? <ul className="divide-y divide-slate-100 dark:divide-slate-700">{[...working, ...waiting].slice(0, 8).map(t => <Task key={t.id} t={t} />)}</ul>
                : <p className="py-1.5 text-xs text-slate-400">Nothing in line.</p>}
              {s.skipped?.length > 0 && <>
                <p className="mt-2 text-xs font-semibold uppercase text-slate-400">Not made</p>
                <ul>{s.skipped.map((k, i) => <li key={i} className="truncate py-0.5 text-xs text-slate-500" translate="no">{k.name || '—'} · {words(k.workflow)}: {k.why}</li>)}</ul>
              </>}
              <p className="mt-2 text-xs font-semibold uppercase text-slate-400">Last results</p>
              {s.last.length ? <ul className="divide-y divide-slate-100 dark:divide-slate-700">{s.last.map(t => <Task key={t.id} t={t} />)}</ul>
                : <p className="py-1.5 text-xs text-slate-400">None in the last 3 days.</p>}
            </section>
          )
        })}
      </div>
    </div>
  )
}
