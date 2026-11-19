import GlassSelect from '../components/shared/GlassSelect'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import ReadingBar from '../components/ReadingBar'
import { onDataChange } from '../lib/changes'
import { profilesList } from '../lib/profilesCache'
import { cachedGet } from '../lib/deviceCache'
import { onPhone } from '../lib/phoneMode'
import { FIRST, AFTER, READY, afterInOrder, phaseOf as phaseFrom, inWaitingPhase, stepMarks } from '../lib/phase'
import { shows } from '../lib/stageActions'

const STATUS_OPTIONS_AM = [
  { value: 'pending', label: 'በመጠባበቅ ላይ' },
  { value: 'in_progress', label: 'በሂደት ላይ' },
  { value: 'completed', label: 'የተጠናቀቀ' },
  { value: 'medical_applied', label: 'ሕክምና › ተመዝግቧል (Applied)', group: 'medical' },
  { value: 'medical_fit', label: 'ሕክምና › ብቁ (Fit)', group: 'medical' },
  { value: 'medical_rejected', label: 'ሕክምና › ውድቅ (Rejected)', group: 'medical' },
]

// One phase at a time (asked on 2026-11-17): the list shows the profiles of
// one phase; a search looks through all of them. The phases: lib/phase.js
// (Waiting and Unfit asked for on 2026-11-19).
// After the EPRO: the steps in the agency's order (dragged here or on a
// profile's AI Actions — Settings "journey_order", the step boxes' names).
export const phaseOf = (steps = {}, p = {}, after = AFTER) => phaseFrom(steps, p, after)
const NOW_TEXT = { cv: 'CV next', musaned: 'Musaned next', waiting: 'Waiting to be chosen', selected: 'Chosen — book Wafid', wafid: 'Wafid medical', unfit: 'Medical UNFIT', epro: 'EPRO approval',
  tasheer: 'Tasheer next', insurance: 'Insurance next', embassy: 'Visa next', police: 'Police clearance next', choices: 'All steps done' }

export default function ProfilesPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [profiles, setProfiles] = useState([])
  const [brokers, setBrokers] = useState([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState(searchParams.get('q') || '')
  // The search looks 500 ms after the last key (not on every letter).
  const [q, setQ] = useState(query)
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(query)
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        if (query.trim()) next.set('q', query.trim())
        else next.delete('q')
        return next
      }, { replace: true })
    }, 500)
    return () => clearTimeout(t)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  const status = searchParams.get('status') || 'all'
  const brokerId = searchParams.get('broker_id') || ''

  // The whole list once (cached); the search, status and broker filter it here, in the browser.
  const load = useCallback(async (quiet) => {
    if (quiet !== true) setLoading(true)
    try {
      const [profilesRes, brokersRes] = await Promise.all([
        profilesList({ fresh: quiet === true, onSaved: quiet === true ? undefined : (d) => { setProfiles(d || []); setLoading(false) } }),
        cachedGet('/brokers', { onSaved: quiet === true ? undefined : (d) => setBrokers(d || []) }),
      ])
      setProfiles(profilesRes || [])
      setBrokers(brokersRes || [])
    } catch {
      if (quiet !== true) toast.error('ፕሮፋይሎችን መጫን አልተቻለም')
    } finally {
      setLoading(false)
    }
  }, [])
  const byStatusBroker = useMemo(() => profiles.filter(p =>
    (status === 'all' || (p.status || 'pending') === status) && (!brokerId || String(p.broker_id ?? '') === String(brokerId))), [profiles, status, brokerId])
  // A profile changed anywhere (a person, a robot, a phone): the list follows at once.
  useEffect(() => onDataChange(['profiles', 'brokers'], () => load(true), 3000), [load])
  // A move running: its new girls show as they come (every 5 s), even if a change notice is missed.
  const waitingFiles = useWaitingFiles()
  useEffect(() => { if (!waitingFiles.size) return; const t = setInterval(() => load(true), 5000); return () => clearInterval(t) }, [waitingFiles.size > 0, load]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  // Date range, experience, age, married, country, skill, religion + sort.
  const { rows: allRows, filterBar, sortBar, active: filtering, clear, step, setStep, stepCounts, activeCount, journey, filterKey } = useProfileFilters(byStatusBroker)
  // An old link ?chosen=1 (the 🤝 Selected button, now the journey's Selected phase).
  useEffect(() => { if (searchParams.get('chosen') === '1') { setStep('selected'); const n = new URLSearchParams(searchParams); n.delete('chosen'); setSearchParams(n, { replace: true }) } }, [searchParams.get('chosen')]) // eslint-disable-line react-hooks/exhaustive-deps
  const [phase, setPhase] = useState(() => { try { return localStorage.getItem('adal-list-phase') || 'cv' } catch { return 'cv' } })
  useEffect(() => { try { localStorage.setItem('adal-list-phase', phase) } catch {} }, [phase])
  // The agency's order of the steps after the EPRO; drag a tab to change it.
  const [order, setOrder] = useState(() => { try { return JSON.parse(localStorage.getItem('adal-journey-order') || '[]') || [] } catch { return [] } })
  useEffect(() => {
    api.get('/settings/journey-order').then(r => { if (Array.isArray(r.data?.order)) { setOrder(r.data.order); try { localStorage.setItem('adal-journey-order', JSON.stringify(r.data.order)) } catch {} } }).catch(() => {})
  }, [])
  const after = afterInOrder(order)
  const [dragging, setDragging] = useState(null)
  const dropOn = (title) => {
    if (!dragging || dragging === title) return
    const titles = after.map(a => a[0]).filter(t => t !== dragging)
    titles.splice(titles.indexOf(title), 0, dragging)
    // The boxes before the EPRO (Musaned, Wafid) keep their place in front.
    const full = [...order.filter(t => !AFTER.some(a => a[0] === t)), ...titles]
    setOrder(full)
    try { localStorage.setItem('adal-journey-order', JSON.stringify(full)) } catch {}
    api.put('/settings', { journey_order: JSON.stringify(full) })
      .then(() => toast.success('Order saved — every girl follows it', { id: 'journey-order' }))
      .catch(() => toast.error('Could not save the order', { id: 'journey-order' }))
  }
  const PHASES = [...FIRST, ...after.map(([title, k, label]) => [k, label, title]), READY]
  const phaseOfP = (p) => phaseOf(journey.steps[p.id], p, after)
  // The tabs' counts: every profile (the search does not change them — greyed while searching).
  const phaseCounts = {}
  for (const p of allRows) { const k = phaseOfP(p); phaseCounts[k] = (phaseCounts[k] || 0) + 1 }
  const term = q.trim().toLowerCase()
  const searching = !!term
  const found = (p) => ['full_name', 'phone_number', 'national_id', 'passport_number', 'labor_id'].some(k => String(p[k] ?? '').toLowerCase().includes(term))
  const filtered = searching ? allRows.filter(found) : allRows.filter(p => phaseOfP(p) === phase)
  // 100 a page: quick to draw on any phone.
  const PAGE = 100
  const [page, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))
  // Back to page 1 only when the tab, the search or a filter changes (not on the 5-second refresh).
  useEffect(() => { setPage(1) }, [step, phase, term, status, brokerId, filterKey])
  // Only the Waiting tab sends CVs to agents on WhatsApp.
  const waitingHere = !searching && phase === 'waiting'
  const rows = filtered.slice((Math.min(page, pages) - 1) * PAGE, Math.min(page, pages) * PAGE)

  // 🔎 The whole Musaned Employment Requests list: who is newly chosen (the
  // Waiting tab). By itself every hour on one PC; Check now here, at most
  // 10 minutes, with Cancel.
  const [scanning, setScanning] = useState(false)
  const [checkInfo, setCheckInfo] = useState(null)
  const loadCheckInfo = () => api.get('/contracts/check').then(r => setCheckInfo(r.data)).catch(() => {})
  // On the Waiting tab: whether a check is on (here or on another PC), every 30 s.
  useEffect(() => {
    if (!shows('musaned_scan', phase, after) || onPhone()) return
    loadCheckInfo()
    const t = setInterval(() => { if (!document.hidden) loadCheckInfo() }, 30000)
    return () => clearInterval(t)
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps
  const cancelScan = () => api.post('/contracts/cancel').then(() => toast('Cancelling the check…', { id: 'scan-cancel' })).catch(() => {})
  const scanMusaned = async () => {
    setScanning(true)
    const id = toast.loading('Looking at the Musaned list… (sign in if Musaned asks)')
    try {
      const r = await api.post('/contracts/scan')
      if (!r.data.started && !r.data.busy) throw new Error(r.data.error || 'Could not start')
      if (r.data.busy) toast.loading(`A check is already on${r.data.by ? ` (${r.data.by})` : ''} — following it…`, { id })
      const limit = Date.now() + (r.data.limit_ms || 10 * 60000) + 60000
      let s
      for (;;) {
        await new Promise(res => setTimeout(res, 4000))
        s = (await api.get('/contracts/check')).data
        setCheckInfo(s)
        if (!s.running) break
        if (Date.now() > limit) { await api.post('/contracts/cancel').catch(() => {}); throw new Error('The check took more than 10 minutes — stopped') }
      }
      if (s.cancel) { toast.error(s.cancel, { id, duration: 6000 }); load(); return }
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
    } finally { setScanning(false); loadCheckInfo() }
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
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="ak-status-tabs grid w-full grid-cols-5 gap-1 md:flex md:flex-wrap md:w-auto md:min-w-0 md:flex-1 md:gap-1.5" role="tablist">
          {PHASES.map(([k, label, title]) => (
            <button key={k} type="button" role="tab" aria-selected={!searching && phase === k} onClick={() => { setPhase(k); setStep(null) }}
              title={searching ? 'All profiles in this tab (not the search)' : undefined}
              {...(title ? {
                draggable: true, title: 'Drag to change the order',
                onDragStart: (e) => { setDragging(title); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', title) },
                onDragEnd: () => setDragging(null),
                onDragOver: (e) => { if (dragging && dragging !== title) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' } },
                onDrop: (e) => { e.preventDefault(); dropOn(title); setDragging(null) },
              } : {})}
              className={`flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1.5 text-[11px] leading-tight font-bold transition-colors md:shrink-0 md:flex-row md:gap-2 md:px-3.5 md:py-2 md:text-sm ${title ? 'cursor-grab active:cursor-grabbing' : ''} ${dragging === title && title ? 'opacity-40' : ''} ${!searching && phase === k ? 'is-on' : ''}`}>
              <span className="max-w-full truncate">{label}</span>
              <span className={`rounded-full px-1.5 text-[10px] md:text-xs tabular-nums ak-seg-badge ${searching ? 'opacity-40' : ''}`}>{phaseCounts[k] || 0}</span>
            </button>
          ))}
        </div>
        {shows('musaned_scan', phase, after) && !searching && !onPhone() && (<>
          <Button variant="secondary" className="whitespace-nowrap !px-3 text-sm" onClick={scanMusaned} disabled={scanning || checkInfo?.running}
            title={`Check for new selections on Musaned (by itself every ${checkInfo?.every_min || 60} minutes; Check now stops after ${checkInfo?.manual_limit_min || 10} minutes)`}>
            {scanning || checkInfo?.running ? 'Checking…' : 'Check now'}
          </Button>
          {(scanning || checkInfo?.running) && (
            <Button variant="secondary" className="whitespace-nowrap !px-3 text-sm" onClick={cancelScan}>Cancel</Button>
          )}
          {checkInfo && (
            <span className="text-xs text-slate-500">
              {checkInfo.running ? `Checking on ${checkInfo.checking_on || checkInfo.by || 'this PC'}…`
                : `${checkInfo.last ? `Last checked ${new Date(checkInfo.last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not checked yet'}${checkInfo.next_at ? ` · next ${new Date(checkInfo.next_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}${checkInfo.why ? ` · ${checkInfo.why}` : ''}`}
            </span>
          )}
        </>)}
        {/* On a phone: a round ＋ above the tab bar, always in reach. */}
        <Button data-tour="new-profile" className="whitespace-nowrap hidden md:inline-flex" onClick={() => navigate('/profiles/new')}>+ ፕሮፋይል አክል</Button>
        {createPortal(<button type="button" aria-label="ፕሮፋይል አክል" onClick={() => navigate('/profiles/new')}
          className="md:hidden fixed right-4 z-40 h-14 w-14 rounded-full bg-gradient-to-br from-teal-600 to-indigo-600 text-3xl font-light text-white shadow-xl active:scale-95"
          style={{ bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}>＋</button>, document.body)}
      </div>

      <div className="panel mb-4 sm:mb-5 grid grid-cols-[minmax(0,1fr)_auto] gap-2 p-2 sm:p-3 sm:grid-cols-[minmax(0,1fr)_auto] items-center">
        <Input
          placeholder="በስም፣ በስልክ ወይም በመታወቂያ ይፈልጉ..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          icon={
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          }
        />

        <GlassSelect
          className={`field col-span-2 sm:col-span-1 ${showFilters ? '' : 'hidden'}`}
          value={status}
          onChange={(e) => updateFilter('status', e.target.value)}
        >
          <option value="all">ሁሉንም ሁኔታዎች</option>
          {STATUS_OPTIONS_AM.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </GlassSelect>

        <GlassSelect
          className={`field col-span-2 sm:col-span-1 ${showFilters ? '' : 'hidden'}`}
          value={brokerId}
          onChange={(e) => updateFilter('broker_id', e.target.value)}
        >
          <option value="">ሁሉንም ደላሎች</option>
          {brokers.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </GlassSelect>

        <button type="button" onClick={() => setShowFilters(v => !v)}
          className={`field !w-auto whitespace-nowrap !px-3 text-sm font-semibold ${activeCount ? 'border-teal-400 text-teal-700 dark:text-teal-300' : ''}`}>
          Filters{activeCount ? ` · ${activeCount}` : ''} {showFilters ? '▴' : '▾'}
        </button>

        {showFilters && <div className="col-span-2 border-t border-slate-100 dark:border-slate-700 pt-3">{filterBar}</div>}

        <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            {searching ? `Search: ${filtered.length} found` : filtered.length}
            {filtering && (
              <button type="button" className="ml-3 text-teal-700 dark:text-teal-300 hover:underline" onClick={clear}>
                Clear filters
              </button>
            )}
            {/* Any filter on (a step, a search, a status…): tick every profile it found, on every page. */}
            {(filtering || step || searching || status !== 'all' || brokerId) && filtered.length > 0 && (
              filtered.every(p => picked.has(p.id))
                ? <button type="button" className="ml-3 font-semibold text-slate-500 hover:underline" onClick={() => { setPicked(new Map()); setLacking({}) }}>☐ Untick all</button>
                : <button type="button" className="ml-3 rounded-md bg-teal-600 px-2 py-0.5 font-semibold text-white hover:bg-teal-700" onClick={() => setPicked(m => { const n = new Map(m); filtered.forEach(p => n.set(p.id, p)); return n })}>☑ Select all {filtered.length}</button>
            )}
          </span>
          {sortBar}
        </div>
      </div>

      <ReadingBar onDone={() => load(true)} />

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
              className={`panel group relative cursor-pointer px-3 py-2.5 sm:p-4 transition hover:shadow-soft ${picked.has(p.id) ? 'ring-2 ring-teal-500' : ''}`}
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
                    {p.passport_number || p.phone_number || '—'}
                  </p>
                </div>
              </div>

              <PrioritizeButton profileId={p.id} className="mt-2" />
              <p className="mt-1.5 truncate text-xs font-semibold text-teal-700 dark:text-teal-300">{NOW_TEXT[phaseOfP(p)]}{p.status === 'medical_rejected' && phaseOfP(p) !== 'unfit' ? ' · UNFIT' : ''}</p>
              <StepMarks {...stepMarks(journey.steps[p.id], p, after)} />
              {lacking[p.id]?.length > 0 && (
                <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
                  <b>Missing:</b> {lacking[p.id].join(' · ')}
                </div>
              )}
            </article>
          ))}
        </div>
        <Pager page={Math.min(page, pages)} pages={pages} total={filtered.length} per={PAGE} onPage={(n) => { setPage(n); window.scrollTo({ top: 0, behavior: 'smooth' }) }} bottom />
        </>
      )}
      {picked.size > 0 && (
        <SelectionBar picked={[...picked.values()]} onRemove={togglePick}
          phases={[...new Set([...picked.values()].map(phaseOfP))]} after={after}
          whatsappHere={waitingHere} waitingPicked={[...picked.values()].filter(p => inWaitingPhase(journey.steps[p.id], p))} onClear={() => { setPicked(new Map()); setLacking({}) }} onLacking={setLacking}
          onAllShown={() => setPicked(m => { const n = new Map(m); rows.forEach(r => n.set(r.id, r)); return n })} />
      )}
    </div>
  )
}
/**
 * On each card: a step skipped up to the EPRO ("skipped"), and each stage
 * done after it (those can come in any order, so they are never "skipped").
 */
function StepMarks({ skipped = [], done = [] }) {
  if (!skipped.length && !done.length) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1 text-[10px] font-semibold leading-tight">
      {skipped.map(s => <span key={`s-${s}`} title={`${s} was not ticked, but a later step was`} className="rounded bg-amber-100 px-1 py-px text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">{s} skipped</span>)}
      {done.map(s => <span key={`d-${s}`} title={`${s} done`} className="rounded bg-emerald-100 px-1 py-px text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">✓ {s}</span>)}
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
