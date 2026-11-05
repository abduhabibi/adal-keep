import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Button from '../components/shared/Button'
import Spinner from '../components/shared/Spinner'
import EmptyState from '../components/shared/EmptyState'
import WhatsAppCVs from '../components/WhatsAppCVs'
import AddFromMusaned from '../components/AddFromMusaned'

export default function CVsPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const profileFilter = params.get('profile')
  const tab = params.get('tab') === 'whatsapp' && !profileFilter ? 'whatsapp' : 'cvs'
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [fromMusaned, setFromMusaned] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await api.get('/cv/generated', profileFilter ? { params: { profile_id: profileFilter } } : undefined)
      setRows(res.data || [])
    } catch { toast.error('Failed to load CVs') }
    finally { setLoading(false) }
  }

  useEffect(() => { if (tab === 'cvs') load() }, [profileFilter, tab])

  const remove = async (id) => {
    if (!confirm('Delete this CV?')) return
    try { await api.delete(`/cv/generated/${id}`); toast.success('Deleted'); load() }
    catch { toast.error('Delete failed') }
  }

  const openNew = () => {
    navigate(profileFilter ? `/cvs/new?profile=${profileFilter}` : '/cvs/new')
  }

  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader
        title="ሲቪዎች"
        subtitle={profileFilter ? `CVs for profile #${profileFilter}` : 'All generated CVs'}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/cvs/templates')}>Templates</Button>
            <Button variant="secondary" onClick={() => setFromMusaned(true)}>📥 Add from Musaned</Button>
            <Button data-tour="new-cv" onClick={openNew}>+ New CV</Button>
          </div>
        }
      />

      {!profileFilter && import.meta.env.VITE_DEMO !== '1' && (
        <div className="flex w-fit rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-800">
          {[['cvs', '📄 Made CVs'], ['whatsapp', '💬 WhatsApp']].map(([id, label]) => (
            <button key={id} type="button" onClick={() => setParams(id === 'whatsapp' ? { tab: 'whatsapp' } : {})}
              className={`rounded-lg px-4 py-1.5 text-sm font-semibold ${tab === id ? 'bg-teal-600 text-white' : 'text-slate-600 dark:text-slate-300'}`}>{label}</button>
          ))}
        </div>
      )}

      {fromMusaned && <AddFromMusaned onClose={() => setFromMusaned(false)} />}

      {tab === 'whatsapp' ? <WhatsAppCVs /> : loading ? <Spinner /> : rows.length === 0 ? (
        <EmptyState
          title="No CVs yet"
          description="Click New CV to pick a candidate and generate a formatted CV for one of your agencies."
          action={<Button onClick={openNew}>Create first CV</Button>}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map(r => (
            <article key={r.id} className="panel p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-display font-bold text-slate-900 dark:text-white">
                    {r.profile_name || `Profile #${r.profile_id}`}
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">{r.template_name || 'Unknown template'}</p>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 shrink-0">
                  {r.agency_name || r.template_name || '—'}
                </span>
              </div>
              <p className="text-xs text-slate-500">Passport: <span className="font-medium">{r.passport_number || '—'}</span></p>
              <p className="text-[10px] text-slate-400">{new Date(r.created_at).toLocaleString()}</p>
              <div className="flex gap-2 border-t border-slate-100 dark:border-slate-700 pt-3">
                <a
                  href={`/api/cv/generated/${r.id}/view`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-center py-2 text-xs font-medium rounded-lg bg-teal-600 text-white hover:bg-teal-700"
                >Preview</a>
                <a
                  href={`/api/cv/generated/${r.id}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-center py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                >Download</a>
                <button
                  className="flex-1 py-2 text-xs font-medium rounded-lg text-red-600 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 border border-red-200/60"
                  onClick={() => remove(r.id)}
                >Delete</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
