import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import GlassSelect from '../components/shared/GlassSelect'
import WaitingRuns from '../components/WaitingRuns'
import SiteBoards from '../components/SiteBoards'

/** What each robot did in the last 30 days, from every PC (the main PC's history). */
const OUTCOME = {
  done: ['Done', 'bg-emerald-100 text-emerald-800'], failed: ['Failed', 'bg-red-100 text-red-800'],
  cancelled: ['Cancelled', 'bg-slate-200 text-slate-700'], paused: ['Waiting for a person', 'bg-amber-100 text-amber-800'],
  stopped: ['Stopped', 'bg-slate-200 text-slate-700'], running: ['Working', 'bg-sky-100 text-sky-800'],
}
const long = (s) => {
  if (s == null) return '—'
  const m = Math.floor(s / 60), h = Math.floor(m / 60)
  return h ? `${h} h ${m % 60} min` : m ? `${m} min ${s % 60} s` : `${s} s`
}
const when = (iso) => iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'
const sel = 'rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900'

export default function RunHistoryPage() {
  const [rows, setRows] = useState(null)
  const [choices, setChoices] = useState({ sites: [], employees: [], pcs: [], outcomes: [] })
  const [f, setF] = useState({ q: '', site: '', outcome: '', employee: '', pc: '' })
  const [error, setError] = useState('')
  const [look, setLook] = useState(null)   // the row whose picture is open
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))

  const query = useMemo(() => Object.fromEntries(Object.entries(f).filter(([, v]) => v)), [f])
  useEffect(() => {
    let live = true
    const t = setTimeout(() => api.get('/run-history', { params: { ...query, limit: 300 }, adalNoCache: true })
      .then(r => { if (live) { setRows(r.data || []); setError('') } })
      .catch(e => { if (live) { setError(e.response?.data?.error || e.message); setRows([]) } }), f.q ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [query])
  useEffect(() => { api.get('/run-history/choices', { adalNoCache: true }).then(r => setChoices(r.data)).catch(() => {}) }, [])

  return (
    <div className="space-y-5 animate-fade-up">
      <PageHeader title="Robot history" subtitle="What each robot did in the last 30 days, from every PC." />
      <SiteBoards />
      <WaitingRuns />
      <div className="panel rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4 dark:border-slate-700">
          <input value={f.q} onChange={set('q')} placeholder="Search a name, step or reason…" className={`${sel} min-w-[220px] flex-1`} />
          <GlassSelect value={f.site} onChange={set('site')} className={sel}>
            <option value="">All sites</option>{choices.sites.map(s => <option key={s} value={s}>{s}</option>)}
          </GlassSelect>
          <GlassSelect value={f.outcome} onChange={set('outcome')} className={sel}>
            <option value="">Any outcome</option>{choices.outcomes.map(o => <option key={o} value={o}>{OUTCOME[o]?.[0] || o}</option>)}
          </GlassSelect>
          <GlassSelect value={f.employee} onChange={set('employee')} className={sel}>
            <option value="">Everyone</option>{choices.employees.map(s => <option key={s} value={s}>{s}</option>)}
          </GlassSelect>
          <GlassSelect value={f.pc} onChange={set('pc')} className={sel}>
            <option value="">All PCs</option>{choices.pcs.map(s => <option key={s} value={s}>{s}</option>)}
          </GlassSelect>
        </div>
        {error ? <p className="p-6 text-sm text-amber-700">{error}</p>
          : rows === null ? <p className="p-6 text-sm text-slate-400">Loading…</p>
          : rows.length === 0 ? <p className="p-10 text-center text-sm text-slate-400">{Object.keys(query).length ? 'Nothing matches.' : 'No robot has run yet.'}</p>
          : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900/50">
                <tr><th className="px-4 py-2 text-left">Robot</th><th className="px-4 py-2 text-left">Started by</th><th className="px-4 py-2 text-left">Started</th><th className="px-4 py-2 text-left">Took</th><th className="px-4 py-2 text-left">Result</th><th className="px-4 py-2" /></tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const [label, cls] = OUTCOME[r.outcome] || [r.outcome, 'bg-slate-100']
                  return (
                    <tr key={r.id} className="border-t border-slate-100 align-top dark:border-slate-700">
                      <td className="px-4 py-2.5">
                        <span className="block font-medium">{r.workflow}{r.site && !r.workflow.includes(r.site) ? ` · ${r.site}` : ''}</span>
                        <span className="text-xs text-slate-500" translate="no">{r.profile_name || (r.kind === 'move' ? 'Whole agency' : '—')}{r.account ? ` · ${r.account}` : ''}</span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300" translate="no">{r.employee || '—'}<span className="block text-xs text-slate-400">{r.pc || ''}</span></td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">{when(r.started_at)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">{long(r.duration_s)}</td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>
                        {r.reason && <span className="mt-1 block max-w-md text-xs text-slate-600 dark:text-slate-300">{r.reason}</span>}
                        {r.step && r.outcome !== 'done' && <span className="mt-0.5 block max-w-md text-xs text-slate-400">Step: {r.step}</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        {r.has_shot && <button type="button" onClick={() => setLook(r)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 dark:border-slate-600">Picture</button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table></div>
          )}
      </div>
      {look && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" onClick={() => setLook(null)}>
          <div className="max-h-full w-full max-w-4xl overflow-auto rounded-2xl bg-white p-4 shadow-2xl dark:bg-slate-900" onClick={e => e.stopPropagation()}>
            <div className="mb-2 flex items-start justify-between gap-3">
              <p className="text-sm"><b>{look.workflow}</b> · {look.profile_name || ''}<span className="block text-xs text-slate-500">{when(look.ended_at)} · {look.step || look.reason || ''}</span></p>
              <button type="button" onClick={() => setLook(null)} className="rounded-lg border px-3 py-1 text-sm">Close</button>
            </div>
            <img src={`/api/run-history/${look.id}/shot`} alt="The tab when the robot stopped" className="w-full rounded-lg border border-slate-200" />
          </div>
        </div>, document.body
      )}
    </div>
  )
}
