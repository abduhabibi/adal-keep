import { useCallback, useEffect, useState } from 'react'
import api from '../services/api'
import { onDataChange } from '../lib/changes'

/** Robot history → Waiting: runs in line to start. Move one up or down, make it run next, pause or cancel it. */
export default function WaitingRuns() {
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState('')
  const load = useCallback(() => api.get('/run-queue', { adalNoCache: true })
    .then(r => { setRows(Array.isArray(r.data) ? r.data : []); setError('') })
    .catch(e => { setError(e.response?.data?.error || e.message); setRows([]) }), [])
  // Live: the queue changing (on any PC) reloads it at once; a slow look besides, in case the live line dropped.
  useEffect(() => { load(); const off = onDataChange(['automation_queue'], load, 500); const t = setInterval(load, 60000); return () => { off(); clearInterval(t) } }, [load])

  const act = async (id, path) => {
    setBusy(id)
    try { await api.post(path); setError('') } catch (e) { setError(e.response?.data?.error || e.message) }
    setBusy(0); load()
  }
  if (!rows || rows.length === 0) return null
  const line = rows.filter(r => r.status === 'pending')
  const btn = 'rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold hover:bg-slate-50 disabled:opacity-40 dark:border-slate-600 dark:hover:bg-slate-700'
  return (
    <div className="panel rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <div className="border-b border-slate-200 p-4 dark:border-slate-700">
        <h2 className="font-display text-base font-bold">Waiting to start</h2>
        <p className="text-xs text-slate-500">The robot takes the first one in line. Move a run up or down, or make it run next.</p>
        {error && <p className="mt-1 text-xs text-amber-700">{error}</p>}
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-700">
        {rows.map(r => {
          const inLine = r.status === 'pending'
          const i = line.findIndex(x => x.id === r.id)
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <span className="w-8 text-center text-xs font-bold text-slate-400">{inLine ? `#${r.position ?? i + 1}` : '⏸'}</span>
              <span className="min-w-[180px] flex-1">
                <span className="block font-medium">{r.workflow}</span>
                <span className="text-xs text-slate-500" translate="no">{r.profile_name || `Run ${r.id}`}{!inLine ? ' · paused' : ''}</span>
              </span>
              <span className="flex flex-wrap gap-1.5">
                {inLine && <>
                  <button type="button" className={btn} disabled={busy === r.id || i === 0} title="Move up" aria-label="Move up" onClick={() => act(r.id, `/run-queue/${r.id}/up`)}>↑</button>
                  <button type="button" className={btn} disabled={busy === r.id || i === line.length - 1} title="Move down" aria-label="Move down" onClick={() => act(r.id, `/run-queue/${r.id}/down`)}>↓</button>
                  <button type="button" className={btn} disabled={busy === r.id || i === 0} onClick={() => act(r.id, `/run-queue/${r.id}/next`)}>Run next</button>
                  <button type="button" className={btn} disabled={busy === r.id} onClick={() => act(r.id, `/automations/${r.id}/pause`)}>Pause</button>
                </>}
                {!inLine && <button type="button" className={btn} disabled={busy === r.id} onClick={() => act(r.id, `/automations/${r.id}/resume`)}>Put back in line</button>}
                <button type="button" className={`${btn} text-red-700`} disabled={busy === r.id} onClick={() => act(r.id, `/automations/${r.id}/cancel`)}>Cancel</button>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
