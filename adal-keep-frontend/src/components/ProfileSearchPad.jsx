import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import { changedGet, isList } from '../lib/changedOnly'
import { dragProfiles } from '../lib/profileDrag'
import { prefetchProfile } from '../lib/profileCache'
import Segmented from './shared/Segmented'
import { useDestination, goesTo } from '../lib/destination'

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
  // The destination country picked in the top bar.
  const [dest] = useDestination()
  const inputRef = useRef(null)

  useEffect(() => {
    if (given) return
    let alive = true
    // Every profile: the PC's slim list (only what the pad shows: the full one
    // is megabytes); a phone's copy has only the full one.
    const all = () => (isList('/profiles/brief') ? changedGet('/profiles/brief').then(data => ({ data })) : api.get('/profiles/brief')).then(r => { if (!Array.isArray(r.data)) throw new Error('no brief list'); return r })
      .catch(() => api.get('/profiles'))
    // The same list as last time is not drawn again (the pad is on every page).
    let last = null, same = null
    const load = () => (brokerId ? api.get('/profiles', { params: { broker_id: brokerId } }) : all())
      .then(r => {
        const rows = Array.isArray(r.data) ? r.data : r.data?.profiles || []
        if (rows === same) return
        same = rows
        const now = JSON.stringify(rows)
        if (!alive || now === last) return
        last = now
        startTransition(() => setLoaded(rows))
      })
      .catch(() => { if (alive) { last = null; setLoaded([]) } })
    load()
    // new documents create profiles: keep the list fresh
    const t = setInterval(load, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [given, brokerId])

  useEffect(() => {
    let alive = true
    let last = ''
    const load = () => api.get('/automations/active')
      .then(r => {
        const now = JSON.stringify(r.data || [])
        if (!alive || now === last) return
        last = now
        setRuns(Object.fromEntries((r.data || []).map(x => [x.profile_id, x.state])))
      })
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
  // Newest first, and each profile's search text, worked out once per list
  // (not again on every key typed): the first 200 that match are shown.
  const sorted = useMemo(() => list
    .map(p => [norm([p.full_name, p.passport_number, p.labor_id, p.phone_number, p.order_id, p.broker_name].join(' ')), p])
    .sort((a, b) => String(b[1].updated_at || '').localeCompare(String(a[1].updated_at || ''))), [list])
  const shown = useMemo(() => {
    const words = norm(q).split(' ').filter(Boolean)
    const out = []
    for (const [hay, p] of sorted) {
      if (run && (run === 'on') !== !!runs[p.id]) continue
      if (!goesTo(dest, p)) continue
      if (words.length && !words.every(w => hay.includes(w))) continue
      out.push(p)
      if (out.length === 200) break
    }
    return out
  }, [sorted, q, run, runs, dest])

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
      <Segmented size="sm" className="mb-2 flex w-full [&>button]:flex-1" aria-label="Run"
        options={[['', 'All'], ['on', 'Running'], ['off', 'Not running']]} value={run} onChange={setRun} />
      <ul className={`overflow-y-auto custom-scrollbar -mx-1 ${maxHeight}`}>
        {shown.map(p => (
          <li key={p.id} className="ak-lazy ak-lazy-line">
            <button
              type="button"
              draggable
              onDragStart={(e) => dragProfiles(e, p)}
              data-profile-drop={p.id} data-profile-name={p.full_name || ''}
              title="Open — or drag onto a checklist or the tray (drop tray files here to put them on her)"
              onClick={() => navigate(`/profiles/${p.id}`)}
              onMouseEnter={() => prefetchProfile(p.id)}
              className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-teal-50 dark:hover:bg-teal-900/30 transition-colors cursor-grab active:cursor-grabbing"
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
