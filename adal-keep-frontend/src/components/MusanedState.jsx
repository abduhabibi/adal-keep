import { useEffect, useState } from 'react'
import api from '../services/api'
import { onDataChange } from '../lib/changes'

/**
 * May "Make Musaned" be asked for her? { ask, state, text }, null until known.
 * What her journey shows is enough for a "no"; a "yes" is the server's (another
 * PC may have started it just now). A PC or the online copy without that answer:
 * the journey decides.
 */
export function useMusanedAsk(id, phase, step) {
  const [said, setSaid] = useState(null)
  const journey = step?.state
  const first = ['cv', 'musaned'].includes(phase)
  const busy = ['active', 'waiting', 'done'].includes(journey)
  useEffect(() => {
    setSaid(null)
    if (!id || !first || !journey || busy) return
    let alive = true
    const look = () => api.get(`/profiles/${id}/musaned-state`, { timeout: 8000 })
      .then(r => { if (alive) setSaid({ id, ...(typeof r.data?.ask === 'boolean' ? r.data : { ask: true, state: 'none', text: '' }) }) })
      .catch(() => { if (alive) setSaid({ id, ask: true, state: 'none', text: '' }) })
    look()
    const off = onDataChange(['automation_queue'], look, 3000)
    window.addEventListener('adal-profile-changed', look)
    return () => { alive = false; off(); window.removeEventListener('adal-profile-changed', look) }
  }, [id, first, journey, busy])
  if (!first || !journey) return null
  if (busy) {
    const note = step.note
    if (journey === 'active') return { ask: false, state: /waiting for you/.test(note) ? 'waiting' : /working/.test(note) ? 'working' : 'queued', text: note || 'in line' }
    return { ask: false, state: 'on', text: note ? `on Musaned, ${note}` : 'on Musaned' }
  }
  return said?.id === id ? said : null
}

/** Her page's line instead of the question: where Musaned is with her. */
export function MusanedState({ ask }) {
  if (!ask || ask.ask) return null
  const hot = ask.state === 'waiting'
  return (
    <div role="status" className={`panel flex items-center gap-3 border-l-4 p-3 text-sm ${hot ? 'border-l-amber-500' : ask.state === 'on' ? 'border-l-emerald-500' : 'border-l-indigo-500'}`}>
      <span aria-hidden="true">🇸🇦</span>
      <span className="font-semibold">Musaned</span>
      <span className="text-slate-600 dark:text-slate-300">{ask.text || ask.state}</span>
    </div>
  )
}
