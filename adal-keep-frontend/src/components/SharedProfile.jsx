// Profiles another agency sent in the chat (backend services/profileShare.js):
// the card in the message, its View window (every girl's details and
// documents) and "Add all to my Adal Keep" (profiles with their details
// first, then their documents). Also the window that sends profiles.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'

export const PROFILE_MIME = 'application/x-adal-profile'
export const isSharedProfile = (m) => m?.file_mime === PROFILE_MIME
/** The message's words without the line that carries the key. */
export const cleanBody = (body) => String(body || '').split('\n').filter(l => !/^\[adal-profile/.test(l)).join('\n')

const fileUrl = (id, i, n) => `/api/chat/profile/${id}/girl/${i}/file/${n}`
const SHOWN = [
  ['passport_number', 'Passport'], ['date_of_birth', 'Date of birth'], ['place_of_birth', 'Place of birth'],
  ['passport_issue_date', 'Passport issued'], ['passport_expiry_date', 'Passport expires'], ['gender', 'Sex'], ['nationality', 'Nationality'],
  ['religion', 'Religion'], ['marital_status', 'Marital status'], ['children_count', 'Children'], ['phone_number', 'Phone'],
  ['education_level', 'Education'], ['work_experience', 'Experience'], ['experience_country', 'Worked in'], ['job_title', 'Position'],
  ['salary', 'Salary'], ['height', 'Height'], ['weight', 'Weight'], ['emergency_name', 'Emergency contact'], ['emergency_phone', 'Emergency phone'],
  ['labor_id', 'Labour ID'], ['visa_number', 'Visa number'], ['employer_name', 'Employer'], ['status', 'Status'],
]
const label = (k) => (SHOWN.find(([c]) => c === k)?.[1]) || k.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())

export function SharedProfileCard({ m, mine }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="my-1 flex w-full items-center gap-3 rounded-lg bg-black/5 px-3 py-2 text-left hover:bg-black/10 dark:bg-white/10">
        <span className="text-2xl">🧑‍💼</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{String(m.file_name || 'Profiles').replace(/\.adalprofile$/, '')}</span>
          <span className="text-[11px] text-slate-500">{mine ? 'you sent them · View' : 'View · Add all to my Adal Keep'}</span>
        </span>
      </button>
      {open && <SharedProfileView id={m.id} onClose={() => setOpen(false)} />}
    </>
  )
}

function Girl({ id, g, open, onToggle }) {
  const nav = useNavigate()
  const [all, setAll] = useState(false)
  const p = g.profile || {}
  const rows = SHOWN.filter(([k]) => p[k] !== undefined && p[k] !== null && p[k] !== '')
  const extra = Object.keys(p).filter(k => k !== 'full_name' && !SHOWN.some(([c]) => c === k) && !/(_raw|_data|_ticks|_source|_at)$/.test(k))
  const groups = {}
  for (const f of g.documents) (groups[f.field] ||= []).push(f)
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-3 py-2 text-left">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{p.full_name || 'Profile'}</span>
          <span className="text-[11px] text-slate-500">{p.passport_number || 'no passport number'} · {g.documents.length} documents{g.documents.length ? (g.documents_ready === false ? ' (still on their way)' : '') : ''}</span>
        </span>
        {g.added ? <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">{g.added.done ? `✓ added · ${g.added.documents} docs` : '✓ profile made · documents next'}</span>
          : g.already_here ? <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">already here</span> : null}
        <span className="text-slate-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-3 py-2 dark:border-slate-800">
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {[...rows, ...(all ? extra.map(k => [k, label(k)]) : [])].map(([k, l]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1 dark:border-slate-800"><span className="text-slate-500">{l}</span><span className="text-right font-medium text-slate-800 dark:text-slate-100">{String(p[k])}</span></div>
            ))}
          </div>
          {extra.length > 0 && <button type="button" onClick={() => setAll(a => !a)} className="mt-1 text-xs font-semibold text-teal-700">{all ? 'Fewer details' : `All details (${extra.length} more)`}</button>}
          <div className="mt-2 space-y-2">
            {Object.entries(groups).map(([field, list]) => (
              <div key={field}>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{field}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {list.map(f => g.documents_ready === false
                    ? <span key={f.n} className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-slate-300 p-1 text-center text-[10px] text-slate-400">on its way</span>
                    : /^image\//.test(f.mimetype)
                      ? <a key={f.n} href={fileUrl(id, g.i, f.n)} target="_blank" rel="noreferrer"><img src={fileUrl(id, g.i, f.n)} alt={f.name} loading="lazy" className="h-20 w-20 rounded-lg border border-slate-200 object-cover" /></a>
                      : <a key={f.n} href={fileUrl(id, g.i, f.n)} target="_blank" rel="noreferrer" className="flex h-20 w-20 flex-col items-center justify-center rounded-lg border border-slate-200 p-1 text-center text-[10px] text-slate-600 hover:bg-slate-50"><span className="text-xl">📄</span><span className="line-clamp-2 break-all">{f.name}</span></a>)}
                </div>
              </div>
            ))}
          </div>
          {g.added && <button type="button" onClick={() => nav(`/profiles/${g.added.profile_id}`)} className="mt-2 text-xs font-semibold text-teal-700">Open her profile →</button>}
        </div>
      )}
    </div>
  )
}

export function SharedProfileView({ id, onClose }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [openGirl, setOpenGirl] = useState(0)
  const [job, setJob] = useState(null)
  const timer = useRef(null)
  const load = () => api.get(`/chat/profile/${id}`, { adalNoCache: true, timeout: 120000 }).then(r => { setD(r.data); if (r.data.job) setJob(r.data.job) }).catch(e => setErr(e.response?.data?.error || e.message))
  useEffect(() => { load(); return () => clearInterval(timer.current) }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  const follow = () => {
    clearInterval(timer.current)
    timer.current = setInterval(async () => {
      try {
        const r = await api.get(`/chat/profile/${id}/add`, { adalNoCache: true })
        setJob(r.data)
        if (r.data && !r.data.running) {
          clearInterval(timer.current); load()
          toast.success(`Added ${r.data.made} profile${r.data.made === 1 ? '' : 's'} with ${r.data.documents} documents`)
        }
      } catch {}
    }, 2500)
  }
  useEffect(() => { if (job?.running) follow() }, [job?.running]) // eslint-disable-line react-hooks/exhaustive-deps
  const addAll = async () => {
    try { const r = await api.post(`/chat/profile/${id}/add`, {}, { timeout: 120000 }); setJob(r.data); follow() }
    catch (e) { toast.error(e.response?.data?.error || e.message) }
  }
  const allAdded = d?.girls?.length && d.girls.every(g => g.added?.done)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">{d ? (d.girls.length === 1 ? d.girls[0].profile.full_name : `${d.girls.length} profiles`) : 'Profiles'}</h2>
            {d && <p className="text-xs text-slate-500">From {d.from} · transferred with every document · {new Date(d.sent_at).toLocaleString()}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 text-xl text-slate-400 hover:text-slate-700">×</button>
        </div>
        {err && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{err}</p>}
        {!d && !err && <p className="text-sm text-slate-500">Opening them…</p>}
        {d && (
          <>
            <div className="space-y-2">
              {d.girls.map(g => <Girl key={g.i} id={id} g={g} open={openGirl === g.i} onToggle={() => setOpenGirl(o => (o === g.i ? -1 : g.i))} />)}
            </div>
            {job && (
              <div className="mt-3 rounded-lg bg-teal-50 p-3 text-sm text-teal-800 dark:bg-teal-900/30 dark:text-teal-200">
                {job.running ? '⏳ ' : '✓ '}Profiles made: {job.made} of {job.total} · documents of {job.girls_done} of {job.total} girls ({job.documents} documents)
                {job.waiting ? ` · ${job.waiting} girls' documents are still on their way` : ''}
                {job.error ? ` · ${job.error}` : ''}
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              {d.mine ? <span className="text-sm text-slate-500">You sent them.</span>
                : allAdded ? <span className="text-sm font-semibold text-emerald-700">✓ All added to your Adal Keep</span>
                : <button type="button" disabled={job?.running} onClick={addAll} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                    {job?.running ? 'Adding — details first, then documents…' : d.girls.length === 1 ? 'Add to my Adal Keep' : `Add all ${d.girls.length} to my Adal Keep`}
                  </button>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Send profiles to another agency: they leave this agency once sent (to the Trash). */
export function SendProfilesDialog({ profileIds, onClose, onSent }) {
  const [agencies, setAgencies] = useState(null)
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState(null)   // the send, while its documents go
  const timer = useRef(null)
  useEffect(() => {
    Promise.all([api.get('/chat/agencies', { adalNoCache: true }), api.get('/chat/status', { adalNoCache: true }).catch(() => ({ data: {} }))])
      .then(([a, s]) => setAgencies((Array.isArray(a.data) ? a.data : []).filter(x => !x.is_admin && x.id !== s.data?.me?.id && !/\s·\s*branch PC \d{6}$/.test(x.name || ''))))
      .catch(e => { toast.error(e.response?.data?.error || 'The agencies could not be loaded (is this PC online?)'); setAgencies([]) })
    return () => clearInterval(timer.current)
  }, [])
  const send = async () => {
    setBusy(true)
    try {
      const r = await api.post('/chat/profile/send', { profile_ids: profileIds, to }, { timeout: 600000 })
      if (r.data.too_big?.length) toast.error(`Too big to send with documents: ${r.data.too_big.join(', ')} (only her details went; she stays here)`)
      const sendId = r.data.send_id
      setJob({ total: r.data.total, sent: 0, failed: [], running: true, to_name: r.data.to })
      timer.current = setInterval(async () => {
        try {
          const s = (await api.get('/chat/profile/sent', { adalNoCache: true })).data.find(x => x.send_id === sendId)
          if (!s) return
          setJob(s)
          if (!s.running) {
            clearInterval(timer.current)
            toast.success(`${s.sent} of ${s.total} sent to ${s.to_name} — they left your Adal Keep (in the Trash)`)
            onSent?.(s)
          }
        } catch {}
      }, 2000)
    } catch (e) { toast.error(e.response?.data?.error || e.message); setBusy(false) }
  }
  const byName = new Map()   // one agency on several accounts (a new PC): once, its newest
  for (const a of agencies || []) {
    const k = String(a.name || '').trim().toLowerCase()
    const had = byName.get(k)
    if (!had || String(a.last_seen || '') > String(had.last_seen || '')) byName.set(k, a)
  }
  const list = [...byName.values()].filter(a => !q || String(a.name).toLowerCase().includes(q.toLowerCase())).sort((x, y) => String(x.name).localeCompare(String(y.name)))
  const n = profileIds.length
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl dark:bg-slate-900" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">Send {n === 1 ? 'this profile' : `${n} profiles`} to another agency</h2>
        <p className="mt-1 text-xs text-slate-500">Her details go first, then every document, in your private chat with that agency (only that agency can open it).
          Once sent, {n === 1 ? 'she leaves' : 'they leave'} your Adal Keep (to the Trash, restorable).</p>
        {job ? (
          <div className="mt-4 rounded-lg bg-teal-50 p-3 text-sm text-teal-800 dark:bg-teal-900/30 dark:text-teal-200">
            <p className="font-semibold">{job.running ? '⏳ Sending their documents…' : '✓ Done'}</p>
            <p>{job.sent} of {job.total} sent to {job.to_name}{job.failed?.length ? ` · not sent (they stay here): ${job.failed.join(', ')}` : ''}</p>
            {job.girls && <div className="mt-2 max-h-40 overflow-y-auto text-xs">{job.girls.map(g => <div key={g.id} className="flex justify-between gap-2"><span className="truncate">{g.name}</span><span>{g.state === 'sent' ? '✓ sent' : g.state === 'failed' ? `✗ ${g.error || 'not sent'}` : g.state === 'sending' ? '…' : 'waiting'}</span></div>)}</div>}
            {!job.running && <button type="button" onClick={onClose} className="mt-2 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white">Close</button>}
          </div>
        ) : (
          <>
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
                {busy ? 'Sending…' : `Send ${n === 1 ? 'her' : `all ${n}`}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
