import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import StatusBadge from '../components/shared/StatusBadge'
import Button from '../components/shared/Button'
import { formatDate } from '../lib/utils'
import FieldCard from '../components/fields/FieldCard'

export default function ProfileDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [profile, setProfile] = useState(null)
  const [fields, setFields] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([
      api.get(`/profiles/${id}`),
      api.get(`/profiles/${id}/fields`)
    ])
      .then(([profileRes, fieldsRes]) => {
        if (alive) {
          setProfile(profileRes.data)
          setFields(fieldsRes.data)
        }
      })
      .catch(() => {
        toast.error('Profile not found')
        navigate('/profiles')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => { alive = false }
  }, [id, navigate])

  const deleteProfile = async () => {
    if (!confirm('Delete this profile permanently?')) return
    try {
      await api.delete(`/profiles/${id}`)
      toast.success('Profile deleted')
      navigate('/profiles')
    } catch {
      toast.error('Delete failed')
    }
  }

  const handleFileUpdate = (fieldId, updatedFiles) => {
    setFields(prevFields =>
      prevFields.map(field => {
        if (field.id === fieldId) {
          return { ...field, files: Array.isArray(updatedFiles) ? updatedFiles : [] }
        }
        return field
      })
    )
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>
  if (!profile) return null

  const location = [profile.room, profile.table_name, profile.box_number].filter(Boolean).join(' / ')

  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader
        title={profile.full_name}
        subtitle={profile.phone_number || 'No phone on file'}
        action={
          <div className="flex flex-wrap items-center gap-2.5">
            <Button
              variant="secondary"
              className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors shadow-sm"
              onClick={() => navigate('/profiles')}
            >
              ← Back
            </Button>
            <Button
              variant="primary"
              className="px-4 py-2 text-sm font-medium rounded-lg bg-teal-600 hover:bg-teal-700 text-white transition-colors shadow-sm"
              onClick={() => navigate(`/profiles/${id}/edit`)}
            >
              ✏️ Edit
            </Button>
            <Button
              variant="danger"
              className="px-4 py-2 text-sm font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors shadow-sm"
              onClick={deleteProfile}
            >
              🗑️ Delete
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={profile.status} />
        {profile.broker_name && (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
            Broker: {profile.broker_name}
          </span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column: Client Details */}
        <section className="panel p-6 bg-white dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/60 rounded-xl shadow-sm lg:col-span-1">
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-700/50 pb-3">Client details</h2>
          <dl className="mt-4 grid gap-3">
            <Field label="Full name" value={profile.full_name} />
            <Field label="Phone" value={profile.phone_number} />
            <Field label="National ID" value={profile.national_id} />
            <Field label="Passport" value={profile.passport_number} />
            <Field label="Broker" value={profile.broker_name || 'Unassigned'} />
            <Field label="Filing location" value={location || '—'} />
            <Field label="Created" value={formatDate(profile.created_at)} />
            <Field label="Updated" value={formatDate(profile.updated_at)} />
          </dl>
        </section>

        {/* Right Column: Documents */}
        <section className="panel p-6 bg-white dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/60 rounded-xl shadow-sm lg:col-span-2">
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4 pb-3 border-b border-slate-100 dark:border-slate-700/50">Documents & Fields</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map(field => (
              <FieldCard
                key={field.id}
                field={field}
                profileId={id}
                onFileUpdate={handleFileUpdate}
              />
            ))}
          </div>
        </section>
      </div>

      {/* Notes Section */}
      <section className="panel p-6 bg-white dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/60 rounded-xl shadow-sm">
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white pb-3 border-b border-slate-100 dark:border-slate-700/50">Notes</h2>
        <div className="mt-3 p-4 rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-700/60">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-300">
            {profile.notes?.trim() || 'No notes yet.'}
          </p>
        </div>
        <Button
          variant="primary"
          className="mt-6 px-5 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-medium text-sm transition-colors shadow-sm"
          onClick={() => navigate(`/profiles/${id}/edit`)}
        >
          Update profile
        </Button>
      </section>
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div className="p-2.5 rounded-lg bg-slate-50/80 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 transition-colors">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-900 dark:text-slate-100">{value || '—'}</dd>
    </div>
  )
}