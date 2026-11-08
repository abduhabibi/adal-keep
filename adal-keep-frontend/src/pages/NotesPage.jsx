/**
 * Notes: one place for every note.
 *   - Write one in the box and press Enter (optionally about one person: type
 *     "@" and her name, or drop a profile on the box).
 *   - Tick it done, click it to change it, ✕ to delete (Undo brings it back).
 *   - Below: what is written in the checklists' note columns and on profiles,
 *     with the person and the list — click to open.
 * Everything follows changes made anywhere at once (lib/changes.js).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { onDataChange } from '../lib/changes'
import { isProfileDrag, profileCardsDropped } from '../lib/profileDrag'
import LangToggle from '../components/LangToggle'

const err = (e) => e?.response?.data?.error || e.message
const when = (t) => {
  if (!t) return ''
  const d = new Date(t), mins = (Date.now() - d) / 60000
  if (mins < 1) return 'now'
  if (mins < 60) return `${Math.floor(mins)} min ago`
  if (mins < 1440) return `${Math.floor(mins / 60)} h ago`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export default function NotesPage() {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [text, setText] = useState('')
  const [who, setWho] = useState(null)          // { id, full_name } the new note is about
  const [find, setFind] = useState('')
  const [tab, setTab] = useState('all')
  const [people, setPeople] = useState([])
  const [editing, setEditing] = useState(null)  // note id
  const [hot, setHot] = useState(false)
  const box = useRef(null)

  const load = () => api.get('/notes').then(r => setData(r.data)).catch(e => toast.error(err(e)))
  useEffect(() => {
    load()
    return onDataChange(['notes', 'checklist_cells', 'checklists', 'profiles'], load)
  }, [])

  // "@name" in the box: pick the person the note is about.
  const at = /@([^@\n]{1,40})$/.exec(text)?.[1]
  useEffect(() => {
    if (!at || at.length < 2) { setPeople([]); return }
    const t = setTimeout(() => api.get('/profiles', { params: { q: at } }).then(r => setPeople((r.data || []).slice(0, 6))).catch(() => {}), 200)
    return () => clearTimeout(t)
  }, [at])
  const pickPerson = (p) => { setWho({ id: p.id, full_name: p.full_name }); setText(text.replace(/@[^@\n]*$/, '')); setPeople([]); box.current?.focus() }

  const add = async (e) => {
    e?.preventDefault()
    const t = text.trim()
    if (!t) return
    try {
      await api.post('/notes', { text: t, profile_id: who?.id || null })
      setText(''); setWho(null)
      load()
    } catch (e2) { toast.error(err(e2)) }
  }
  const save = async (n, patch) => {
    setData(d => ({ ...d, notes: d.notes.map(x => x.id === n.id ? { ...x, ...patch } : x) }))
    try { await api.put(`/notes/${n.id}`, patch) } catch (e) { toast.error(err(e)); load() }
  }
  const remove = async (n) => {
    setData(d => ({ ...d, notes: d.notes.filter(x => x.id !== n.id) }))
    try {
      const r = await api.delete(`/notes/${n.id}`)
      toast((t) => (
        <span className="flex items-center gap-3 text-sm">Note deleted
          <button type="button" className="font-semibold text-teal-600" onClick={async () => {
            toast.dismiss(t.id)
            try { await api.post(`/notes/undo/${r.data.trash_id}`); load() } catch (e) { toast.error(err(e)) }
          }}>Undo</button>
        </span>
      ), { duration: 6000 })
    } catch (e) { toast.error(err(e)); load() }
  }

  const q = find.trim().toLowerCase()
  const has = (...s) => !q || s.some(x => String(x || '').toLowerCase().includes(q))
  const notes = useMemo(() => (data?.notes || []).filter(n => has(n.text, n.full_name, n.created_by)), [data, q])
  const fromLists = useMemo(() => (data?.checklists || []).filter(c => has(c.value, c.full_name, c.checklist_name, c.column)), [data, q])
  const fromProfiles = useMemo(() => (data?.profiles || []).filter(p => has(p.notes, p.full_name)), [data, q])
  const open = notes.filter(n => !n.done), done = notes.filter(n => n.done)
  const counts = { all: open.length + done.length + fromLists.length + fromProfiles.length, mine: open.length + done.length, lists: fromLists.length, profiles: fromProfiles.length }

  const onDrop = async (e) => {
    if (!isProfileDrag(e)) return
    e.preventDefault(); setHot(false)
    const [p] = profileCardsDropped(e)
    if (!p) return
    if (p.full_name) setWho(p)
    else api.get(`/profiles/${p.id}`).then(r => setWho({ id: p.id, full_name: r.data?.full_name || `#${p.id}` })).catch(() => {})
    box.current?.focus()
  }

  const tabBtn = (id, label) => (
    <button key={id} type="button" onClick={() => setTab(id)}
      className={`rounded-full px-3 py-1 text-xs font-semibold transition ${tab === id ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300'}`}>
      {label} <span className="opacity-70">{counts[id]}</span>
    </button>
  )

  return (
    <div className="mx-auto max-w-3xl animate-fade-up space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="font-display text-xl font-bold text-slate-800 dark:text-white">📝 Notes</h1>
        <LangToggle />
      </div>

      {/* Write */}
      <form onSubmit={add} onDragOver={(e) => { if (isProfileDrag(e)) { e.preventDefault(); setHot(true) } }} onDragLeave={() => setHot(false)} onDrop={onDrop}
        className={`panel relative p-3 transition ${hot ? 'ring-2 ring-teal-500' : ''}`}>
        {who && (
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-800 dark:bg-teal-900/30 dark:text-teal-200">
            👤 {who.full_name}
            <button type="button" onClick={() => setWho(null)} className="opacity-60 hover:opacity-100" aria-label="Not about her">✕</button>
          </div>
        )}
        <div className="flex gap-2">
          <textarea ref={box} rows={1} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !people.length) add(e) }}
            placeholder="Write a note, then Enter…   (@name: about a person)"
            className="min-h-[42px] flex-1 resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
          <button type="submit" disabled={!text.trim()} className="shrink-0 rounded-xl bg-teal-600 px-4 text-sm font-semibold text-white disabled:opacity-40">Add</button>
        </div>
        {people.length > 0 && (
          <ul className="absolute left-3 right-3 z-20 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
            {people.map(p => (
              <li key={p.id}><button type="button" onClick={() => pickPerson(p)} className="w-full px-3 py-2 text-left text-sm hover:bg-teal-50 dark:hover:bg-teal-900/30">
                {p.full_name} <span className="text-xs text-slate-400">{p.passport_number}</span></button></li>
            ))}
          </ul>
        )}
      </form>

      {/* Find */}
      <div className="flex flex-wrap items-center gap-2">
        <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="🔍 Search notes, names, lists…"
          className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
        <div className="flex gap-1.5">{tabBtn('all', 'All')}{tabBtn('mine', 'Notes')}{tabBtn('lists', 'Checklists')}{tabBtn('profiles', 'Profiles')}</div>
      </div>

      {!data && <p className="py-10 text-center text-sm text-slate-400">Loading…</p>}

      {data && (tab === 'all' || tab === 'mine') && (
        <ul className="space-y-1.5">
          {[...open, ...done].map(n => (
            <li key={n.id} className={`panel group flex items-start gap-3 px-3 py-2.5 ${n.done ? 'opacity-60' : ''}`}>
              <input type="checkbox" checked={!!n.done} onChange={(e) => save(n, { done: e.target.checked })} className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-teal-600" aria-label="Done" />
              <div className="min-w-0 flex-1">
                {editing === n.id ? (
                  <textarea autoFocus defaultValue={n.text} rows={2}
                    onBlur={(e) => { setEditing(null); const v = e.target.value.trim(); if (v && v !== n.text) save(n, { text: v }) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur() } if (e.key === 'Escape') setEditing(null) }}
                    className="w-full rounded-lg border border-teal-400 bg-white px-2 py-1 text-sm dark:bg-slate-900" />
                ) : (
                  <p onClick={() => setEditing(n.id)} className={`cursor-text whitespace-pre-wrap break-words text-sm text-slate-800 dark:text-slate-100 ${n.done ? 'line-through' : ''}`}>{n.text}</p>
                )}
                <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-slate-400">
                  {n.profile_id && <button type="button" onClick={() => navigate(`/profiles/${n.profile_id}`)} className="font-semibold text-teal-600 hover:underline dark:text-teal-400">👤 {n.full_name || `#${n.profile_id}`}</button>}
                  {n.created_by && <span>{n.created_by}</span>}
                  <span>{when(n.updated_at || n.created_at)}</span>
                </p>
              </div>
              <button type="button" onClick={() => remove(n)} className="shrink-0 rounded-md px-1.5 py-0.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10" aria-label="Delete">✕</button>
            </li>
          ))}
          {tab === 'mine' && !open.length && !done.length && <li className="py-8 text-center text-sm text-slate-400">No notes yet — write one above.</li>}
        </ul>
      )}

      {data && (tab === 'all' || tab === 'lists') && fromLists.length > 0 && (
        <section>
          <h2 className="mb-1.5 mt-4 text-xs font-bold uppercase tracking-wide text-slate-400">📋 In checklists</h2>
          <ul className="space-y-1.5">
            {fromLists.map(c => (
              <li key={`${c.checklist_id}-${c.profile_id}-${c.column}`} className="panel flex items-start gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="whitespace-pre-wrap break-words text-sm text-slate-800 dark:text-slate-100"><b className="text-slate-500">{c.column}:</b> {c.value}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px]">
                    <button type="button" onClick={() => navigate(`/profiles/${c.profile_id}`)} className="font-semibold text-teal-600 hover:underline dark:text-teal-400">👤 {c.full_name}</button>
                    <button type="button" onClick={() => navigate('/checklist')} className="text-slate-400 hover:underline">in “{c.checklist_name}”</button>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && (tab === 'all' || tab === 'profiles') && fromProfiles.length > 0 && (
        <section>
          <h2 className="mb-1.5 mt-4 text-xs font-bold uppercase tracking-wide text-slate-400">👤 On profiles</h2>
          <ul className="space-y-1.5">
            {fromProfiles.map(p => (
              <li key={p.profile_id} className="panel px-3 py-2">
                <button type="button" onClick={() => navigate(`/profiles/${p.profile_id}`)} className="text-xs font-semibold text-teal-600 hover:underline dark:text-teal-400">👤 {p.full_name}</button>
                <p className="whitespace-pre-wrap break-words text-sm text-slate-800 dark:text-slate-100">{p.notes}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && tab === 'all' && !counts.all && <p className="py-8 text-center text-sm text-slate-400">No notes yet — write one above.</p>}
    </div>
  )
}
