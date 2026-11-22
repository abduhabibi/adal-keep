import { Children, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import ProfileFormPage from './ProfileFormPage'
import toast from 'react-hot-toast'
import { parts, kept, keptNow, keep, noteOpened } from '../lib/profileCache'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import StatusBadge from '../components/shared/StatusBadge'
import Button from '../components/shared/Button'
import { formatDate } from '../lib/utils'
import FieldCard from '../components/fields/FieldCard'
import NeedsFill from '../components/NeedsFill'
import CropReview from '../components/CropReview'
import PrioritizeButton from '../components/PrioritizeButton'
import ProfileAutomations from '../components/ProfileAutomations'
import ProfileJourney from '../components/ProfileJourney'
import ProfileDays from '../components/ProfileDays'
import WhatsAppSend from '../components/WhatsAppSend'
import EmbassyPrintButton from '../components/EmbassyPrintButton'
import NotesTimeline from '../components/NotesTimeline'
import VisaBarcodes from '../components/VisaBarcodes'
import MedicalBattery from '../components/MedicalBattery'
import { onDataChange } from '../lib/changes'
import { onPhone } from '../lib/phoneMode'
import { photosFirst, missingPhotos, hasFiles } from '../lib/photosFirst'
import { missingNow } from '../lib/missingNow'
import { ACTIONS, shows } from '../lib/stageActions'
import useProfilePhase from '../hooks/useProfilePhase'
import { useCan } from '../lib/staffPerms'

// Her father's name as the emergency contact: his name and his father's (her surname),
// e.g. "ABAGOLE KEDIR". A saved name that was only his first name gets the surname too.
function fatherFull(p = {}) {
  const base = String(p.father_name || p.middle_name || '').trim()
  const sur = String(p.last_name || '').trim()
  if (!base) return ''
  return sur && !base.toUpperCase().split(/s+/).includes(sur.toUpperCase()) ? `${base} ${sur}` : base
}
function emergencyName(p = {}) {
  const e = String(p.emergency_name || '').trim()
  const bare = [p.father_name, p.middle_name].map(x => String(x || '').trim().toUpperCase()).filter(Boolean)
  return (!e || bare.includes(e.toUpperCase())) ? fatherFull(p) || e : e
}

// One thing at a time (asked on 2026-11-17): each step shows only the
// documents and details it needs; "Show everything" opens the rest.
const STEP_FILES = {
  cv: ['Passport', 'Photo', 'Full Body Photo'],
  musaned: ['Photo', 'Passport'],
  selected: ['Passport'],
  wafid: ['Passport', 'Appointment Slip'],
  epro: ['Contract'],
}
const STEP_DETAILS = {
  cv: ['Full name', 'Passport', 'Date of birth (GE)', 'Phone'],
  musaned: ['Full name', 'Passport', 'Phone', 'Marital status', 'Religion'],
  selected: ['Full name', 'Passport', 'Phone', 'Broker'],
  wafid: ['Full name', 'Passport', 'Date of birth (GE)', 'Passport expiry', '📅 Wafid medical'],
  epro: ['Full name', 'Passport', 'Contract number (Musaned)', 'Visa number (Musaned)'],
}

export default function ProfileDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const canDelete = useCan('delete_profiles')
  const [profile, setProfile] = useState(null)
  const [fields, setFields] = useState([])
  const [cvs, setCvs] = useState([])
  const [cvReadiness, setCvReadiness] = useState(null)
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState(null)        // the step she is at (backend stepNow)
  const [everything, setEverything] = useState(false)
  const { phase, after } = useProfilePhase(profile)
  // Edit opens as a pop-up over her page (asked on 2026-11-19).
  const [editOpen, setEditOpen] = useState(false)
  // A new profile: her photos → her CV → Musaned, one pop-up after the other.
  const [search, setSearch] = useSearchParams()
  // Every profile still in the first stage (photos, CV, Musaned) shows what to do next each
  // time her page is opened; ✕ and Later only hide it until she is opened again (asked on 2026-11-20).
  const [nextOpen, setNextOpen] = useState(false)
  const [hidden, setHidden] = useState(null)   // the profile whose pop-up was hidden on this visit
  useEffect(() => {
    setHidden(null)
    if (search.get('next') === 'photos') { setNextOpen(true); search.delete('next'); setSearch(search, { replace: true }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  useEffect(() => { if (['cv', 'musaned'].includes(phase) && hidden !== id) setNextOpen(true) }, [id, phase]) // eslint-disable-line react-hooks/exhaustive-deps
  // Past the Musaned step: nothing left for the pop-up.
  useEffect(() => { if (phase && !['cv', 'musaned'].includes(phase)) setNextOpen(false) }, [phase])
  const closeNext = () => { setHidden(id); setNextOpen(false) }
  const doneNext = closeNext
  // Any robot on her page that is missing something: a pop-up to fill it, then that robot starts (asked on 2026-11-20).
  const [fill, setFill] = useState(null)   // { workflowId, name, body }
  useEffect(() => {
    const on = (e) => { if (String(e.detail?.profileId) === String(id)) { e.detail.handled = true; setFill(e.detail) } }
    window.addEventListener('adal-fill-missing', on)
    return () => window.removeEventListener('adal-fill-missing', on)
  }, [id])
  const startFilled = async () => {
    const f = fill
    if (!f) return
    const t = toast.loading(`${f.name}: starting…`)
    try {
      const r = await api.post(`/profiles/${id}/automations/${f.workflowId}/start`, f.body || {})
      toast.success(`${f.name}: ${r.data?.message || 'started'}`, { id: t })
      setFill(null)
      window.dispatchEvent(new Event('adal-profile-changed'))
    } catch (e) { toast.error(`${f.name}: ${e.response?.data?.error || 'could not start'}`, { id: t, duration: 8000 }) }
  }
  const refreshAll = () => {
    window.dispatchEvent(new Event('adal-profile-changed'))
    api.get(`/profiles/${id}/fields`).then(r => { keep(parts(id).fields, r.data); setFields(r.data) }).catch(() => {})
    api.get(`/cv/generated`, { params: { profile_id: id } }).then(r => setCvs(r.data || [])).catch(() => {})
  }
  useEffect(() => {
    const look = () => api.get(`/profiles/${id}/step`).then(r => setStep(r.data)).catch(() => {})
    look()
    setEverything(false)
    // A CV made by itself shows at once (8f5d12b).
    const cvsAgain = () => api.get(`/cv/generated`, { params: { profile_id: id } }).then(r => setCvs(r.data || [])).catch(() => {})
    const offCvs = onDataChange(['generated_cvs', 'files', 'profile_fields'], cvsAgain)
    const off = onDataChange(['profiles', 'automation_queue', 'files', 'profile_fields'], look)
    return () => { off?.(); offCvs?.() }
  }, [id])
  // Only the step's files still missing: an uploaded one leaves the page; all there → the part folds away.
  const stepFiles = !everything && STEP_FILES[step?.key]
  // A missing Photo / Full Body Photo is always in front, whatever the step.
  const needFiles = stepFiles ? [...new Set([...missingPhotos(fields), ...stepFiles.filter(n => !hasFiles(fields.find(fl => fl.name === n)))])] : null
  const needDetails = !everything && STEP_DETAILS[step?.key]
  const showAll = (stepFiles || needDetails) ? (
    <button type="button" onClick={() => setEverything(true)} className="mt-3 text-xs font-semibold text-teal-700 hover:underline dark:text-teal-400">▸ Show everything</button>
  ) : null

  useEffect(() => {
    let alive = true
    // Opened before: what this device kept shows at once (lib/profileCache.js),
    // and the PC's fresh answers replace it as they come.
    const P = parts(id)
    const nowProfile = keptNow(P.profile), nowFields = keptNow(P.fields)
    setProfile(nowProfile ?? null)
    setFields(nowFields ?? [])
    setCvs(keptNow(P.cvs) ?? [])
    setCvReadiness(keptNow(P.readiness) ?? null)
    setLoading(nowProfile === undefined)
    let fresh = false
    if (nowProfile === undefined) {
      Promise.all([kept(P.profile), kept(P.fields), kept(P.cvs), kept(P.readiness)]).then(([pr, fl, cv, rd]) => {
        if (!alive || fresh || pr === undefined) return
        setProfile(pr); if (fl !== undefined) setFields(fl); if (cv !== undefined) setCvs(cv); if (rd !== undefined) setCvReadiness(rd)
        setLoading(false)
      }).catch(() => {})
    }
    noteOpened(id)
    // The profile and its documents first (on a phone: from its own copy, at
    // once); the CVs and the CV check fill in when they come.
    Promise.all([
      api.get(`/profiles/${id}`),
      api.get(`/profiles/${id}/fields`),
    ])
      .then(([profileRes, fieldsRes]) => {
        fresh = true
        keep(P.profile, profileRes.data); keep(P.fields, fieldsRes.data)
        if (alive) {
          setProfile(profileRes.data)
          setFields(fieldsRes.data)
        }
      })
      .catch(() => {
        toast.error('Profile not found')
        navigate('/profiles')
      })
      .finally(() => { if (alive) setLoading(false) })
    api.post(`/profiles/${id}/opened`).catch(() => {})   // the most recent on the list now
    api.get(`/cv/generated`, { params: { profile_id: id } }).then(r => { keep(P.cvs, r.data || []); if (alive) setCvs(r.data || []) }).catch(() => {})
    api.get(`/cv/profile-readiness/${id}`).then(r => { keep(P.readiness, r.data || null); if (alive) setCvReadiness(r.data || null) }).catch(() => {})
    return () => { alive = false }
  }, [id, navigate])

  // A run changed state or a person pressed a run's button: her notes and
  // fields are fresh again (the runs write into them).
  useEffect(() => {
    const again = () => api.get(`/profiles/${id}`).then(r => { keep(parts(id).profile, r.data); setProfile(r.data) }).catch(() => {})
    window.addEventListener('adal-profile-changed', again)
    // Tray files were put on one of her fields (TrayPutOn.jsx).
    const fieldsAgain = (e) => { if (!e.detail?.id || String(e.detail.id) === String(id)) api.get(`/profiles/${id}/fields`).then(r => { keep(parts(id).fields, r.data); setFields(r.data) }).catch(() => {}) }
    window.addEventListener('adal-fields-changed', fieldsAgain)
    // Changed anywhere else too: her details, notes, documents and status follow at once.
    const off = onDataChange(['profiles', 'profile_fields', 'files', 'automation_queue', 'profile_automations', 'notes'], (t) => {
      again()
      if (t.some(x => x === 'profile_fields' || x === 'files' || x === '*')) api.get(`/profiles/${id}/fields`).then(r => { keep(parts(id).fields, r.data); setFields(r.data) }).catch(() => {})
    })
    return () => { window.removeEventListener('adal-profile-changed', again); window.removeEventListener('adal-fields-changed', fieldsAgain); off() }
  }, [id])

  // Photo and Full Body Photo first; a missing one sits outside the fold, always in view.
  const orderedFields = photosFirst(fields)
  const gapNames = missingPhotos(fields)
  const miss = missingNow(profile, fields, step?.key)
  const missFields = orderedFields.filter(f => miss.files.includes(f.name) || gapNames.includes(f.name))
  const restFiles = orderedFields.filter(f => !miss.files.includes(f.name) && !gapNames.includes(f.name) && (!needFiles || needFiles.includes(f.name)))
  const fieldCard = (field) => (
    <FieldCard
      id={`field-${field.name.replace(/\s+/g, '-')}`}
      key={field.id}
      field={field}
      profileId={id}
      onFileUpdate={handleFileUpdate}
      cvReadiness={field.name === 'CV' ? cvReadiness : null}
    />
  )

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
  // Her stage's buttons only (lib/stageActions.js); the stage ones wait until her stage is known.
  const can = (key) => phase ? shows(key, phase, after) : !!ACTIONS[key]?.all

  const location = [profile.room, profile.table_name, profile.box_number].filter(Boolean).join(' / ')
  const amharicName = (profile.given_names_am && profile.surname_am)
    ? `${profile.given_names_am} ${profile.surname_am}`.trim()
    : null

  return (
    <div className="animate-fade-up space-y-6">
      {/* A picture JEV cut into parts: a person checks the crop before it goes in. */}
      <CropReview profileId={id} onSaved={refreshAll} />
      {editOpen && (
        <GlassPopup onClose={() => setEditOpen(false)} wide>
          <ProfileFormPage embeddedId={id} onDone={(saved) => { setEditOpen(false); if (saved) refreshAll() }} />
        </GlassPopup>
      )}
      {fill && !editOpen && (
        <GlassPopup onClose={() => setFill(null)} title={`${fill.name}: what she still needs`}>
          <NeedsFill profileId={id} workflowId={fill.workflowId} fields={fields} onFileUpdate={handleFileUpdate} onReady={startFilled} />
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" onClick={startFilled} className="rounded-xl bg-teal-600 px-5 py-3 font-semibold text-white hover:bg-teal-700">Start {fill.name}</button>
            <button type="button" onClick={() => setFill(null)} className="rounded-xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 dark:border-slate-600 dark:text-slate-200">Later</button>
          </div>
        </GlassPopup>
      )}
      {nextOpen && !editOpen && !fill && (
        <NextSteps profileId={id} fields={fields} cvs={cvs} onFileUpdate={handleFileUpdate} onClose={closeNext} onDone={doneNext}
          onCv={() => navigate(`/cvs/new?profile=${id}&auto=1`)} />
      )}
      <PageHeader
        title={amharicName || profile.full_name}
        subtitle={amharicName ? profile.full_name : (profile.phone_number || 'No phone on file')}
        // The medical deadline: between her name and the buttons.
        middle={can('medical_battery') ? <div className="flex min-w-0 justify-center"><MedicalBattery profile={profile} onSaved={(v) => setProfile(p => ({ ...p, ...v }))} /></div> : null}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <PrioritizeButton profileId={id} />
            <Button variant="secondary" onClick={() => navigate('/profiles')} title="Back" aria-label="Back"><span aria-hidden="true">←</span><span className="hidden 2xl:inline"> Back</span></Button>
            <Button
              className="bg-purple-600 hover:bg-purple-700 text-white"
              data-tour="cv-create"
              onClick={() => navigate(`/cvs/new?profile=${id}`)}
            >
              📄 Create CV
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white"
              onClick={() => setEditOpen(true)}
            >
              ✏️ Edit
            </Button>
            {canDelete && (
              <Button
                className="bg-red-600 hover:bg-red-700 text-white"
                onClick={deleteProfile}
                title="Delete" aria-label="Delete"
              >
                🗑️<span className="hidden 2xl:inline"> Delete</span>
              </Button>
            )}
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

      {/* She has experience: her self video is a must (it goes to WhatsApp with her CV). */}
      {/^\s*have/i.test(profile.work_experience || '') && !(fields || []).some(f => /^self video/i.test(f.name || '') && (f.files || []).length) && (
        <div className="panel p-3 border-l-4 border-l-amber-500 text-sm font-semibold text-amber-800 dark:text-amber-300">
          🎥 She has experience: upload her Self Video — it is required, and it is sent to WhatsApp with her CV.
        </div>
      )}

      <MissingCard miss={miss} fields={missFields} profileId={id} fieldCard={fieldCard}
        onSaved={(patch) => { setProfile(p => ({ ...p, ...patch })); window.dispatchEvent(new Event('adal-profile-changed')) }} />

      <ProfileJourney profileId={id} />
      {can('day_by_day') && <ProfileDays profileId={id} />}

      {import.meta.env.VITE_DEMO !== '1' && <WhatsAppSend profile={profile} />}

      {(profile.chosen_at || profile.contract_number) && <ContractCard profile={profile} />}

      {can('print_embassy') && <div className="flex flex-wrap items-center gap-2"><EmbassyPrintButton profile={profile} /></div>}

      {can('visa_barcodes') && <VisaBarcodes profile={profile} />}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left: client details */}
        <Fold id="details" title="Client details" lessLabel="See less ▲" className="panel p-4 sm:p-6 lg:col-span-1">
          <dl className="mt-4 grid grid-cols-1 gap-3">{onlyNeeded(needDetails, <>
            <Field label="Full name" value={profile.full_name} />
            <Field label="Order ID" value={profile.order_id} />
            {amharicName && <Field label="Full name (AM)" value={amharicName} />}
            <Field label="Phone" value={profile.phone_number} />
            <Field label="National ID" value={profile.national_id} />
            <Field label="Passport" value={profile.passport_number} />
            {profile.visa_number && <Field label="Visa number (Musaned)" value={profile.visa_number} />}
            {profile.contract_number && <Field label="Contract number (Musaned)" value={profile.contract_number} />}
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
            <Field label="Education" value={profile.education_level} />
            <Field
              label="Work experience"
              value={(profile.work_experience || 'No experience') +
                (profile.work_experience === 'Have experience' && profile.experience_country ? ` — ${profile.experience_country}` : '') +
                (profile.work_experience === 'Have experience' && profile.experience_years ? ` · ${profile.experience_years} year${Number(profile.experience_years) === 1 ? '' : 's'}` : '')}
            />
            <Field label="Speaks English" value={profile.speaks_english ? 'Yes' : 'No'} />
            <Field label="Speaks Arabic" value={profile.speaks_arabic ? 'Yes' : 'No'} />
            <Field label="Living town" value={profile.living_town} />
            <Field label="Region" value={profile.region} />
            <Field label="Zone / Sub-city" value={profile.zone_subcity} />
            <Field label="Personal number" value={profile.personal_number} />
            <Field label="Cooking skill" value={profile.cooking_skill} />
            <Field label="Emergency name (father)" value={emergencyName(profile)} />
            <Field label="Emergency phone" value={profile.emergency_phone} />
            <Field label="Emergency relationship" value={profile.emergency_relationship} />
            <Field label="Destination Country" value={profile.destination_country} />
            {profile.tasheer_date && <Field label="📅 Tasheer (visa biometrics)" value={[profile.tasheer_date, profile.tasheer_time, profile.tasheer_center, profile.tasheer_ref && `ref ${profile.tasheer_ref}`].filter(Boolean).join(' · ')} />}
            {profile.wafid_appt_date && <Field label="📅 Wafid medical" value={[profile.wafid_appt_date, profile.wafid_appt_time, profile.wafid_center, profile.wafid_slip_number && `slip ${profile.wafid_slip_number}`].filter(Boolean).join(' · ')} />}
            <Field label="Broker" value={profile.broker_name || 'Unassigned'} />
            <Field label="Created" value={formatDate(profile.created_at)} />
            <Field label="Updated" value={formatDate(profile.updated_at)} />
          </>)}</dl>
          {needDetails && showAll}
        </Fold>

        {/* Right: documents */}
        <section className="panel p-4 sm:p-6 lg:col-span-2 space-y-6">
          {/* Her missing Photo / Full Body Photo: empty slots right at the front, never folded away. */}
          {restFiles.length === 0 ? (
            needFiles && !miss.files.length && <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">✓ Documents for this step are all here</p>
          ) : <Fold id="documents" title="Documents & Fields">
            <div className="mt-4 grid grid-cols-2 gap-2 sm:gap-4 lg:grid-cols-3">
              {restFiles.map(field => fieldCard(field))}
            </div>
          </Fold>}
          {stepFiles && showAll}

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
                        href={`/api/cv/generated/${c.id}/view`} data-name={`${profile?.full_name || 'CV'}${c.template_name ? ' - ' + c.template_name : ''}.pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-center text-[11px] py-1.5 rounded-md bg-teal-600 text-white hover:bg-teal-700"
                      >
                        Preview
                      </a>
                      <a
                        href={`/api/cv/generated/${c.id}/download`} data-name={`${profile?.full_name || 'CV'}${c.template_name ? ' - ' + c.template_name : ''}.pdf`}
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
      {!onPhone() && <div id="ai-actions" className="scroll-mt-24"><ProfileAutomations profileId={id} phase={phase} after={after} /></div>}

      {/* Notes */}
      <section className="panel p-6">
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white pb-3 border-b border-slate-100 dark:border-slate-700/50">Notes</h2>
        <div className="mt-4">
          <NotesTimeline notes={profile.notes} />
        </div>
        <Button
          className="mt-6 px-5 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-medium text-sm"
          onClick={() => setEditOpen(true)}
        >
          Update profile
        </Button>
      </section>

      {/* Status — the last thing on her profile. */}
      <section className="panel flex flex-wrap items-center gap-2 p-4">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-400">Status</span>
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
      </section>
    </div>
  )
}

/** What her step still lacks, at the top: type it or upload it here and it leaves the card; nothing missing, no card. */
function MissingCard({ miss, fields, profileId, fieldCard, onSaved }) {
  const [vals, setVals] = useState({})
  const [busy, setBusy] = useState(null)
  const save = async (t) => {
    const v = String(vals[t.key] ?? '').trim()
    if (!v || busy) return
    setBusy(t.key)
    try {
      await api.put(`/profiles/${profileId}`, { [t.key]: v })
      onSaved({ [t.key]: v })
      setVals(x => { const n = { ...x }; delete n[t.key]; return n })
    } catch (e) { toast.error(e.response?.data?.error || 'Could not save') }
    finally { setBusy(null) }
  }
  if (!miss.texts.length && !fields.length) return null
  const cls = 'w-full rounded-lg border border-amber-300 bg-white/80 px-2.5 py-1.5 text-sm dark:border-amber-700 dark:bg-slate-900/60 dark:text-white'
  return (
    <section className="panel p-4 border-l-4 border-l-amber-500" data-testid="missing-card">
      <h2 className="font-display text-base font-bold text-amber-800 dark:text-amber-300">Missing</h2>
      {miss.texts.length > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {miss.texts.map(t => (
            <label key={t.key} className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {t.label}
              {t.type === 'select' ? (
                <select className={`${cls} mt-1 normal-case`} value={vals[t.key] ?? ''} disabled={busy === t.key}
                  onChange={e => { const v = e.target.value; setVals(x => ({ ...x, [t.key]: v })); if (v) { setBusy(t.key); api.put(`/profiles/${profileId}`, { [t.key]: v }).then(() => onSaved({ [t.key]: v })).catch(() => toast.error('Could not save')).finally(() => setBusy(null)) } }}>
                  <option value="">—</option>
                  {t.options.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input className={`${cls} mt-1 normal-case`} type={t.type} placeholder={t.hint || ''} value={vals[t.key] ?? ''} disabled={busy === t.key}
                  onChange={e => setVals(x => ({ ...x, [t.key]: e.target.value }))}
                  onBlur={() => save(t)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
              )}
            </label>
          ))}
        </div>
      )}
      {fields.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-4 lg:grid-cols-3">
          {fields.map(f => fieldCard(f))}
        </div>
      )}
    </section>
  )
}

/** A section folded to its title until opened; opening it is remembered on this device. */
/** Only the details whose label the step needs (all of them when `labels` is empty). */
function onlyNeeded(labels, fragment) {
  const kids = Children.toArray(fragment.props.children)
  return labels ? kids.filter(k => labels.includes(k?.props?.label)) : kids
}

function Fold({ id, title, className = '', lessLabel, children }) {
  const key = `adal-folded-${id}`
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(key) === '1' } catch { return false } })
  const toggle = () => setOpen(o => { try { localStorage.setItem(key, o ? '0' : '1') } catch {} return !o })
  return (
    <section className={className}>
      <button type="button" onClick={toggle} aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 text-left border-b border-slate-100 dark:border-slate-700/50 pb-3">
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">{title}</h2>
        <span className={`text-slate-400 text-sm transition-transform ${open ? '' : '-rotate-90'}`}>▼</span>
      </button>
      {open && children}
      {open && lessLabel && (
        <button type="button" onClick={toggle} className="mt-4 w-full rounded-lg py-2 text-sm font-semibold text-teal-700 hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-slate-800/40">{lessLabel}</button>
      )}
    </section>
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
        <h2 className="font-display text-base font-bold text-slate-900 dark:text-white">Chosen by an employer</h2>
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
  // A click on the Labor ID copies it (asked on 2026-11-19); "edit" changes it.
  const copy = async () => {
    const v = String(profile.labor_id || '').trim()
    if (!v) { setValue(''); setEditing(true); return }
    try { await navigator.clipboard.writeText(v); toast.success(`Copied: ${v}`) }
    catch {
      const t = document.createElement('textarea'); t.value = v; document.body.appendChild(t); t.select()
      try { document.execCommand('copy'); toast.success(`Copied: ${v}`) } catch { toast.error('Could not copy') } finally { t.remove() }
    }
  }
  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <button type="button" title="Click to copy the Labor ID" onClick={copy} className="flex items-center gap-2 group">
          <span className={big}>{profile.labor_id || '— not set —'}</span>
          {profile.labor_id && <span className="text-xs text-slate-400 group-hover:text-teal-600">📋 copy</span>}
        </button>
        <button type="button" title="Change the Labor ID" onClick={() => { setValue(profile.labor_id || ''); setEditing(true) }}
          className="text-xs text-slate-400 hover:text-teal-600">✏️ edit</button>
      </div>
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

/** A glassy, luxurious pop-up over the page (Edit, and the new profile's next steps). */
function GlassPopup({ children, onClose, wide = false, title = null }) {
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', esc)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', esc); document.body.style.overflow = prev }
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto bg-slate-950/45 p-3 backdrop-blur-md sm:items-center sm:p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <div className={`relative w-full ${wide ? 'max-w-5xl' : 'max-w-xl'} max-h-[92vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_30px_80px_-20px_rgba(15,23,42,0.55)] ring-1 ring-black/5 dark:border-slate-700 dark:bg-slate-900 sm:p-6`}>
        <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white/90 to-transparent dark:via-white/30" />
        <button type="button" onClick={onClose} aria-label="Close"
          className="absolute right-4 top-4 z-10 grid h-9 w-9 place-items-center rounded-full border border-slate-200/70 bg-white/70 text-slate-500 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-800/70 dark:hover:text-white">✕</button>
        {title && <h2 className="mb-4 pr-10 font-display text-xl font-bold text-slate-900 dark:text-white">{title}</h2>}
        {children}
      </div>
    </div>,
    document.body,
  )
}

/**
 * A new profile's next steps, one pop-up after the other (asked on 2026-11-19):
 * 1. her Photo and Full Body Photo, 2. her CV (a "Created" box too), 3. Musaned.
 */
function NextSteps({ profileId, fields, cvs, onFileUpdate, onClose, onDone, onCv }) {
  const [madeByHand, setMadeByHand] = useState(() => { try { return sessionStorage.getItem(`next-cv-${profileId}`) === '1' } catch { return false } })
  const [sending, setSending] = useState(false)
  const [needs, setNeeds] = useState({ ready: false })
  const photo = fields.find(f => f.name === 'Photo')
  const body = fields.find(f => f.name === 'Full Body Photo')
  const photosOk = hasFiles(photo) && hasFiles(body)
  const cvOk = (cvs || []).length > 0 || madeByHand
  const mark = (v) => { setMadeByHand(v); try { v ? sessionStorage.setItem(`next-cv-${profileId}`, '1') : sessionStorage.removeItem(`next-cv-${profileId}`) } catch {} }
  const musaned = async () => {
    setSending(true)
    const t = toast.loading('Musaned: checking her profile…')
    try {
      const r = await api.post(`/profiles/${profileId}/automations/musaned_add_candidate/start`, {})
      toast.success(`Musaned: ${r.data?.message || 'started'}`, { id: t })
      try { sessionStorage.removeItem(`next-cv-${profileId}`) } catch {}
      onDone()
    } catch (e) {
      toast.error(`Musaned: ${e.response?.data?.error || 'could not start'}`, { id: t, duration: 8000 })
    } finally { setSending(false) }
  }
  const Step = ({ n, on, done, children }) => (
    <div className={`flex items-center gap-2 text-xs font-semibold ${on ? 'text-teal-700 dark:text-teal-300' : done ? 'text-emerald-600' : 'text-slate-400'}`}>
      <span className={`grid h-6 w-6 place-items-center rounded-full ${on ? 'bg-teal-600 text-white' : done ? 'bg-emerald-500 text-white' : 'bg-slate-200 dark:bg-slate-700'}`}>{done ? '✓' : n}</span>{children}
    </div>
  )
  return (
    <GlassPopup onClose={onClose} wide={!photosOk}>
      <div className="mb-5 flex flex-wrap items-center gap-4 pr-10">
        <Step n={1} on={!photosOk} done={photosOk}>Photos</Step>
        <span className="h-px w-6 bg-slate-300 dark:bg-slate-600" />
        <Step n={2} on={photosOk && !cvOk} done={cvOk}>CV</Step>
        <span className="h-px w-6 bg-slate-300 dark:bg-slate-600" />
        <Step n={3} on={photosOk && cvOk} done={false}>Musaned</Step>
      </div>
      {!photosOk ? (
        <>
          <h2 className="mb-1 font-display text-xl font-bold text-slate-900 dark:text-white">Her photos</h2>
          <p className="mb-4 text-sm text-slate-500">Add her Photo and her Full Body Photo. The next step opens by itself.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {[photo, body].filter(Boolean).map(f => (
              <FieldCard key={f.id} id={`next-${f.name.replace(/\s+/g, '-')}`} field={f} profileId={profileId} onFileUpdate={onFileUpdate} />
            ))}
          </div>
        </>
      ) : !cvOk ? (
        <>
          <h2 className="mb-1 font-display text-xl font-bold text-slate-900 dark:text-white">Her CV</h2>
          <p className="mb-4 text-sm text-slate-500">Both photos are in. Make her CV now.</p>
          <div className="mb-4"><NeedsFill profileId={profileId} cv fields={fields} onFileUpdate={onFileUpdate} /></div>
          <div className="flex flex-wrap items-center gap-4">
            <button type="button" onClick={onCv} className="rounded-xl bg-purple-600 px-5 py-3 font-semibold text-white shadow-lg shadow-purple-600/30 hover:bg-purple-700">📄 Create CV</button>
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
              <input type="checkbox" className="h-5 w-5 accent-teal-600" checked={madeByHand} onChange={e => mark(e.target.checked)} />
              Created
            </label>
          </div>
        </>
      ) : (
        <>
          <h2 className="mb-1 font-display text-xl font-bold text-slate-900 dark:text-white">Musaned</h2>
          <p className="mb-4 text-sm text-slate-500">Her CV is made. Add her to Musaned; when she waits there, send her CV to agents on WhatsApp.</p>
          {/* What Musaned still needs, filled here; once it is all in, Musaned starts by itself. */}
          <div className="mb-4"><NeedsFill profileId={profileId} workflowId="musaned_add_candidate" fields={fields} onFileUpdate={onFileUpdate} onReady={musaned} onState={setNeeds} /></div>
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={sending || !needs.ready} onClick={musaned}
              className="rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-700 disabled:opacity-50">
              {sending ? '…' : '🇸🇦 Make Musaned'}
            </button>
            <button type="button" onClick={onClose} className="rounded-xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 dark:border-slate-600 dark:text-slate-200">Later</button>
          </div>
        </>
      )}
    </GlassPopup>
  )
}
