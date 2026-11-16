import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { onDataChange } from '../lib/changes'
import MorningSignIn from '../components/MorningSignIn'
import { onPhone } from '../lib/phoneMode'
import { useAuth } from '../context/AuthContext'

// Task numbers: the PC counts them (GET /tasks/count); a phone's offline copy
// has only the list, so it is counted here then.
async function taskCounts() {
  try {
    const { data } = await api.get('/tasks/count')
    if (data && typeof data.undone === 'number') {
      const s = data.by_status || {}
      return { tasksTodo: (s.todo || 0) + (s.pending || 0), tasksInProgress: (s.in_progress || 0) + (s.ongoing || 0), tasksDone: s.done || 0, totalTasks: data.total || 0 }
    }
  } catch {}
  const tasks = (await api.get('/tasks')).data || []
  return {
    tasksTodo: tasks.filter(t => t.status === 'todo' || t.status === 'pending').length,
    tasksInProgress: tasks.filter(t => t.status === 'in_progress' || t.status === 'ongoing').length,
    tasksDone: tasks.filter(t => t.status === 'done').length,
    totalTasks: tasks.length,
  }
}

const STATUS = {
  completed: ['ተጠናቋል', 'ak-badge-green'],
  in_progress: ['በሂደት', 'ak-badge-blue'],
  medical_applied: ['ሕክምና · ተመዝግቧል', 'ak-badge-violet'],
  medical_fit: ['ሕክምና · ብቁ', 'ak-badge-green'],
  medical_rejected: ['ሕክምና · ውድቅ', 'ak-badge-red'],
}

const Icon = ({ d }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
)

export default function DashboardPage() {
  const { company } = useAuth()
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const [dash, tasks] = await Promise.all([api.get('/dashboard'), taskCounts()])
        setStats({ ...dash.data, ...tasks })
      } catch {}
      finally { setLoading(false) }
    }
    load()
    return onDataChange(['profiles', 'tasks', 'automation_queue', 'profile_automations'], load)
  }, [])

  const cards = [
    { label: 'ፕሮፋይሎች', value: stats?.totalProfiles, tone: 'teal', link: '/profiles', icon: <Icon d={<><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19v-.8A4.2 4.2 0 0 1 7.7 14h2.6a4.2 4.2 0 0 1 4.2 4.2v.8" /><path d="M18 9v6M15 12h6" /></>} /> },
    { label: 'ደላሎች', value: stats?.totalBrokers, tone: 'blue', link: '/brokers', icon: <Icon d={<><circle cx="8" cy="9" r="2.6" /><circle cx="16.5" cy="9" r="2.6" /><path d="M3 19c.4-2.6 2.4-4.2 5-4.2s4.6 1.6 5 4.2M12 19c.4-2.6 2.2-4.2 4.5-4.2S20.6 16.4 21 19" /></>} /> },
    { label: 'ተግባሮች (ለመስራት)', value: stats?.tasksTodo, tone: 'amber', link: '/tasks', icon: <Icon d={<><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8.5 12.2l2.4 2.4 4.6-5" /></>} /> },
    { label: 'ተግባሮች (በሂደት)', value: stats?.tasksInProgress, tone: 'violet', link: '/tasks', icon: <Icon d={<><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>} /> },
  ]

  const quick = [
    { to: '/profiles/new', label: 'New profile', icon: '＋' },
    { to: '/cvs/new', label: 'New CV', icon: '📄' },
    { to: '/chat', label: 'Chat', icon: '💬' },
    { to: '/tasks', label: 'Tasks', icon: '✓' },
  ]

  return (
    <div className="space-y-6">
      {/* The welcome band: one still gradient (painted once, nothing moves). */}
      <section className="ak-hero">
        <div className="relative z-[1] flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">{company ? `Adal ${company}` : 'Adal Keep'}</p>
            <h1 className="ak-hero-title mt-1">ዳሽቦርድ</h1>
            <p className="mt-1 text-sm text-white/80">የስርዓት አጠቃላይ እይታ</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {quick.map(q => (
              <Link key={q.to} to={q.to} className="ak-hero-chip"><span aria-hidden="true">{q.icon}</span>{q.label}</Link>
            ))}
          </div>
        </div>
      </section>

      {!onPhone() && <MorningSignIn />}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {cards.map(card => (
          <Link key={card.label} to={card.link} className={`ak-stat ak-tone-${card.tone}`}>
            <span className="ak-stat-icon">{card.icon}</span>
            <span className="ak-stat-value tabular-nums">{loading ? '–' : (card.value ?? 0)}</span>
            <span className="ak-stat-label">{card.label}</span>
          </Link>
        ))}
      </div>

      <section className="panel p-4 sm:p-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-bold">የቅርብ ጊዜ ፕሮፋይሎች</h2>
          <Link to="/profiles" className="text-xs font-semibold text-teal-600 hover:text-teal-700 dark:text-teal-400">ሁሉንም ይመልከቱ →</Link>
        </div>
        {loading ? (
          <div className="space-y-2">{[1, 2, 3, 4].map(i => <div key={i} className="h-12 rounded-xl bg-slate-100 dark:bg-white/5" />)}</div>
        ) : stats?.recent?.length > 0 ? (
          <ul className="divide-y divide-slate-100 dark:divide-white/5">
            {stats.recent.map(profile => {
              const [label, tone] = STATUS[profile.status] || ['በመጠባበቅ', 'ak-badge-amber']
              const initials = String(profile.full_name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase()
              return (
                <li key={profile.id}>
                  <Link to={`/profiles/${profile.id}`} className="flex items-center gap-3 py-2.5 px-2 -mx-2 rounded-xl hover:bg-slate-50 dark:hover:bg-white/5">
                    <span className="ak-avatar">{initials}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{profile.full_name}</span>
                      <span className="block truncate text-xs text-slate-500">{profile.phone_number}{profile.broker_name ? ` · ${profile.broker_name}` : ''}</span>
                    </span>
                    <span className={`ak-badge ${tone}`}>{label}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-sm text-slate-500 text-center py-8">ምንም ፕሮፋይል የለም</p>
        )}
      </section>
    </div>
  )
}
