/**
 * Settings → WhatsApp: sign in by scanning the QR code (like web.whatsapp.com),
 * then the agents in Saudi Arabia that get CVs — each with its CV template(s)
 * and its office name on Musaned (so the one who chose her keeps the CV).
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import { wa } from '../lib/whatsapp'
import Card from './shared/Card'
import Button from './shared/Button'

const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm'
const err = (e) => e?.response?.data?.error || e.message
const EMPTY = { name: '', chat_id: '', number: '', musaned_office: '', template_ids: [] }

/**
 * An agent in three taps: its CV template(s) → "Link with WhatsApp" (pick the
 * chat) → its name (the chat's name, change it if you like) → Save. Its office
 * on Musaned is the template's name (the templates are named after the Saudi
 * offices), so the CVs it chose are taken back from the others by themselves.
 */
function AgentForm({ initial, templates, chats, onDone, onCancel }) {
  const [a, setA] = useState({ ...EMPTY, ...initial })
  const [q, setQ] = useState('')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const shown = (chats || []).filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 40)
  const toggle = (id) => setA(x => ({ ...x, template_ids: x.template_ids.includes(id) ? x.template_ids.filter(t => t !== id) : [...x.template_ids, id] }))
  const office = a.musaned_office || templates.find(t => t.id === a.template_ids[0])?.name || ''
  const save = async () => {
    setBusy(true)
    try {
      const body = { name: a.name.trim(), musaned_office: office, template_ids: a.template_ids, ...(a.chat_id ? { chat_id: a.chat_id } : { number: a.number }) }
      if (initial?.id) await wa.patch(`/whatsapp/agents/${initial.id}`, body)
      else await wa.post('/whatsapp/agents', body)
      toast.success('Agent saved'); onDone()
    } catch (e) { toast.error(err(e)) }
    setBusy(false)
  }
  const chatName = (chats || []).find(c => c.id === a.chat_id)?.name
  const linked = !!(a.chat_id || a.number.trim())
  const step = (n, done, text) => (
    <p className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
      <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${done ? 'bg-teal-600 text-white' : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-200'}`}>{done ? '✓' : n}</span>{text}
    </p>
  )
  return (
    <div className="space-y-4 rounded-xl border border-teal-200 bg-teal-50/40 p-3 dark:border-teal-800 dark:bg-teal-900/10">
      <div>
        {step(1, a.template_ids.length > 0, 'Click its CV template')}
        <div className="flex flex-wrap gap-1.5">
          {templates.map(t => (
            <button key={t.id} type="button" onClick={() => toggle(t.id)}
              className={`rounded-full border px-2.5 py-1 text-xs ${a.template_ids.includes(t.id) ? 'border-teal-500 bg-teal-600 text-white' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800'}`}>
              {t.name}
            </button>
          ))}
        </div>
      </div>
      <div>
        {step(2, linked, 'Link it with WhatsApp')}
        {linked && !picking ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full bg-teal-100 px-2.5 py-1 text-xs font-semibold text-teal-800 dark:bg-teal-900/30 dark:text-teal-300">💬 {chatName || a.number || a.chat_id}</span>
            <button type="button" onClick={() => setPicking(true)} className="text-xs text-teal-700 underline dark:text-teal-400">change</button>
          </div>
        ) : picking ? (
          <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900">
            <input autoFocus className={field} placeholder="Search your WhatsApp chats…" value={q} onChange={e => setQ(e.target.value)} />
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              {chats === null && <p className="p-2 text-xs text-slate-400">Loading your chats…</p>}
              {shown.map(c => (
                <button key={c.id} type="button" onClick={() => { setA(x => ({ ...x, chat_id: c.id, number: '', name: x.name || c.name })); setPicking(false); setQ('') }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-teal-50 dark:hover:bg-teal-900/20">
                  <span>{c.group ? '👥' : '👤'}</span><span className="truncate">{c.name}</span>
                </button>
              ))}
              {chats && !chats.length && <p className="p-2 text-xs text-slate-500">Your chats are still loading — they show here by themselves, or type the number below.</p>}
              {chats?.length > 0 && !shown.length && <p className="p-2 text-xs text-slate-500">No chat with that name</p>}
            </div>
            <input className={field} placeholder="…or type a number (966…)" value={a.number}
              onChange={e => setA({ ...a, number: e.target.value, chat_id: '' })} onBlur={() => a.number.trim() && setPicking(false)} />
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>💬 Link with WhatsApp</Button>
        )}
      </div>
      <div>
        {step(3, !!a.name.trim(), 'Name it')}
        <input className={field} placeholder={chatName || 'e.g. Al-Riyadh office'} value={a.name} onChange={e => setA({ ...a, name: e.target.value })} />
        {office && <p className="mt-1 text-[11px] text-slate-500">Musaned office: {office} (from the template)</p>}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button size="sm" disabled={busy || !a.name.trim() || !linked || !a.template_ids.length} onClick={save}>{busy ? 'Saving…' : 'Save agent'}</Button>
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
  const [phone, setPhone] = useState('')
  const [byPhone, setByPhone] = useState(false)

  // Not answering (the server restarting): the card stays and asks again.
  const load = () => wa.get('/whatsapp').then(r => setS(r.data)).catch(e => e.response ? setS(false) : setTimeout(load, 3000))
  const loadAgents = () => wa.get('/whatsapp/agents').then(r => setAgents(r.data)).catch(() => {})
  useEffect(() => {
    load(); loadAgents()
    api.get('/cv/templates').then(r => setTemplates((r.data || []).filter(t => t.is_active !== 0))).catch(() => {})
  }, [])
  // While it starts / shows the QR, look every second (WhatsApp changes its QR every ~20 s).
  useEffect(() => {
    if (!s || !['starting', 'qr', 'code', 'signing-in', 'web'].includes(s.status)) return
    const t = setInterval(load, s.status === 'web' ? 3000 : 1000)
    return () => clearInterval(t)
  }, [s?.status])
  // Right after connecting WhatsApp is still bringing its chats: keep asking until they are there.
  useEffect(() => {
    if (s?.status !== 'ready' || !edit || chats?.length) return
    const load = () => wa.get('/whatsapp/chats').then(r => setChats(r.data)).catch(() => setChats(c => c || []))
    load()
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [s?.status, edit, chats?.length])

  if (s === false || s === null) return null
  // WhatsApp's own page in a window of its own: scan its QR there; Adal Keep connects when it shows the chats.
  const openWeb = async () => { try { setS((await wa.post('/whatsapp/open-web')).data); toast.success('WhatsApp is open on the PC — scan its QR there', { duration: 7000 }) } catch (e) { toast.error(err(e)) } }
  const connect = async (withPhone) => { try { setS((await wa.post('/whatsapp/connect', withPhone ? { phone } : {})).data) } catch (e) { toast.error(err(e)) } }
  const logout = async () => { if (!confirm('Sign your WhatsApp out of Adal Keep?')) return; try { setS((await wa.post('/whatsapp/logout')).data) } catch (e) { toast.error(err(e)) } }
  const remove = async (a) => { if (!confirm(`Remove ${a.name}?`)) return; await wa.delete(`/whatsapp/agents/${a.id}`); loadAgents() }
  const tname = (id) => templates.find(t => t.id === id)?.name || `#${id}`
  const active = agents.filter(a => a.active)

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>💬</span> WhatsApp</h2>
      <p className="text-sm text-slate-500 mb-4" translate="no">
        Everyone links their own WhatsApp here and sends CVs to their own agents in Saudi Arabia (a profile, or CVs → WhatsApp). When Musaned shows who chose her, her CV is taken back from the other agents.
      </p>

      {s.status === 'ready' ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800 dark:bg-teal-900/20 dark:text-teal-300">
          <span>✓ Your WhatsApp is connected{s.me?.name ? ` — ${s.me.name}` : ''}{s.me?.number ? ` · +${s.me.number}` : ''}</span>
          <button type="button" onClick={logout} className="text-xs underline">Sign out</button>
        </div>
      ) : s.status === 'qr' || s.status === 'code' ? (
        <div className="mb-4 flex flex-col items-center gap-4 rounded-xl border border-slate-200 p-4 sm:flex-row dark:border-slate-700">
          {s.status === 'code'
            ? <div className="rounded-xl bg-slate-900 px-6 py-5 font-mono text-3xl font-bold tracking-[0.2em] text-white" translate="no">{s.code}</div>
            : s.qr ? <img src={s.qr} alt="WhatsApp QR code" className="h-56 w-56 rounded-lg bg-white p-2" /> : <div className="h-56 w-56 animate-pulse rounded-lg bg-slate-100" />}
          <div className="space-y-2 text-sm">
            <ol className="list-decimal space-y-1 pl-5">
              <li>Open WhatsApp on your phone</li>
              <li>Tap <b>⋮</b> (or Settings) → <b>Linked devices</b> → <b>Link a device</b></li>
              {s.status === 'code'
                ? <li>Tap <b>Link with phone number instead</b> and type this code</li>
                : <li>Point the phone at this code</li>}
            </ol>
            {s.status === 'qr' && (
              <button type="button" className="text-xs text-teal-700 underline dark:text-teal-400" onClick={() => setByPhone(true)}>On this phone? Link with your phone number instead</button>
            )}
            {s.status === 'qr' && (
              <button type="button" className="block text-xs text-teal-700 underline dark:text-teal-400" onClick={openWeb}>QR not working? Sign in on web.whatsapp.com instead</button>
            )}
            {s.status === 'qr' && byPhone && (
              <div className="flex gap-2">
                <input className={field} inputMode="tel" placeholder="Your WhatsApp number (251…)" value={phone} onChange={e => setPhone(e.target.value)} />
                <Button size="sm" disabled={phone.replace(/\D/g, '').length < 9} onClick={() => connect(true)}>Get code</Button>
              </div>
            )}
          </div>
        </div>
      ) : s.status === 'web' ? (
        <div className="mb-4 rounded-xl border border-teal-200 bg-teal-50/60 p-4 text-sm dark:border-teal-800 dark:bg-teal-900/10">
          <p className="font-semibold">🌐 WhatsApp is open in {s.where || 'a window on this PC'}</p>
          <p className="mt-1 text-slate-600 dark:text-slate-300">Scan the QR there with your phone (Linked devices → Link a device). When your chats show, Adal Keep closes the tab and connects by itself.</p>
          <p className="mt-2 flex items-center gap-2 text-xs text-slate-500"><span className="h-2 w-2 animate-ping rounded-full bg-teal-500" /> Waiting for you to sign in…</p>
        </div>
      ) : (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => connect(false)} disabled={s.status === 'starting' || s.status === 'signing-in'}>
            {s.status === 'starting' ? 'Opening WhatsApp…' : s.status === 'signing-in' ? 'Signing in…' : '💬 Connect my WhatsApp'}
          </Button>
          <Button variant="secondary" onClick={openWeb} disabled={s.status === 'starting' || s.status === 'signing-in'} title="Opens a normal web.whatsapp.com tab in Adal Browser: sign in there; Adal Keep connects when you are in">
            🌐 Sign in on web.whatsapp.com
          </Button>
          {s.error && <span className="text-sm text-red-600">{s.error}</span>}
        </div>
      )}
      {s.others?.length > 0 && (
        <p className="-mt-2 mb-4 text-xs text-slate-500">Also connected on this agency: {s.others.map(o => o.me?.name || o.me?.number || o.key).join(' · ')}</p>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Your agents ({active.length})</p>
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
