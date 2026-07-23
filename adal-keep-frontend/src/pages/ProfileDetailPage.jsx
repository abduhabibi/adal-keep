import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import StatusBadge from '../components/shared/StatusBadge'
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
          // updatedFiles is already an array from the backend, so we just use it directly
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
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={() => navigate('/profiles')}>
              Back
            </button>
            <button type="button" className="btn-secondary" onClick={() => navigate(`/profiles/${id}/edit`)}>
              Edit
            </button>
            <button type="button" className="btn-danger" onClick={deleteProfile}>
              Delete
            </button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={profile.status} />
        {profile.broker_name && (
          <span className="chip bg-slate-100 text-slate-700 ring-1 ring-slate-200">
            Broker: {profile.broker_name}
          </span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column: Client Details */}
        <section className="panel p-5 lg:col-span-1">
          <h2 className="font-display text-lg font-bold text-slate-900">Client details</h2>
          <dl className="mt-4 grid gap-4">
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

        {/* Right Column: 19 Permanent Fields */}
        <section className="panel p-5 lg:col-span-2">
          <h2 className="font-display text-lg font-bold text-slate-900 mb-4">Documents & Fields</h2>
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

      {/* Bottom: Notes */}
      <section className="panel p-5">
        <h2 className="font-display text-lg font-bold text-slate-900">Notes</h2>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">
          {profile.notes?.trim() || 'No notes yet.'}
        </p>
        <button
          type="button"
          className="btn-primary mt-6 w-full sm:w-auto"
          onClick={() => navigate(`/profiles/${id}/edit`)}
        >
          Update profile
        </button>
      </section>
    </div>
  )
}

function Field({ label, value }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-slate-900">{value || '—'}</dd>
    </div>
  )
}