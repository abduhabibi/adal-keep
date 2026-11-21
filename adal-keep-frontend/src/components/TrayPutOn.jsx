/**
 * "Put on…": tray files onto a profile's field without dragging (the arrival
 * pop-up, the tray, a phone). A quick profile search, then her fields; the
 * files are added to that field (a full body photo is cropped first), and
 * leave the tray.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import Icon from './shared/Icon'
import FullBodyCropper from './FullBodyCropper'
import { useFileCapture } from '../context/FileCaptureContext'
import { tapMode } from '../lib/trayDrag'

let listCache = null // { at, rows }
function allProfiles() {
  if (listCache && Date.now() - listCache.at < 30000) return listCache.rows
  const rows = api.get('/profiles/brief').then(r => { if (!Array.isArray(r.data)) throw new Error('no brief'); return r.data })
    .catch(() => api.get('/profiles').then(r => (Array.isArray(r.data) ? r.data : r.data?.profiles || [])))
    .catch(() => [])
  listCache = { at: Date.now(), rows }
  return rows
}

/** The profile open on this page (/profiles/123), if any. */
const openProfileId = () => Number((location.pathname.match(/^\/profiles\/(\d+)/) || [])[1]) || null

const FIRST = ['Passport', 'Photo', 'Full Body Photo', 'ID Card', 'Medical', 'Yellow Card', 'COC', 'CV']

export default function TrayPutOn({ files, profile: given = null, onDone, onCancel, compact = false }) {
  const { removeFilesById } = useFileCapture()
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])
  const [profile, setProfile] = useState(given)
  const [fields, setFields] = useState(null)
  const [busy, setBusy] = useState(null) // field id being filled
  const [crop, setCrop] = useState(null) // { field, file }
  const inputRef = useRef(null)

  useEffect(() => {
    let alive = true
    Promise.resolve(allProfiles()).then(r => {
      if (!alive) return
      setRows(r)
      const here = openProfileId()
      if (!given && here) { const p = r.find(x => x.id === here); if (p) setProfile(p) }
    })
    return () => { alive = false }
  }, [])
  useEffect(() => { if (!profile && !tapMode()) setTimeout(() => inputRef.current?.focus(), 30) }, [profile])
  useEffect(() => {
    if (!profile?.id) return
    setFields(null)
    api.get(`/profiles/${profile.id}/fields`).then(r => setFields(Array.isArray(r.data) ? r.data : [])).catch(() => setFields([]))
  }, [profile?.id])

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = !s ? rows : rows.filter(p => `${p.full_name || ''} ${p.phone_number || ''} ${p.passport_number || ''} #${p.id}`.toLowerCase().includes(s))
    return list.slice(0, 40)
  }, [q, rows])

  const orderedFields = useMemo(() => {
    if (!fields) return []
    const rank = (n) => { const i = FIRST.indexOf(n); return i < 0 ? 99 : i }
    return [...fields].sort((a, b) => rank(a.name) - rank(b.name))
  }, [fields])

  const send = async (field, list) => {
    setBusy(field.id)
    const fd = new FormData()
    list.forEach(f => fd.append('files', f))
    try {
      await api.post(`/profiles/${profile.id}/fields/${field.id}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      removeFilesById(files.map(f => f.id))
      toast.success(`${list.length === 1 ? list[0].name : list.length + ' files'} → ${profile.full_name || 'profile'} · ${field.name}`)
      window.dispatchEvent(new CustomEvent('adal-fields-changed', { detail: { id: profile.id } }))
      onDone?.()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not put it there')
    } finally { setBusy(null) }
  }
  const putOn = (field) => {
    const pic = files.find(f => /^image\//.test(f.type || ''))
    if (field.name === 'Full Body Photo' && pic) { setCrop({ field, file: pic }); return }
    send(field, files)
  }

  const box = compact ? 'max-h-56' : 'max-h-[min(50vh,420px)]'
  return (
    <div className="flex min-h-0 flex-col gap-2" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel?.() } }}>
      <div className="flex items-center justify-between gap-2">
        <span className="ak-eyebrow">Put {files.length > 1 ? `${files.length} files` : 'it'} on…</span>
        <button type="button" onClick={onCancel} className="ak-icon-btn !h-8 !min-w-8 !p-0" aria-label="Back"><Icon name="close" size={16} /></button>
      </div>
      {!profile ? (
        <>
          <label className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3">
            <Icon name="search" size={16} className="ak-muted" />
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find her: name, phone, passport…"
              onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) setProfile(shown[0]) }}
              className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" />
          </label>
          <ul className={`${box} overflow-y-auto custom-scrollbar -mx-1`}>
            {shown.map(p => (
              <li key={p.id}>
                <button type="button" onClick={() => setProfile(p)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--glass-track)]">
                  <Icon name="user" size={16} className="ak-muted shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.full_name || `Profile #${p.id}`}</span>
                  <span className="shrink-0 text-xs ak-muted">{p.phone_number || `#${p.id}`}</span>
                </button>
              </li>
            ))}
            {!shown.length && <li className="px-2 py-3 text-sm ak-muted">{rows.length ? 'Nobody by that name' : 'Loading profiles…'}</li>}
          </ul>
        </>
      ) : (
        <>
          <button type="button" onClick={() => { if (!given) { setProfile(null); setFields(null) } }}
            className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left">
            <Icon name="user" size={16} className="shrink-0 text-[var(--primary)]" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{profile.full_name || `Profile #${profile.id}`}</span>
            {!given && <span className="text-xs font-medium text-[var(--primary)]">Change</span>}
          </button>
          <div className={`${box} grid grid-cols-2 gap-1.5 overflow-y-auto custom-scrollbar`}>
            {fields === null && <span className="col-span-2 px-2 py-3 text-sm ak-muted">Loading her fields…</span>}
            {fields?.length === 0 && <span className="col-span-2 px-2 py-3 text-sm ak-muted">No fields on this profile</span>}
            {orderedFields.map(f => (
              <button key={f.id} type="button" disabled={!!busy} onClick={() => putOn(f)}
                className={`flex min-h-[40px] items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${busy === f.id ? 'border-[var(--primary)] bg-[var(--primary-glow)]' : 'border-[var(--border)] hover:border-[var(--primary)] hover:bg-[var(--glass-track)]'} disabled:opacity-60`}>
                <span className="min-w-0 truncate font-medium">{f.name}</span>
                {busy === f.id ? <span className="text-xs ak-muted">…</span>
                  : f.files?.length ? <Icon name="check" size={14} className="shrink-0 text-emerald-600" /> : null}
              </button>
            ))}
          </div>
        </>
      )}
      {crop && createPortal(
        <div data-tray-keep="">
          <FullBodyCropper file={crop.file} onCancel={() => setCrop(null)}
            onDone={(f) => { const field = crop.field; setCrop(null); send(field, [f]) }} />
        </div>, document.body
      )}
    </div>
  )
}
