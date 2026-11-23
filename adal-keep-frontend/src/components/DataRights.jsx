import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { useCan } from '../lib/staffPerms'

/**
 * Data protection on a candidate's page: "Download her data" (a .zip with everything) and "Erase her data" (for
 * good: she must be typed by name). The PC logs each of these (Settings → Audit log).
 */
export default function DataRights({ profile, onChanged }) {
  const navigate = useNavigate()
  const canExport = useCan('export_backup')
  const canErase = useCan('delete_profiles')
  const [busy, setBusy] = useState(false)
  const download = async () => {
    setBusy(true)
    try {
      const r = await api.get(`/profiles/${profile.id}/data-export`, { responseType: 'blob', adalNoCache: true, timeout: 120000 })
      const a = document.createElement('a'); a.href = URL.createObjectURL(r.data); a.download = `candidate-${profile.id}-data.zip`; a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10000)
    } catch (e) { toast.error('Could not export her data') }
    setBusy(false)
  }
  const erase = async () => {
    const name = window.prompt(`Erase ${profile.full_name} and all her documents for good? This cannot be undone.\n\nType her full name to confirm:`)
    if (name == null) return
    setBusy(true)
    try { await api.post(`/profiles/${profile.id}/erase`, { confirm_name: name }); toast.success('Her data was erased'); navigate('/profiles') }
    catch (e) { toast.error(e.response?.data?.error || 'Could not erase') }
    setBusy(false)
  }

  // The consent tick is gone (asked on 2026-11-23): only her data's two buttons.
  if (!canExport && !canErase) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2.5 text-sm">
      <span className="ms-auto flex gap-2">
        {canExport && <button type="button" disabled={busy} onClick={download} className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1 text-xs font-medium hover:bg-slate-100 dark:hover:bg-slate-700">Download her data</button>}
        {canErase && <button type="button" disabled={busy} onClick={erase} className="rounded-lg border border-red-300 text-red-700 dark:text-red-400 px-3 py-1 text-xs font-medium hover:bg-red-50 dark:hover:bg-red-950/30">Erase her data</button>}
      </span>
    </div>
  )
}
