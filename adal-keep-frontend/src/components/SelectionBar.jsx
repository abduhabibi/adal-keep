/**
 * The Profiles page's ticked girls, in a bar on the right (at the bottom on a
 * phone), with what can be done for all of them at once:
 *   🛂 Make Tasheer (one group appointment) · 📥 Excel download (name, labour ID, passport; other formats under it) · 🛡️ Make insurance · 🖨️ Print embassy (2 pages a girl) ·
 *   📋 Make a checklist of them (found later on the Checklists page).
 * Every button first checks each girl has what it needs: the ones who do go
 * ahead; the others slide up in a list with what they lack (also shown on
 * their cards), with a link to each one's profile.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { useAuth } from '../context/AuthContext'
import { loadEmbassy, printEmbassy } from '../lib/embassyPrint'
import { dragProfiles } from '../lib/profileDrag'
import WhatsAppSendPicked from './WhatsAppSendPicked'
import { SendProfilesDialog } from './SharedProfile'
import { FORMATS, downloadTable } from '../lib/tableExport'

const err = (e) => e?.response?.data?.error || e.message

/** The girls who lack something: slides up from the bottom. */
function MissingSheet({ sheet, onClose }) {
  const navigate = useNavigate()
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/30" onClick={onClose}>
      <div className="solid-sheet w-full max-w-2xl rounded-t-2xl border border-slate-200 shadow-2xl animate-slide-up dark:border-slate-700" onClick={e => e.stopPropagation()}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <div>
            <p className="font-bold">{sheet.title}</p>
            <p className="text-xs text-slate-500">{sheet.done}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">✕</button>
        </div>
        <ul className="max-h-[50vh] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
          {sheet.rows.map(({ p, missing }, i) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 animate-fade-up" style={{ animationDelay: `${Math.min(i, 10) * 50}ms` }}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{p.full_name}</span>
                <span className="mt-0.5 flex flex-wrap gap-1">
                  {missing.map(m => <span key={m} className="rounded-md bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700 ring-1 ring-red-200 dark:bg-red-900/20 dark:text-red-300 dark:ring-red-800">✗ {m}</span>)}
                </span>
              </span>
              <button type="button" onClick={() => { onClose(); navigate(`/profiles/${p.id}`) }}
                className="shrink-0 rounded-lg border border-teal-300 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50 dark:border-teal-700 dark:text-teal-300 dark:hover:bg-teal-900/20">Open profile →</button>
            </li>
          ))}
        </ul>
        {sheet.anyway && (
          <div className="border-t border-slate-100 px-4 py-3 text-right dark:border-slate-800">
            <button type="button" onClick={() => { onClose(); sheet.anyway() }} className="text-xs font-semibold text-slate-600 underline dark:text-slate-300">{sheet.anywayLabel}</button>
          </div>
        )}
      </div>
    </div>,
    document.body)
}

export default function SelectionBar({ picked, onRemove, onClear, onAllShown, onLacking }) {
  const { company } = useAuth()
  const [busy, setBusy] = useState('')
  const [open, setOpen] = useState(true)
  const [sheet, setSheet] = useState(null)
  const [naming, setNaming] = useState(null) // the checklist panel is open: the new one's name, while typed
  const [messaging, setMessaging] = useState(false) // the WhatsApp message panel is open
  const [sharing, setSharing] = useState(false) // sending them to another agency
  const [exporting, setExporting] = useState(false) // the download formats are shown
  const [lists, setLists] = useState(null)     // the checklists already made (to add the selected to)
  const navigate = useNavigate()
  const openLists = () => {
    if (naming != null) { setNaming(null); return }
    setNaming('')
    api.get('/checklists').then(r => setLists((r.data || []).map(c => ({ id: c.id, name: c.name, count: c.profiles?.length || 0, has: new Set((c.profiles || []).map(p => p.id)) })))).catch(() => setLists([]))
  }
  const opened = (t, text) => toast.success((x) => (
    <span className="flex items-center gap-3">{text}
      <button type="button" className="font-semibold text-teal-600" onClick={() => { toast.dismiss(x.id); navigate('/checklist') }}>Open</button>
    </span>
  ), { id: t, duration: 6000 })
  const addTo = async (c) => {
    setBusy('checklist')
    try {
      const r = await api.post(`/checklists/${c.id}/profiles`, { profile_ids: picked.map(p => p.id) })
      const n = r.data?.added ?? picked.length
      setNaming(null)
      opened(undefined, n ? `${n} added to “${c.name}”` : `They are all in “${c.name}” already`)
    } catch (e2) { toast.error(err(e2)) }
    setBusy('')
  }

  const makeChecklist = async (e) => {
    e.preventDefault()
    const name = (naming || '').trim()
    if (!name) return
    setBusy('checklist')
    try {
      await api.post('/checklists', { name, profile_ids: picked.map(p => p.id) })
      setNaming(null)
      opened(undefined, `Checklist “${name}” made with ${picked.length}`)
    } catch (e2) { toast.error(err(e2)) }
    setBusy('')
  }

  const showLacking = (title, done, rows, extra = {}) => {
    onLacking?.(Object.fromEntries(rows.map(r => [r.p.id, r.missing])))
    if (rows.length) setSheet({ title, done, rows, ...extra })
  }

  // One run per girl. The server checks each one before it starts (the same
  // check as on her profile): those that lack something are listed, not started.
  const startAll = async (workflowId, name) => {
    if (['insurance_certificate', 'tasheer_schedule'].includes(workflowId) && picked.length > 1) return insureTogether(name, workflowId)
    setBusy(workflowId)
    let ok = 0
    const rows = []
    for (const p of picked) {
      try { await api.post(`/profiles/${p.id}/automations/${workflowId}/start`, {}); ok++ }
      catch (e) { rows.push({ p, missing: e?.response?.data?.missing?.length ? e.response.data.missing : [err(e)] }) }
    }
    setBusy('')
    if (ok) toast.success(`${name}: started for ${ok} girl${ok === 1 ? '' : 's'}`)
    showLacking(`${name}: ${rows.length} not started — they lack something`, ok ? `Started for the ${ok} who have everything.` : 'Nobody had everything yet.', rows)
  }

  // Make insurance for several: ONE FetaP certificate with all of them as
  // members (Number Of Insured = how many). The first who has everything leads.
  const insureTogether = async (name, workflowId = 'insurance_certificate') => {
    const tasheer = workflowId === 'tasheer_schedule'
    setBusy(workflowId)
    const rows = []
    let started = null
    for (const p of picked) {
      try {
        const r = await api.post(`/profiles/${p.id}/automations/${workflowId}/start`, { group_ids: picked.map(x => x.id) })
        started = r.data
        for (const s of r.data?.skipped || []) { const q = picked.find(x => x.id === s.id); if (q) rows.push({ p: q, missing: s.missing }) }
        break
      } catch (e) { rows.push({ p, missing: e?.response?.data?.missing?.length ? e.response.data.missing : [err(e)] }) }
    }
    setBusy('')
    if (started) toast.success(tasheer ? `${name}: one group appointment for ${started.members || 1} — sign in when it rings, then pick the day and time.` : `${name}: one certificate for ${started.members || 1} — Adal Keep fills each and presses Add Member, then tells you.`, { duration: 8000 })
    const once = [...new Map(rows.map(r => [r.p.id, r])).values()]
    showLacking(`${name}: ${once.length} not ${tasheer ? 'in the appointment' : 'on the certificate'} — they lack something`, started ? `${tasheer ? 'In the appointment' : 'On the certificate'}: ${started.members || 1}.` : 'Nobody had everything yet.', once)
  }

  const print = async () => {
    setBusy('print')
    try {
      const loaded = await loadEmbassy(picked.map(p => p.id))
      const ready = loaded.girls.filter(x => !x.missing.length).map(x => x.g)
      const rows = loaded.girls.filter(x => x.missing.length).map(x => ({ p: x.g.profile, missing: x.missing }))
      if (ready.length) await printEmbassy(loaded, ready, company || '')
      showLacking(`Print embassy: ${rows.length} not printed — they lack something`,
        ready.length ? `Printed for the ${ready.length} who have everything (${ready.length} page${ready.length === 1 ? "" : "s"}).` : 'Nobody had everything yet.',
        rows)
    } catch (e) { toast.error(err(e)) }
    setBusy('')
  }

  const download = async (format) => {
    try {
      const day = new Date().toISOString().slice(0, 10)
      await downloadTable(format, {
        title: `Selected (${picked.length}) — ${day}`,
        head: ['No.', 'Name', 'Labour ID', 'Passport'],
        rows: picked.map((p, i) => [String(i + 1), p.full_name || '', p.labor_id || '', p.passport_number || '']),
        name: `Selected_${picked.length}_${day}`,
      })
    } catch (e) { toast.error(err(e)) }
  }

  const btn = 'flex w-full items-center gap-1 rounded-lg px-2 py-2 text-xs font-semibold leading-tight transition disabled:opacity-50 lg:gap-2 lg:px-3 lg:text-sm'
  return (
    <>
    <aside className="solid-sheet fixed inset-x-2 bottom-2 z-[60] flex flex-col rounded-2xl border border-slate-200 shadow-2xl dark:border-slate-700 lg:inset-x-auto lg:bottom-3 lg:right-3 lg:top-20 lg:max-h-none lg:w-[19rem]">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <button type="button" onClick={() => setOpen(o => !o)} className="text-sm font-bold cursor-grab" draggable
          onDragStart={(e) => dragProfiles(e, picked)} title="Drag all of them onto a checklist or the tray">
          ✓ {picked.length} selected <span className="text-slate-400 lg:hidden">{open ? '▾' : '▴'}</span>
        </button>
        <span className="flex gap-2 text-xs">
          <button type="button" onClick={onAllShown} className="text-teal-700 hover:underline dark:text-teal-400">+ all shown</button>
          <button type="button" onClick={onClear} className="text-slate-500 hover:underline">Clear</button>
        </span>
      </div>
      <div className={`${open ? '' : 'hidden lg:flex'} flex min-h-0 flex-1 flex-col`}>
        <div className="grid grid-cols-2 gap-1.5 border-b border-slate-100 p-2 dark:border-slate-800 lg:grid-cols-1 lg:p-3">
          <button type="button" className={`${btn} bg-sky-50 text-sky-800 hover:bg-sky-100 dark:bg-sky-900/30 dark:text-sky-300`} disabled={!!busy}
            onClick={() => startAll('tasheer_schedule', 'Tasheer')} title="One group appointment on Tasheer for all of them (only those whose visa is made)">🛂 {busy === 'tasheer_schedule' ? 'Checking and starting…' : 'Make Tasheer'} <span className="ml-auto hidden text-[10px] font-normal opacity-80 lg:inline">group</span></button>
          <button type="button" className={`${btn} bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-300`} disabled={!!busy}
            onClick={() => startAll('insurance_certificate', 'Insurance certificate')}>🛡️ {busy === 'insurance_certificate' ? 'Checking and starting…' : 'Make insurance'}</button>
          <button type="button" className={`${btn} bg-teal-600 text-white hover:bg-teal-700`} disabled={!!busy}
            onClick={print} title="2 pages a girl: the contract's first page and the embassy form with the visa and application numbers as barcodes">
            🖨️ {busy === 'print' ? 'Checking…' : 'Print embassy'} <span className="ml-auto hidden text-[10px] font-normal opacity-80 lg:inline">{picked.length * 2} pages</span></button>
          <button type="button" className={`${btn} bg-indigo-50 text-indigo-800 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-300`} disabled={!!busy}
            onClick={openLists}>📋 {busy === 'checklist' ? 'Saving…' : 'Checklist'} <span className="ml-auto hidden text-[10px] font-normal opacity-80 lg:inline">new or add</span></button>
          <button type="button" className={`${btn} bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-300`} disabled={!!busy}
            onClick={() => setMessaging(m => !m)}>💬 WhatsApp <span className="ml-auto hidden text-[10px] font-normal opacity-80 lg:inline">send CVs</span></button>
          {messaging && <WhatsAppSendPicked picked={picked} onClose={() => setMessaging(false)} />}
          {import.meta.env.VITE_DEMO !== '1' && <button type="button" className={`${btn} bg-violet-50 text-violet-800 hover:bg-violet-100 dark:bg-violet-900/30 dark:text-violet-300`} disabled={!!busy}
            onClick={() => setSharing(true)}>🏢 Another agency <span className="ml-auto hidden text-[10px] font-normal opacity-80 lg:inline">send or transfer</span></button>}
          {sharing && <SendProfilesDialog profileIds={picked.map(p => p.id)} onClose={() => setSharing(false)} />}
          <button type="button" className={`${btn} bg-lime-50 text-lime-800 hover:bg-lime-100 dark:bg-lime-900/30 dark:text-lime-300`}
            onClick={() => { setExporting(true); download('xlsx') }} title="No. · Name · Labour ID · Passport of the selected">📥 Excel download <span className="ml-auto hidden text-[10px] font-normal opacity-80 lg:inline">no. · name · labour ID · passport</span></button>
          <div className="col-span-2 lg:col-span-1">
            <button type="button" onClick={() => setExporting(x => !x)} className="px-1 text-[11px] text-slate-500 hover:underline">{exporting ? '▾' : '▸'} Other formats</button>
            {exporting && (
              <div className="mt-1 flex flex-wrap gap-1">
                {FORMATS.map(fm => (
                  <button key={fm} type="button" onClick={() => download(fm)}
                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold uppercase text-slate-700 hover:border-lime-400 hover:bg-lime-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">{fm}</button>
                ))}
              </div>
            )}
          </div>
          {naming != null && (
            <div className="col-span-2 space-y-2 rounded-xl border border-indigo-200 bg-indigo-50/50 p-2 dark:border-indigo-800 dark:bg-indigo-900/20 lg:col-span-1">
              <form onSubmit={makeChecklist} className="flex gap-1.5">
                <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="New checklist name"
                  onKeyDown={(e) => { if (e.key === 'Escape') setNaming(null) }}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900" />
                <button type="submit" disabled={!naming.trim() || !!busy} className="shrink-0 rounded-lg bg-indigo-600 px-3 text-sm font-semibold text-white disabled:opacity-50">Make</button>
              </form>
              {lists === null ? <p className="text-xs text-slate-400">Loading the checklists…</p> : lists.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">or add them to</p>
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {lists.map(c => {
                      const already = picked.every(p => c.has.has(p.id))
                      return (
                        <button key={c.id} type="button" disabled={!!busy || already} onClick={() => addTo(c)}
                          className="flex w-full items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-left text-sm hover:bg-indigo-100 disabled:opacity-50 dark:bg-slate-900 dark:hover:bg-indigo-900/40">
                          <span className="min-w-0 truncate font-medium">{c.name}</span>
                          <span className="shrink-0 text-[11px] text-slate-400">{already ? 'all in it' : `${c.count} in it · ＋`}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {/* On a phone the list stays about 3 names high and scrolls, so the
            cards above stay free to tick more. */}
        <ul className="max-h-[7.5rem] min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto overscroll-contain dark:divide-slate-800 lg:max-h-none">
          {picked.map(p => (
            <li key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-grab" draggable onDragStart={(e) => dragProfiles(e, p)}>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{p.full_name}</span>
                <span className="text-slate-500">{p.passport_number || '—'}</span>
              </span>
              <button type="button" onClick={() => onRemove(p)} className="rounded px-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800" title="Take out">✕</button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
    {sheet && <MissingSheet sheet={sheet} onClose={() => setSheet(null)} />}
    </>
  )
}
