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
import { STATUS_OPTIONS } from '../lib/utils'

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
      toast.error('Failed to load profiles')
    } finally {
      setLoading(false)
    }
  }, [query, status, brokerId])

  useEffect(() => {
    const t = setTimeout(load, 200)
    return () => clearTimeout(t)
  }, [load])

  const updateFilter = (key, value) => {
    const next = new URLSearchParams(searchParams)
    if (!value || value === 'all') next.delete(key)
    else next.set(key, value)
    setSearchParams(next)
  }

  const deleteProfile = async (id, e) => {
    e?.stopPropagation()
    if (!confirm('Delete this profile permanently?')) return
    try {
      await api.delete(`/profiles/${id}`)
      toast.success('Profile deleted')
      load()
    } catch {
      toast.error('Delete failed')
    }
  }

  const filterLabel = useMemo(() => {
    const parts = []
    if (status !== 'all') parts.push(STATUS_OPTIONS.find((s) => s.value === status)?.label || status)
    if (brokerId) {
      const b = brokers.find((x) => String(x.id) === String(brokerId))
      if (b) parts.push(b.name)
    }
    if (query.trim()) parts.push(`“${query.trim()}”`)
    return parts.length ? parts.join(' · ') : 'All clients'
  }, [status, brokerId, query, brokers])

  return (
    <div>
      <PageHeader
        title="Profiles"
        subtitle={filterLabel}
        action={
          <Button onClick={() => navigate('/profiles/new')}>
            + Add Profile
          </Button>
        }
      />

      <div className="panel mb-5 grid gap-3 p-4 sm:grid-cols-[1fr_auto_auto] animate-fade-up">
        <Input
          placeholder="Search profiles by name, phone, or ID..."
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
          <option value="all">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
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
          <option value="">All brokers</option>
          {brokers.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <Spinner />
      ) : profiles.length === 0 ? (
        <EmptyState
          title="No profiles found"
          description={
            query || status !== 'all' || brokerId
              ? 'Try clearing filters or search for something else.'
              : 'Add a client profile to start tracking paperwork and status.'
          }
          action={
            <Button onClick={() => navigate('/profiles/new')}>
              Create profile
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {profiles.map((p, i) => (
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
                  <p className="mt-0.5 truncate text-sm text-slate-500">{p.phone_number || 'No phone'}</p>
                </div>
                <StatusBadge status={p.status} />
              </div>

              <dl className="mt-4 space-y-1.5 text-sm text-slate-600">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-400">Broker</dt>
                  <dd className="truncate font-medium">{p.broker_name || 'Unassigned'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-400">Passport</dt>
                  <dd className="truncate font-medium">{p.passport_number || '—'}</dd>
                </div>
                {(p.room || p.table_name || p.box_number) && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-400">Location</dt>
                    <dd className="truncate font-medium">
                      {[p.room, p.table_name, p.box_number].filter(Boolean).join(' / ')}
                    </dd>
                  </div>
                )}
              </dl>

              <div className="mt-4 flex gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  className="btn-secondary flex-1 py-2 text-xs"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/profiles/${p.id}`)
                  }}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="btn-secondary flex-1 py-2 text-xs"
                  onClick={(e) => {
                    e.stopPropagation()
                    navigate(`/profiles/${p.id}/edit`)
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn-ghost py-2 text-xs text-red-600 hover:bg-red-50"
                  onClick={(e) => deleteProfile(p.id, e)}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}