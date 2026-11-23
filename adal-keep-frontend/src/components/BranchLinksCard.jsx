/**
 * Settings → Branches: link another agency as a branch — no second password.
 * Search it by name → Connect → they press "Yes, it is me" and tell you the
 * 6-digit code they see → type it → linked both ways, profile summaries
 * shared (backend services/branchLinks.js, adal-admin/supabase/branch-links.sql).
 */
import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'
import { useCan } from '../lib/staffPerms'
import { onDataChange } from '../lib/changes'

const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm'
const err = (e) => e?.response?.data?.error || e.message
const where = (a) => a.city ? `${a.name} · ${a.city}` : a.name

function Countdown({ until }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const s = Math.max(0, Math.round((new Date(until) - now) / 1000))
  return s ? <span>valid {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')} more</span> : <span className="text-red-600">expired — press again for a new one</span>
}

/** Asked of us: "X wants to link as your branch" → Yes, it is me (the code) / No. */
function Asked({ r, onDone, can }) {
  const [code, setCode] = useState(null)
  const [busy, setBusy] = useState(false)
  const yes = async () => {
    setBusy(true)
    try { setCode((await api.post(`/branch-links/requests/${r.id}/yes`)).data) } catch (e) { toast.error(err(e)) }
    setBusy(false)
  }
  const no = async () => {
    try { await api.post(`/branch-links/requests/${r.id}/no`); onDone() } catch (e) { toast.error(err(e)) }
  }
  return (
    <li className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 text-sm space-y-2">
      <p><b>{where(r)}</b> wants to link as your branch.</p>
      {code ? (
        <div>
          <p className="text-slate-600 dark:text-slate-300">Tell them this code (by phone or in person). They type it in their Settings → Branches:</p>
          <p className="my-1 font-mono text-3xl font-extrabold tracking-[0.3em] text-teal-700 dark:text-teal-300">{code.code}</p>
          <p className="text-xs text-slate-500">Works once, <Countdown until={code.until} />. <button type="button" className="text-teal-700 underline" onClick={yes} disabled={busy}>New code</button></p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={yes} disabled={busy || !can}>{busy ? 'Making the code…' : 'Yes, it is me'}</Button>
          <Button size="sm" variant="secondary" onClick={no} disabled={!can}>No, not us</Button>
        </div>
      )}
    </li>
  )
}

/** What we asked: waiting for their Yes, then the code box. */
function Sent({ r, onDone, can }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const verify = async (e) => {
    e.preventDefault()
    setBusy(true)
    try { await api.post(`/branch-links/requests/${r.id}/verify`, { code }); toast.success(`Linked with ${r.name}`); onDone() }
    catch (e) { toast.error(err(e), { duration: 7000 }); setCode(''); onDone() }
    setBusy(false)
  }
  const again = async () => {
    try { await api.post('/branch-links/connect', { agency_id: r.agencyId }); toast.success(`Asked ${r.name} again`); onDone() } catch (e) { toast.error(err(e)) }
  }
  const ended = { denied: 'They said No.', expired: 'The code ran out (10 minutes).', failed: 'Too many wrong codes.' }[r.status]
  return (
    <li className="rounded-xl border border-slate-200 dark:border-slate-700 p-3 text-sm space-y-2">
      <p><b>{where(r)}</b> — {ended || (r.status === 'shown' ? 'they pressed "Yes, it is me". Type the code they tell you:' : 'waiting for them to press "Yes, it is me" in their Settings → Branches.')}</p>
      {!ended && (
        <form onSubmit={verify} className="flex flex-wrap gap-2">
          <input value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code"
            placeholder="6-digit code" aria-label="The 6-digit code" className={`${field} max-w-[11rem] font-mono tracking-widest text-center`} />
          <Button size="sm" type="submit" disabled={busy || code.length !== 6 || !can}>{busy ? 'Checking…' : 'Verify'}</Button>
        </form>
      )}
      {ended && <Button size="sm" variant="secondary" onClick={again} disabled={!can}>Connect again</Button>}
    </li>
  )
}

function Linked({ l, onDone, can }) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState(null)
  const show = async () => {
    const o = !open
    setOpen(o)
    if (o) { setList(null); try { setList((await api.get(`/branch-links/${l.id}/profiles`)).data) } catch (e) { setList({ error: err(e) }) } }
  }
  const share = async (on) => {
    try { await api.post(`/branch-links/${l.id}/share`, { on }); onDone() } catch (e) { toast.error(err(e)) }
  }
  const unlink = async () => {
    if (!window.confirm(`Unlink ${l.name}? You both stop seeing each other's profiles at once. You can link again later with a new code.`)) return
    try { await api.post(`/branch-links/${l.id}/unlink`); toast.success(`Unlinked ${l.name}`); onDone() } catch (e) { toast.error(err(e)) }
  }
  return (
    <li className="rounded-xl border border-teal-200 dark:border-teal-800 p-3 text-sm space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold flex-1 min-w-[10rem]">{where(l)}</span>
        <span className="rounded-full bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200 px-2 py-0.5 text-xs font-semibold">✓ Connected</span>
        <Button size="sm" variant="secondary" onClick={unlink} disabled={!can}>Unlink</Button>
      </div>
      <p className="text-xs text-slate-500">
        Linked {new Date(l.since).toLocaleDateString()}.{' '}
        {l.theyShare
          ? <button type="button" className="text-teal-700 dark:text-teal-300 underline" onClick={show}>{open ? 'Hide' : 'See'} their profiles{l.profiles != null ? ` (${l.profiles})` : ''}</button>
          : 'They do not share their profiles now.'}
        {l.updated && <> · updated {new Date(l.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>}
      </p>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={l.iShare} disabled={!can} onChange={e => share(e.target.checked)} />
        Share our profiles with them (name, passport number, stage, status — never documents or passwords)
      </label>
      {open && (
        list === null ? <p className="text-xs text-slate-500">Loading…</p>
          : list.error ? <p className="text-xs text-red-600">{list.error}</p>
          : !list.profiles.length ? <p className="text-xs text-slate-500">No profiles yet.</p>
          : <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 dark:bg-slate-800 text-slate-500"><tr><th className="text-start p-1.5">Name</th><th className="text-start p-1.5">Passport</th><th className="text-start p-1.5">Stage</th><th className="text-start p-1.5">Status</th></tr></thead>
                <tbody>{list.profiles.map(p => (
                  <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="p-1.5">{p.name || '—'}</td><td className="p-1.5 font-mono">{p.passport || '—'}</td><td className="p-1.5">{p.stage || '—'}</td><td className="p-1.5">{p.status || '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
      )}
    </li>
  )
}

export default function BranchLinksCard() {
  const can = useCan('change_settings')
  const [st, setSt] = useState(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [found, setFound] = useState(null)
  const [city, setCity] = useState(null)
  const asking = useRef(0)

  const load = () => api.get('/branch-links', { adalNoCache: true }).then(r => { setSt(r.data); setError(''); setCity(c => c ?? r.data.city ?? '') }).catch(e => setError(err(e)))
  useEffect(() => {
    load()
    const t = setInterval(load, 10000)
    const off = onDataChange(['branches', 'notifications'], load)
    return () => { clearInterval(t); off() }
  }, [])
  useEffect(() => {
    const text = q.trim()
    if (text.length < 2) { setFound(null); return }
    const n = ++asking.current
    const t = setTimeout(() => api.get('/branch-links/search', { params: { q: text } })
      .then(r => n === asking.current && setFound(r.data)).catch(e => n === asking.current && setFound({ error: err(e) })), 350)
    return () => clearTimeout(t)
  }, [q])

  const connect = async (a) => {
    try { await api.post('/branch-links/connect', { agency_id: a.id }); toast.success(`Asked ${a.name}. They press "Yes, it is me" and tell you a 6-digit code.`, { duration: 7000 }); setQ(''); load() }
    catch (e) { toast.error(err(e)) }
  }
  const saveCity = async () => {
    try { await api.post('/branch-links/city', { city }); toast.success('City saved') } catch (e) { toast.error(err(e)) }
  }
  const linkedIds = new Set((st?.links || []).map(l => l.id))
  const waitingIds = new Set((st?.outbox || []).filter(r => ['pending', 'shown'].includes(r.status)).map(r => r.agencyId))

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1">Branches</h2>
      <p className="text-sm text-slate-500 mb-4">
        Link your other branches. Search the branch by its name and press <b>Connect</b>. The branch presses
        <b> “Yes, it is me”</b> in its Settings → Branches and tells you the 6-digit code it sees; you type it here.
        No extra password — every agency keeps its own.
      </p>

      {error && <p className="mb-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 px-3 py-2 text-sm">{error}</p>}

      {st?.inbox?.length > 0 && (
        <ul className="space-y-2 mb-4">{st.inbox.map(r => <Asked key={r.id} r={r} onDone={load} can={can} />)}</ul>
      )}

      {st && (
        <>
          <h3 className="font-semibold text-sm mb-2">Your branches</h3>
          {st.links.length
            ? <ul className="space-y-2 mb-4">{st.links.map(l => <Linked key={l.id} l={l} onDone={load} can={can} />)}</ul>
            : <p className="text-sm text-slate-500 mb-4">None linked yet.</p>}

          {st.outbox.length > 0 && (
            <>
              <h3 className="font-semibold text-sm mb-2">Asked by you</h3>
              <ul className="space-y-2 mb-4">{st.outbox.filter(r => !linkedIds.has(r.agencyId)).map(r => <Sent key={r.id} r={r} onDone={load} can={can} />)}</ul>
            </>
          )}
        </>
      )}

      <h3 className="font-semibold text-sm mb-2">Add a branch</h3>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search agencies by name…" aria-label="Search agencies by name" className={field} />
      {found?.error && <p className="mt-2 text-sm text-red-600">{found.error}</p>}
      {Array.isArray(found) && (
        found.length
          ? <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">{found.map(a => (
              <li key={a.id} className="flex items-center gap-2 py-2 text-sm">
                <span className="flex-1"><b>{a.name}</b>{a.city && <span className="text-slate-500"> · {a.city}</span>}</span>
                {a.linked || linkedIds.has(a.id)
                  ? <span className="text-xs font-semibold text-teal-700">✓ Connected</span>
                  : <Button size="sm" onClick={() => connect(a)} disabled={!can}>{waitingIds.has(a.id) ? 'Ask again' : 'Connect'}</Button>}
              </li>
            ))}</ul>
          : <p className="mt-2 text-sm text-slate-500">No agency with that name.</p>
      )}

      {st && (
        <div className="mt-4 border-t border-slate-200 dark:border-slate-700 pt-3">
          <label className="block text-sm text-slate-600 dark:text-slate-300 mb-1">Your city (shown beside your name when a branch searches)</label>
          <div className="flex gap-2">
            <input value={city ?? ''} onChange={e => setCity(e.target.value)} maxLength={60} placeholder="e.g. Addis Ababa" className={field} />
            <Button size="sm" variant="secondary" onClick={saveCity} disabled={!can}>Save</Button>
          </div>
        </div>
      )}
    </Card>
  )
}
