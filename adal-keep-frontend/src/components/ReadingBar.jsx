import { useEffect, useRef, useState } from 'react'
import api from '../services/api'

// Downloads being read by the AI right now: name and a percent bar each, and
// how many wait. Hidden when nothing is read. Asks every 1.5 s while
// something is read, every 8 s otherwise.
export default function ReadingBar({ onDone }) {
  const [state, setState] = useState({ reading: [], waiting: 0 })
  const busy = state.reading.length + state.waiting > 0
  const was = useRef(0)

  useEffect(() => {
    let stop = false, t
    const tick = async () => {
      if (!document.hidden) {
        try {
          const { data } = await api.get('/tasks/reading')
          if (stop) return
          const n = (data.reading?.length || 0) + (data.waiting || 0)
          if (n < was.current) onDone?.() // one finished: its profile shows
          was.current = n
          setState({ reading: data.reading || [], waiting: data.waiting || 0 })
        } catch {}
      }
      if (!stop) t = setTimeout(tick, was.current ? 1500 : 8000)
    }
    tick()
    return () => { stop = true; clearTimeout(t) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!busy) return null
  return (
    <div className="panel mb-4 sm:mb-5 p-2 sm:p-3 space-y-2" aria-live="polite">
      {state.reading.map(r => (
        <div key={r.id}>
          <div className="flex justify-between gap-2 text-sm">
            <span className="truncate">Reading {r.filename}</span>
            <span className="tabular-nums text-gray-500">{r.percent}%</span>
          </div>
          <div className="h-1.5 rounded bg-teal-50 dark:bg-teal-900 overflow-hidden mt-1">
            <div className="h-full bg-teal-600 transition-all duration-700" style={{ width: `${r.percent}%` }} />
          </div>
        </div>
      ))}
      {state.waiting > 0 && <div className="text-xs text-gray-500">{state.waiting} waiting</div>}
    </div>
  )
}
