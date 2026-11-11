/**
 * The selected profiles' CVs to agents on WhatsApp: only the agents on the
 * WhatsApp that is connected now are listed, with "Select all". Anyone
 * may send them.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { wa } from '../lib/whatsapp'
import { useAuth } from '../context/AuthContext'

const err = (e) => e?.response?.data?.error || e.message

export default function WhatsAppSendPicked({ picked, onClose }) {
  const { activeEmployee } = useAuth()
  const [conn, setConn] = useState(null)
  const [agents, setAgents] = useState(null)
  const [to, setTo] = useState(new Set())
  const [job, setJob] = useState(null)

  useEffect(() => {
    wa.get('/whatsapp').then(r => setConn(r.data)).catch(() => setConn(false))
    wa.get('/whatsapp/agents').then(r => setAgents((r.data || []).filter(a => a.active))).catch(() => setAgents([]))
    wa.get('/whatsapp/bulk').then(r => r.data?.running && setJob(r.data)).catch(() => {})
  }, [])
  useEffect(() => {
    if (!job?.running) return
    const t = setInterval(async () => {
      try {
        const { data } = await wa.get('/whatsapp/bulk')
        setJob(data)
        if (!data.running) toast[data.failed ? 'error' : 'success'](data.failed ? `${data.sent} sent · ${data.failed} not sent — ${data.errors?.[0] || ''}` : `Sent — ${data.sent} CV${data.sent === 1 ? '' : 's'}`, { duration: 8000 })
      } catch {}
    }, 2000)
    return () => clearInterval(t)
  }, [job?.running])

  const ready = conn?.status === 'ready'
  const all = agents?.length > 0 && to.size === agents.length
  const flip = (id) => setTo(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const send = async () => {
    if (!to.size) return toast.error('Pick the agents (or Select all)')
    try { setJob((await wa.post('/whatsapp/bulk', { profile_ids: picked.map(p => p.id), agent_ids: [...to] })).data); toast.success(`Sending ${picked.length} CV${picked.length === 1 ? '' : 's'} to ${to.size} agent${to.size === 1 ? '' : 's'}…`) }
    catch (e) { toast.error(err(e)) }
  }

  return (
    <div className="col-span-2 space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/50 p-2 dark:border-emerald-800 dark:bg-emerald-900/20 lg:col-span-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-emerald-800 dark:text-emerald-300">💬 {picked.length} CV{picked.length === 1 ? '' : 's'} to agents on WhatsApp</span>
        <button type="button" onClick={onClose} className="rounded px-1.5 text-slate-400 hover:text-slate-600">✕</button>
      </div>
      {conn === null || agents === null ? (
        <p className="text-xs text-slate-500">Looking at the WhatsApp…</p>
      ) : !ready ? (
        <p className="text-xs text-slate-600 dark:text-slate-300">WhatsApp is not connected now: connect it in Settings → Integrations → WhatsApp.</p>
      ) : !agents.length ? (
        <p className="text-xs text-slate-600 dark:text-slate-300">No agents on this WhatsApp yet: add them in Settings → Integrations → WhatsApp.</p>
      ) : (<>
        <label className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-xs font-semibold dark:bg-slate-900">
          <input type="checkbox" checked={all} onChange={() => setTo(all ? new Set() : new Set(agents.map(a => a.id)))} /> Select all ({agents.length})
        </label>
        <div className="max-h-44 space-y-1 overflow-y-auto">
          {agents.map(a => (
            <label key={a.id} className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-xs dark:bg-slate-900">
              <input type="checkbox" checked={to.has(a.id)} onChange={() => flip(a.id)} />
              <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
              {a.musaned_office && <span className="truncate text-[10px] text-slate-500">{a.musaned_office}</span>}
            </label>
          ))}
        </div>
        <button type="button" onClick={send} disabled={job?.running || !to.size}
          className="w-full rounded-lg bg-emerald-600 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
          {job?.running ? `Sending ${job.done} of ${job.total}…` : `Send to ${to.size || '…'} agent${to.size === 1 ? '' : 's'}`}
        </button>
      </>)}
    </div>
  )
}
