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
import ProfileAutomations from '../components/ProfileAutomations'
import ProfileJourney from '../components/ProfileJourney'
import MedicalBattery from '../components/MedicalBattery'

export default function ProfileDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [profile, setProfile] = useState(null)
  const [fields, setFields] = useState([])
  const [cvs, setCvs] = useState([])
  const [cvReadiness, setCvReadiness] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([
      api.get(`/profiles/${id}`),
      api.get(`/profiles/${id}/fields`),
      api.get(`/cv/generated`, { params: { profile_id: id } }).catch(() => ({ data: [] })),
      api.get(`/cv/profile-readiness/${id}`).catch(() => ({ data: null })),
    ])
      .then(([profileRes, fieldsRes, cvsRes, readinessRes]) => {
        if (alive) {
          setProfile(profileRes.data)
          setFields(fieldsRes.data)
          setCvs(cvsRes.data || [])
          setCvReadiness(readinessRes?.data || null)
        }
      })
      .catch(() => {
        toast.error('Profile not found')
        navigate('/profiles')
      })
      .finally(() => { if (alive) setLoading(false) })
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

  const deleteCV = async (cvId) => {
    if (!confirm('Delete this generated CV?')) return
    try {
      await api.delete(`/cv/generated/${cvId}`)
      toast.success('CV deleted')
      setCvs(prev => prev.filter(c => c.id !== cvId))
    } catch {
      toast.error('Delete failed')
    }
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>
  if (!profile) return null

  const location = [profile.room, profile.table_name, profile.box_number].filter(Boolean).join(' / ')
  const amharicName = (profile.given_names_am && profile.surname_am)
    ? `${profile.given_names_am} ${profile.surname_am}`.trim()
    : null

  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader
        title={amharicName || profile.full_name}
        subtitle={amharicName ? profile.full_name : (profile.phone_number || 'No phone on file')}
        action={
          <div className="flex flex-wrap items-center gap-2.5">
            <Button variant="secondary" onClick={() => navigate('/profiles')}>← Back</Button>
            <Button
              className="bg-purple-600 hover:bg-purple-700 text-white"
              data-tour="cv-create"
              onClick={() => navigate(`/cvs/new?profile=${id}`)}
            >
              📄 Create CV
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white"
              onClick={() => navigate(`/profiles/${id}/edit`)}
            >
              ✏️ Edit
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={deleteProfile}
            >
              🗑️ Delete
            </Button>
          </div>
        }
      />

      {/* Labor ID — first thing on the page */}
      <div data-tour="labor-id" className="rounded-2xl p-[2px] bg-gradient-to-r from-teal-500 via-sky-500 to-indigo-500 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] bg-gradient-to-r from-teal-50 via-sky-50 to-indigo-50 dark:from-slate-900 dark:via-slate-900 dark:to-slate-900 px-5 py-3">
          <span className="text-xs font-bold uppercase tracking-widest bg-gradient-to-r from-teal-600 via-sky-600 to-indigo-600 bg-clip-text text-transparent">Labor ID</span>
          <LaborIdEdit profile={profile} onSaved={(v) => setProfile(p => ({ ...p, labor_id: v }))} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={profile.status} />
        {profile.broker_name && (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
            Broker: {profile.broker_name}
          </span>
        )}
        {profile.nationality && (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
            {profile.nationality}
          </span>
        )}
        <span className="ml-auto"><MedicalBattery profile={profile} onSaved={(v) => setProfile(p => ({ ...p, ...v }))} /></span>
      </div>

      {/* Auto-trigger status */}
      {profile.destination_country?.toLowerCase() === 'kuwait' && (
        <div className={`panel p-4 border-l-4 ${
          cvReadiness?.can_generate ? 'border-l-emerald-500 bg-emerald-50/30 dark:bg-emerald-900/10'
                                    : 'border-l-amber-400 bg-amber-50/30 dark:bg-amber-900/10'
        }`}>
          <p className="text-sm font-semibold">
            {profile.order_id && profile.labor_id
              ? '🇰🇼 Kuwait police clearance will auto-start once all files are present'
              : '🇰🇼 Kuwait selected — waiting for Labor ID + Order ID + files'}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Requires: Passport, Photo, Full Body Photo, Slip, Labor ID, Order ID.
            {profile.order_id && ` Order ID: ${profile.order_id}`}
          </p>
        </div>
      )}

      {profile.destination_country === 'Saudi Arabia' && (
        <SaudiEmergency profile={profile} onSaved={(v) => setProfile(p => ({ ...p, emergency_labor_id: v }))} />
      )}

      <ProfileJourney profileId={id} />

      {(profile.chosen_at || profile.contract_number) && <ContractCard profile={profile} />}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left: client details */}
        <section className="panel p-6 lg:col-span-1">
          <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-700/50 pb-3">Client details</h2>
          <dl className="mt-4 grid grid-cols-1 gap-3">
            <Field label="Full name" value={profile.full_name} />
            <Field label="Order ID" value={profile.order_id} />
            {amharicName && <Field label="Full name (AM)" value={amharicName} />}
            <Field label="Phone" value={profile.phone_number} />
            <Field label="National ID" value={profile.national_id} />
            <Field label="Passport" value={profile.passport_number} />
            <Field label="Date of birth (GE)" value={profile.date_of_birth} />
            <Field label="Passport issued" value={profile.passport_issue_date} />
            <Field label="Passport expiry" value={profile.passport_expiry_date} />
            <Field label="Gender" value={profile.gender} />
            <Field label="Place of birth" value={profile.place_of_birth} />
            <Field label="Nationality" value={profile.nationality} />
            <Field label="Religion" value={profile.religion} />
            <Field label="Marital status" value={profile.marital_status} />
            <Field label="Children" value={profile.children_count != null && String(profile.children_count).trim() !== '' ? String(Number(profile.children_count) || 0) : '0'} />
            <Field label="Weight" value={profile.weight} />
            <Field label="Height" value={profile.height} />
            <Field label="Mother's name" value={profile.mother_name} />
            <Field label="Father's name" value={profile.father_name} />
            <Field label="Education" value={profile.education_level} />
            <Field
              label="Work experience"
              value={(profile.work_experience || 'No experience') +
                (profile.work_experience === 'Have experience' && profile.experience_country ? ` — ${profile.experience_country}` : '') +
                (profile.work_experience === 'Have experience' && profile.experience_years ? ` · ${profile.experience_years} year${Number(profile.experience_years) === 1 ? '' : 's'}` : '')}
            />
            <Field label="Speaks English" value={profile.speaks_english ? 'Yes' : 'No'} />
            <Field label="Speaks Arabic" value={profile.speaks_arabic ? 'Yes' : 'No'} />
            <Field label="Region" value={profile.region} />
            <Field label="Zone / Sub-city" value={profile.zone_subcity} />
            <Field label="Personal number" value={profile.personal_number} />
            <Field label="Cooking skill" value={profile.cooking_skill} />
            <Field label="Emergency name" value={profile.emergency_name} />
            <Field label="Emergency phone" value={profile.emergency_phone} />
            <Field label="Emergency relationship" value={profile.emergency_relationship} />
            {profile.destination_country === 'Saudi Arabia' && <Field label="Emergency Labor ID (LMIS)" value={profile.emergency_labor_id} />}
            <Field label="Destination Country" value={profile.destination_country} />
            <Field label="Broker" value={profile.broker_name || 'Unassigned'} />
            <Field label="Created" value={formatDate(profile.created_at)} />
            <Field label="Updated" value={formatDate(profile.updated_at)} />
          </dl>
        </section>

        {/* Right: documents */}
        <section className="panel p-6 lg:col-span-2 space-y-6">
          <div>
            <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4 pb-3 border-b border-slate-100 dark:border-slate-700/50">Documents & Fields</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {fields.map(field => (
                <FieldCard
                  id={`field-${field.name.replace(/\s+/g, '-')}`}
                  key={field.id}
                  field={field}
                  profileId={id}
                  onFileUpdate={handleFileUpdate}
                  cvReadiness={field.name === 'CV' ? cvReadiness : null}
                />
              ))}
            </div>
          </div>

          {/* Generated CVs */}
          <div>
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-100 dark:border-slate-700/50">
              <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">
                Generated CVs <span className="text-slate-400 font-normal text-sm">({cvs.length})</span>
              </h2>
              <Button
                className="bg-purple-600 hover:bg-purple-700 text-white text-xs px-3 py-1.5"
                onClick={() => navigate(`/cvs/new?profile=${id}`)}
              >
                + New CV
              </Button>
            </div>
            {cvs.length === 0 ? (
              <p className="text-sm text-slate-400 italic py-4 text-center">
                No CVs generated yet. Click "Create CV" to build one from a template.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {cvs.map(c => (
                  <article key={c.id} className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/40 flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-sm text-slate-900 dark:text-white truncate">
                          {c.template_name || 'CV'}
                        </p>
                        <p className="text-[11px] text-slate-500 truncate">
                          {c.agency_name || '—'}
                        </p>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 shrink-0">
                        PDF
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-400">
                      {new Date(c.created_at).toLocaleString()}
                    </p>
                    <div className="flex gap-1.5 pt-2 border-t border-slate-200 dark:border-slate-700 mt-1">
                      <a
                        href={`/api/cv/generated/${c.id}/download`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-center text-[11px] py-1.5 rounded-md bg-teal-50 text-teal-700 hover:bg-teal-100 dark:bg-teal-900/30 dark:text-teal-400"
                      >
                        Download
                      </a>
                      <button
                        onClick={() => deleteCV(c.id)}
                        className="flex-1 text-[11px] py-1.5 rounded-md bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400"
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
      <div id="ai-actions" className="scroll-mt-24"><ProfileAutomations profileId={id} /></div>

      {/* Notes */}
      <section className="panel p-6">
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white pb-3 border-b border-slate-100 dark:border-slate-700/50">Notes</h2>
        <div className="mt-3 p-4 rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-200/80 dark:border-slate-700/60">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-300">
            {profile.notes?.trim() || 'No notes yet.'}
          </p>
        </div>
        <Button
          className="mt-6 px-5 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-medium text-sm"
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
    <div className="p-2.5 rounded-lg bg-slate-50/80 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-slate-900 dark:text-slate-100 break-words">{value || '—'}</dd>
    </div>
  )
}
/** Chosen on Musaned: the employer, the Saudi agency and the contract, as Musaned and template.pdf say. */
function ContractCard({ profile: p }) {
  let c = {}
  try { c = JSON.parse(p.contract_data || '{}') || {} } catch {}
  const rows = [
    ['Employer', c['Employer Full Name'] || p.employer_name],
    ['Employer ID', p.employer_id],
    ['Employer mobile', p.employer_phone],
    ['Employer telephone', c['Employer Telephone']],
    ['Employer city', c['Employer City']],
    ['City of work', p.work_city],
    ['Employer address', p.employer_address],
    ['Saudi agency (PRO)', p.musaned_pro || c['Saudi Agency']],
    ['Agency license', c['Saudi Agency License']],
    ['Agency phone', c['Saudi Agency Phone']],
    ['Agency email', c['Saudi Agency Email']],
    ['Contract no.', p.contract_number],
    ['Visa no.', p.visa_number],
    ['Tawassut no.', p.tawassut_number],
    ['Contract date', p.contract_date || c['Contract Date']],
    ['Salary', p.salary && `${p.salary} SAR`],
    ['Job', p.job_title],
  ].filter(([, v]) => v)
  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">🤝 Chosen by an employer</h2>
        {p.chosen_at && <span className="rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 px-2.5 py-0.5 text-xs font-semibold">{new Date(p.chosen_at).toLocaleDateString()}</span>}
        {p.musaned_stage && <span className="rounded-full bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300 px-2.5 py-0.5 text-xs font-semibold">{p.musaned_stage}</span>}
        {p.musaned_payment && <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${/^paid$/i.test(p.musaned_payment) ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'}`}>{p.musaned_payment}</span>}
        <span className="ml-auto text-[11px] text-slate-400">from Musaned and template.pdf · the PDFs are in the Contract documents</span>
      </div>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[11px] uppercase tracking-wide text-slate-400">{k}</dt>
            <dd className="font-medium text-slate-800 dark:text-slate-200 break-words" dir="auto">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** The Labor ID, changed right here (Enter or ✓ saves, Esc cancels). */
function LaborIdEdit({ profile, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(profile.labor_id || '')
  const [saving, setSaving] = useState(false)
  const big = 'font-mono text-xl font-extrabold bg-gradient-to-r from-teal-600 via-sky-600 to-indigo-600 bg-clip-text text-transparent'
  const save = async () => {
    const v = value.trim()
    if (v === (profile.labor_id || '')) return setEditing(false)
    setSaving(true)
    try {
      await api.put(`/profiles/${profile.id}`, { labor_id: v })
      onSaved(v)
      toast.success(v ? `Labor ID saved: ${v}` : 'Labor ID cleared')
      setEditing(false)
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not save the Labor ID')
    } finally { setSaving(false) }
  }
  if (!editing) {
    return (
      <button type="button" title="Click to change the Labor ID" onClick={() => { setValue(profile.labor_id || ''); setEditing(true) }}
        className="flex items-center gap-2 group">
        <span className={big}>{profile.labor_id || '— not set —'}</span>
        <span className="text-xs text-slate-400 group-hover:text-teal-600">✏️ edit</span>
      </button>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <input autoFocus value={value} onChange={e => setValue(e.target.value.toUpperCase())}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
        placeholder="EF…" className="field font-mono text-lg w-56" />
      <button type="button" disabled={saving} onClick={save} className="px-3 py-1.5 rounded-lg bg-teal-600 text-white text-sm font-semibold disabled:opacity-50">{saving ? '…' : '✓ Save'}</button>
      <button type="button" onClick={() => setEditing(false)} className="px-2 py-1.5 rounded-lg border text-sm">✕</button>
    </div>
  )
}

/** Saudi Arabia: the LMIS contract needs the emergency contact person's Labor ID. */
function SaudiEmergency({ profile, onSaved }) {
  const [value, setValue] = useState(profile.emergency_labor_id || '')
  const [editing, setEditing] = useState(!profile.emergency_labor_id)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    const v = value.toUpperCase().trim()
    if (!v) return toast.error('Type the Labor ID of the emergency contact person')
    setSaving(true)
    try {
      await api.put(`/profiles/${profile.id}`, { emergency_labor_id: v })
      onSaved(v); setEditing(false); toast.success('Emergency contact saved')
    } catch (e) { toast.error(e?.response?.data?.error || 'Could not save') } finally { setSaving(false) }
  }
  return (
    <div className={`panel p-4 border-l-4 ${profile.emergency_labor_id && !editing ? 'border-l-emerald-500' : 'border-l-amber-400 bg-amber-50/30 dark:bg-amber-900/10'}`}>
      <p className="text-sm font-semibold">🇸🇦 Saudi Arabia — emergency contact person for the LMIS contract</p>
      {editing ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1.5 text-sm w-48"
            placeholder="EM13001783" value={value} onChange={e => setValue(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} />
          <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          <span className="text-xs text-slate-500">Their LMIS Labor ID (register the person on LMIS first). The contract run adds them on the Emergency Contact tab.</span>
        </div>
      ) : (
        <p className="text-xs text-slate-500 mt-1">Labor ID <b>{profile.emergency_labor_id}</b> — added on the LMIS contract's Emergency Contact tab. <button type="button" className="underline" onClick={() => setEditing(true)}>Change</button></p>
      )}
    </div>
  )
}
