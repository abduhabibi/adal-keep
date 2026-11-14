// A profile another agency sent in the chat (backend services/profileShare.js):
// the card in the message, its View window (her details and every document)
// and "Add to my Adal Keep". Also the window that sends profiles.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'

export const PROFILE_MIME = 'application/x-adal-profile'
export const isSharedProfile = (m) => m?.file_mime === PROFILE_MIME
/** The message's words without the line that carries the key. */
export const sharedTitle = (body) => String(body || '').split('\n').filter(l => !/^\[adal-profile/.test(l)).join('\n')
/** "Added … to its Adal Keep" replies: only their words. */
export const cleanBody = (body) => String(body || '').split('\n').filter(l => !/^\[adal-profile/.test(l)).join('\n')

const fileUrl = (id, n) => `/api/chat/profile/${id}/file/${n}`
const SHOWN = [
  ['full_name', 'Name'], ['passport_number', 'Passport'], ['date_of_birth', 'Date of birth'], ['place_of_birth', 'Place of birth'],
  ['passport_issue_date', 'Passport issued'], ['passport_expiry_date', 'Passport expires'], ['gender', 'Sex'], ['nationality', 'Nationality'],
  ['religion', 'Religion'], ['marital_status', 'Marital status'], ['children_count', 'Children'], ['phone_number', 'Phone'],
  ['education_level', 'Education'], ['work_experience', 'Experience'], ['experience_country', 'Worked in'], ['job_title', 'Position'],
  ['salary', 'Salary'], ['height', 'Height'], ['weight', 'Weight'], ['emergency_name', 'Emergency contact'], ['emergency_phone', 'Emergency phone'],
  ['labor_id', 'Labour ID'], ['visa_number', 'Visa number'], ['employer_name', 'Employer'], ['status', 'Status'],
]
const label = (k) => (SHOWN.find(([c]) => c === k)?.[1]) || k.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())

export function SharedProfileCard({ m, mine }) {
  const [open, setOpen] = useState(false)
  const transfer = /\[adal-profile v1 [^\]]* m=transfer /.test(m.body || '')
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="my-1 flex w-full items-center gap-3 rounded-lg bg-black/5 px-3 py-2 text-left hover:bg-black/10 dark:bg-white/10">
        <span className="text-2xl">🧑‍💼</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{String(m.file_name || 'Profile').replace(/\.adalprofile$/, '')}</span>
          <span className="text-[11px] text-slate-500">{transfer ? 'Transfer' : 'To see'} · {mine ? 'you sent her' : 'View · Add to my Adal Keep'}</span>
        </span>
      </button>
      {open && <SharedProfileView id={m.id} onClose={() => setOpen(false)} />}
    </>
  )
}

export function SharedProfileView({ id, onClose }) {
  const nav = useNavigate()
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [all, setAll] = useState(false)
  useEffect(() => {
    api.get(`/chat/profile/${id}`, { adalNoCache: true, timeout: 120000 }).then(r => setD(r.data)).catch(e => setErr(e.response?.data?.error || e.message))
  }, [id])
  const add = async () => {
    setBusy(true)
    try {
      const r = await api.post(`/chat/profile/${id}/add`, {}, { timeout: 300000 })
      toast.success(r.data.created ? `Added to your Adal Keep with ${r.data.documents} documents` : `Her documents were added to her profile here (${r.data.documents} new)`)
      setD(x => ({ ...x, added: { profile_id: r.data.profile_id } }))
    } catch (e) { toast.error(e.response?.data?.error || e.message) } finally { setBusy(false) }
  }
  const p = d?.profile || {}
  const rows = SHOWN.filter(([k]) => p[k] !== undefined && p[k] !== null && p[k] !== '')
  const extra = Object.keys(p).filter(k => !SHOWN.some(([c]) => c === k) && !/(_raw|_data|_ticks|_source|_at)$/.test(k))
  const groups = {}
  for (const f of d?.documents || []) (groups[f.field] ||= []).push(f)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">{p.full_name || 'Profile'}</h2>
            {d && <p className="text-xs text-slate-500">From {d.from} · {d.mode === 'transfer' ? 'transferred (she moves to the agency that adds her)' : 'sent to see'} · {new Date(d.sent_at).toLocaleString()}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 text-xl text-slate-400 hover:text-slate-700">×</button>
        </div>
        {err && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        {!d && !err && <p className="text-sm text-slate-500">Opening her profile…</p>}
        {d && (
          <>
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {rows.map(([k, l]) => <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1 dark:border-slate-800"><span className="text-slate-500">{l}</span><span className="text-right font-medium text-slate-800 dark:text-slate-100">{String(p[k])}</span></div>)}
              {all && extra.map(k => <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1 dark:border-slate-800"><span className="text-slate-500">{label(k)}</span><span className="text-right font-medium text-slate-800 dark:text-slate-100">{String(p[k])}</span></div>)}
            </div>
            {extra.length > 0 && <button type="button" onClick={() => setAll(a => !a)} className="mt-1 text-xs font-semibold text-teal-700">{all ? 'Fewer details' : `All details (${extra.length} more)`}</button>}
            <h3 className="mt-4 text-sm font-bold text-slate-700 dark:text-slate-200">Documents ({d.documents.length})</h3>
            <div className="mt-2 space-y-3">
              {Object.entries(groups).map(([field, list]) => (
                <div key={field}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{field}</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {list.map(f => /^image\//.test(f.mimetype)
                      ? <a key={f.n} href={fileUrl(id, f.n)} target="_blank" rel="noreferrer"><img src={fileUrl(id, f.n)} alt={f.name} className="h-24 w-24 rounded-lg border border-slate-200 object-cover" /></a>
                      : <a key={f.n} href={fileUrl(id, f.n)} target="_blank" rel="noreferrer" className="flex h-24 w-24 flex-col items-center justify-center rounded-lg border border-slate-200 p-1 text-center text-[11px] text-slate-600 hover:bg-slate-50"><span className="text-2xl">📄</span><span className="line-clamp-2 break-all">{f.name}</span></a>)}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              {d.mine ? <span className="text-sm text-slate-500">You sent her.</span>
                : d.added ? <button type="button" onClick={() => nav(`/profiles/${d.added.profile_id}`)} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white">✓ Added — open her profile</button>
                : <button type="button" disabled={busy} onClick={add} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                    {busy ? 'Adding her and her documents…' : d.already_here ? `Add her documents to ${d.already_here.full_name || 'her profile here'}` : 'Add to my Adal Keep'}
                  </button>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Send one or more profiles to another agency: to see, or as a transfer. */
export function SendProfilesDialog({ profileIds, onClose, onSent }) {
  const [agencies, setAgencies] = useState(null)
  const [to, setTo] = useState('')
  const [mode, setMode] = useState('show')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    Promise.all([api.get('/chat/agencies', { adalNoCache: true }), api.get('/chat/status', { adalNoCache: true }).catch(() => ({ data: {} }))])
      .then(([a, s]) => setAgencies((Array.isArray(a.data) ? a.data : []).filter(x => !x.is_admin && x.id !== s.data?.me?.id && !/s·s*branch PC d{6}$/.test(x.name || ''))))
      .catch(e => { toast.error(e.response?.data?.error || 'The agencies could not be loaded (is this PC online?)'); setAgencies([]) })
  }, [])
  const send = async () => {
    setBusy(true)
    try {
      const r = await api.post('/chat/profile/send', { profile_ids: profileIds, to, mode }, { timeout: 600000 })
      const n = r.data.sent?.length || 0
      toast.success(mode === 'transfer'
        ? `${n} profile${n === 1 ? '' : 's'} sent as a transfer. She leaves your Adal Keep when they add her (to the Trash, restorable).`
        : `${n} profile${n === 1 ? '' : 's'} sent with every document.`)
      onSent?.(r.data); onClose()
    } catch (e) { toast.error(e.response?.data?.error || e.message) } finally { setBusy(false) }
  }
  // One agency on several accounts (a new PC, Adal Keep installed again): once, its newest.
  const byName = new Map()
  for (const a of agencies || []) {
    const k = String(a.name || '').trim().toLowerCase()
    const had = byName.get(k)
    if (!had || String(a.last_seen || '') > String(had.last_seen || '')) byName.set(k, a)
  }
  const list = [...byName.values()].filter(a => !q || String(a.name).toLowerCase().includes(q.toLowerCase())).sort((x, y) => String(x.name).localeCompare(String(y.name)))
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">Send {profileIds.length === 1 ? 'this profile' : `${profileIds.length} profiles`} to another agency</h2>
        <p className="mt-1 text-xs text-slate-500">With every document. It goes in your private chat with that agency; only that agency can open it.</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {[['show', 'To see', 'She stays with you. They see her and may add her.'], ['transfer', 'Transfer', 'She moves to them: when they add her, she leaves your Adal Keep (to the Trash).']].map(([v, t, s]) => (
            <button key={v} type="button" onClick={() => setMode(v)}
              className={`rounded-xl border p-3 text-left ${mode === v ? 'border-teal-500 bg-teal-50 dark:bg-teal-900/30' : 'border-slate-200 dark:border-slate-700'}`}>
              <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{t}</span><span className="block text-[11px] text-slate-500">{s}</span>
            </button>
          ))}
        </div>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find the agency…" className="mt-4 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800" />
        <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-slate-100 dark:border-slate-800">
          {agencies === null ? <p className="p-3 text-sm text-slate-500">Loading the agencies…</p>
            : list.length ? list.map(a => (
              <button key={a.id} type="button" onClick={() => setTo(a.id)}
                className={`block w-full px-3 py-2 text-left text-sm ${to === a.id ? 'bg-teal-600 text-white' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>{a.name}</button>
            )) : <p className="p-3 text-sm text-slate-500">No agency found.</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-600">Cancel</button>
          <button type="button" disabled={!to || busy} onClick={send} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? 'Sending her documents…' : mode === 'transfer' ? 'Transfer' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
