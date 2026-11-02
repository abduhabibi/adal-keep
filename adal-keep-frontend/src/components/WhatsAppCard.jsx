/**
 * Settings → WhatsApp: sign in by scanning the QR code (like web.whatsapp.com),
 * then the agents in Saudi Arabia that get CVs — each with its CV template(s)
 * and its office name on Musaned (so the one who chose her keeps the CV).
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm'
const err = (e) => e?.response?.data?.error || e.message
const EMPTY = { name: '', chat_id: '', number: '', musaned_office: '', template_ids: [] }

function AgentForm({ initial, templates, chats, onDone, onCancel }) {
  const [a, setA] = useState({ ...EMPTY, ...initial })
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const shown = (chats || []).filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
  const toggle = (id) => setA(x => ({ ...x, template_ids: x.template_ids.includes(id) ? x.template_ids.filter(t => t !== id) : [...x.template_ids, id] }))
  const save = async () => {
    setBusy(true)
    try {
      const body = { name: a.name, musaned_office: a.musaned_office, template_ids: a.template_ids, ...(a.chat_id ? { chat_id: a.chat_id } : { number: a.number }) }
      if (initial?.id) await api.patch(`/whatsapp/agents/${initial.id}`, body)
      else await api.post('/whatsapp/agents', body)
      toast.success('Agent saved'); onDone()
    } catch (e) { toast.error(err(e)) }
    setBusy(false)
  }
  const chatName = (chats || []).find(c => c.id === a.chat_id)?.name
  return (
    <div className="space-y-3 rounded-xl border border-teal-200 bg-teal-50/40 p-3 dark:border-teal-800 dark:bg-teal-900/10">
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={field} placeholder="Agent's name (e.g. Al-Riyadh office)" value={a.name} onChange={e => setA({ ...a, name: e.target.value })} />
        <input className={field} placeholder="Its office name on Musaned" value={a.musaned_office} onChange={e => setA({ ...a, musaned_office: e.target.value })} />
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold text-slate-500">Chat {a.chat_id && <span className="text-teal-600">✓ {chatName || a.chat_id}</span>}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className={field} placeholder="Search your chats…" value={q} onChange={e => setQ(e.target.value)} />
          <input className={field} placeholder="…or type the number (966…)" value={a.number} onChange={e => setA({ ...a, number: e.target.value, chat_id: '' })} />
        </div>
        {q && (
          <div className="mt-1 flex flex-wrap gap-1">
            {shown.map(c => (
              <button key={c.id} type="button" onClick={() => { setA({ ...a, chat_id: c.id, number: '', name: a.name || c.name }); setQ('') }}
                className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs hover:border-teal-500 dark:border-slate-700 dark:bg-slate-800">
                {c.group ? '👥' : '👤'} {c.name}
              </button>
            ))}
            {!shown.length && <span className="text-xs text-slate-500">No chat with that name</span>}
          </div>
        )}
      </div>
      <div>
        <p className="mb-1 text-xs font-semibold text-slate-500">Its CV template(s)</p>
        <div className="flex flex-wrap gap-1.5">
          {templates.map(t => (
            <button key={t.id} type="button" onClick={() => toggle(t.id)}
              className={`rounded-full border px-2.5 py-1 text-xs ${a.template_ids.includes(t.id) ? 'border-teal-500 bg-teal-600 text-white' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'}`}>
              {t.name}
            </button>
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={busy || !a.name.trim() || (!a.chat_id && !a.number.trim())} onClick={save}>{busy ? 'Saving…' : 'Save agent'}</Button>
      </div>
    </div>
  )
}

export default function WhatsAppCard() {
  const [s, setS] = useState(null)
  const [agents, setAgents] = useState([])
  const [templates, setTemplates] = useState([])
  const [chats, setChats] = useState(null)
  const [edit, setEdit] = useState(null) // {} new · agent

  const load = () => api.get('/whatsapp').then(r => setS(r.data)).catch(() => setS(false))
  const loadAgents = () => api.get('/whatsapp/agents').then(r => setAgents(r.data)).catch(() => {})
  useEffect(() => {
    load(); loadAgents()
    api.get('/cv/templates').then(r => setTemplates((r.data || []).filter(t => t.is_active !== 0))).catch(() => {})
  }, [])
  // While it starts / shows the QR, look every 2 s (the QR changes).
  useEffect(() => {
    if (!s || !['starting', 'qr', 'signing-in'].includes(s.status)) return
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [s?.status])
  useEffect(() => { if (s?.status === 'ready' && edit && !chats) api.get('/whatsapp/chats').then(r => setChats(r.data)).catch(() => setChats([])) }, [s?.status, edit])

  if (s === false || s === null) return null
  const connect = async () => { try { setS((await api.post('/whatsapp/connect')).data) } catch (e) { toast.error(err(e)) } }
  const logout = async () => { if (!confirm('Sign this PC out of WhatsApp?')) return; try { setS((await api.post('/whatsapp/logout')).data) } catch (e) { toast.error(err(e)) } }
  const remove = async (a) => { if (!confirm(`Remove ${a.name}?`)) return; await api.delete(`/whatsapp/agents/${a.id}`); loadAgents() }
  const tname = (id) => templates.find(t => t.id === id)?.name || `#${id}`
  const active = agents.filter(a => a.active)

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>💬</span> WhatsApp</h2>
      <p className="text-sm text-slate-500 mb-4" translate="no">
        Send CVs to your agents in Saudi Arabia from a profile. When Musaned shows who chose her, her CV is taken back from the other agents.
      </p>

      {s.status === 'ready' ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800 dark:bg-teal-900/20 dark:text-teal-300">
          <span>✓ Connected{s.me?.name ? ` as ${s.me.name}` : ''}{s.me?.number ? ` · +${s.me.number}` : ''}</span>
          <button type="button" onClick={logout} className="text-xs underline">Sign out</button>
        </div>
      ) : s.status === 'qr' ? (
        <div className="mb-4 flex flex-col items-center gap-3 rounded-xl border border-slate-200 p-4 sm:flex-row dark:border-slate-700">
          {s.qr ? <img src={s.qr} alt="WhatsApp QR code" className="h-56 w-56 rounded-lg bg-white p-2" /> : <div className="h-56 w-56 animate-pulse rounded-lg bg-slate-100" />}
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>Open WhatsApp on the agency's phone</li>
            <li>Tap <b>⋮</b> (or Settings) → <b>Linked devices</b> → <b>Link a device</b></li>
            <li>Point the phone at this code</li>
          </ol>
        </div>
      ) : (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button onClick={connect} disabled={s.status === 'starting' || s.status === 'signing-in'}>
            {s.status === 'starting' ? 'Opening WhatsApp…' : s.status === 'signing-in' ? 'Signing in…' : '💬 Connect with WhatsApp'}
          </Button>
          {s.error && <span className="text-sm text-red-600">{s.error}</span>}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Agents ({active.length})</p>
          {!edit && <Button size="sm" variant="secondary" onClick={() => setEdit({})} disabled={s.status !== 'ready'} title={s.status !== 'ready' ? 'Connect WhatsApp first' : ''}>＋ Add agent</Button>}
        </div>
        {edit && !edit.id && <AgentForm initial={null} templates={templates} chats={chats} onDone={() => { setEdit(null); loadAgents() }} onCancel={() => setEdit(null)} />}
        {active.map(a => edit?.id === a.id
          ? <AgentForm key={a.id} initial={a} templates={templates} chats={chats} onDone={() => { setEdit(null); loadAgents() }} onCancel={() => setEdit(null)} />
          : (
            <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700">
              <span className="font-semibold">{a.name}</span>
              {a.musaned_office && <span className="text-xs text-slate-500">Musaned: {a.musaned_office}</span>}
              <span className="flex flex-wrap gap-1">{a.template_ids.map(id => <span key={id} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">{tname(id)}</span>)}</span>
              <span className="ml-auto text-xs text-slate-500">{a.counts?.sent || 0} out · {a.counts?.chosen_here || 0} chosen</span>
              <button type="button" className="text-xs text-teal-700 underline" onClick={() => setEdit(a)}>Edit</button>
              <button type="button" className="text-xs text-red-600 underline" onClick={() => remove(a)}>Remove</button>
            </div>
          ))}
        {!active.length && !edit && <p className="text-sm text-slate-500">No agents yet.</p>}
      </div>
    </Card>
  )
}
