/**
 * The Profiles page's ticked girls, in a bar on the right (at the bottom on a
 * phone), with what can be done for all of them at once:
 *   🛂 Make Tasheer · 🛡️ Make insurance · 🖨️ Print embassy (2 pages a girl) ·
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
import { isPhoneApp } from '../lib/phoneMode'

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
  const [naming, setNaming] = useState(null) // the new checklist's name, while typed
  const navigate = useNavigate()

  const makeChecklist = async (e) => {
    e.preventDefault()
    const name = (naming || '').trim()
    if (!name) return
    setBusy('checklist')
    try {
      await api.post('/checklists', { name, profile_ids: picked.map(p => p.id) })
      setNaming(null)
      toast.success((t) => (
        <span className="flex items-center gap-3">Checklist “{name}” made with {picked.length}
          <button type="button" className="font-semibold text-teal-600" onClick={() => { toast.dismiss(t.id); navigate('/checklist') }}>Open</button>
        </span>
      ), { duration: 6000 })
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

  const print = async () => {
    setBusy('print')
    try {
      const loaded = await loadEmbassy(picked.map(p => p.id))
      const ready = loaded.girls.filter(x => !x.missing.length).map(x => x.g)
      const rows = loaded.girls.filter(x => x.missing.length).map(x => ({ p: x.g.profile, missing: x.missing }))
      if (ready.length) await printEmbassy(loaded, ready, company || '')
      showLacking(`Print embassy: ${rows.length} not printed — they lack something`,
        ready.length ? `Printed for the ${ready.length} who have everything (${ready.length * 2} pages).` : 'Nobody had everything yet.',
        rows, {
          anywayLabel: `Print these ${rows.length} anyway (what is missing is left as a marked gap)`,
          anyway: () => printEmbassy(loaded, rows.map(r => loaded.girls.find(x => x.g.profile.id === r.p.id).g), company || '').catch(e => toast.error(err(e))),
        })
    } catch (e) { toast.error(err(e)) }
    setBusy('')
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
          {!isPhoneApp() && <><button type="button" className={`${btn} bg-slate-100 text-slate-400 dark:bg-slate-800`} disabled
            title="The Tasheer run is not built yet — show Adal Keep the Tasheer site's steps and it will be">🛂 Make Tasheer <span className="ml-auto hidden text-[10px] font-normal lg:inline">coming</span></button>
          <button type="button" className={`${btn} bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-300`} disabled={!!busy}
            onClick={() => startAll('insurance_certificate', 'Insurance certificate')}>🛡️ {busy === 'insurance_certificate' ? 'Checking and starting…' : 'Make insurance'}</button></>}
          <button type="button" className={`${btn} bg-teal-600 text-white hover:bg-teal-700`} disabled={!!busy}
            onClick={print} title="2 pages a girl: the contract's first page and the embassy form with the visa and application numbers as barcodes">
            🖨️ {busy === 'print' ? 'Checking…' : 'Print embassy'} <span className="ml-auto hidden text-[10px] font-normal opacity-80 lg:inline">{picked.length * 2} pages</span></button>
          <button type="button" className={`${btn} bg-indigo-50 text-indigo-800 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-300`} disabled={!!busy}
            onClick={() => setNaming(naming == null ? '' : null)}>📋 {busy === 'checklist' ? 'Making…' : 'Make checklist'}</button>
          {naming != null && (
            <form onSubmit={makeChecklist} className="col-span-2 flex gap-1.5 lg:col-span-1">
              <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Checklist name"
                onKeyDown={(e) => { if (e.key === 'Escape') setNaming(null) }}
                className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900" />
              <button type="submit" disabled={!naming.trim() || !!busy} className="rounded-lg bg-indigo-600 px-3 text-sm font-semibold text-white disabled:opacity-50">Save</button>
            </form>
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
