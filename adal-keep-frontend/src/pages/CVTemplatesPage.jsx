import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Button from '../components/shared/Button'
import Spinner from '../components/shared/Spinner'
import EmptyState from '../components/shared/EmptyState'

export default function CVTemplatesPage() {
  const navigate = useNavigate()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try { const r = await api.get('/cv/templates'); setRows(r.data || []) }
    catch { toast.error('Failed to load templates') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const toggleActive = async (t) => {
    try { await api.patch(`/cv/templates/${t.id}`, { is_active: !t.is_active }); load() }
    catch { toast.error('Update failed') }
  }

  const remove = async (t) => {
    if (!confirm(`Delete template "${t.name}"?`)) return
    try { await api.delete(`/cv/templates/${t.id}`); toast.success('Deleted'); load() }
    catch { toast.error('Delete failed') }
  }

  const preview = (t) => window.open(`/api/cv/templates/${t.id}/preview`, '_blank')

  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader
        title="CV Templates"
        subtitle={`${rows.length} template(s) — each one is an agency`}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/cvs')}>← CVs</Button>
            <Button onClick={() => navigate('/cvs/templates/new')}>+ New Template</Button>
          </div>
        }
      />

      <div className="panel p-4 text-xs text-slate-500 leading-relaxed">
        Each template is a hand-authored HTML/CSS layout with <code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">{'{{TOKENS}}'}</code> for the profile fields.
        Click <b>New Template</b> to create one, or <b>Edit</b> on any card to modify.
        Header and footer images are uploaded inside the editor.
      </div>

      {loading ? <Spinner /> : rows.length === 0 ? (
        <EmptyState
          title="No templates yet"
          description="Click New Template to create your first agency layout."
          action={<Button onClick={() => navigate('/cvs/templates/new')}>Create template</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
          {rows.map(t => {
            const headerUrl = t.header_path ? `/api/cv/templates/${t.id}/header-image?t=${t.updated_at}` : null
            const footerUrl = t.footer_path ? `/api/cv/templates/${t.id}/footer-image?t=${t.updated_at}` : null
            return (
              <article key={t.id} className="panel p-4 flex flex-col gap-3">
                <div className="relative w-full h-20 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 flex items-center justify-center">
                  {headerUrl
                    ? <img src={headerUrl} alt="header" className="max-w-full max-h-full object-contain" />
                    : <span className="text-[10px] text-slate-400">No header image</span>}
                </div>
                {footerUrl && (
                  <div className="relative w-full h-12 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 flex items-center justify-center">
                    <img src={footerUrl} alt="footer" className="max-w-full max-h-full object-contain" />
                  </div>
                )}

                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-display font-bold text-slate-900 dark:text-white">{t.name}</h3>
                    <p className="text-xs text-slate-500 truncate mt-0.5">{t.agency_name || '—'}</p>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${
                    t.is_active ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                                : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                  }`}>{t.is_active ? 'Active' : 'Off'}</span>
                </div>

                <div className="text-[11px] text-slate-500">
                  {t.salary ? `${t.salary} ${t.currency || 'SAR'}` : '—'} · {t.country || '—'} · {t.contract_years || 2}y
                </div>

                <div className="grid grid-cols-4 gap-1.5 border-t border-slate-100 dark:border-slate-700 pt-3 mt-1">
                  <button className="py-1.5 text-[11px] rounded-md bg-teal-600 text-white hover:bg-teal-700 transition"
                    onClick={() => navigate(`/cvs/templates/${t.id}/edit`)}>Edit</button>
                  <button className="py-1.5 text-[11px] rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
                    onClick={() => preview(t)}>Preview</button>
                  <button className="py-1.5 text-[11px] rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition"
                    onClick={() => toggleActive(t)}>{t.is_active ? 'Off' : 'On'}</button>
                  <button className="py-1.5 text-[11px] rounded-md text-red-600 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 transition"
                    onClick={() => remove(t)}>Del</button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
