/**
 * CVs → WhatsApp: every girl not chosen yet who has a CV. Tick some (or all)
 * and send them to all your agents, or only to the agents you pick. A girl
 * chosen on Musaned leaves this list (her CV is taken back from the others).
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { wa } from '../lib/whatsapp'
import Button from './shared/Button'
import Spinner from './shared/Spinner'

const err = (e) => e?.response?.data?.error || e.message
const FILTERS = [['all', 'All'], ['new', 'Not sent yet'], ['out', 'Sent, not selected']]

export default function WhatsAppCVs() {
  const navigate = useNavigate()
  const [conn, setConn] = useState(null)
  const [rows, setRows] = useState(null)
  const [agents, setAgents] = useState([])
  const [picked, setPicked] = useState(new Set())
  const [toAgents, setToAgents] = useState(new Set()) // empty → all agents
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const [job, setJob] = useState(null)

  const load = () => wa.get('/whatsapp/available').then(r => setRows(r.data)).catch(e => { setRows([]); toast.error(err(e)) })
  useEffect(() => {
    load()
    wa.get('/whatsapp').then(r => setConn(r.data)).catch(() => setConn(false))
    wa.get('/whatsapp/agents').then(r => setAgents(r.data.filter(a => a.active))).catch(() => {})
    wa.get('/whatsapp/bulk').then(r => r.data.running && setJob(r.data)).catch(() => {})
  }, [])
  // While sending: how far, every 2 s; the list again at the end.
  useEffect(() => {
    if (!job?.running) return
    const t = setInterval(async () => {
      try {
        const { data } = await wa.get('/whatsapp/bulk')
        setJob(data)
        if (!data.running) {
          load()
          if (data.failed) toast.error(`${data.sent} sent · ${data.failed} not sent — ${data.errors[0] || ''}`, { duration: 9000 })
          else toast.success(`Sent — ${data.sent} CV${data.sent === 1 ? '' : 's'}`)
        }
      } catch {}
    }, 2000)
    return () => clearInterval(t)
  }, [job?.running])

  const shown = useMemo(() => (rows || []).filter(r =>
    (filter === 'all' || (filter === 'new' ? !r.sent_to.length : r.sent_to.length > 0)) &&
    (!q || `${r.full_name} ${r.passport_number || ''}`.toLowerCase().includes(q.toLowerCase()))), [rows, filter, q])

  if (rows === null || conn === null) return <Spinner />
  const ready = conn?.status === 'ready'
  const allShownPicked = shown.length > 0 && shown.every(r => picked.has(r.id))
  const toggle = (set, setter, id) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setter(n) }
  const send = async (ids) => {
    if (!ids.length) return toast.error('Tick the girls to send')
    const who = toAgents.size ? `${toAgents.size} agent${toAgents.size === 1 ? '' : 's'}` : `all ${agents.length} agents`
    if (!confirm(`Send ${ids.length} CV${ids.length === 1 ? '' : 's'} to ${who}?`)) return
    try { setJob((await wa.post('/whatsapp/bulk', { profile_ids: ids, agent_ids: [...toAgents] })).data); setPicked(new Set()) }
    catch (e) { toast.error(err(e)) }
  }

  if (!ready || !agents.length) {
    return (
      <div className="panel p-6 text-center text-sm">
        <p className="mb-3 text-slate-600 dark:text-slate-300">{!ready ? 'Connect your WhatsApp first.' : 'Add your agents first.'}</p>
        <Button onClick={() => navigate('/settings?tab=integrations')}>Settings → Integrations</Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="panel space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Send to:</span>
          <button type="button" onClick={() => setToAgents(new Set())}
            className={`rounded-full border px-2.5 py-1 text-xs ${!toAgents.size ? 'border-teal-500 bg-teal-600 text-white' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'}`}>All agents ({agents.length})</button>
          {agents.map(a => (
            <button key={a.id} type="button" onClick={() => toggle(toAgents, setToAgents, a.id)}
              className={`rounded-full border px-2.5 py-1 text-xs ${toAgents.has(a.id) ? 'border-teal-500 bg-teal-600 text-white' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'}`}>{a.name}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="field min-w-[200px] flex-1" placeholder="Search name or passport…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
            {FILTERS.map(([id, label]) => (
              <button key={id} type="button" onClick={() => setFilter(id)}
                className={`rounded-md px-2.5 py-1 text-xs ${filter === id ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : ''}`}>{label}</button>
            ))}
          </div>
          <Button size="sm" variant="secondary" disabled={job?.running || !picked.size} onClick={() => send([...picked])}>📤 Send ticked ({picked.size})</Button>
          <Button size="sm" disabled={job?.running || !shown.length} onClick={() => send(shown.filter(r => !r.sent_to.length).map(r => r.id))}>📤 Send all not sent yet</Button>
        </div>
        {job?.running && (
          <div>
            <div className="mb-1 flex justify-between text-xs text-slate-500"><span>Sending {job.current}…</span><span>{job.done} / {job.total}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full bg-teal-500 transition-all" style={{ width: `${(job.done / Math.max(1, job.total)) * 100}%` }} /></div>
          </div>
        )}
      </div>

      {!shown.length ? (
        <p className="panel p-6 text-center text-sm text-slate-500">{rows.length ? 'No one here with this filter.' : 'No girl with a CV who is not chosen yet. Make CVs first (+ New CV).'}</p>
      ) : (
        <div className="panel overflow-hidden">
          <label className="flex items-center gap-3 border-b border-slate-100 px-4 py-2 text-xs font-semibold text-slate-500 dark:border-slate-800">
            <input type="checkbox" checked={allShownPicked} onChange={() => setPicked(allShownPicked ? new Set() : new Set(shown.map(r => r.id)))} />
            {shown.length} girl{shown.length === 1 ? '' : 's'} · not selected yet
          </label>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {shown.map(r => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(picked, setPicked, r.id)} />
                <button type="button" className="min-w-0 text-left" onClick={() => navigate(`/profiles/${r.id}`)}>
                  <span className="font-semibold hover:underline">{r.full_name}</span>
                  <span className="ml-2 text-xs text-slate-500">{r.passport_number}</span>
                </button>
                <span className="ml-auto flex flex-wrap items-center gap-1">
                  {r.sent_to.length
                    ? r.sent_to.map(n => <span key={n} className="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800 dark:bg-sky-900/30 dark:text-sky-300">{n}</span>)
                    : r.failed ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">Not sent — try again</span>
                    : <span className="text-xs text-slate-400">Not sent yet</span>}
                </span>
                <Button size="sm" variant="secondary" disabled={job?.running} onClick={() => send([r.id])}>Send</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
