import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { onDataChange } from '../lib/changes'
import MorningSignIn from '../components/MorningSignIn'
import { onPhone } from '../lib/phoneMode'
import { useAuth } from '../context/AuthContext'
import { greeting } from '../lib/ethiopic'
import { lastPlace } from '../lib/lastPlace'

// The page everyone lands on (written in Amharic; English from lib/i18n.js).
// Beautiful, and one thing at a time (asked on 2026-11-17): the welcome band
// with "Continue where you left off", the morning sign-in, and the tasks to
// do only when there are some. No dates, no numbers for their own sake.

async function tasksToDo() {
  try {
    const { data } = await api.get('/tasks/count')
    if (data && typeof data.undone === 'number') { const s = data.by_status || {}; return (s.todo || 0) + (s.pending || 0) }
  } catch {}
  try { return ((await api.get('/tasks')).data || []).filter(t => t.status === 'todo' || t.status === 'pending').length } catch { return 0 }
}

export default function DashboardPage() {
  const { company } = useAuth()
  const [todo, setTodo] = useState(0)
  const place = lastPlace()

  useEffect(() => {
    const load = () => tasksToDo().then(setTodo)
    load()
    return onDataChange(['tasks'], load)
  }, [])

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <section className="ak-hero">
        <div className="relative z-[1] flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/60" translate="no">{company ? `Adal ${company}` : 'Adal Keep'}</p>
            <h1 className="ak-hero-title mt-1">{greeting()}</h1>
          </div>
          {place ? (
            <Link to={place.path}
              className="group flex min-w-0 items-center gap-3 rounded-2xl bg-white/12 px-4 py-3 ring-1 ring-white/25 backdrop-blur-0 transition-colors hover:bg-white/20 md:max-w-sm">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-xl text-teal-700 shadow-lg" aria-hidden="true">↩</span>
              <span className="min-w-0">
                <span className="block text-base font-bold text-white">ካቆሙበት ይቀጥሉ</span>
                <span className="block truncate text-sm text-white/75"><span>{place.kind}</span>{place.name ? <span translate="no"> · {place.name}</span> : null}</span>
              </span>
            </Link>
          ) : (
            <Link to="/profiles/new" className="ak-hero-chip self-start md:self-auto"><span aria-hidden="true">＋</span>አዲስ ፕሮፋይል</Link>
          )}
        </div>
        <div className="ak-tibeb ak-hero-tibeb" aria-hidden="true" />
      </section>

      {!onPhone() && <MorningSignIn />}

      {todo > 0 && (
        <Link to="/tasks" className="ak-stat ak-tone-amber flex-row items-center gap-4">
          <span className="ak-stat-icon !mb-0">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8.5 12.2l2.4 2.4 4.6-5" /></svg>
          </span>
          <span className="ak-stat-value tabular-nums">{todo}</span>
          <span className="ak-stat-label">ለመስራት ተግባሮች</span>
        </Link>
      )}
    </div>
  )
}
