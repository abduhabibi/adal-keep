import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import StatusBadge from '../components/shared/StatusBadge'
import { formatDate } from '../lib/utils'

export default function DashboardPage() {
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    api
      .get('/dashboard')
      .then((res) => {
        if (alive) setStats(res.data)
      })
      .catch(() => toast.error('Could not load dashboard'))
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  if (loading) return <Spinner />

  const statusCounts = stats?.statusCounts || { pending: 0, in_progress: 0, completed: 0 }

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Overview of clients and brokers in your workspace"
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => navigate('/brokers')}>
              Manage brokers
            </button>
            <button type="button" className="btn-primary" onClick={() => navigate('/profiles/new')}>
              New profile
            </button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-fade-up">
        <StatCard label="Profiles" value={stats?.totalProfiles ?? 0} tone="teal" />
        <StatCard label="Brokers" value={stats?.totalBrokers ?? 0} tone="slate" />
        <StatCard label="In progress" value={statusCounts.in_progress ?? 0} tone="sky" />
        <StatCard label="Completed" value={statusCounts.completed ?? 0} tone="emerald" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <section className="panel p-5 lg:col-span-2 animate-fade-up" style={{ animationDelay: '60ms' }}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-lg font-bold text-slate-900">Recent profiles</h2>
            <Link to="/profiles" className="text-sm font-semibold text-teal-700 hover:text-teal-800">
              View all
            </Link>
          </div>

          {(stats?.recent || []).length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">
              No profiles yet. Create your first client to get started.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {stats.recent.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/profiles/${p.id}`)}
                    className="flex w-full items-center justify-between gap-3 py-3 text-left transition hover:bg-slate-50/80 rounded-lg px-2 -mx-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{p.full_name}</p>
                      <p className="truncate text-sm text-slate-500">
                        {p.phone_number || 'No phone'}
                        {p.broker_name ? ` · ${p.broker_name}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusBadge status={p.status} />
                      <span className="text-xs text-slate-400">{formatDate(p.created_at)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel p-5 animate-fade-up" style={{ animationDelay: '120ms' }}>
          <h2 className="font-display text-lg font-bold text-slate-900">Status mix</h2>
          <p className="mt-1 text-sm text-slate-500">How your pipeline looks right now</p>
          <div className="mt-5 space-y-3">
            <StatusBar label="Pending" value={statusCounts.pending} total={stats?.totalProfiles || 0} color="bg-amber-500" />
            <StatusBar label="In progress" value={statusCounts.in_progress} total={stats?.totalProfiles || 0} color="bg-sky-500" />
            <StatusBar label="Completed" value={statusCounts.completed} total={stats?.totalProfiles || 0} color="bg-emerald-500" />
          </div>
        </section>
      </div>
    </div>
  )
}

function StatCard({ label, value, tone }) {
  const tones = {
    teal: 'from-teal-700 to-teal-600',
    slate: 'from-slate-700 to-slate-600',
    sky: 'from-sky-600 to-sky-500',
    emerald: 'from-emerald-700 to-emerald-600',
  }

  return (
    <div className="panel overflow-hidden p-5">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className={`mt-2 bg-gradient-to-r ${tones[tone]} bg-clip-text font-display text-3xl font-extrabold text-transparent`}>
        {value}
      </p>
    </div>
  )
}

function StatusBar({ label, value, total, color }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        <span className="tabular-nums text-slate-500">
          {value} · {pct}%
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
