import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { onDataChange } from '../lib/changes'
import MorningSignIn from '../components/MorningSignIn'
import { onPhone } from '../lib/phoneMode'
import { useAuth } from '../context/AuthContext'
import { ethiopianDate, geez, greeting } from '../lib/ethiopic'

// The page is written in Amharic; English comes from lib/i18n.js (whole phrases).

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

/**
 * Her road, drawn once: Addis Ababa → Riyadh, with how many are at each part
 * of it. A still picture (no animation): the numbers are what changes.
 */
function Journey({ counts }) {
  const legs = [
    { label: 'በመጠባበቅ', n: counts.pending || 0, x: 22 },
    { label: 'በሂደት', n: (counts.in_progress || 0) + (counts.medical_applied || 0) + (counts.medical_fit || 0), x: 50 },
    { label: 'ተጠናቋል', n: counts.completed || 0, x: 78 },
  ]
  return (
    <div className="ak-journey" aria-label="ጉዞ">
      <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="ak-journey-line" aria-hidden="true">
        <defs>
          <linearGradient id="akRoad" x1="0" x2="1">
            <stop offset="0" stopColor="#5eead4" /><stop offset=".55" stopColor="#a5b4fc" /><stop offset="1" stopColor="#fcd34d" />
          </linearGradient>
        </defs>
        <path d="M2 20 C 30 -4, 70 -4, 98 20" fill="none" stroke="url(#akRoad)" strokeWidth=".7" strokeDasharray="1.6 1.4" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="ak-journey-end ak-journey-from"><span className="ak-journey-dot" />አዲስ አበባ</div>
      <div className="ak-journey-end ak-journey-to">ሪያድ<span className="ak-journey-dot ak-journey-dot-to" /></div>
      <span className="ak-journey-plane" aria-hidden="true">✈</span>
      {legs.map(l => (
        <div key={l.label} className="ak-journey-leg" style={{ left: `${l.x}%` }}>
          <span className="ak-journey-n tabular-nums">{l.n}</span>
          <span className="ak-journey-label">{l.label}</span>
        </div>
      ))}
    </div>
  )
}

export default function DashboardPage() {
  const { company } = useAuth()
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const now = new Date()
  const et = ethiopianDate(now)

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
    { to: '/profiles/new', label: 'አዲስ ፕሮፋይል', icon: '＋' },
    { to: '/cvs/new', label: 'አዲስ ሲቪ', icon: '📄' },
    { to: '/chat', label: 'ቻት', icon: '💬' },
    { to: '/tasks', label: 'ተግባሮች', icon: '✓' },
  ]

  return (
    <div className="space-y-6">
      {/* The welcome band: still gradients and a woven border (painted once). */}
      <section className="ak-hero">
        <div className="relative z-[1] grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/60" translate="no">{company ? `Adal ${company}` : 'Adal Keep'}</p>
            <h1 className="ak-hero-title mt-1">{greeting(now)}</h1>
            <p className="mt-1 text-sm text-white/75">ዳሽቦርድ · የስርዓት አጠቃላይ እይታ</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {quick.map(q => (
                <Link key={q.to} to={q.to} className="ak-hero-chip"><span aria-hidden="true">{q.icon}</span>{q.label}</Link>
              ))}
            </div>
          </div>
          {/* Today, in the Ethiopian calendar (and the other one under it). */}
          <div className="ak-date" title="ዛሬ">
            <span className="ak-date-day" aria-hidden="true" translate="no">{geez(et.day)}</span>
            <span className="ak-date-text">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-200/90">{et.weekday}</span>
              <span className="block text-lg font-extrabold leading-tight">{et.monthName} {et.day}</span>
              <span className="block text-xs text-white/70"><span translate="no">{geez(et.year)}</span> · {et.year}</span>
              <span className="block text-[11px] text-white/50" translate="no">{now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            </span>
          </div>
        </div>
        <div className="relative z-[1] mt-6">
          <Journey counts={stats?.statusCounts || {}} />
        </div>
        <div className="ak-tibeb ak-hero-tibeb" aria-hidden="true" />
      </section>

      {!onPhone() && <MorningSignIn />}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {cards.map(card => (
          <Link key={card.label} to={card.link} className={`ak-stat ak-tone-${card.tone}`}>
            <span className="ak-stat-icon">{card.icon}</span>
            <span className="ak-stat-value tabular-nums">{loading ? '–' : (card.value ?? 0)}</span>
            <span className="ak-stat-label">{card.label}</span>
            {!loading && card.value > 0 && <span className="ak-stat-geez" aria-hidden="true" translate="no">{geez(card.value)}</span>}
          </Link>
        ))}
      </div>

      <section className="panel p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
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
                    <span className="ak-avatar" translate="no">{initials}</span>
                    <span className="min-w-0 flex-1" translate="no">
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
