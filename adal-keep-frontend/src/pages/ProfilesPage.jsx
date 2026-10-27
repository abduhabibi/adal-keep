import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
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
  const rows = selectedOnly ? allRows.filter(isChosen) : allRows

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
      <PageHeader
        title="ፕሮፋይሎች"
        subtitle={filterLabel}
        action={
          <div className="grid grid-cols-1 sm:grid-cols-[auto_auto] gap-2 sm:justify-end">
            <div className="flex flex-col gap-2">
              <Button variant="secondary" className="w-full whitespace-nowrap" onClick={scanMusaned} disabled={scanning} title="Reads the Musaned Employment Requests list: anyone newly chosen gets her contract saved and a task; girls not in Adal Keep are added">
                {scanning ? '🔎 Checking Musaned…' : '🔎 Check for new selections'}
              </Button>
              <Button variant={selectedOnly ? 'primary' : 'secondary'} className="w-full whitespace-nowrap" onClick={() => updateFilter('chosen', selectedOnly ? '' : '1')} title="The girls an employer chose on Musaned">
                🤝 Selected ({chosenCount})
              </Button>
            </div>
            <Button data-tour="new-profile" className="w-full sm:w-auto self-start whitespace-nowrap" onClick={() => navigate('/profiles/new')}>
              + ፕሮፋይል አክል
            </Button>
          </div>
        }
      />

      {/* The journey: its own full-width line, scrolling sideways on narrow screens. */}
      <div className="panel mb-5 px-4 py-3 overflow-x-auto" data-tour="journey-filter">
        <div className="min-w-[560px]">
          <JourneyFork counts={stepCounts} selected={step} onSelect={setStep} />
        </div>
      </div>

      <div className="panel mb-5 grid gap-2 p-3 sm:grid-cols-[1fr_auto_auto_auto] items-center animate-fade-up">
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
          className="field"
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
          className="field"
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

        {showFilters && <div className="sm:col-span-4 border-t border-slate-100 dark:border-slate-700 pt-3">{filterBar}</div>}

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
        <div key={step || 'all'} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((p, i) => (
            <article
              key={p.id}
              className="panel group cursor-pointer p-4 transition hover:-translate-y-0.5 hover:shadow-soft animate-fade-up"
              style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
              onClick={() => navigate(`/profiles/${p.id}`)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-display text-lg font-bold text-slate-900">
                    {p.full_name}
                  </h3>
                  <p className="mt-0.5 truncate text-sm text-slate-500">{p.phone_number || 'ስልክ የለም'}</p>
                </div>
                <StatusBadge status={p.status} />
              </div>

              <dl className="mt-4 space-y-1.5 text-sm text-slate-600">
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

              <div className="mt-4 flex gap-2 border-t border-slate-100 dark:border-slate-700 pt-3">
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
      )}
    </div>
  )
}