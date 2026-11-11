/**
 * Profile → "Send CV to agents" on WhatsApp: a person picks the agents (or all);
 * each gets her CV made with its own template. Shows where her CV is now —
 * out, chosen there, taken back.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import { wa } from '../lib/whatsapp'
import Button from './shared/Button'
import { usePlan } from '../lib/plan'
import { useAuth } from '../context/AuthContext'

const err = (e) => e?.response?.data?.error || e.message
const STATUS = {
  sent: ['Not selected yet', 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300'],
  chosen_here: ['Chosen by this agent', 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'],
  withdrawn: ['Deleted (chosen elsewhere)', 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'],
  marked: ['Marked 🔴 selected', 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300'],
  failed: ['Not sent', 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'],
}

export default function WhatsAppSend({ profile }) {
  const [conn, setConn] = useState(null)
  const [agents, setAgents] = useState([])
  const [sends, setSends] = useState([])
  const [pick, setPick] = useState(null) // null closed · Set of agent ids
  const [busy, setBusy] = useState(false)
  const plan = usePlan()
  const { activeEmployee } = useAuth()
  // Only between a complete CV and her being selected: before, there is no CV
  // to send; after, it is gone for good.
  const [due, setDue] = useState(false)

  const loadSends = () => wa.get(`/profiles/${profile.id}/whatsapp`).then(r => setSends(r.data)).catch(() => {})
  useEffect(() => {
    wa.get('/whatsapp').then(r => setConn(r.data)).catch(() => setConn(false))
    wa.get('/whatsapp/agents').then(r => setAgents(r.data.filter(a => a.active))).catch(() => {})
    loadSends()
    api.get(`/profiles/${profile.id}/journey`).then(({ data }) => {
      const st = (k) => (data?.embassy || []).find(x => x.key === k)?.state
      setDue(Array.isArray(data?.cv_missing) && !data.cv_missing.length && st('selected') !== 'done')
    }).catch(() => setDue(false))
  }, [profile.id, profile.chosen_at])

  // WhatsApp outside this agency's plan: not offered here (Settings → Plan says so).
  if (plan?.features?.find(f => f.key === 'whatsapp')?.state === 'off') return null
  if (!due || profile.chosen_at || !conn || (!agents.length && !sends.length)) return null
  const ready = conn.status === 'ready'
  const send = async (ids) => {
    setBusy(true)
    const t = toast.loading('Making the CVs and sending…')
    try {
      const { data } = await wa.post(`/profiles/${profile.id}/whatsapp/send`, { agent_ids: ids })
      const ok = data.results.filter(r => r.ok && !r.already).length
      const bad = data.results.filter(r => !r.ok)
      if (bad.length) toast.error(`${ok} sent · ${bad.length} not sent: ${bad[0].agent} — ${bad[0].error}`, { id: t, duration: 9000 })
      else toast.success(ok ? `Sent to ${ok} chat${ok === 1 ? '' : 's'}` : 'Already sent to them', { id: t })
      setPick(null); loadSends()
    } catch (e) { toast.error(err(e), { id: t }) }
    setBusy(false)
  }
  // Newest line per agent.
  const latest = [...new Map([...sends].reverse().map(s => [`${s.agent_id}-${s.template_id}`, s])).values()]

  return (
    <div className="panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-display font-bold">💬 CV on WhatsApp</p>
        {!ready && <span className="text-xs text-amber-700">WhatsApp is not connected (Settings → Integrations)</span>}
        {!profile.chosen_at && agents.length > 0 && (
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" disabled={!ready || busy} onClick={() => setPick(pick ? null : new Set())}>Choose agents</Button>
            <Button size="sm" disabled={!ready || busy} onClick={() => { if (confirm(`Send ${profile.full_name}'s CV to all ${agents.length} agent(s)?`)) send([]) }}>📤 Show for all</Button>
          </span>
        )}
      </div>
      {pick && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {agents.map(a => (
            <button key={a.id} type="button" onClick={() => { const n = new Set(pick); n.has(a.id) ? n.delete(a.id) : n.add(a.id); setPick(n) }}
              className={`rounded-full border px-2.5 py-1 text-xs ${pick.has(a.id) ? 'border-teal-500 bg-teal-600 text-white' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'}`}>
              {a.name}
            </button>
          ))}
          <Button size="sm" disabled={!pick.size || busy} onClick={() => send([...pick])}>Send to {pick.size || ''}</Button>
        </div>
      )}
      {latest.length > 0 && (
        <ul className="mt-3 divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {latest.map(s => {
            const [label, cls] = STATUS[s.status] || [s.status, '']
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="font-semibold">{s.agent_name || 'Agent'}</span>
                {s.template_name && <span className="text-xs text-slate-500">{s.template_name}</span>}
                <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{label}</span>
                <span className="ml-auto text-xs text-slate-400">{new Date(s.sent_at).toLocaleString()}</span>
                {s.status === 'failed' && s.error && <span className="w-full text-xs text-red-600">{s.error}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
