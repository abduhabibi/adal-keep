import GlassSelect from '../components/shared/GlassSelect'
import { useEffect, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PickBrokerHere from '../components/PickBrokerHere'
import UploadPhotoHere from '../components/UploadPhotoHere'
import { pdfHere } from '../lib/pdfHere'
import PageHeader from '../components/shared/PageHeader'
import Button from '../components/shared/Button'
import Input from '../components/shared/Input'
import Spinner from '../components/shared/Spinner'
import { REGIONS, regionByName, WORK_COUNTRIES, COUNTRIES_APPLY } from '../lib/regions'

// Her father's name as the emergency contact: his name and his father's (her surname),
// e.g. "ABAGOLE KEDIR". A saved name that was only his first name gets the surname too.
function fatherFull(p = {}) {
  const base = String(p.father_name || p.middle_name || '').trim()
  const sur = String(p.last_name || '').trim()
  if (!base) return ''
  return sur && !base.toUpperCase().split(/\s+/).includes(sur.toUpperCase()) ? `${base} ${sur}` : base
}
function emergencyName(p = {}) {
  const e = String(p.emergency_name || '').trim()
  const bare = [p.father_name, p.middle_name].map(x => String(x || '').trim().toUpperCase()).filter(Boolean)
  return (!e || bare.includes(e.toUpperCase())) ? fatherFull(p) || e : e
}

const RELIGIONS = ['Muslim', 'Christian']
// Her religion as one of the choices ("ISLAM", "muslim " → Muslim); another word stays as it is.
function religionOption(v) {
  const t = String(v || '').trim()
  if (/muslim|islam/i.test(t) && !/non/i.test(t)) return 'Muslim'
  if (/christ|orthodox|protestant|pente|evangel/i.test(t)) return 'Christian'
  return t
}

const DEFAULT_SKILLS = { cleaning: true, ironing: true, washing: true, baby_sitting: true }

const DEFAULT_FORM = {
  religion: '', marital_status: 'SINGLE', children_count: '',
  weight: '', height: '',
  mother_name: '', father_name: '',
  education_level: 'Preparatory', speaks_english: false, speaks_arabic: false,
  english_read: false, english_write: false, arabic_read: false, arabic_write: false,
  skills: { ...DEFAULT_SKILLS }, previous_employment: [],
  cooking_skill: 'None', region: '', zone_subcity: '',
  labor_id: '', personal_number: '',
  emergency_name: '', emergency_phone: '',
  emergency_gender: 'Male', emergency_relationship: 'Father',
  post_applied: 'HOUSE MAID',
  countries_applying: [{ country: 'Saudi Arabia', salary: 1000, currency: 'SAR' }],
  contract_years: 2, ref_no: '',
}

export default function CVNewPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [step, setStep] = useState(params.get('profile') ? 2 : 1)
  const [profileId, setProfileId] = useState(params.get('profile') || '')
  const [profiles, setProfiles] = useState([])
  const [search, setSearch] = useState('')
  const [readiness, setReadiness] = useState(null)
  const [broker, setBroker] = useState(null)
  const [templates, setTemplates] = useState([])
  const [templateId, setTemplateId] = useState('')
  const [busy, setBusy] = useState(false)
  const [genResult, setGenResult] = useState(null)
  const [showPreview, setShowPreview] = useState(false)
  const [previewHtml, setPreviewHtml] = useState(null)
  // Words changed in the preview (double-click): from → to, kept for the PDF.
  const [textEdits, setTextEdits] = useState({})
  const editsRef = useRef({})
  const editList = () => Object.entries(editsRef.current).map(([from, to]) => ({ from, to }))
  const [previewTemplateId, setPreviewTemplateId] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({ ...DEFAULT_FORM })
  const [formReady, setFormReady] = useState(false)

  // Step 1: search profiles
  useEffect(() => {
    if (step !== 1) return
    let alive = true
    api.get('/profiles', { params: search ? { q: search } : undefined })
      .then(r => { if (alive) setProfiles(r.data || []) })
      .catch(() => toast.error('Failed to load profiles'))
    return () => { alive = false }
  }, [step, search])

  // Step 2: load readiness + templates + broker + local draft
  useEffect(() => {
    if (step !== 2 || !profileId) return
    setFormReady(false)
    setBusy(true)
    Promise.all([
      api.get(`/cv/profile-readiness/${profileId}`),
      api.get('/cv/templates'),
    ]).then(async ([r1, r2]) => {
      setReadiness(r1.data)
      setTemplates((r2.data || []).filter(t => t.is_active))
      const p = r1.data.profile || {}

      let brokerObj = null
      if (p.broker_id) {
        try { const b = await api.get(`/brokers/${p.broker_id}`); brokerObj = b.data; setBroker(b.data) } catch {}
      }

      // Merge defaults → profile values
      const skills = { ...DEFAULT_SKILLS }
      try { const s = typeof p.skills === 'string' ? JSON.parse(p.skills) : (p.skills || {}); Object.assign(skills, s) } catch {}
      let prev = []
      try { prev = typeof p.previous_employment === 'string' ? JSON.parse(p.previous_employment) : (p.previous_employment || []) } catch {}
      // The profile's "Have experience" answer fills the first line.
      if (!prev.length && /^have/i.test(p.work_experience || '') && p.experience_country) {
        const c = WORK_COUNTRIES.find(w => w.name === p.experience_country)
        prev = [{ country: p.experience_country, years: p.experience_years || '', from: '', to: '', position: 'HOUSE MAID', salary: c?.salary || 1000, currency: c?.currency || 'SAR' }]
      }

      const base = {
        ...DEFAULT_FORM,
        religion: religionOption(p.religion),
        marital_status: p.marital_status || 'SINGLE',
        children_count: p.children_count ?? '',
        weight: /^normal$/i.test(p.weight || '') ? '' : (p.weight || ''),
        height: /^normal$/i.test(p.height || '') ? '' : (p.height || ''),
        mother_name: p.mother_name || '',
        father_name: p.father_name || '',
        education_level: (p.education_level && !/^new$/i.test(String(p.education_level).trim())) ? p.education_level : 'Preparatory',
        phone_number: p.phone_number || brokerObj?.contact1 || '',
        speaks_english: !!p.speaks_english,
        speaks_arabic: !!p.speaks_arabic,
        english_read: !!p.english_read, english_write: !!p.english_write,
        arabic_read: !!p.arabic_read, arabic_write: !!p.arabic_write,
        skills, previous_employment: prev,
        cooking_skill: p.cooking_skill || 'None',
        region: p.region || '',
        zone_subcity: p.zone_subcity || '',
        labor_id: p.labor_id || '',
        personal_number: p.personal_number || brokerObj?.contact1 || '',
        emergency_name: emergencyName(p),
        emergency_phone: p.emergency_phone || brokerObj?.contact1 || '',
        emergency_gender: p.emergency_gender || 'Male',
        emergency_relationship: p.emergency_relationship || 'Father',
      }

      // Apply localStorage draft overrides (user's unsaved edits)
      const draftRaw = localStorage.getItem(`cv-draft-${profileId}`)
      // Only what was changed here wins over her profile; a box changed on her
      // profile since (religion set, a phone fixed) shows the profile's value.
      profileBase.current = JSON.parse(JSON.stringify(base))
      if (draftRaw) {
        try {
          const saved = JSON.parse(draftRaw)
          const from = saved && saved.__from
          const draft = from ? saved.values || {} : saved
          const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '')
          for (const [k, v] of Object.entries(draft)) {
            if (v === '' || v == null) continue
            if (from ? (same(from[k], base[k]) && !same(v, from[k])) : (base[k] === '' || base[k] == null)) base[k] = v
          }
        } catch {}
      }

      setForm(base)
      setFormReady(true)
    }).catch((e) => {
      toast.error('Failed to load data')
      console.error(e)
    }).finally(() => setBusy(false))
  }, [step, profileId])

  // Persist draft on every change (only after initial load)
  const profileBase = useRef(null)
  useEffect(() => {
    if (!formReady || !profileId) return
    try { localStorage.setItem(`cv-draft-${profileId}`, JSON.stringify({ __from: profileBase.current || {}, values: form })) } catch {}
  }, [form, formReady, profileId])

  // AUTO_GENERATE_EFFECT — when arriving with ?auto=1 and everything is ready, open preview
  useEffect(() => {
    if (params.get('auto') !== '1') return
    // Her form is filled a moment after readiness (the broker is fetched first):
    // the preview waits for it, or it says "Religion is required" with a religion set.
    if (!readiness || !formReady) return
    if (showPreview || genResult) return
    if (!readiness.can_generate) {
      toast.error('CV is not ready yet. Fill the missing fields on the profile.')
      return
    }
    if (!templates.length) {
      toast.error('No templates yet. Upload one first.')
      return
    }
    const t = setTimeout(() => openPreview(), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readiness, templates, formReady])

  useEffect(() => { if (!templateId && templates.length) setTemplateId(String(templates[0].id)) }, [templates, templateId])

  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const regionObj = regionByName(form.region)

  const addExperience = () => setForm(f => ({ ...f, previous_employment: [...f.previous_employment, { country: '', from: '', to: '', position: '', salary: 1000, currency: 'SAR' }] }))
  const removeExperience = (i) => setForm(f => ({ ...f, previous_employment: f.previous_employment.filter((_, idx) => idx !== i) }))
  const updExperience = (i, k, v) => setForm(f => {
    const next = [...f.previous_employment]; next[i] = { ...next[i], [k]: v }
    if (k === 'country') { const c = WORK_COUNTRIES.find(w => w.name === v); if (c) { next[i].currency = c.currency; next[i].salary = c.salary } }
    return { ...f, previous_employment: next }
  })

  const addCountry = () => setForm(f => ({ ...f, countries_applying: [...f.countries_applying, { country: '', salary: 1000, currency: 'SAR' }] }))
  const removeCountry = (i) => setForm(f => ({ ...f, countries_applying: f.countries_applying.filter((_, idx) => idx !== i) }))
  const updCountry = (i, k, v) => setForm(f => {
    const next = [...f.countries_applying]; next[i] = { ...next[i], [k]: v }
    if (k === 'country') { const c = COUNTRIES_APPLY.find(x => x.name === v); if (c) { next[i].currency = c.currency; next[i].salary = c.salary } }
    return { ...f, countries_applying: next }
  })

  const clearDraft = () => {
    if (!confirm('Reset the form to the last saved profile values? Any unsaved edits will be lost.')) return
    localStorage.removeItem(`cv-draft-${profileId}`)
    // Reload profile values
    setFormReady(false)
    setReadiness(null)
    setStep(1)
    setTimeout(() => setStep(2), 50)
  }

  useEffect(() => {
    if (!previewHtml) { setPreviewUrl(null); return }
    const blob = new Blob([previewHtml], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [previewHtml])

  // Her broker set here: the readiness again (the block goes) and the broker's phone.
  // What was fixed here (a broker, a photo): kept on top of an older answer
  // (a phone with the PC off gets the PC's answer only once it has filed it).
  const fixedHere = useRef({})
  const reloadReadiness = async (setId) => {
    if (typeof setId === 'number' && setId > 0) fixedHere.current.broker_id = setId
    const withFixes = (d) => d && {
      ...d,
      has_photo: d.has_photo || !!fixedHere.current.has_photo,
      has_full_body_photo: d.has_full_body_photo || !!fixedHere.current.has_full_body_photo,
      profile: { ...(d.profile || {}), broker_id: d.profile?.broker_id || fixedHere.current.broker_id || null },
    }
    setReadiness(r => withFixes(r))
    try {
      const r = await api.get(`/cv/profile-readiness/${profileId}`, { adalNoCache: true })
      setReadiness(withFixes(r.data))
      const bid = r.data?.profile?.broker_id || fixedHere.current.broker_id
      if (bid) { try { setBroker((await api.get(`/brokers/${bid}`)).data) } catch {} }
    } catch {}
  }

  const validate = () => {
    if (!readiness) return 'Not ready'
    if (!readiness.profile?.broker_id) return 'Assign a broker to this profile first'
    if (!readiness.has_photo) return 'Upload a Photo for this profile'
    if (!readiness.has_full_body_photo) return 'Upload a Full Body Photo'
    if (!form.religion || !form.religion.trim()) return 'Religion is required'
    if (!form.marital_status || !form.marital_status.trim()) return 'Marital status is required'
    if (!templateId) return 'Pick a template'
    return null
  }

  // What the PC is asked for this CV (preview, PDF): the same body for both.
  const cvBody = (tid) => {
    const primary = form.countries_applying[0] || {}
    return {
      profile_id: Number(profileId),
      template_id: Number(tid),
      overrides: { __edits: editList(), ...form, country: primary.country || '', salary: primary.salary || 0, currency: primary.currency || 'SAR' },
    }
  }
  // Previews already drawn (by their body): opening one again, or the one made
  // ready behind the form, shows at once. The PDF of an open preview is made
  // behind it (/cv/prepare), so Download / Save as only copy it.
  const previews = useRef(new Map())
  const previewOf = (body) => {
    const key = JSON.stringify(body)
    const hit = previews.current.get(key)
    if (hit) return hit
    const p = api.post('/cv/preview', body, { responseType: 'text' }).then(r => r.data)
    p.catch(() => previews.current.delete(key))
    previews.current.set(key, p)
    if (previews.current.size > 12) previews.current.delete(previews.current.keys().next().value)
    return p
  }
  const onThePC = !window.__ADAL_CLOUD
  const prepared = useRef(new Set())
  const preparePdf = (body) => {
    if (!onThePC) return
    const key = JSON.stringify(body)
    if (prepared.current.has(key)) return
    prepared.current.add(key)
    api.post('/cv/prepare', body).catch(() => prepared.current.delete(key))
  }
  // The page opened with her: the PC starts its PDF browser and shrinks her pictures now.
  useEffect(() => {
    if (!onThePC || step !== 2 || !profileId || !templateId) return
    api.post('/cv/warm', { profile_id: Number(profileId), template_id: Number(templateId) }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, profileId, templateId])
  // The preview is drawn behind the form, a moment after the last change.
  useEffect(() => {
    if (!formReady || step !== 2 || showPreview || validate()) return
    const t = setTimeout(() => { previewOf(cvBody(templateId)).catch(() => {}) }, 700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, templateId, readiness, formReady, step, showPreview, textEdits])

  const openPreview = async (templateIdOverride) => {
    const err = validate()
    if (err) return toast.error(err)
    const tid = templateIdOverride || templateId
    setBusy(true)
    try {
      const body = cvBody(tid)
      const html = await previewOf(body)
      // Never a white page: an empty answer says so (and is not kept for the next look).
      if (!String(html || '').trim() || !/<(body|div|table|img|p)\b/i.test(String(html))) {
        previews.current.delete(JSON.stringify(body))
        throw new Error('The PC sent back an empty CV preview. Press Preview again; if it stays empty, open Settings → Health.')
      }
      setPreviewHtml(html)
      setPreviewTemplateId(String(tid))
      setTemplateId(String(tid))
      setShowPreview(true)
      preparePdf(body)
    } catch (e) {
      const msg = e.response?.data?.error || e.message || 'Preview failed'
      // Her pictures are listed but not on this device yet: the upload box shows instead of a CV without them.
      if (/not on this device yet/i.test(msg)) {
        const lostPhoto = /\bPhoto\b(?! )|^Photo/.test(msg.replace('Full Body Photo', ''))
        const lostBody = /Full Body Photo/.test(msg)
        setReadiness(r => r && ({ ...r, has_photo: r.has_photo && !lostPhoto, has_full_body_photo: r.has_full_body_photo && !lostBody }))
      }
      toast.error(msg)
    } finally { setBusy(false) }
  }

  // Makes the PDF and saves it straight to Downloads (no new tab to allow).
  // Save as: where and under what name is asked first (while the click still
  // counts), then the PDF is made and written there.
  const saveAs = async () => {
    const tid = (showPreview && previewTemplateId) || templateId
    const err = validate()
    if (err) return toast.error(err)
    const who = (readiness?.profile?.full_name || 'CV').replace(/[\\/:*?"<>|]+/g, ' ').trim()
    const tname = (templates.find(t => String(t.id) === String(tid))?.name || '').replace(/[\\/:*?"<>|]+/g, ' ').trim()
    const suggested = `${who}${tname ? ' - ' + tname : ''}.pdf`
    let handle = null, name = suggested
    // The PDF starts being made now, while the name is being chosen (it does not depend on the name).
    const job = api.post('/cv/generate', cvBody(tid))
    job.catch(() => {}) // a cancelled save must not leave an unhandled error
    if (window.showSaveFilePicker) {
      try { handle = await window.showSaveFilePicker({ suggestedName: suggested, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] }) }
      catch (e) { if (e?.name === 'AbortError') return; handle = null }
    }
    if (!handle) {
      const typed = window.prompt('Save the CV as:', suggested)
      if (typed == null) return
      name = /\.pdf$/i.test(typed.trim()) ? typed.trim() : `${typed.trim() || who}.pdf`
    }
    setSaving(true)
    const t = toast.loading('Making the PDF…')
    try {
      const res = await job
      if (res.data?.local_html) {
        // The PC is off: this phone made the CV itself (the PC files the same CV when it is on).
        const how = await pdfHere(res.data.local_html, name)
        toast.success(how === 'saved' ? `Saved: Downloads/Adal Keep/${name}` : 'Choose Save as PDF', { id: t, duration: 6000 })
        try { localStorage.removeItem('cv-draft-' + profileId) } catch {}
        return
      }
      if (res.data?.queued || !res.data?.download_url) {
        toast.success('Saved — the office PC makes the PDF when it is on; it then shows under CVs', { id: t, duration: 7000 })
        return
      }
      setGenResult(res.data)
      if (handle) {
        const blob = (await api.get(res.data.download_url.replace(/^\/api/, ''), { responseType: 'blob' })).data
        const w = await handle.createWritable()
        await w.write(blob); await w.close()
        toast.success(`Saved as ${handle.name}`, { id: t })
      } else {
        const a = document.createElement('a')
        a.href = res.data.download_url
        a.download = name
        document.body.appendChild(a); a.click(); a.remove()
        if (!window.Capacitor?.Plugins?.AdalDiscovery?.saveFile) toast.success(`Saved as ${name}`, { id: t })
        else toast.dismiss(t)
      }
      try { localStorage.removeItem('cv-draft-' + profileId) } catch {}
    } catch (e) { toast.error(e.response?.data?.error || e.message || 'Save failed', { id: t }) }
    finally { setSaving(false) }
  }

  const downloadCurrent = async () => {
    const tid = (showPreview && previewTemplateId) || templateId
    const err = validate()
    if (err) return toast.error(err)
    setSaving(true)
    const t = toast.loading('Making the PDF…')
    try {
      const res = await api.post('/cv/generate', cvBody(tid))
      // A phone with the office PC off: this phone makes the PDF itself (the PC files the same CV when it is on).
      if (res.data?.local_html) {
        const how = await pdfHere(res.data.local_html, res.data.filename || 'CV.pdf')
        toast.success(how === 'saved' ? `Saved: Downloads/Adal Keep/${res.data.filename || 'CV.pdf'}` : 'Choose Save as PDF', { id: t, duration: 6000 })
        try { localStorage.removeItem('cv-draft-' + profileId) } catch {}
        return
      }
      if (res.data?.queued || !res.data?.download_url) {
        toast.success('Saved — the office PC makes the PDF when it is on; it then shows under CVs', { id: t, duration: 7000 })
        try { localStorage.removeItem('cv-draft-' + profileId) } catch {}
        return
      }
      setGenResult(res.data)
      const a = document.createElement('a')
      a.href = res.data.download_url
      a.download = res.data.filename || 'CV.pdf'
      document.body.appendChild(a); a.click(); a.remove()
      // (In the phone app the click is caught and the PDF saved to Downloads — lib/phoneSave.js.)
      if (!window.Capacitor?.Plugins?.AdalDiscovery?.saveFile) toast.success('PDF downloaded', { id: t })
      else toast.dismiss(t)
      try { localStorage.removeItem('cv-draft-' + profileId) } catch {}
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed', { id: t }) }
    finally { setSaving(false) }
  }

  const generate = () => openPreview()

  // ===== STEP 1 =====
  if (step === 1) {
    return (
      <div className="animate-fade-up space-y-6">
        <PageHeader title="New CV — pick profile" subtitle="Search by name, phone, or passport"
          action={<Button variant="secondary" onClick={() => navigate('/cvs')}>Cancel</Button>} />
        <div className="panel p-4">
          <Input placeholder="Search profiles…" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {profiles.map(p => (
            <button key={p.id} className="panel p-4 text-left hover:-translate-y-0.5 transition"
              onClick={() => { setProfileId(String(p.id)); setStep(2) }}>
              <div className="font-display font-bold text-slate-900 dark:text-white truncate">{p.full_name}</div>
              <div className="text-xs text-slate-500 mt-1">Passport: {p.passport_number || '—'}</div>
              <div className="text-xs text-slate-500">Broker: {p.broker_name || 'UNASSIGNED'}</div>
            </button>
          ))}
          {profiles.length === 0 && <p className="text-sm text-slate-400 col-span-3 text-center py-10">No profiles match</p>}
        </div>
      </div>
    )
  }

  if (busy && !readiness) return <div className="flex h-64 items-center justify-center"><Spinner /></div>

  const p = readiness?.profile || {}
  const skills = form.skills || {}
  const blocker = validate()

  // ===== STEP 2 =====
  // One clean form (asked on 2026-11-20: "make creating CV clean"): what the
  // passport gave sits under her name, each thing is asked once, and one bar
  // at the bottom holds Preview and PDF (Save as… is in the preview).
  const known = [p.passport_number, p.date_of_birth, p.nationality, p.place_of_birth].filter(Boolean).join(' · ')

  return (
    <div className="animate-fade-up space-y-4 pb-28 max-w-4xl mx-auto">
      <PageHeader
        title={p.full_name || 'CV'}
        subtitle={known || undefined}
        action={<span className="hidden md:inline-flex"><Button variant="secondary" onClick={() => { setStep(1); setGenResult(null) }}>← Back</Button></span>}
      />

      {/* What still stops the CV: fixed right here (a phone has no other page open). */}
      {blocker && (
        <div className="panel p-4 border-l-4 border-l-amber-500">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">{blocker}</p>
          {!readiness?.profile?.broker_id ? (
            <PickBrokerHere profileId={profileId} onDone={reloadReadiness} />
          ) : (!readiness?.has_photo || !readiness?.has_full_body_photo) && (
            <UploadPhotoHere profileId={profileId} field={!readiness?.has_photo ? 'Photo' : 'Full Body Photo'}
              onDone={(f) => { fixedHere.current[f === 'Photo' ? 'has_photo' : 'has_full_body_photo'] = true; reloadReadiness() }} />
          )}
        </div>
      )}

      {genResult && (
        <div className="panel flex items-center justify-between gap-3 p-3 border-l-4 border-l-teal-500">
          <p className="min-w-0 truncate text-sm font-semibold text-teal-700 dark:text-teal-300">✓ {genResult.filename}</p>
          <div className="flex shrink-0 gap-2">
            <a href={genResult.download_url} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white">Open</a>
            <button onClick={() => setGenResult(null)} className="rounded-lg px-2 py-1.5 text-xs text-slate-500">✕</button>
          </div>
        </div>
      )}

      <Section title="Her details">
        {readiness?.profile?.broker_id && (
          <div className="mb-3">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Broker</span>
            <PickBrokerHere profileId={profileId} current={readiness.profile.broker_id} onDone={reloadReadiness} />
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Pick label="Religion" value={form.religion} onChange={e => upd('religion', e.target.value)}>
            <option value="">—</option>
            <option>Muslim</option><option>Christian</option>
            {form.religion && !RELIGIONS.includes(form.religion) && <option>{form.religion}</option>}
          </Pick>
          <Pick label="Marital status" value={form.marital_status} onChange={e => upd('marital_status', e.target.value)}>
            <option value="">—</option>
            <option value="SINGLE">Single</option><option value="MARRIED">Married</option>
          </Pick>
          <Input label="Children" value={form.children_count} onChange={e => upd('children_count', e.target.value)} />
          <Input label="Education" value={form.education_level} onChange={e => upd('education_level', e.target.value)} />
          <Input label="Weight" value={form.weight} onChange={e => upd('weight', e.target.value)} />
          <Input label="Height" value={form.height} onChange={e => upd('height', e.target.value)} />
          <Input label="Mother's name" value={form.mother_name} onChange={e => upd('mother_name', e.target.value)} />
          <Input label="Father's name" value={form.father_name} onChange={e => upd('father_name', e.target.value)} />
          <Input label="Phone" value={form.personal_number} onChange={e => upd('personal_number', e.target.value)} placeholder={broker?.contact1 || ''} />
          <Input label="Labor ID" value={form.labor_id} onChange={e => upd('labor_id', e.target.value)} />
          <Pick label="Region" value={form.region} onChange={e => { upd('region', e.target.value); upd('zone_subcity', '') }}>
            <option value="">—</option>
            {REGIONS.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
          </Pick>
          <Pick label={regionObj?.label || 'Zone / Sub City'} value={form.zone_subcity} onChange={e => upd('zone_subcity', e.target.value)} disabled={!regionObj}>
            <option value="">—</option>
            {regionObj?.areas.map(a => <option key={a} value={a}>{a}</option>)}
          </Pick>
        </div>
      </Section>

      <Section title="Languages and skills">
        {/* A ticked language speaks it; read and write only when ticked. */}
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          {[['english', 'English', 'speaks_english'], ['arabic', 'Arabic', 'speaks_arabic']].map(([k, label, speak]) => (
            <div key={k} className="flex items-center gap-3 text-sm">
              <span className="w-14 font-medium">{label}</span>
              {[[speak, 'Speak'], [`${k}_read`, 'Read'], [`${k}_write`, 'Write']].map(([f, word]) => (
                <label key={f} className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={f === speak ? !!(form[speak] || form[`${k}_read`] || form[`${k}_write`]) : !!form[f]}
                    onChange={e => { const v = e.target.checked; upd(f, v); if (f === speak && !v) { upd(`${k}_read`, false); upd(`${k}_write`, false) } }} /> {word}
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
          {Object.keys(DEFAULT_SKILLS).map(k => (
            <label key={k} className="inline-flex items-center gap-2 text-sm capitalize">
              <input type="checkbox" checked={!!skills[k]} onChange={e => upd('skills', { ...skills, [k]: e.target.checked })} />
              {k.replace('_', ' ')}
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <span className="text-xs text-slate-500">Cooking</span>
          {['Cooking', 'Cooking Helper', 'None'].map(v => (
            <label key={v} className="inline-flex items-center gap-2">
              <input type="radio" checked={form.cooking_skill === v} onChange={() => upd('cooking_skill', v)} /> {v === 'Cooking' ? 'Cook' : v === 'Cooking Helper' ? 'Helper' : 'None'}
            </label>
          ))}
        </div>
      </Section>

      <Section title="Emergency contact">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Name" value={form.emergency_name} onChange={e => upd('emergency_name', e.target.value)} placeholder={fatherFull({ ...p, ...form }) || ''} />
          <Input label="Phone" value={form.emergency_phone} onChange={e => upd('emergency_phone', e.target.value)} placeholder={broker?.contact1 || ''} />
          <Pick label="Gender" value={form.emergency_gender} onChange={e => upd('emergency_gender', e.target.value)}>
            <option>Male</option><option>Female</option>
          </Pick>
          <Input label="Relationship" value={form.emergency_relationship} onChange={e => upd('emergency_relationship', e.target.value)} />
        </div>
      </Section>

      <Section title="Worked abroad" action={<button onClick={addExperience} className="text-xs font-semibold text-teal-600 hover:underline">+ Add</button>}>
        {form.previous_employment.length === 0 && <p className="text-xs text-slate-400">None</p>}
        {form.previous_employment.map((exp, i) => (
          <div key={i} className="mt-2 grid gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-3">
            <Pick label="Country" value={exp.country} onChange={e => updExperience(i, 'country', e.target.value)}>
              <option value="">—</option>
              {WORK_COUNTRIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </Pick>
            <Input label="From" type="date" value={exp.from || ''} onChange={e => updExperience(i, 'from', e.target.value)} />
            <Input label="To" type="date" value={exp.to || ''} onChange={e => updExperience(i, 'to', e.target.value)} />
            <Input label="Position" value={exp.position || ''} onChange={e => updExperience(i, 'position', e.target.value)} />
            <Input label="Salary" type="number" value={exp.salary || ''} onChange={e => updExperience(i, 'salary', e.target.value)} />
            <div className="flex items-end gap-2">
              <div className="flex-1"><Input label="Currency" value={exp.currency || ''} onChange={e => updExperience(i, 'currency', e.target.value)} /></div>
              <button onClick={() => removeExperience(i)} className="mb-2 text-xs text-red-500" aria-label="Remove">✕</button>
            </div>
          </div>
        ))}
      </Section>

      <Section title="Going to" action={<button onClick={addCountry} className="text-xs font-semibold text-teal-600 hover:underline">+ Add</button>}>
        {form.countries_applying.map((c, i) => (
          <div key={i} className="mt-2 grid gap-2 sm:grid-cols-3">
            <Pick label="Country" value={c.country} onChange={e => updCountry(i, 'country', e.target.value)}>
              <option value="">—</option>
              {COUNTRIES_APPLY.map(x => <option key={x.name} value={x.name}>{x.name}</option>)}
            </Pick>
            <Input label="Salary" type="number" value={c.salary || ''} onChange={e => updCountry(i, 'salary', e.target.value)} />
            <div className="flex items-end gap-2">
              <div className="flex-1"><Input label="Currency" value={c.currency || ''} onChange={e => updCountry(i, 'currency', e.target.value)} /></div>
              {form.countries_applying.length > 1 && <button onClick={() => removeCountry(i)} className="mb-2 text-xs text-red-500" aria-label="Remove">✕</button>}
            </div>
          </div>
        ))}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Input label="Contract years" type="number" value={form.contract_years} onChange={e => upd('contract_years', e.target.value)} />
          <Input label="Ref. No." value={form.ref_no} onChange={e => upd('ref_no', e.target.value)} />
        </div>
      </Section>

      <Section title="Template">
        {templates.length === 0 ? (
          <button className="text-sm text-teal-600 underline" onClick={() => navigate('/cvs/templates')}>Upload a template</button>
        ) : (
          <div className="flex flex-wrap gap-2">
            {templates.map(t => (
              <button key={t.id} type="button" onClick={() => { setTemplateId(String(t.id)); openPreview(String(t.id)) }}
                className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${String(templateId) === String(t.id)
                  ? 'border-teal-500 bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800/40'}`}>
                {t.name}
              </button>
            ))}
          </div>
        )}
      </Section>

      <div className="text-center">
        <button onClick={clearDraft} className="text-xs text-slate-400 hover:underline" title="Back to the values saved in her profile">Start again</button>
      </div>

      {/* One bar for what is done with the CV. */}
      {/* (Under 768 px the phone's tab bar is at the very bottom: this bar sits on it.) */}
      <div className="fixed inset-x-0 bottom-0 max-md:bottom-[calc(51px+env(safe-area-inset-bottom))] z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
        <div className="mx-auto flex max-w-4xl items-center justify-center gap-3">
          <Button variant="secondary" onClick={generate} isLoading={busy} disabled={!!blocker}>Preview</Button>
          <Button onClick={downloadCurrent} isLoading={saving} disabled={!!blocker}>⬇ PDF</Button>
        </div>
      </div>
          {/* Preview modal */}
      {showPreview && previewUrl && createPortal(
<div className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center p-2 sm:p-4"
          onClick={() => setShowPreview(false)}>
          <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-[98vw] max-w-[1600px] h-[96vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}>

            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0 gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-800 dark:text-white">CV Preview</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={downloadCurrent}
                  disabled={saving}
                  className="px-4 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold hover:bg-teal-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : '⬇ Download PDF'}
                </button>
                <button
                  onClick={saveAs}
                  disabled={saving}
                  title="Choose where to save it and its name"
                  className="px-4 py-1.5 rounded-lg border border-teal-600 text-teal-700 dark:text-teal-300 text-xs font-semibold hover:bg-teal-50 dark:hover:bg-teal-900/30 disabled:opacity-50"
                >
                  💾 Save as…
                </button>
                <button
                  onClick={() => setShowPreview(false)}
                  className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 flex items-center justify-center"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Template tabs */}
            <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-700 flex items-center gap-2 overflow-x-auto shrink-0">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 shrink-0">Agency:</span>
              {templates.map(t => (
                <button
                  key={t.id}
                  onClick={() => openPreview(String(t.id))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition ${
                    String(previewTemplateId) === String(t.id)
                      ? 'bg-teal-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>

            {/* Iframe */}
            <iframe
              src={previewUrl}
              title="CV Preview — double-click a text to change it"
              className="flex-1 w-full border-0 bg-white"
              // A phone: the A4 page shrinks to the screen's width (nothing cut off on the right).
              onLoad={(e) => {
                try {
                  const f = e.currentTarget, d = f.contentDocument
                  if (!d?.documentElement) return
                  d.documentElement.style.zoom = ''
                  // Double-click a text to change it; it is kept for the PDF.
                  d.addEventListener('dblclick', (ev) => {
                    let el = ev.target
                    while (el && el !== d.body && !(el.childNodes.length && [...el.childNodes].every(c => c.nodeType === 3 || c.nodeName === 'BR'))) el = el.parentElement
                    if (!el || el === d.body || !el.textContent.trim()) return
                    if (el.isContentEditable) return
                    const before = el.textContent.trim()
                    const first = Object.entries(editsRef.current).find(([, to]) => to.trim() === before)?.[0] || before
                    el.contentEditable = 'true'
                    el.style.outline = '2px solid #14b8a6'
                    el.focus()
                    const done = () => {
                      el.contentEditable = 'false'; el.style.outline = ''
                      const now = el.textContent.trim()
                      if (now === before) return
                      editsRef.current = { ...editsRef.current, [first]: now }
                      if (now === first) { const { [first]: _, ...rest } = editsRef.current; editsRef.current = rest }
                      setTextEdits(editsRef.current)
                      // The PDF behind follows the words changed here.
                      preparePdf(cvBody(previewTemplateId || templateId))
                    }
                    el.addEventListener('blur', done, { once: true })
                    el.addEventListener('keydown', (k) => { if (k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); el.blur() } if (k.key === 'Escape') { el.textContent = before; el.blur() } })
                  })
                  // The A4 page fills the preview's width, bigger or smaller (it used to stay
                  // at its own size on a wide screen, leaving the right side empty).
                  const k = (f.clientWidth - 24) / 794 // 794 px = A4 width (210 mm)
                  if (k > 0) d.documentElement.style.zoom = String(Math.min(2.5, Math.max(0.3, k)))
                } catch {}
              }}
            />
          </div>
        </div>
      ,
        document.body
      )/* CV_MODAL_PORTAL */}


      </div>

  )
}

// The CV form's pieces (outside the page: inside it every key typed would rebuild them and lose the box).
function Section({ title, action, children }) {
  return (
  <section className="panel p-4 sm:p-5">
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-sm font-bold text-slate-900 dark:text-white">{title}</h3>
      {action}
    </div>
    {children}
  </section>
  )
}
function Pick({ label, value, onChange, children, disabled }) {
  return (
  <div>
    <label className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1 block">{label}</label>
    <GlassSelect className="field w-full" value={value} onChange={onChange} disabled={disabled}>{children}</GlassSelect>
  </div>
  )
}
