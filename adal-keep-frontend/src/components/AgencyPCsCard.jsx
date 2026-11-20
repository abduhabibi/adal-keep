/**
 * Settings → The agency's PCs (services/sync): every PC has its own full copy
 * and works on it at once; this card shows which PC holds the main PC's role
 * (robots, backups, the online copy, the licence), how each PC was last
 * reached, and lets a person move the role when the main PC is gone.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

const when = (at) => {
  if (!at) return 'never'
  const m = Math.round((Date.now() - (typeof at === 'number' ? at : Date.parse(at))) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

export default function AgencyPCsCard() {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = () => api.get('/sync/status').then(r => setSt(r.data)).catch(() => setSt({ running: false }))
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [])
  if (!st?.running) return null

  const now = async () => {
    setBusy(true)
    try { await api.post('/sync/now'); await load(); toast.success('Copied with the other PCs') } catch (e) { toast.error(e.response?.data?.error || e.message) } finally { setBusy(false) }
  }
  const take = async () => {
    const gone = st.lease && !st.lease.alive
    const ask = gone
      ? `Make this PC the main PC?\n\n${st.lease.name} has not been seen for a while. The robots, backups, online copy and licence move here. If ${st.lease.name} comes back it becomes a Companion.`
      : `${st.lease?.name || 'The main PC'} was seen ${when(st.lease?.seen_at)}.\n\nTake the role anyway only if that PC is gone for good (broken, stolen, replaced). Take it anyway?`
    if (!window.confirm(ask)) return
    // Within 15 minutes of the main PC being seen: a second confirmation (two PCs must never run the robots at once).
    if (!gone && !window.confirm(`Second confirmation.\n\nIf ${st.lease?.name || 'the main PC'} is still switched on somewhere, both PCs would run the robots at the same time.\n\nIs ${st.lease?.name || 'it'} really gone for good?`)) return
    setBusy(true)
    try { await api.post('/sync/take-main', { force: !gone }); toast.success('This PC is the main PC now — Adal Keep starts again') } catch (e) { toast.error(e.response?.data?.error || e.message) } finally { setBusy(false) }
  }
  const handTo = async (pc) => {
    if (!window.confirm(`Give the main PC's role to ${pc.name}?\n\nThe robots, backups, online copy and licence move there; this PC becomes a Companion with its own copy.`)) return
    setBusy(true)
    try { await api.post('/sync/hand-main', { pc_id: pc.pc_id }); toast.success(`${pc.name} is the main PC now`) } catch (e) { toast.error(e.response?.data?.error || e.message) } finally { setBusy(false) }
  }

  const leave = async () => {
    if (!window.confirm('Log out of this main PC?\n\nThis PC leaves the agency: the other PCs stop copying with it, and the main PC lets go of its key and its online account. The copy of the data stays on this PC until it joins an agency again.\n\nNothing on the main PC or the other PCs is deleted.')) return
    setBusy(true)
    try {
      const { data } = await api.post('/sync/leave-agency')
      toast.success(data.main ? 'Logged out of the main PC' : 'Logged out — the main PC is told as soon as it answers')
      setTimeout(() => location.reload(), 800)
    } catch (e) { toast.error(e.response?.data?.error || e.message); setBusy(false) }
  }

  const e = st.engine || {}
  const last = st.status?.last
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h3 className="font-semibold text-slate-800 dark:text-white">The agency's PCs</h3>
          <p className="text-sm text-slate-500">
            Every PC has its own full copy and works on it at once. {st.main ? 'This PC is the main PC.' : `Main PC: ${st.lease?.name || '—'} (seen ${when(st.lease?.seen_at)}).`}
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={now} isLoading={busy}>Copy now</Button>
      </div>
      {st.cut_off && <p className="mb-3 text-sm text-red-600">This PC was {st.cut_off} by the main PC: nothing is copied.</p>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
        {(st.pcs || []).filter(p => !p.revoked_at).map(p => (
          <li key={p.pc_id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium text-slate-800 dark:text-slate-100">{p.name}{p.pc_id === st.me ? ' (this PC)' : ''}</span>
            {p.pc_id === st.lease?.holder && <span className="text-xs rounded-full bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200 px-2">main PC</span>}
            {p.suspended_at && <span className="text-xs rounded-full bg-red-100 text-red-700 px-2">suspended</span>}
            {p.ip && <span className="text-xs font-mono text-slate-500">{p.ip}</span>}
            <span className="text-xs text-slate-400">last seen {when(p.pc_id !== st.me && p.reach?.ok ? Math.max(p.reach.seen || p.reach.at || 0, Date.parse(p.seen_at || 0) || 0) : p.seen_at)}</span>
            {p.pc_id !== st.me && <span className="text-xs text-slate-400">{p.reach?.ok ? 'on the network' : p.reach ? 'not on the network' : ''}</span>}
            {p.pc_id !== st.me && !p.suspended_at && (p.in_sync
              ? <span className="text-xs rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200 px-2">in sync</span>
              : <span className="text-xs rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 px-2" title={`as of ${when(p.vector_at)}`}>
                  {p.they_lack ? `behind (${p.they_lack} changes to get)` : ''}{p.they_lack && p.we_lack ? ' · ' : ''}{p.we_lack ? `${p.we_lack} new for this PC` : ''}
                </span>)}
            {st.main && p.pc_id !== st.me && !p.suspended_at && <button type="button" className="ml-auto text-xs text-teal-700 hover:underline" onClick={() => handTo(p)}>make it the main PC</button>}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-400">
        Last copy {when(last?.at)}{last?.relay && !last.relay.error ? ' · through the online copy too' : ''} ·
        {' '}{e.pending ? `${e.pending} waiting` : 'nothing waiting'}{e.merged ? ` · ${e.merged} merged twins` : ''}{e.conflicts ? ` · ${e.conflicts} kept beside` : ''}
      </p>
      {!st.main && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={take} disabled={busy}>Make this PC the main PC…</Button>
          <Button size="sm" variant="ghost" className="text-amber-700 dark:text-amber-300" onClick={leave} disabled={busy}>Log out of this main PC</Button>
        </div>
      )}
    </Card>
  )
}
