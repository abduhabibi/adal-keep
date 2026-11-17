import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'
import { onDataChange } from '../lib/changes'
import MorningSignIn from '../components/MorningSignIn'
import { onPhone } from '../lib/phoneMode'
import { lastPlace } from '../lib/lastPlace'

// The page is written in Amharic; English comes from lib/i18n.js (whole phrases).
// One thing at a time (asked on 2026-11-17): where you were, the morning
// sign-in, and the tasks to do — only when there are some. Nothing else.

async function tasksToDo() {
  try {
    const { data } = await api.get('/tasks/count')
    if (data && typeof data.undone === 'number') { const s = data.by_status || {}; return (s.todo || 0) + (s.pending || 0) }
  } catch {}
  try { return ((await api.get('/tasks')).data || []).filter(t => t.status === 'todo' || t.status === 'pending').length } catch { return 0 }
}

export default function DashboardPage() {
  const [todo, setTodo] = useState(0)
  const place = lastPlace()

  useEffect(() => {
    const load = () => tasksToDo().then(setTodo)
    load()
    return onDataChange(['tasks'], load)
  }, [])

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {place && (
        <Link to={place.path} className="panel flex items-center gap-4 p-4 hover:border-teal-400 hover:bg-teal-50/50 dark:hover:bg-teal-900/20">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-600 text-xl text-white" aria-hidden="true">↩</span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-bold">ካቆሙበት ይቀጥሉ</span>
            <span className="block text-sm text-slate-500"><span>{place.kind}</span>{place.name ? <span translate="no"> · {place.name}</span> : null}</span>
          </span>
        </Link>
      )}

      {!onPhone() && <MorningSignIn />}

      {todo > 0 && (
        <Link to="/tasks" className="panel flex items-center gap-4 p-4 hover:border-amber-400 hover:bg-amber-50/50 dark:hover:bg-amber-900/20">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-lg font-bold text-white tabular-nums">{todo}</span>
          <span className="text-base font-bold">ለመስራት ተግባሮች</span>
        </Link>
      )}
    </div>
  )
}
