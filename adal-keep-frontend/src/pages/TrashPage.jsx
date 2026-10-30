import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { createPortal } from 'react-dom'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'

/** Everything deleted in Adal Keep — only on the main PC itself. */
const KIND = {
  profile: '👤 Profile', file: '📄 Document', broker: '🤝 Broker', employee: '🧑‍💼 Employee',
  cv_template: '🎨 CV template', generated_cv: '📄 CV', checklist: '☑️ Checklist', task: '✅ Task',
  quick_link: '🔗 Quick link', lmis_account: '🔐 LMIS account', musaned_account: '🔐 Musaned account',
}

export default function TrashPage() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [kind, setKind] = useState('')
  const [q, setQ] = useState('')
  const [ask, setAsk] = useState(null) // { text, run }

  const load = () => api.get('/trash').then(r => setRows(r.data || [])).catch(e => { setError(e.response?.data?.error || e.message); setRows([]) })
  useEffect(() => { load() }, [])

  const restore = async (r) => {
    try { await api.post(`/trash/${r.id}/restore`); toast.success(`Restored: ${r.title}`); load() }
    catch (e) { toast.error(e.response?.data?.error || 'Not restored') }
  }
  const purge = (r) => setAsk({ text: `Delete "${r.title}" for good? It cannot be brought back.`, run: async () => { await api.post(`/trash/${r.id}/purge`); load() } })
  const empty = () => setAsk({ text: `Empty the Trash? All ${rows.length} items are deleted for good.`, run: async () => { await api.post('/trash/empty'); load() } })

  const list = (rows || []).filter(r => (!kind || r.kind === kind) && (!q.trim() || `${r.title} ${r.deleted_by || ''}`.toLowerCase().includes(q.trim().toLowerCase())))

  return (
    <div className="space-y-5 animate-fade-up">
      <PageHeader title="Trash" subtitle="Everything deleted in Adal Keep, from any PC — only this main PC sees it. Restore puts it back exactly as it was." />
      {error ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">{error}</div>
      ) : (
        <div className="panel rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-4 dark:border-slate-700">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search the trash…" className="min-w-[220px] flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
            <select value={kind} onChange={e => setKind(e.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
              <option value="">Everything</option>
              {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {rows?.length > 0 && <button type="button" onClick={empty} className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50">Empty the Trash</button>}
          </div>
          {rows === null ? <p className="p-6 text-sm text-slate-400">Loading…</p>
            : list.length === 0 ? <p className="p-10 text-center text-sm text-slate-400">{rows.length ? 'Nothing matches.' : 'The Trash is empty.'}</p>
            : (
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-900/50">
                  <tr><th className="px-4 py-2 text-left">What</th><th className="px-4 py-2 text-left">Deleted by</th><th className="px-4 py-2 text-left">When</th><th className="px-4 py-2" /></tr>
                </thead>
                <tbody>
                  {list.map(r => (
                    <tr key={r.id} className="border-t border-slate-100 dark:border-slate-700">
                      <td className="px-4 py-2.5">
                        <span className="block font-medium" translate="no">{r.title}</span>
                        <span className="text-xs text-slate-500">{KIND[r.kind] || r.kind}{r.files ? ` · ${r.files} file${r.files > 1 ? 's' : ''}` : ''}</span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300" translate="no">{r.deleted_by || '—'}<span className="block text-xs text-slate-400">{r.deleted_from || ''}</span></td>
                      <td className="px-4 py-2.5 text-slate-500">{new Date(r.deleted_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        <button type="button" onClick={() => restore(r)} className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700">Restore</button>
                        <button type="button" onClick={() => purge(r)} className="ml-2 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-slate-600">Delete for good</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
        </div>
      )}
      {/* On the screen itself (document.body), never inside the page: it shows in
          the middle of the window however long the list is. */}
      {ask && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
            <p className="text-sm">{ask.text}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setAsk(null)} className="rounded-lg border px-4 py-1.5 text-sm">Cancel</button>
              <button type="button" onClick={async () => { const a = ask; setAsk(null); try { await a.run() } catch (e) { toast.error(e.response?.data?.error || 'Not done') } }}
                className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-semibold text-white">Delete for good</button>
            </div>
          </div>
        </div>, document.body
      )}
    </div>
  )
}
