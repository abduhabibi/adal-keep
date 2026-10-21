import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'

/**
 * Search pad: a searchable list of profiles. Type a name, passport number,
 * labor ID, phone or order ID; click a row to open the profile.
 *
 *   <ProfileSearchPad />                       every profile (loads them)
 *   <ProfileSearchPad brokerId={7} />          one broker's profiles (loads them)
 *   <ProfileSearchPad profiles={list} />       a list the page already has
 */
const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim()

export default function ProfileSearchPad({
  title = 'Profiles',
  brokerId = null,
  profiles: given = null,
  autoFocusKey = false,
  maxHeight = 'max-h-96',
  className = '',
}) {
  const navigate = useNavigate()
  const [loaded, setLoaded] = useState(null)
  const [q, setQ] = useState('')
  // All / running (a browser run working or waiting) / not running
  const [run, setRun] = useState('')
  const [runs, setRuns] = useState({})
  const inputRef = useRef(null)

  useEffect(() => {
    if (given) return
    let alive = true
    const load = () => api.get('/profiles', { params: brokerId ? { broker_id: brokerId } : {} })
      .then(r => { if (alive) setLoaded(Array.isArray(r.data) ? r.data : r.data?.profiles || []) })
      .catch(() => { if (alive) setLoaded([]) })
    load()
    // new documents create profiles: keep the list fresh
    const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [given, brokerId])

  useEffect(() => {
    let alive = true
    const load = () => api.get('/automations/active')
      .then(r => { if (alive) setRuns(Object.fromEntries((r.data || []).map(x => [x.profile_id, x.state]))) })
      .catch(() => {})
    load()
    const t = setInterval(load, 10000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  // Ctrl+K (or ⌘K) jumps to the global pad.
  useEffect(() => {
    if (!autoFocusKey) return
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [autoFocusKey])

  const list = given || loaded || []
  const shown = useMemo(() => {
    const words = norm(q).split(' ').filter(Boolean)
    const byRun = run ? list.filter(p => (run === 'on') === !!runs[p.id]) : list
    const rows = words.length
      ? byRun.filter(p => {
          const hay = norm([p.full_name, p.passport_number, p.labor_id, p.phone_number, p.order_id, p.broker_name].join(' '))
          return words.every(w => hay.includes(w))
        })
      : byRun
    return [...rows].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 200)
  }, [list, q, run, runs])

  return (
    <section data-tour={autoFocusKey ? 'search-pad' : undefined} className={`panel p-3 flex flex-col min-h-0 ${className}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-600 dark:text-slate-300">{title}</h3>
        <span className="text-[10px] text-slate-400">
          {loaded === null && !given ? '…' : `${shown.length}${q ? ` of ${list.length}` : ''}`}
        </span>
      </div>
      <div className="relative mb-2">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">⌕</span>
        <input
          ref={inputRef}
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && shown[0]) navigate(`/profiles/${shown[0].id}`)
            if (e.key === 'Escape') setQ('')
          }}
          placeholder={autoFocusKey ? 'Name, passport, labor ID…  (Ctrl+K)' : 'Name, passport, labor ID…'}
          className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white/80 dark:bg-slate-900/60 pl-7 pr-2 py-1.5 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none"
        />
      </div>
      <div className="flex gap-1 mb-2" role="group" aria-label="Run">
        {[['', 'All'], ['on', 'Running'], ['off', 'Not running']].map(([v, t]) => (
          <button key={v} type="button" onClick={() => setRun(v)}
            className={`flex-1 rounded-md px-1.5 py-1 text-[11px] font-semibold ${run === v ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300'}`}>
            {t}
          </button>
        ))}
      </div>
      <ul className={`overflow-y-auto custom-scrollbar -mx-1 ${maxHeight}`}>
        {shown.map(p => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => navigate(`/profiles/${p.id}`)}
              className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-teal-50 dark:hover:bg-teal-900/30 transition-colors"
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-slate-800 dark:text-slate-100">
                {runs[p.id] && <span title={runs[p.id] === 'running' ? 'Run working now' : 'Run waiting'} className={`flex-none w-2 h-2 rounded-full ${runs[p.id] === 'running' ? 'bg-blue-500 animate-pulse' : 'bg-amber-500'}`} />}
                <span className="truncate">{p.full_name || `Profile #${p.id}`}</span>
              </span>
              <span className="block text-[11px] text-slate-500 dark:text-slate-400 truncate">
                {[p.labor_id, p.passport_number, p.phone_number].filter(Boolean).join(' · ') || `#${p.id}`}
              </span>
            </button>
          </li>
        ))}
        {shown.length === 0 && (loaded !== null || given) && (
          <li className="px-2 py-4 text-center text-xs text-slate-400">{q ? 'No profile matches' : 'No profiles'}</li>
        )}
      </ul>
    </section>
  )
}
