import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import EmptyState from '../components/shared/EmptyState'
import Spinner from '../components/shared/Spinner'
import StatusBadge from '../components/shared/StatusBadge'
import Button from '../components/shared/Button'
import Input from '../components/shared/Input'
import { useProfileFilters } from '../components/profileFilters'
import { JourneyFork } from '../components/ProfileJourney'

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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = {}
      if (query.trim()) params.q = query.trim()
      if (status && status !== 'all') params.status = status
      if (brokerId) params.broker_id = brokerId

      const [profilesRes, brokersRes] = await Promise.all([
        api.get('/profiles', { params }),
        api.get('/brokers'),
      ])
      setProfiles(profilesRes.data)
      setBrokers(brokersRes.data)
    } catch {
      toast.error('ፕሮፋይሎችን መጫን አልተቻለም')
    } finally {
      setLoading(false)
    }
  }, [query, status, brokerId])

  useEffect(() => {
    const t = setTimeout(load, 200)
    return () => clearTimeout(t)
  }, [load])

  // Date range, experience, age, married, country, skill, religion + sort.
  const { rows: allRows, filterBar, sortBar, active: filtering, clear, step, setStep, stepCounts, activeCount } = useProfileFilters(profiles)
  // 🤝 Selected: the girls an employer chose on Musaned.
  const selectedOnly = searchParams.get('chosen') === '1'
  const isChosen = (p) => !!p.chosen_at && !/CANCEL|REJECT/i.test(p.musaned_stage || '')
  const chosenCount = useMemo(() => profiles.filter(isChosen).length, [profiles])
  const filtered = selectedOnly ? allRows.filter(isChosen) : allRows
  // 100 a page: quick to draw on any phone.
  const PAGE = 100
  const [page, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))
  useEffect(() => { setPage(1) }, [filtered.length, step, selectedOnly])
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
      if (s.signedOut) toast.error('Musaned is signed out — sign in in the Adal Keep Brave; the check goes on by itself.', { id, duration: 8000 })
      else if (fresh.length) toast.success(`Newly chosen: ${fresh.join(', ')} — contracts saved.`, { id, duration: 10000 })
      else toast.success(`No one new.${moved ? ` ${moved} moved to a new stage.` : ''}${s.unknown?.length ? ` ${s.unknown.length} on Musaned are not in Adal Keep.` : ''}`, { id, duration: 6000 })
      load()
    } catch (e) {
      toast.error(e.response?.data?.error || e.message, { id })
    } finally { setScanning(false) }
  }

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

  const filterLabel = useMemo(() => {
    const parts = []
    if (status !== 'all') parts.push(STATUS_OPTIONS_AM.find((s) => s.value === status)?.label || status)
    if (brokerId) {
      const b = brokers.find((x) => String(x.id) === String(brokerId))
      if (b) parts.push(b.name)
    }
    if (query.trim()) parts.push(`“${query.trim()}”`)
    return parts.length ? parts.join(' · ') : 'ሁሉንም ደንበኞች'
  }, [status, brokerId, query, brokers])

  return (
    <div>
      {/* Title · the journey (fills the space between) · the buttons — one
          line on wide screens; stacked on narrow ones, the journey scrolling sideways. */}
      <div className="mb-5 flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4">
        <div className="shrink-0">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">ፕሮፋይሎች</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{filterLabel}</p>
        </div>
        <div className="panel min-w-0 flex-1 px-2 py-2" data-tour="journey-filter">
          <JourneyFork compact counts={stepCounts} selected={step} onSelect={setStep} />
        </div>
        <div className="shrink-0 grid grid-cols-2 lg:grid-cols-1 lg:w-56 gap-2">
          <Button data-tour="new-profile" className="col-span-2 lg:col-span-1 w-full whitespace-nowrap" onClick={() => navigate('/profiles/new')}>
            + ፕሮፋይል አክል
          </Button>
          <Button variant="secondary" className="w-full whitespace-nowrap !px-2 text-xs sm:text-sm" onClick={scanMusaned} disabled={scanning} title="Reads the Musaned Employment Requests list: anyone newly chosen gets her contract saved and a task; girls not in Adal Keep are added">
            {scanning ? '🔎 Checking…' : '🔎 Check for new selections'}
          </Button>
          <Button variant={selectedOnly ? 'primary' : 'secondary'} className="w-full whitespace-nowrap !px-2 text-xs sm:text-sm" onClick={() => updateFilter('chosen', selectedOnly ? '' : '1')} title="The girls an employer chose on Musaned">
            🤝 Selected ({chosenCount})
          </Button>
        </div>
      </div>

      <div className="panel mb-4 sm:mb-5 grid grid-cols-[1fr_auto] gap-2 p-2 sm:p-3 sm:grid-cols-[1fr_auto_auto_auto] items-center animate-fade-up">
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
          className={`field whitespace-nowrap text-sm font-semibold ${activeCount ? 'border-teal-400 text-teal-700 dark:text-teal-300' : ''}`}>
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
        <div key={step || 'all'} className="grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-3">
          {rows.map((p, i) => (
            <article
              key={p.id}
              className="panel group cursor-pointer px-3 py-2.5 sm:p-4 transition hover:-translate-y-0.5 hover:shadow-soft animate-fade-up"
              style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
              onClick={() => navigate(`/profiles/${p.id}`)}
            >
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
    </div>
  )
}
/** Pages of 100: « 1 | 2 | … | n » — folds to "Page 2 of 5" with « when not needed. */
function Pager({ page, pages, total, per, onPage, bottom = false }) {
  const [open, setOpen] = useState(true)
  if (pages <= 1) return null
  const from = (page - 1) * per + 1, to = Math.min(total, page * per)
  return (
    <div className={`flex items-center gap-1.5 text-xs ${bottom ? 'mt-4 justify-center' : 'mb-3'} col-span-full`}>
      <button type="button" onClick={() => setOpen(o => !o)} title={open ? 'Fold the pages' : 'Show the pages'}
        className="shrink-0 rounded-md border border-slate-200 dark:border-slate-700 px-1.5 py-1 font-bold text-slate-500">{open ? '«' : '»'}</button>
      {open ? (
        <div className="flex flex-wrap items-center gap-1 min-w-0">
          {Array.from({ length: pages }, (_, k) => k + 1).map(n => (
            <button key={n} type="button" onClick={() => onPage(n)}
              className={`min-w-[28px] rounded-md px-2 py-1 font-semibold ${n === page ? 'bg-teal-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}>{n}</button>
          ))}
          <span className="ml-1 text-slate-400">{from}–{to} of {total}</span>
        </div>
      ) : (
        <span className="text-slate-500">Page {page} of {pages} · {from}–{to} of {total}</span>
      )}
    </div>
  )
}
