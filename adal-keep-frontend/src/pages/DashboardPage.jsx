import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { onDataChange } from '../lib/changes'
import MorningSignIn from '../components/MorningSignIn'
import NeedsActionCard from '../components/NeedsActionCard'
import { onPhone } from '../lib/phoneMode'
import { useAuth } from '../context/AuthContext'
import { greeting } from '../lib/ethiopic'
import { lastPlace } from '../lib/lastPlace'
import Icon from '../components/shared/Icon'
import { BackupLine, DaySummaryCard } from '../components/OfficeCards'

// The page everyone lands on (written in Amharic; English from lib/i18n.js).
// One thing at a time: the greeting with "Continue where you left off", the
// morning sign-in and the tasks to do. Both cards draw at once from what this
// device saw last (or a skeleton), then fill in when the PC answers.

const TODO_KEY = 'ak-dash-todo'
const readTodo = () => { try { const n = Number(localStorage.getItem(TODO_KEY)); return Number.isFinite(n) && localStorage.getItem(TODO_KEY) != null ? n : null } catch { return null } }

async function tasksToDo() {
  try {
    const { data } = await api.get('/tasks/count')
    if (data && typeof data.undone === 'number') { const s = data.by_status || {}; return (s.todo || 0) + (s.pending || 0) }
  } catch {}
  try { return ((await api.get('/tasks')).data || []).filter(t => t.status === 'todo' || t.status === 'pending').length } catch { return 0 }
}

export default function DashboardPage() {
  const { company } = useAuth()
  const [todo, setTodo] = useState(readTodo)   // null: not known yet (skeleton)
  const place = lastPlace()

  useEffect(() => {
    const load = () => tasksToDo().then(n => { setTodo(n); try { localStorage.setItem(TODO_KEY, String(n)) } catch {} })
    load()
    return onDataChange(['tasks'], load)
  }, [])

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <section className="ak-hero">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <p className="ak-eyebrow" translate="no">{company ? `Adal ${company}` : 'Adal Keep'}</p>
            <h1 className="ak-hero-title">{greeting()}</h1>
          </div>
          {place ? (
            <Link to={place.path} className="ak-glass-card group flex min-w-0 items-center gap-3 md:max-w-sm">
              <span className="ak-tile flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"><Icon name="continue" /></span>
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold">ካቆሙበት ይቀጥሉ</span>
                <span className="block truncate text-[13px] ak-muted"><span>{place.kind}</span>{place.name ? <span translate="no"> · {place.name}</span> : null}</span>
              </span>
            </Link>
          ) : (
            <Link to="/profiles/new" className="ak-pill-btn self-start md:self-auto"><Icon name="plus" size={18} />አዲስ ፕሮፋይል</Link>
          )}
        </div>
      </section>

      {!onPhone() && <MorningSignIn />}

      {!onPhone() && <BackupLine />}
      <DaySummaryCard />

      <NeedsActionCard />

      {todo == null ? (
        <div className="ak-stat flex-row items-center gap-4" aria-hidden="true">
          <span className="ak-skel h-8 w-12" /><span className="ak-skel h-4 w-32" />
        </div>
      ) : todo > 0 && (
        <Link to="/tasks" className="ak-stat flex-row items-center gap-4">
          <span className="ak-stat-value tabular-nums">{todo}</span>
          <span className="ak-stat-label flex-1">ለመስራት ተግባሮች</span>
        </Link>
      )}
    </div>
  )
}
