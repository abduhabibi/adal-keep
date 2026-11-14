import { useCallback, useEffect, useState } from 'react'
import PrioritizeButton, { useWaitingFiles } from '../components/PrioritizeButton'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import EmptyState from '../components/shared/EmptyState'
import Spinner from '../components/shared/Spinner'
import StatusBadge from '../components/shared/StatusBadge'
import Button from '../components/shared/Button'
import Input from '../components/shared/Input'
import { useProfileFilters } from '../components/profileFilters'
import { JourneyFork, SHARED, BRANCHES } from '../components/ProfileJourney'
import SelectionBar from '../components/SelectionBar'
import { onDataChange } from '../lib/changes'
import { profilesList } from '../lib/profilesCache'
import { cachedGet } from '../lib/deviceCache'

const STATUS_OPTIONS_AM = [
  { value: 'pending', label: 'በመጠባበቅ ላይ' },
  { value: 'in_progress', label: 'በሂደት ላይ' },
  { value: 'completed', label: 'የተጠናቀቀ' },
  { value: 'medical_applied', label: 'ሕክምና › ተመዝግቧል (Applied)', group: 'medical' },
  { value: 'medical_fit', label: 'ሕክምና › ብቁ (Fit)', group: 'medical' },
  { value: 'medical_rejected', label: 'ሕክምና › ውድቅ (Rejected)', group: 'medical' },
]

export default function ProfilesPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [profiles, setProfiles] = useState([])
  const [brokers, setBrokers] = useState([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState(searchParams.get('q') || '')

  const status = searchParams.get('status') || 'all'
  const brokerId = searchParams.get('broker_id') || ''

  const load = useCallback(async (quiet) => {
    if (quiet !== true) setLoading(true)
    try {
      const params = {}
      if (query.trim()) params.q = query.trim()
      if (status && status !== 'all') params.status = status
      if (brokerId) params.broker_id = brokerId

      const [profilesRes, brokersRes] = await Promise.all([
        Object.keys(params).length ? api.get('/profiles', { params }).then(r => r.data)
          : profilesList({ fresh: quiet === true, onSaved: quiet === true ? undefined : (d) => { setProfiles(d || []); setLoading(false) } }),
        cachedGet('/brokers', { onSaved: quiet === true ? undefined : (d) => setBrokers(d || []) }),
      ])
      setProfiles(profilesRes)
      setBrokers(brokersRes)
    } catch {
      if (quiet !== true) toast.error('ፕሮፋይሎችን መጫን አልተቻለም')
    } finally {
      setLoading(false)
    }
  }, [query, status, brokerId])
  // A profile changed anywhere (a person, a robot, a phone): the list follows at once.
  useEffect(() => onDataChange(['profiles', 'brokers'], () => load(true), 3000), [load])
  // A move running: its new girls show as they come (every 5 s), even if a change notice is missed.
  const waitingFiles = useWaitingFiles()
  useEffect(() => { if (!waitingFiles.size) return; const t = setInterval(() => load(true), 5000); return () => clearInterval(t) }, [waitingFiles.size > 0, load]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(load, 200)
    return () => clearTimeout(t)
  }, [load])

  // Date range, experience, age, married, country, skill, religion + sort.
  const { rows: allRows, filterBar, sortBar, active: filtering, clear, step, setStep, stepCounts, activeCount, journey } = useProfileFilters(profiles)
  // An old link ?chosen=1 (the 🤝 Selected button, now the journey's Selected phase).
  useEffect(() => { if (searchParams.get('chosen') === '1') { setStep('selected'); const n = new URLSearchParams(searchParams); n.delete('chosen'); setSearchParams(n, { replace: true }) } }, [searchParams.get('chosen')]) // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = allRows
  // 100 a page: quick to draw on any phone.
  const PAGE = 100
  const [page, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))
  useEffect(() => { setPage(1) }, [filtered.length, step])
  const rows = filtered.slice((Math.min(page, pages) - 1) * PAGE, Math.min(page, pages) * PAGE)

  // 🔎 The whole Musaned Employment Requests list: who is newly chosen.
  const [scanning, setScanning] = useState(false)
  const scanMusaned = async () => {
    setScanning(true)
    const id = toast.loading('Looking at the Musaned list… (sign in if Musaned asks)')
    try {
      const r = await api.post('/contracts/scan')
      if (!r.data.started && !r.data.busy) throw new Error(r.data.error || 'Could not start')
      let s
      for (;;) {
        await new Promise(res => setTimeout(res, 4000))
        s = (await api.get('/contracts/check')).data
        if (!s.running) break
      }
      const fresh = (s.results || []).filter(x => x.first).map(x => x.name)
      const moved = (s.results || []).filter(x => !x.first && x.state === 'chosen' && !x.unchanged).length
      const added = s.added || []
      if (added.length) toast.success(`Added to Adal Keep from Musaned: ${added.map(a => a.name).join(', ')}`, { duration: 10000 })
      if (s.signedOut) toast.error('Musaned is signed out — sign in to Musaned in the window that opens; the check goes on by itself.', { id, duration: 8000 })
      else if (fresh.length) toast.success(`Newly chosen: ${fresh.join(', ')} — contracts saved.`, { id, duration: 10000 })
      else toast.success(`No one new.${moved ? ` ${moved} moved to a new stage.` : ''}${s.unknown?.length ? ` ${s.unknown.length} on Musaned are not in Adal Keep.` : ''}`, { id, duration: 6000 })
      load()
    } catch (e) {
      toast.error(e.response?.data?.error || e.message, { id })
    } finally { setScanning(false) }
  }

  // Ticked profiles (the box at the top centre of each card) → the side bar.
  const [picked, setPicked] = useState(() => new Map())
  const togglePick = (p) => setPicked(m => { const n = new Map(m); n.has(p.id) ? n.delete(p.id) : n.set(p.id, p); return n })
  // While some are ticked the bar takes the right side: the search pad steps aside.
  useEffect(() => { document.body.dataset.picking = picked.size ? '1' : ''; return () => { document.body.dataset.picking = '' } }, [picked.size])
  // What each ticked girl lacks for the last button pressed (shown on her card).
  const [lacking, setLacking] = useState({})

  // The nine filters fold away: the search line stays one line high.
  const [showFilters, setShowFilters] = useState(false)

  const updateFilter = (key, value) => {
    const next = new URLSearchParams(searchParams)
    if (!value || value === 'all') next.delete(key)
    else next.set(key, value)
    setSearchParams(next)
  }

  const deleteProfile = async (id, e) => {
    e?.stopPropagation()
    if (!confirm('ይህንን ፕሮፋይል ሙሉ በሙሉ ለማጥፋት እርግጠኛ ነዎት?')) return
    try {
      await api.delete(`/profiles/${id}`)
      toast.success('ፕሮፋይሉ ተሰርዟል')
      load()
    } catch {
      toast.error('ማጥፋት አልተቻለም')
    }
  }


  return (
    <div>
      {/* Title · the journey (fills the space between) · the buttons — one
          line on wide screens; stacked on narrow ones, the journey scrolling sideways. */}
      <div className="mb-5 flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4">
        {/* The wakala (paid on Musaned or not): two buttons — the page's name is already in the header. */}
        <div className="shrink-0 lg:w-40">
          <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">Wakala</div>
          <div className="grid grid-cols-2 lg:grid-cols-1 gap-1.5">
            {[['wakala:paid', '✓ Paid', 'border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300', 'bg-emerald-600 text-white border-emerald-600'],
              ['wakala:unpaid', '⏳ Unpaid', 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300', 'bg-red-600 text-white border-red-600']].map(([k, t, look, on]) => (
              <button key={k} type="button" onClick={() => setStep(k)} title={k === 'wakala:paid' ? 'Chosen, the wakala paid on Musaned' : 'Chosen by an employer, the wakala not paid yet'}
                className={`flex min-w-0 items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition ${step === k ? on + ' shadow-md' : 'bg-white/60 dark:bg-slate-900/60 ' + look}`}>
                <span className="truncate">{t}</span>
                <span className={`shrink-0 rounded-full px-1.5 text-[11px] ${step === k ? 'bg-white/25' : 'bg-slate-100 dark:bg-slate-800'}`}>{stepCounts[k] || 0}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="panel min-w-0 flex-1 px-2 py-2" data-tour="journey-filter">
          <JourneyFork compact counts={stepCounts} selected={step} onSelect={setStep} />
        </div>
        <div className="shrink-0 grid grid-cols-2 lg:grid-cols-1 lg:w-56 gap-2">
          <Button data-tour="new-profile" className="col-span-2 lg:col-span-1 w-full whitespace-nowrap" onClick={() => navigate('/profiles/new')}>
            + ፕሮፋይል አክል
          </Button>
          <Button variant="secondary" className="col-span-2 lg:col-span-1 w-full whitespace-nowrap !px-2 text-xs sm:text-sm" onClick={scanMusaned} disabled={scanning} title="Reads the Musaned Employment Requests list: anyone newly chosen gets her contract saved and a task; girls not in Adal Keep are added">
            {scanning ? '🔎 Checking…' : '🔎 Check for new selections'}
          </Button>
        </div>
      </div>

      <div className="panel mb-4 sm:mb-5 grid grid-cols-[minmax(0,1fr)_auto] gap-2 p-2 sm:p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center animate-fade-up">
        <Input
          placeholder="በስም፣ በስልክ ወይም በመታወቂያ ይፈልጉ..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            const next = new URLSearchParams(searchParams)
            if (e.target.value.trim()) next.set('q', e.target.value.trim())
            else next.delete('q')
            setSearchParams(next, { replace: true })
          }}
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          }
        />

        <select
          className={`field col-span-2 sm:col-span-1 ${showFilters ? '' : 'hidden sm:block'}`}
          value={status}
          onChange={(e) => updateFilter('status', e.target.value)}
        >
          <option value="all">ሁሉንም ሁኔታዎች</option>
          {STATUS_OPTIONS_AM.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <select
          className={`field col-span-2 sm:col-span-1 ${showFilters ? '' : 'hidden sm:block'}`}
          value={brokerId}
          onChange={(e) => updateFilter('broker_id', e.target.value)}
        >
          <option value="">ሁሉንም ደላሎች</option>
          {brokers.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>

        <button type="button" onClick={() => setShowFilters(v => !v)}
          className={`field !w-auto whitespace-nowrap !px-3 text-sm font-semibold ${activeCount ? 'border-teal-400 text-teal-700 dark:text-teal-300' : ''}`}>
          ⚙ Filters{activeCount ? ` · ${activeCount}` : ''} {showFilters ? '▴' : '▾'}
        </button>

        {showFilters && <div className="col-span-2 sm:col-span-4 border-t border-slate-100 dark:border-slate-700 pt-3">{filterBar}</div>}

        <div className="sm:col-span-4 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            {rows.length} of {profiles.length} profiles
            {filtering && (
              <button type="button" className="ml-3 text-teal-700 dark:text-teal-300 hover:underline" onClick={clear}>
                Clear filters
              </button>
            )}
            {/* Any filter on (a step, a search, a status…): tick every profile it found, on every page. */}
            {(filtering || step || query.trim() || status !== 'all' || brokerId) && filtered.length > 0 && (
              filtered.every(p => picked.has(p.id))
                ? <button type="button" className="ml-3 font-semibold text-slate-500 hover:underline" onClick={() => { setPicked(new Map()); setLacking({}) }}>☐ Untick all</button>
                : <button type="button" className="ml-3 rounded-md bg-teal-600 px-2 py-0.5 font-semibold text-white hover:bg-teal-700" onClick={() => setPicked(m => { const n = new Map(m); filtered.forEach(p => n.set(p.id, p)); return n })}>☑ Select all {filtered.length}</button>
            )}
          </span>
          {sortBar}
        </div>
      </div>

      {loading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="ምንም ፕሮፋይል አልተገኘም"
          description={
            query || status !== 'all' || brokerId || filtering
              ? 'እባክዎ ማጣሪያዎችን ያጽዱ ወይም ሌላ ነገር ይፈልጉ።'
              : 'የሰነዶች እና የሁኔታ ክትትል ለመጀመር የደንበኛ ፕሮፋይል ያክሉ።'
          }
          action={
            <Button onClick={() => navigate('/profiles/new')}>
              ፕሮፋይል ፍጠር
            </Button>
          }
        />
      ) : (
        <>
        <Pager page={Math.min(page, pages)} pages={pages} total={filtered.length} per={PAGE} onPage={setPage} />
        <div key={step || 'all'} className={`grid grid-cols-2 gap-x-2 gap-y-4 pt-3 sm:gap-x-3 sm:gap-y-5 xl:grid-cols-3 ${picked.size ? 'lg:pr-[20rem]' : ''}`}>
          {rows.map((p, i) => (
            <article
              key={p.id}
              className={`panel group relative cursor-pointer px-3 py-2.5 sm:p-4 transition hover:-translate-y-0.5 hover:shadow-soft animate-fade-up ${picked.has(p.id) ? 'ring-2 ring-teal-500' : ''}`}
              style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
              onClick={() => navigate(`/profiles/${p.id}`)}
            >
              <label onClick={(e) => e.stopPropagation()} title="Select"
                className="absolute right-1.5 top-1.5 z-10 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md">
                <input type="checkbox" className="h-4 w-4 cursor-pointer accent-teal-600" checked={picked.has(p.id)} onChange={() => togglePick(p)} />
              </label>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-display text-sm sm:text-lg font-bold text-slate-900" title={p.full_name}>
                    <span className="sm:hidden">{String(p.full_name || '').trim().split(/\s+/)[0]}</span>
                    <span className="hidden sm:inline">{p.full_name}</span>
                  </h3>
                  <p className="mt-0.5 truncate text-[11px] sm:text-sm text-slate-500">
                    <span className="hidden sm:inline">{p.phone_number || 'ስልክ የለም'}</span>
                    {/* Phones: two short cards a row — first name and passport. */}
                    <span className="sm:hidden">{p.passport_number || p.phone_number || '—'}</span>
                  </p>
                </div>
                <span className="hidden sm:block"><StatusBadge status={p.status} /></span>
              </div>

              <PrioritizeButton profileId={p.id} className="mt-2" />
              <MiniJourney steps={journey.steps[p.id]} who={journey.who[p.id]} missing={journey.missing[p.id]} picked={step?.split(':')[0]} />
              {lacking[p.id]?.length > 0 && (
                <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700 animate-slide-up dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
                  <b>Missing:</b> {lacking[p.id].join(' · ')}
                </div>
              )}

              <dl className="hidden sm:block mt-4 space-y-1.5 text-sm text-slate-600">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-400">ደላላ</dt>
                  <dd className="truncate font-medium">{p.broker_name || 'ያልተመደበ'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-400">ፓስፖርት</dt>
                  <dd className="truncate font-medium">{p.passport_number || '—'}</dd>
                </div>
                {(p.room || p.table_name || p.box_number) && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-400">ቦታ</dt>
                    <dd className="truncate font-medium">
                      {[p.room, p.table_name, p.box_number].filter(Boolean).join(' / ')}
                    </dd>
                  </div>
                )}
              </dl>

              <div className="hidden sm:flex mt-4 gap-2 border-t border-slate-100 dark:border-slate-700 pt-3">
                <button
                  type="button"
                  className="btn-secondary flex-1 py-2 text-xs"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/profiles/${p.id}/edit`)
                  }}
                >
                  አርም
                </button>
                <button
                  type="button"
                  className="flex-1 py-2 text-xs font-medium rounded-lg text-red-600 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 border border-red-200/60 dark:border-red-800/40 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteProfile(p.id, e)
                  }}
                >
                  ሰርዝ
                </button>
              </div>
            </article>
          ))}
        </div>
        <Pager page={Math.min(page, pages)} pages={pages} total={filtered.length} per={PAGE} onPage={(n) => { setPage(n); window.scrollTo({ top: 0, behavior: 'smooth' }) }} bottom />
        </>
      )}
      {picked.size > 0 && (
        <SelectionBar picked={[...picked.values()]} onRemove={togglePick} onClear={() => { setPicked(new Map()); setLacking({}) }} onLacking={setLacking}
          onAllShown={() => setPicked(m => { const n = new Map(m); rows.forEach(r => n.set(r.id, r)); return n })} />
      )}
    </div>
  )
}
// The seven steps in journey order, for the small dots on each card.
const STEP_LIST = [...SHARED, ...BRANCHES.flatMap(b => b.steps)].map(([k, t]) => [k, t])
const DOT = { waiting: 'bg-sky-400', done: 'bg-emerald-500', active: 'bg-amber-400 animate-pulse', failed: 'bg-red-500', todo: 'bg-slate-200 dark:bg-slate-700', soon: 'bg-slate-100 dark:bg-slate-800' }

/**
 * On each card: her journey as seven small dots (hover: the step and who it is
 * with); with a step picked above the list, that step's who and missing documents.
 */
function MiniJourney({ steps = {}, who = {}, missing = {}, picked }) {
  const n = Object.values(steps).filter(v => v === 'done').length
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1" title={`${n} of ${STEP_LIST.length} steps done`}>
        {STEP_LIST.map(([k, t], i) => (
          <span key={k} title={`${t}${who[k] ? ` — ${who[k]}` : ''}${missing[k]?.length ? ` · missing: ${missing[k].join(', ')}` : ''}`}
            className={`h-1.5 flex-1 rounded-full ${DOT[steps[k]] || DOT.todo} ${picked === k ? 'ring-2 ring-emerald-300' : ''} ${i === SHARED.length ? 'ml-1' : ''}`} />
        ))}
      </div>
      {picked && (who[picked] || missing[picked]?.length > 0) && (
        <div className="mt-1.5 space-y-0.5 text-[11px] leading-tight">
          {who[picked] && <p className="line-clamp-2 text-slate-600 dark:text-slate-300">👤 {who[picked]}</p>}
          {missing[picked]?.length > 0 && <p className="truncate text-red-600 dark:text-red-400">✗ {missing[picked].join(', ')}</p>}
        </div>
      )}
    </div>
  )
}

/** Pages of 100: « 1 | 2 | … | n » — folds to "Page 2 of 5" with « when not needed. */
/** ‹ 1 … 4 5 6 … 21 › — one short line on any screen. */
function Pager({ page, pages, total, per, onPage, bottom = false }) {
  if (pages <= 1) return null
  const from = (page - 1) * per + 1, to = Math.min(total, page * per)
  const near = [...new Set([1, page - 1, page, page + 1, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b)
  const list = []
  near.forEach((n, i) => { if (i && n - near[i - 1] > 1) list.push('…' + n); list.push(n) })
  const btn = 'h-8 min-w-[32px] rounded-lg px-2 font-semibold'
  const plain = `${btn} bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-40`
  return (
    <div className={`flex flex-wrap items-center gap-1 text-xs ${bottom ? 'mt-4 justify-center' : 'mb-3'} col-span-full`}>
      <button type="button" className={plain} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
      {list.map(n => typeof n === 'string'
        ? <span key={n} className="px-0.5 text-slate-400">…</span>
        : <button key={n} type="button" onClick={() => onPage(n)} className={n === page ? `${btn} bg-teal-600 text-white` : plain}>{n}</button>)}
      <button type="button" className={plain} disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">›</button>
      <span className="ml-1 text-slate-400 whitespace-nowrap">{from}–{to} of {total}</span>
    </div>
  )
}
