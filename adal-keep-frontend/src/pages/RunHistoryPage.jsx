import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { onDataChange } from '../lib/changes'
import { idbGet, idbPut } from '../lib/idbStore'
import PageHeader from '../components/shared/PageHeader'
import GlassSelect from '../components/shared/GlassSelect'
import WaitingRuns from '../components/WaitingRuns'

/** What each robot did in the last 30 days, from every PC of the agency (copied between them). */
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
const PAGE = 100
// The first page without filters, kept on this device: shown at once on the next visit, the PC's answer behind it.
const KEPT = 'robot-history|first-page'

export default function RunHistoryPage() {
  const [rows, setRows] = useState(null)
  const [more, setMore] = useState(false)
  const [choices, setChoices] = useState({ sites: [], employees: [], pcs: [], outcomes: [] })
  const [f, setF] = useState({ q: '', site: '', outcome: '', employee: '', pc: '' })
  const [error, setError] = useState('')
  const [look, setLook] = useState(null)   // the row whose picture is open
  const [picked, setPicked] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const shown = useRef(PAGE)               // how many rows are open (a live reload keeps them)
  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }))

  const query = useMemo(() => Object.fromEntries(Object.entries(f).filter(([, v]) => v)), [f])
  const plain = Object.keys(query).length === 0
  const ask = useRef(0)
  /** The newest rows again (as many as are open now): at the start, a filter, or a change on any PC. */
  const load = useCallback(() => {
    const n = ++ask.current
    const limit = Math.min(500, Math.max(PAGE, shown.current))
    return api.get('/run-history', { params: { ...query, limit: limit + 1 }, adalNoCache: true })
      .then(r => {
        if (n !== ask.current) return
        const all = Array.isArray(r.data) ? r.data : []
        setRows(all.slice(0, limit)); setMore(all.length > limit); setError('')
        if (plain) idbPut(KEPT, all.slice(0, PAGE)).catch(() => {})
      })
      .catch(e => { if (n === ask.current) { setError(e.response?.data?.error || e.message); setRows(x => x || []) } })
  }, [query, plain])
  useEffect(() => {
    shown.current = PAGE
    let live = true
    if (plain) idbGet(KEPT).then(old => { if (live && Array.isArray(old)) setRows(x => x || old) }).catch(() => {})
    const t = setTimeout(load, f.q ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [load])
  // Live: a run that starts, ends or is deleted — on this PC or another — shows at once (no polling).
  useEffect(() => onDataChange(['run_history', 'run_history_shots'], () => { load(); loadChoices() }, 500), [load])
  const loadChoices = () => api.get('/run-history/choices', { adalNoCache: true }).then(r => setChoices(r.data)).catch(() => {})
  useEffect(() => { loadChoices() }, [])
  // Rows gone (deleted elsewhere): not picked any more.
  useEffect(() => { if (rows && picked.size) { const ids = new Set(rows.map(r => r.id)); if ([...picked].some(id => !ids.has(id))) setPicked(p => new Set([...p].filter(id => ids.has(id)))) } }, [rows])

  const showMore = () => {
    const last = rows?.[rows.length - 1]
    if (!last) return
    setBusy(true)
    api.get('/run-history', { params: { ...query, limit: PAGE + 1, before: `${last.started_at}|${last.id}` }, adalNoCache: true })
      .then(r => {
        const got = Array.isArray(r.data) ? r.data : []
        setRows(x => { const have = new Set((x || []).map(y => y.id)); const next = [...(x || []), ...got.slice(0, PAGE).filter(y => !have.has(y.id))]; shown.current = next.length; return next })
        setMore(got.length > PAGE)
      })
      .catch(e => toast.error(e.response?.data?.error || e.message))
      .finally(() => setBusy(false))
  }

  const toggle = (id) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const allPicked = !!rows?.length && rows.every(r => picked.has(r.id))
  const pickAll = () => setPicked(allPicked ? new Set() : new Set(rows.map(r => r.id)))

  /** Rows go (gone at once here; the PC and the other PCs follow). A robot still working: asked first. */
  const remove = async (ids) => {
    if (!ids.length) return
    const byId = new Map((rows || []).map(r => [r.id, r]))
    const working = ids.filter(id => byId.get(id)?.outcome === 'running')
    const what = ids.length === 1 ? 'this entry' : `these ${ids.length} entries`
    if (working.length) {
      if (!window.confirm(`${working.length === 1 ? 'A robot is still working on one of them' : `Robots are still working on ${working.length} of them`}. The robot goes on; only its entry here is deleted.\n\nDelete ${what}?`)) return
    } else if (!window.confirm(`Delete ${what} from the robot history?`)) return
    setBusy(true)
    const before = rows
    setRows(x => (x || []).filter(r => !ids.includes(r.id)))
    try {
      let r = await api.post('/run-history/delete', { ids, running_ok: working.length > 0 }).catch(e => e.response?.status === 409 ? e.response : Promise.reject(e))
      // Started on another PC meanwhile: ask once more.
      if (r.status === 409) {
        if (!window.confirm('A robot started working on one of them meanwhile. Delete anyway?')) { setRows(before); load(); return }
        r = await api.post('/run-history/delete', { ids, running_ok: true })
      }
      setPicked(p => new Set([...p].filter(id => !ids.includes(id))))
      toast.success(r.data?.deleted === 1 ? 'Deleted' : `${r.data?.deleted ?? ids.length} deleted`)
    } catch (e) {
      setRows(before)
      toast.error(e.response?.data?.error || e.message)
    } finally { setBusy(false); load() }
  }

  return (
    <div className="space-y-5 animate-fade-up">
      <PageHeader title="Robot history" subtitle="What each robot did in the last 30 days, from every PC." />
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
        {picked.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm dark:border-slate-700 dark:bg-slate-900/50">
            <span>{picked.size} picked</span>
            <button type="button" disabled={busy} onClick={() => remove([...picked])} className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800">Delete</button>
            <button type="button" onClick={() => setPicked(new Set())} className="text-xs text-slate-500 hover:underline">Clear</button>
          </div>
        )}
        {error && rows?.length ? <p className="px-4 pt-3 text-xs text-amber-700">{error}</p> : null}
        {error && !rows?.length ? <p className="p-6 text-sm text-amber-700">{error}</p>
          : rows === null ? <p className="p-6 text-sm text-slate-400">Loading…</p>
          : rows.length === 0 ? <p className="p-10 text-center text-sm text-slate-400">{Object.keys(query).length ? 'Nothing matches.' : 'No robot has run yet.'}</p>
          : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900/50">
                <tr><th className="w-8 px-3 py-2"><input type="checkbox" aria-label="Pick all" checked={allPicked} onChange={pickAll} /></th><th className="px-4 py-2 text-left">Robot</th><th className="px-4 py-2 text-left">Started by</th><th className="px-4 py-2 text-left">Started</th><th className="px-4 py-2 text-left">Took</th><th className="px-4 py-2 text-left">Result</th><th className="px-4 py-2" /></tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const [label, cls] = OUTCOME[r.outcome] || [r.outcome, 'bg-slate-100']
                  return (
                    <tr key={r.id} className={`border-t border-slate-100 align-top dark:border-slate-700 ${picked.has(r.id) ? 'bg-sky-50/60 dark:bg-sky-900/20' : ''}`}>
                      <td className="px-3 py-3"><input type="checkbox" aria-label="Pick" checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>
                      <td className="px-4 py-2.5">
                        <span className="block font-medium">{r.workflow}{r.site && !r.workflow.includes(r.site) ? ` · ${r.site}` : ''}</span>
                        <span className="text-xs text-slate-500" translate="no">{r.profile_name || (r.kind === 'move' ? 'Whole agency' : '—')}{r.account ? ` · ${r.account}` : ''}</span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300" translate="no">{r.employee || '—'}<span className="block text-xs text-slate-400">{r.pc || ''}{r.asked_on ? ` · asked on ${r.asked_on}` : ''}</span></td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">{when(r.started_at)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">{long(r.duration_s)}</td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>
                        {r.reason && <span className="mt-1 block max-w-md text-xs text-slate-600 dark:text-slate-300">{r.reason}</span>}
                        {r.step && r.outcome !== 'done' && <span className="mt-0.5 block max-w-md text-xs text-slate-400">Step: {r.step}</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        {r.has_shot && <button type="button" onClick={() => setLook(r)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 dark:border-slate-600">Picture</button>}
                        <button type="button" disabled={busy} onClick={() => remove([r.id])} title="Delete" aria-label="Delete" className="ml-2 rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-500 hover:border-red-300 hover:text-red-700 disabled:opacity-50 dark:border-slate-600">✕</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {more && <div className="border-t border-slate-100 p-3 text-center dark:border-slate-700"><button type="button" disabled={busy} onClick={showMore} className="rounded-lg border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600">Show more</button></div>}
            </div>
          )}
      </div>
      {look && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" onClick={() => setLook(null)}>
          <div className="max-h-full w-full max-w-4xl overflow-auto rounded-2xl bg-white p-4 shadow-2xl dark:bg-slate-900" onClick={e => e.stopPropagation()}>
            <div className="mb-2 flex items-start justify-between gap-3">
              <p className="text-sm"><b>{look.workflow}</b> · {look.profile_name || ''}<span className="block text-xs text-slate-500">{when(look.ended_at)} · {look.step || look.reason || ''}</span></p>
              <button type="button" onClick={() => setLook(null)} className="rounded-lg border px-3 py-1 text-sm">Close</button>
            </div>
            <img src={`${api.defaults.baseURL}/run-history/${look.id}/shot`} alt="The tab when the robot stopped" className="w-full rounded-lg border border-slate-200" />
          </div>
        </div>, document.body
      )}
    </div>
  )
}
