/**
 * "Send on WhatsApp" in the CV preview: pick from the agency's agents, press Send.
 * Nothing goes before that press, and only to the ones picked. An agent she was sent
 * to before says when; sending again is asked for that agent alone.
 * The PDF is made when Send is pressed (cv_id from onMake), not before.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { wa } from '../lib/whatsapp'

const err = (e) => e?.response?.data?.error || e.message
export const waDay = (t) => { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) }

export default function SendCvWhatsApp({ profileId, templateId, name, onMake, onClose }) {
  const [info, setInfo] = useState(null)     // { blocked, had, whatsapp } · false: this PC has not that part
  const [agents, setAgents] = useState(null)
  const [pick, setPick] = useState(new Set())
  const [again, setAgain] = useState(new Set())
  const [q, setQ] = useState('')
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    wa.get(`/whatsapp/cv/${profileId}`).then(r => setInfo(r.data)).catch(e => setInfo({ error: e.response?.status === 404 ? 'Update the main PC first' : err(e) }))
    wa.get('/whatsapp/agents').then(r => setAgents((r.data || []).filter(a => a.active))).catch(() => setAgents([]))
  }, [profileId])
  useEffect(() => {
    if (!job?.running) return
    const t = setInterval(() => wa.get(`/whatsapp/cv/jobs/${job.id}`).then(r => setJob(r.data)).catch(() => setJob(j => ({ ...j, running: false }))), 1500)
    return () => clearInterval(t)
  }, [job?.id, job?.running])
  useEffect(() => { const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }; window.addEventListener('keydown', esc, true); return () => window.removeEventListener('keydown', esc, true) }, [onClose])

  const shown = useMemo(() => { const s = q.trim().toLowerCase(); return (agents || []).filter(a => !s || `${a.name} ${a.musaned_office || ''} ${a.chat_id || ''}`.toLowerCase().includes(s)) }, [agents, q])
  const had = info?.had || {}
  const flip = (set, id) => set(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const ready = info?.whatsapp?.status === 'ready'
  const asking = [...pick].filter(id => had[id] && !again.has(id))
  const why = info?.error || info?.blocked || (info && !ready ? (info.whatsapp?.own ? 'WhatsApp on this computer is not signed in: WhatsApp page → Sign in' : 'WhatsApp is not connected (Settings → Integrations)') : '')

  const send = async () => {
    setBusy(true)
    const t = toast.loading('Making her CV…')
    try {
      const cv = await onMake()
      if (!cv?.generated_cv_id) throw new Error('The office PC must be on to send it')
      const { data } = await wa.post(`/whatsapp/cv/${profileId}`, { cv_id: cv.generated_cv_id, template_id: Number(templateId) || null, agent_ids: [...pick], again: [...again].filter(id => pick.has(id)) })
      toast.dismiss(t); setJob(data)
    } catch (e) {
      const before = e.response?.data?.before
      if (before) setInfo(i => ({ ...i, had: { ...(i.had || {}), ...Object.fromEntries(before.map(b => [b.agent_id, b])) } }))
      toast.error(err(e), { id: t, duration: 8000 })
    }
    setBusy(false)
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-3" style={{ background: 'rgba(15,23,42,.9)' }} onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="tutor-solid flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="text-base font-bold text-slate-900 dark:text-white">Send on WhatsApp</p><p className="truncate text-sm text-slate-500" translate="no">{name}</p></div>
          <button type="button" onClick={onClose} aria-label="Close" className="h-8 w-8 shrink-0 rounded-full bg-slate-100 dark:bg-slate-800">✕</button>
        </div>
        {job ? (
          <div className="space-y-2 text-sm">
            <p className="font-semibold">{job.running ? `Sending ${job.done} of ${job.total}${job.agent ? ` — ${job.agent}` : '…'}` : `${job.sent} sent${job.failed ? ` · ${job.failed} not sent` : ''}`}</p>
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {(job.results || []).map((r, i) => <li key={i} className={r.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600'}>{r.ok ? '✓' : '✗'} <span translate="no">{r.agent}</span>{r.error ? ` — ${r.error}` : ''}{r.note ? ` — ${r.note}` : ''}</li>)}
            </ul>
            {job.error && <p className="text-red-600">{job.error}</p>}
            <button type="button" onClick={onClose} className="w-full rounded-lg bg-slate-800 py-2 font-semibold text-white">{job.running ? 'Close (it goes on)' : 'Done'}</button>
          </div>
        ) : info === null || agents === null ? <p className="py-6 text-center text-sm text-slate-500">…</p> : (<>
          {why && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">{why}</p>}
          {agents.length > 8 && <input className="field mb-2 w-full" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} />}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {!agents.length && <p className="text-sm text-slate-500">No agents yet: Settings → Integrations → WhatsApp.</p>}
            {shown.map(a => (
              <div key={a.id} className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" checked={pick.has(a.id)} onChange={() => flip(setPick, a.id)} />
                  <span className="min-w-0 flex-1 truncate font-medium" translate="no">{a.name}</span>
                  {had[a.id] && <span className="shrink-0 text-xs text-amber-700 dark:text-amber-300">sent {waDay(had[a.id].at)}</span>}
                </label>
                {pick.has(a.id) && had[a.id] && (
                  <label className="mt-1 flex cursor-pointer items-center gap-2 pl-6 text-xs text-amber-800 dark:text-amber-200">
                    <input type="checkbox" checked={again.has(a.id)} onChange={() => flip(setAgain, a.id)} />
                    <span>Sent {had[a.id].times > 1 ? `${had[a.id].times} times, last ` : ''}on {waDay(had[a.id].at)}{had[a.id].by ? ` by ${had[a.id].by}` : ''}. Send again</span>
                  </label>
                )}
              </div>
            ))}
          </div>
          <button type="button" onClick={send} disabled={busy || !!why || !pick.size || asking.length > 0 || pick.size > 15}
            className="mt-3 w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? '…' : asking.length ? 'Tick "Send again" or leave them out' : pick.size > 15 ? 'At most 15 at once' : `Send${pick.size ? ` to ${pick.size}` : ''}`}
          </button>
        </>)}
      </div>
    </div>, document.body)
}
