import { useEffect, useState } from 'react'
import api from '../services/api'
import { useCan } from '../lib/staffPerms'

/** Settings → who viewed, downloaded, exported or erased which candidate's data (the PC keeps the log). */
export default function AuditLogCard() {
  const can = useCan('manage_staff')
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!can) return
    api.get('/audit?limit=200', { adalNoCache: true }).then(r => setRows(r.data || [])).catch(e => setError(e.response?.data?.error || 'Could not load'))
  }, [can])
  if (!can) return null
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-5">
      <h2 className="font-display text-lg font-bold mb-1">Audit log</h2>
      <p className="text-xs text-slate-500 mb-3">Who looked at what</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {rows && !rows.length && <p className="text-sm text-slate-500">None yet.</p>}
      {rows?.length > 0 && (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-start text-xs text-slate-500"><th className="text-start py-1">When</th><th className="text-start">Who</th><th className="text-start">What</th><th className="text-start">From</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-700/60 align-top">
                  <td className="py-1 pe-2 whitespace-nowrap text-xs" translate="no">{new Date(r.at).toLocaleString()}</td>
                  <td className="pe-2" translate="no">{r.who}</td>
                  <td className="pe-2"><span>{r.action}</span> <span translate="no">{r.target_name || (r.target_id != null ? `#${r.target_id}` : '')}</span>{r.detail ? <span className="text-xs text-slate-500" translate="no"> · {r.detail}</span> : null}</td>
                  <td className="text-xs text-slate-500" translate="no">{r.from_pc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
