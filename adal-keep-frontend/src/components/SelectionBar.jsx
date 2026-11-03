/**
 * The Profiles page's ticked girls, in a bar on the right (at the bottom on a
 * phone), with what can be done for all of them at once:
 *   🛂 Make Tasheer · 🛡️ Make insurance · 🖨️ Print embassy (3 pages a girl).
 */
import { useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import { useAuth } from '../context/AuthContext'
import { printEmbassy } from '../lib/embassyPrint'

const err = (e) => e?.response?.data?.error || e.message

export default function SelectionBar({ picked, onRemove, onClear, onAllShown }) {
  const { company } = useAuth()
  const [busy, setBusy] = useState('')
  const [open, setOpen] = useState(true)

  // One run per girl, each in its own tab (or in line), as from her profile.
  const startAll = async (workflowId, name) => {
    if (!confirm(`${name} for ${picked.length} girl${picked.length === 1 ? '' : 's'}?`)) return
    setBusy(workflowId)
    let ok = 0
    const failed = []
    for (const p of picked) {
      try { await api.post(`/profiles/${p.id}/automations/${workflowId}/start`, {}); ok++ }
      catch (e) { failed.push(`${p.full_name}: ${err(e)}`) }
    }
    setBusy('')
    if (ok) toast.success(`${name}: ${ok} started`)
    if (failed.length) toast.error(failed.slice(0, 4).join('\n'), { duration: 10000 })
  }

  const print = async () => {
    setBusy('print')
    try {
      const got = await printEmbassy(picked.map(p => p.id), company || '')
      const lacking = got.filter(g => !g.contract || !g.payment || !g.application)
      if (lacking.length) toast(`Printed. Missing: ${lacking.map(g => `${g.name} (${[!g.contract && 'contract', !g.payment && 'payment page', !g.application && 'application number'].filter(Boolean).join(', ')})`).join('; ')}`, { icon: '⚠️', duration: 12000 })
    } catch (e) { toast.error(err(e)) }
    setBusy('')
  }

  const btn = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:opacity-50'
  return (
    <aside className="fixed inset-x-2 bottom-2 z-[60] flex max-h-[60vh] flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900 lg:inset-x-auto lg:bottom-3 lg:right-3 lg:top-20 lg:max-h-none lg:w-[19rem]">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <button type="button" onClick={() => setOpen(o => !o)} className="text-sm font-bold">
          ✓ {picked.length} selected <span className="text-slate-400 lg:hidden">{open ? '▾' : '▴'}</span>
        </button>
        <span className="flex gap-2 text-xs">
          <button type="button" onClick={onAllShown} className="text-teal-700 hover:underline dark:text-teal-400">+ all shown</button>
          <button type="button" onClick={onClear} className="text-slate-500 hover:underline">Clear</button>
        </span>
      </div>
      <div className={`${open ? '' : 'hidden lg:flex'} flex min-h-0 flex-1 flex-col`}>
        <div className="space-y-1.5 border-b border-slate-100 p-3 dark:border-slate-800">
          <button type="button" className={`${btn} bg-slate-100 text-slate-400 dark:bg-slate-800`} disabled
            title="The Tasheer run is not built yet — show Adal Keep the Tasheer site's steps and it will be">🛂 Make Tasheer <span className="ml-auto text-[10px] font-normal">coming</span></button>
          <button type="button" className={`${btn} bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/20 dark:text-amber-300`} disabled={!!busy}
            onClick={() => startAll('insurance_certificate', 'Insurance certificate')}>🛡️ {busy === 'insurance_certificate' ? 'Starting…' : 'Make insurance'}</button>
          <button type="button" className={`${btn} bg-teal-600 text-white hover:bg-teal-700`} disabled={!!busy}
            onClick={print} title="3 pages a girl: the contract's first page, the visa payment page, and the embassy form with the visa and application numbers as barcodes">
            🖨️ {busy === 'print' ? 'Preparing…' : 'Print embassy'} <span className="ml-auto text-[10px] font-normal opacity-80">{picked.length * 3} pages</span></button>
        </div>
        <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
          {picked.map(p => (
            <li key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
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
  )
}
