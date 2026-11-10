/**
 * Profile → 🖨 Print for embassy: her embassy page (lib/embassyPrint.js). What
 * she still lacks is said first; it can be printed anyway.
 */
import { useState } from 'react'
import toast from 'react-hot-toast'
import { loadEmbassy, printEmbassy } from '../lib/embassyPrint'
import { useAuth } from '../context/AuthContext'

const err = (e) => e?.response?.data?.error || e.message

export default function EmbassyPrintButton({ profile }) {
  const { company } = useAuth()
  const [busy, setBusy] = useState(false)
  const print = async () => {
    setBusy(true)
    try {
      const loaded = await loadEmbassy([profile.id])
      const one = loaded.girls[0]
      if (!one) throw new Error('Nothing to print')
      if (one.missing.length && !window.confirm(`${profile.full_name} still lacks: ${one.missing.join(', ')}.\n\nPrint anyway (what is missing stays empty)?`)) { setBusy(false); return }
      await printEmbassy(loaded, [one.g], company || '')
    } catch (e) { toast.error(err(e)) }
    setBusy(false)
  }
  return (
    <button type="button" onClick={print} disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-sm font-semibold text-sky-800 hover:bg-sky-50 disabled:opacity-50 dark:border-sky-800 dark:bg-slate-900 dark:text-sky-300">
      🖨 {busy ? 'Preparing…' : 'Print for embassy'}
    </button>
  )
}
