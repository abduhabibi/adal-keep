import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Button from '../components/shared/Button'
import Input from '../components/shared/Input'
import Spinner from '../components/shared/Spinner'
import { REGIONS, regionByName, WORK_COUNTRIES, COUNTRIES_APPLY } from '../lib/regions'

const DEFAULT_SKILLS = { cleaning: true, ironing: true, washing: true, baby_sitting: true }

const DEFAULT_FORM = {
  religion: '', marital_status: 'SINGLE', children_count: '',
  weight: 'Normal', height: 'Normal', complexion: '', living_town: '',
  mother_name: '', father_name: '', spouse_name: '',
  education_level: 'New', speaks_english: false, speaks_arabic: false,
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

      const base = {
        ...DEFAULT_FORM,
        religion: p.religion || '',
        marital_status: p.marital_status || 'SINGLE',
        children_count: p.children_count ?? '',
        weight: p.weight || 'Normal',
        height: p.height || 'Normal',
        complexion: p.complexion || '',
        living_town: p.living_town || p.place_of_birth || '',
        mother_name: p.mother_name || '',
        father_name: p.father_name || '',
        spouse_name: p.spouse_name || '',
        education_level: p.education_level || 'New',
        phone_number: p.phone_number || brokerObj?.contact1 || '',
        speaks_english: !!p.speaks_english,
        speaks_arabic: !!p.speaks_arabic,
        skills, previous_employment: prev,
        cooking_skill: p.cooking_skill || 'None',
        region: p.region || '',
        zone_subcity: p.zone_subcity || '',
        labor_id: p.labor_id || '',
        personal_number: p.personal_number || brokerObj?.contact1 || '',
        emergency_name: p.emergency_name || p.father_name || '',
        emergency_phone: p.emergency_phone || brokerObj?.contact1 || '',
        emergency_gender: p.emergency_gender || 'Male',
        emergency_relationship: p.emergency_relationship || 'Father',
      }

      // Apply localStorage draft overrides (user's unsaved edits)
      const draftRaw = localStorage.getItem(`cv-draft-${profileId}`)
      if (draftRaw) {
        try {
          const draft = JSON.parse(draftRaw)
          Object.assign(base, draft)
          console.log('[CV] restored draft for', profileId)
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
  useEffect(() => {
    if (!formReady || !profileId) return
    try { localStorage.setItem(`cv-draft-${profileId}`, JSON.stringify(form)) } catch {}
  }, [form, formReady, profileId])

  // AUTO_GENERATE_EFFECT — when arriving with ?auto=1 and everything is ready, open preview
  useEffect(() => {
    if (params.get('auto') !== '1') return
    if (!readiness) return
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
  }, [readiness, templates])

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

  const validate = () => {
    if (!readiness) return 'Not ready'
    if (!readiness.profile?.broker_id) return 'Assign a broker to this profile first'
    if (!readiness.has_photo) return 'Upload a Photo for this profile'
    if (!readiness.has_full_body_photo) return 'Upload a Full Body Photo'
    if (!form.labor_id?.trim()) return 'Labor ID is required'
    if (!form.religion || !form.religion.trim()) return 'Religion is required'
    if (!form.marital_status || !form.marital_status.trim()) return 'Marital status is required'
    if (!templateId) return 'Pick a template'
    return null
  }

  const openPreview = async (templateIdOverride) => {
    const err = validate()
    if (err) return toast.error(err)
    const tid = templateIdOverride || templateId
    setBusy(true)
    try {
      const primary = form.countries_applying[0] || {}
      const r = await api.post('/cv/preview', {
        profile_id: Number(profileId),
        template_id: Number(tid),
        overrides: {
          ...form,
          country: primary.country || '',
          salary: primary.salary || 0,
          currency: primary.currency || 'SAR',
        },
      }, { responseType: 'text' })
      setPreviewHtml(r.data)
      setPreviewTemplateId(String(tid))
      setTemplateId(String(tid))
      setShowPreview(true)
    } catch (e) {
      toast.error(e.response?.data?.error || 'Preview failed')
    } finally { setBusy(false) }
  }

  const downloadCurrent = async () => {
    if (!previewTemplateId) return
    setSaving(true)
    try {
      const primary = form.countries_applying[0] || {}
      const res = await api.post('/cv/generate', {
        profile_id: Number(profileId),
        template_id: Number(previewTemplateId),
        overrides: {
          ...form,
          country: primary.country || '',
          salary: primary.salary || 0,
          currency: primary.currency || 'SAR',
        },
      })
      toast.success('PDF saved')
      setGenResult(res.data)
      // Trigger the browser download
      window.open(res.data.download_url, '_blank')
      try { localStorage.removeItem('cv-draft-' + profileId) } catch {}
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed') }
    finally { setSaving(false) }
  }

  const generate = () => openPreview()

  const reformat = async (newTemplateId) => {
    if (!genResult?.generated_cv_id) return
    setBusy(true)
    try {
      const res = await api.post(`/cv/generated/${genResult.generated_cv_id}/reformat`, { template_id: Number(newTemplateId) })
      setGenResult(res.data); setTemplateId(String(newTemplateId))
      toast.success('Reformatted')
    } catch (e) { toast.error(e.response?.data?.error || 'Reformat failed') }
    finally { setBusy(false) }
  }

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
  return (
    <div className="animate-fade-up space-y-5 pb-24 max-w-5xl mx-auto">
      <PageHeader
        title={`CV — ${p.full_name || '—'}`}
        subtitle={broker?.name ? `Broker: ${broker.name}` : 'Broker not assigned'}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => { setStep(1); setGenResult(null) }}>← Back</Button>
            <button
              onClick={clearDraft}
              className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              title="Reset the form to the last saved profile values"
            >Reset</button>
            <Button onClick={generate} isLoading={busy} disabled={!!blocker}>Preview &amp; Save</Button>
          </div>
        }
      />

      {/* Blocker card — one consolidated message */}
      {blocker && (
        <div className="panel p-4 border-l-4 border-l-red-500">
          <p className="text-sm font-semibold text-red-700 dark:text-red-400">⚠ {blocker}</p>
          <p className="text-xs text-slate-500 mt-1">
            Fix this on the profile page, then come back. Your form input is being saved automatically.
          </p>
        </div>
      )}

      {/* Generated result */}
      {genResult && (
        <div className="panel p-4 border-l-4 border-l-purple-500 bg-purple-50/30 dark:bg-purple-900/10">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <p className="text-sm font-semibold text-purple-700 dark:text-purple-400">✅ CV Generated</p>
              <p className="text-xs text-slate-500 mt-1">{genResult.filename}</p>
            </div>
            <div className="flex gap-2">
              <a href={genResult.download_url} target="_blank" rel="noopener noreferrer"
                className="px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs">Download</a>
              <button onClick={() => setGenResult(null)} className="px-3 py-1.5 rounded-lg bg-slate-200 dark:bg-slate-700 text-xs">Close</button>
            </div>
          </div>
          <p className="text-xs text-slate-500 mb-2">Change format without re-entering:</p>
          <div className="flex flex-wrap gap-2">
            {templates.filter(t => String(t.id) !== String(templateId)).map(t => (
              <button key={t.id} onClick={() => reformat(t.id)} disabled={busy}
                className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 hover:border-purple-400 transition">
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Auto-filled summary */}
      <section className="panel p-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Auto-filled from passport</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
          <div><div className="text-slate-400">Full name</div><div className="font-medium truncate">{p.full_name || '—'}</div></div>
          <div><div className="text-slate-400">Passport</div><div className="font-medium">{p.passport_number || '—'}</div></div>
          <div><div className="text-slate-400">Date of birth</div><div className="font-medium">{p.date_of_birth || '—'}</div></div>
          <div><div className="text-slate-400">Nationality</div><div className="font-medium">{p.nationality || '—'}</div></div>
          <div><div className="text-slate-400">Place of birth</div><div className="font-medium truncate">{p.place_of_birth || '—'}</div></div>
          <div><div className="text-slate-400">Broker phone</div><div className="font-medium">{broker?.contact1 || '—'}</div></div>
        </div>
      </section>

      {/* Fill in details */}
      <section className="panel p-5 space-y-5">
        <h3 className="font-display text-lg font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-700 pb-3">Fill in details</h3>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1 block">Religion</label>
            <select className="field w-full" value={form.religion} onChange={e => upd('religion', e.target.value)}>
              <option value="">— Select —</option>
              <option>Muslim</option><option>Orthodox</option><option>Protestant</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1 block">Marital status</label>
            <select className="field w-full" value={form.marital_status} onChange={e => upd('marital_status', e.target.value)}>
              <option value="SINGLE">Single</option><option value="MARRIED">Married</option>
            </select>
          </div>
          <Input label="Children count" value={form.children_count} onChange={e => upd('children_count', e.target.value)} />
          <Input label="Weight" value={form.weight} onChange={e => upd('weight', e.target.value)} />
          <Input label="Height" value={form.height} onChange={e => upd('height', e.target.value)} />
          <Input label="Complexion" value={form.complexion} onChange={e => upd('complexion', e.target.value)} />
          <Input label="Living town" value={form.living_town} onChange={e => upd('living_town', e.target.value)} />
          <Input label="Education" value={form.education_level} onChange={e => upd('education_level', e.target.value)} />
          <Input label="Mother's name" value={form.mother_name} onChange={e => upd('mother_name', e.target.value)} />
          <Input label="Father's name" value={form.father_name} onChange={e => upd('father_name', e.target.value)} />
          <Input label="Spouse name" value={form.spouse_name} onChange={e => upd('spouse_name', e.target.value)} />
          <Input label="Personal number" value={form.personal_number} onChange={e => upd('personal_number', e.target.value)} placeholder={broker?.contact1 || ''} />
          <Input label="Labor ID *" value={form.labor_id} onChange={e => upd('labor_id', e.target.value)} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 pt-2 border-t border-slate-100 dark:border-slate-700">
          <div>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1 block">Region</label>
            <select className="field w-full" value={form.region} onChange={e => { upd('region', e.target.value); upd('zone_subcity', '') }}>
              <option value="">— Select —</option>
              {REGIONS.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1 block">{regionObj?.label || 'Zone / Sub City'}</label>
            <select className="field w-full" value={form.zone_subcity} onChange={e => upd('zone_subcity', e.target.value)} disabled={!regionObj}>
              <option value="">— Select —</option>
              {regionObj?.areas.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>

        <div className="flex gap-4 pt-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.speaks_english} onChange={e => upd('speaks_english', e.target.checked)} /> English
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.speaks_arabic} onChange={e => upd('speaks_arabic', e.target.checked)} /> Arabic
          </label>
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-700">
          <p className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">Emergency contact</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" value={form.emergency_name} onChange={e => upd('emergency_name', e.target.value)} placeholder={form.father_name || 'Father name'} />
            <Input label="Phone" value={form.emergency_phone} onChange={e => upd('emergency_phone', e.target.value)} placeholder={broker?.contact1 || 'Broker phone'} />
            <div>
              <label className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1 block">Gender</label>
              <select className="field w-full" value={form.emergency_gender} onChange={e => upd('emergency_gender', e.target.value)}>
                <option>Male</option><option>Female</option>
              </select>
            </div>
            <Input label="Relationship" value={form.emergency_relationship} onChange={e => upd('emergency_relationship', e.target.value)} />
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-700">
          <p className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">Skills</p>
          <div className="flex flex-wrap gap-4">
            {Object.keys(DEFAULT_SKILLS).map(k => (
              <label key={k} className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!!skills[k]} onChange={e => upd('skills', { ...skills, [k]: e.target.checked })} />
                {k.replace('_', ' ')}
              </label>
            ))}
          </div>
          <div className="mt-3">
            <p className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">Cooking skills</p>
            <div className="flex flex-wrap gap-4">
              {['Cooking', 'Cooking Helper', 'None'].map(v => (
                <label key={v} className="inline-flex items-center gap-2 text-sm">
                  <input type="radio" checked={form.cooking_skill === v} onChange={() => upd('cooking_skill', v)} /> {v}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Work experience abroad</p>
            <button onClick={addExperience} className="text-xs text-teal-600 hover:underline">+ Add experience</button>
          </div>
          {form.previous_employment.length === 0 && <p className="text-xs text-slate-400 italic">No previous employment</p>}
          {form.previous_employment.map((exp, i) => (
            <div key={i} className="mt-2 p-3 rounded-lg border border-slate-200 dark:border-slate-700 grid gap-2 sm:grid-cols-3">
              <div className="sm:col-span-3 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500">Experience #{i+1}</span>
                <button onClick={() => removeExperience(i)} className="text-xs text-red-500">Remove</button>
              </div>
              <div>
                <label className="text-[11px] text-slate-500 block mb-1">Country</label>
                <select className="field w-full" value={exp.country} onChange={e => updExperience(i, 'country', e.target.value)}>
                  <option value="">— Select —</option>
                  {WORK_COUNTRIES.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
              </div>
              <Input label="From" type="date" value={exp.from || ''} onChange={e => updExperience(i, 'from', e.target.value)} />
              <Input label="To" type="date" value={exp.to || ''} onChange={e => updExperience(i, 'to', e.target.value)} />
              <Input label="Position" value={exp.position || ''} onChange={e => updExperience(i, 'position', e.target.value)} />
              <Input label="Salary" type="number" value={exp.salary || ''} onChange={e => updExperience(i, 'salary', e.target.value)} />
              <Input label="Currency" value={exp.currency || ''} onChange={e => updExperience(i, 'currency', e.target.value)} />
            </div>
          ))}
        </div>
      </section>

      {/* Country + template */}
      <section className="panel p-5 space-y-5">
        <h3 className="font-display text-lg font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-700 pb-3">Country & template</h3>

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Country applying to</p>
            <button onClick={addCountry} className="text-xs text-teal-600 hover:underline">+ Add country</button>
          </div>
          {form.countries_applying.map((c, i) => (
            <div key={i} className="mt-2 p-3 rounded-lg border border-slate-200 dark:border-slate-700 grid gap-2 sm:grid-cols-3">
              <div className="sm:col-span-3 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-500">Country #{i+1}</span>
                {form.countries_applying.length > 1 && <button onClick={() => removeCountry(i)} className="text-xs text-red-500">Remove</button>}
              </div>
              <div>
                <label className="text-[11px] text-slate-500 block mb-1">Country</label>
                <select className="field w-full" value={c.country} onChange={e => updCountry(i, 'country', e.target.value)}>
                  <option value="">— Select —</option>
                  {COUNTRIES_APPLY.map(x => <option key={x.name} value={x.name}>{x.name}</option>)}
                </select>
              </div>
              <Input label="Salary" type="number" value={c.salary || ''} onChange={e => updCountry(i, 'salary', e.target.value)} />
              <Input label="Currency" value={c.currency || ''} onChange={e => updCountry(i, 'currency', e.target.value)} />
            </div>
          ))}
          <div className="grid gap-3 sm:grid-cols-2 mt-3">
            <Input label="Contract years" type="number" value={form.contract_years} onChange={e => upd('contract_years', e.target.value)} />
            <Input label="Ref. No." value={form.ref_no} onChange={e => upd('ref_no', e.target.value)} />
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-700">
          <p className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide">Template</p>
          {templates.length === 0 ? (
            <div className="text-sm text-slate-500 text-center py-4">
              No templates yet.
              <button className="block mt-2 text-teal-600 underline mx-auto" onClick={() => navigate('/cvs/templates')}>Upload templates</button>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {templates.map(t => (
                <button key={t.id} type="button" onClick={() => setTemplateId(String(t.id))}
                  className={`text-left p-3 rounded-xl border transition ${
                    String(templateId) === String(t.id)
                      ? 'border-teal-500 bg-teal-50/60 dark:bg-teal-900/20'
                      : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}>
                  <div className="font-semibold text-sm text-slate-900 dark:text-white truncate">{t.name}</div>
                  <div className="text-[11px] text-slate-500 truncate">{t.agency_name || '—'}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-700 flex justify-end">
          <Button onClick={generate} isLoading={busy} disabled={!!blocker}>Preview &amp; Save</Button>
        </div>
      </section>
          {/* Preview modal */}
      {showPreview && previewUrl && createPortal(
<div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4"
          onClick={() => setShowPreview(false)}>
          <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-[98vw] max-w-[1600px] h-[96vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}>

            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0 gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-800 dark:text-white">CV Preview</p>
                <p className="text-[11px] text-slate-500 truncate">Switch template below — the preview updates instantly. Download to save as PDF.</p>
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
              title="CV Preview"
              className="flex-1 w-full border-0 bg-white"
            />
          </div>
        </div>
      ,
        document.body
      )/* CV_MODAL_PORTAL */}


      </div>

  )
}
