import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import { REGIONS, regionByName } from '../lib/regions'
import { useAuth } from '../context/AuthContext'
import PassportFirst from '../components/PassportFirst'

const STATUS_OPTIONS_AM = [
  { value: 'pending', label: 'በመጠባበቅ ላይ' },
  { value: 'in_progress', label: 'በሂደት ላይ' },
  { value: 'completed', label: 'የተጠናቀቀ' },
  { value: 'medical_applied', label: 'ሕክምና › ተመዝግቧል (Applied)', group: 'medical' },
  { value: 'medical_fit', label: 'ሕክምና › ብቁ (Fit)', group: 'medical' },
  { value: 'medical_rejected', label: 'ሕክምና › ውድቅ (Rejected)', group: 'medical' },
]

// Work experience: Musaned's "Experience" field. Countries A→Z.
const EXPERIENCE_OPTIONS = ['No experience', 'Have experience']
const EXPERIENCE_COUNTRIES = [
  'Bahrain', 'Jordan', 'Kuwait', 'Oman', 'Qatar', 'Saudi Arabia', 'United Arab Emirates',
]

// Empty / missing children count is 0; any number in the database is kept.
const childrenOrZero = (v) => (v === null || v === undefined || String(v).trim() === '' ? 0 : Number(v) || 0)

// Visa & Contract fields (Musaned employment request).
const CONTRACT_KEYS = ["contract_number", "visa_number", "tawassut_number", "musaned_stage", "musaned_payment", "contract_date", "employer_name", "employer_id", "employer_phone", "employer_address", "work_city", "salary", "issuing_authority", "job_title", "musaned_pro"]
const HIDDEN_EXTRA = /^(card|stages)$/
function contractView(p) {
  let data = {}
  try { data = JSON.parse(p.contract_data || '{}') } catch {}
  return {
    chosen_at: p.chosen_at || null,
    checked_at: p.contract_checked_at || null,
    extra: Object.entries(data).filter(([k, v]) => !HIDDEN_EXTRA.test(k) && typeof v === 'string' && v.trim()),
  }
}

const emptyForm = {
  destination_country: '',
  full_name: '',
  order_id: '',
  phone_number: '',
  phone_number_2: '',
  national_id: '',
  passport_number: '',
  status: 'pending',
  broker_id: '',
  notes: '',
  religion: '',
  marital_status: '',
  gender: '',
  children_count: 0,
  weight: 'Normal',
  height: 'Normal',
  education_level: '',
  mother_name: '',
  father_name: '',
  region: '',
  zone_subcity: '',
  labor_id: '',
  work_experience: 'No experience',
  experience_country: '',
  experience_years: '',
  personal_number: '',
  emergency_name: '',
  emergency_phone: '',
  emergency_gender: 'Male',
  emergency_relationship: 'Father',
  cooking_skill: 'None',
  speaks_english: false,
  speaks_arabic: false,
  complexion: '',
  spouse_name: '',
  skills: '',
  previous_employment: '',
  contract_number: '',
  visa_number: '',
  tawassut_number: '',
  musaned_stage: '',
  musaned_payment: '',
  contract_date: '',
  employer_name: '',
  employer_id: '',
  employer_phone: '',
  employer_address: '',
  work_city: '',
  salary: '',
  issuing_authority: '',
  job_title: '',
  musaned_pro: '',
}

export default function ProfileFormPage() {
  const { id } = useParams()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const { activeEmployee, user } = useAuth()
  const [form, setForm] = useState(emptyForm)
  const [brokers, setBrokers] = useState([])
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  // New profile: the passport comes first (PassportFirst), then a short form.
  const [step, setStep] = useState(isEdit ? 'form' : 'passport')
  const [passport, setPassport] = useState(null)   // what was read + the waiting upload
  const [showAll, setShowAll] = useState(isEdit)
  const [contract, setContract] = useState({ chosen_at: null, checked_at: null, extra: [] })
  const [checkingContract, setCheckingContract] = useState(false)

  // Look this profile up on Musaned now (the same check that runs every 4 hours).
  const checkContractNow = async () => {
    setCheckingContract(true)
    try {
      const r = await api.post('/contracts/check', { profile_id: Number(id) })
      const one = r.data?.results?.[0]
      if (r.data?.busy) toast('The contract check is already running — try again in a minute.', { icon: '⏳' })
      else if (one?.state === 'signed-out') toast.error('Musaned is signed out: sign in in the Adal Keep Brave, then press again.', { duration: 8000 })
      else if (one?.state === 'not-chosen') toast('Nobody has chosen her on Musaned yet.', { icon: 'ℹ️' })
      else if (one?.state === 'error') toast.error(`Musaned: ${one.error}`, { duration: 8000 })
      else if (one?.state === 'chosen') {
        const p = (await api.get(`/profiles/${id}`)).data
        setForm(f => ({ ...f, ...Object.fromEntries(CONTRACT_KEYS.map(k => [k, p[k] || ''])) }))
        setContract(contractView(p))
        toast.success(`Contract ${p.contract_number || ''} · ${p.musaned_stage || ''}${one.pdfs?.length ? ` · ${one.pdfs.length} PDF(s) saved` : ''}`)
      }
    } catch (e) { toast.error(e.response?.data?.error || 'Could not check Musaned') }
    setCheckingContract(false)
  }

  useEffect(() => {
    let alive = true
    async function boot() {
      try {
        const brokersRes = await api.get('/brokers')
        if (!alive) return
        setBrokers(brokersRes.data || [])

        if (isEdit) {
          const res = await api.get(`/profiles/${id}`)
          if (!alive) return
          const p = res.data
          setForm({
            full_name: p.full_name || '',
            destination_country: p.destination_country || '',
            order_id: p.order_id || '',
            phone_number: p.phone_number || '',
            phone_number_2: p.phone_number_2 || '',
            national_id: p.national_id || '',
            passport_number: p.passport_number || '',
            status: p.status || 'pending',
            broker_id: p.broker_id ?? '',
            notes: p.notes || '',
            religion: p.religion || '',
            marital_status: p.marital_status || '',
            gender: p.gender || '',
            children_count: childrenOrZero(p.children_count),
            weight: p.weight || 'Normal',
            height: p.height || 'Normal',
            education_level: p.education_level || '',
            mother_name: p.mother_name || '',
            father_name: p.father_name || '',
            region: p.region || '',
            zone_subcity: p.zone_subcity || '',
            labor_id: p.labor_id || '',
            work_experience: p.work_experience || 'No experience',
            experience_country: p.experience_country || '',
            experience_years: p.experience_years ?? '',
            personal_number: p.personal_number || '',
            emergency_name: p.emergency_name || '',
            emergency_phone: p.emergency_phone || '',
            emergency_gender: p.emergency_gender || 'Male',
            emergency_relationship: p.emergency_relationship || 'Father',
            cooking_skill: p.cooking_skill || 'None',
            speaks_english: !!p.speaks_english,
            speaks_arabic: !!p.speaks_arabic,
            complexion: p.complexion || '',
            spouse_name: p.spouse_name || '',
            skills: p.skills || '',
            previous_employment: p.previous_employment || '',
            contract_number: p.contract_number || '',
            visa_number: p.visa_number || '',
            tawassut_number: p.tawassut_number || '',
            musaned_stage: p.musaned_stage || '',
            musaned_payment: p.musaned_payment || '',
            contract_date: p.contract_date || '',
            employer_name: p.employer_name || '',
            employer_id: p.employer_id || '',
            employer_phone: p.employer_phone || '',
            employer_address: p.employer_address || '',
            work_city: p.work_city || '',
            salary: p.salary || '',
            issuing_authority: p.issuing_authority || '',
            job_title: p.job_title || '',
            musaned_pro: p.musaned_pro || '',
          })
          setContract(contractView(p))
        }
      } catch {
        toast.error(isEdit ? 'ፕሮፋይሉን መጫን አልተቻለም' : 'የፎርም መረጃዎችን መጫን አልተቻለም')
        if (isEdit) navigate('/profiles')
      } finally {
        if (alive) { setLoading(false); setHydrated(true) }
      }
    }
    boot()
    return () => { alive = false }
  }, [id, isEdit, navigate])

  // Defaults from broker — personal number + emergency phone
  useEffect(() => {
    if (!hydrated || !form.broker_id) return
    const broker = brokers.find(b => String(b.id) === String(form.broker_id))
    if (!broker) return
    setForm(f => ({
      ...f,
      personal_number: f.personal_number || broker.contact1 || '',
      emergency_phone: f.emergency_phone || broker.contact1 || '',
    }))
  }, [hydrated, form.broker_id, brokers])

  const setField = (key) => (e) => setForm(prev => ({ ...prev, [key]: e.target.value }))

  // The passport was read: fill what it says. The person adds the rest.
  const fromPassport = (r) => {
    const f = r.fields || {}
    const place = String(f.place_of_birth || '').trim()
    const low = place.toLowerCase()
    const region = low && REGIONS.find(x => x.name.toLowerCase() === low || x.areas.some(a => a.toLowerCase() === low))
    const zone = region && region.areas.find(a => a.toLowerCase() === low)
    const sex = String(f.gender || '').toUpperCase().startsWith('F') ? 'F' : String(f.gender || '').toUpperCase().startsWith('M') ? 'M' : ''
    setForm(prev => ({
      ...prev,
      full_name: f.full_name || prev.full_name,
      first_name: f.first_name || '',
      middle_name: f.middle_name || '',
      last_name: f.last_name || '',
      passport_number: f.passport_number || prev.passport_number,
      date_of_birth: f.date_of_birth || '',
      gender: sex || prev.gender,
      place_of_birth: place,
      passport_issue_date: f.passport_issue_date || '',
      passport_expiry_date: f.passport_expiry_date || '',
      ...(f.nationality ? { nationality: f.nationality } : {}),
      ...(region ? { region: region.name, zone_subcity: zone || '' } : {}),
      // The middle name is the father's name: the guardian by default.
      emergency_name: prev.emergency_name || f.middle_name || '',
      father_name: prev.father_name || f.middle_name || '',
    }))
    setPassport(r)
    setStep('form')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const payload = {
        ...form,
        broker_id: form.broker_id === '' ? null : Number(form.broker_id),
        children_count: childrenOrZero(form.children_count),
        // Living town is the region (read from the passport) — no separate field.
        ...(form.region ? { living_town: form.region } : {}),
        experience_country: form.work_experience === 'Have experience' ? form.experience_country : '',
        experience_years: form.work_experience === 'Have experience' && form.experience_years !== '' ? Number(form.experience_years) : null,
      }
      // Tag the creator so this profile shows under the right employee
      if (!isEdit) {
        const me = activeEmployee || user || {}
        const createdByName = String(me.name || me.full_name || me.username || '').trim()
        payload.created_by = createdByName || 'System'
      }
      if (isEdit) {
        await api.put(`/profiles/${id}`, payload)
        toast.success('ፕሮፋይሉ በስኬት ተዘምኗል')
        navigate(`/profiles/${id}`)
      } else {
        const res = await api.post('/profiles', payload)
        if (passport?.upload) {
          try {
            await api.post('/new-profile/attach', { upload: passport.upload, profileId: res.data.id, filename: passport.filename })
          } catch { toast.error('The profile was made, but the passport file could not be added — drop it on the Passport field.') }
        }
        toast.success('አዲስ ፕሮፋይል ተፈጥሯል')
        navigate(`/profiles/${res.data.id}`)
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'ፕሮፋይሉን ማስቀመጥ አልተቻለም')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner label={isEdit ? 'ፕሮፋይል በመጫን ላይ…' : 'በመጫን ላይ…'} />

  const inputClass = "w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/50 px-3 py-3 text-[15px] text-slate-800 dark:text-slate-100 focus:bg-white dark:focus:bg-slate-900 focus:border-teal-500 focus:outline-none transition-colors"
  const labelClass = "label mb-1.5 block font-semibold text-sm text-slate-700 dark:text-slate-200"
  const smallInput = "w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/40 px-2 py-1.5 text-xs text-slate-700 dark:text-slate-200 focus:border-teal-500 focus:outline-none"
  const smallLabel = "mb-1 block text-[11px] text-slate-500 dark:text-slate-400"

  if (!isEdit && step === 'passport') {
    return (
      <div className="mx-auto max-w-2xl animate-fade-up">
        <PageHeader title="አዲስ ፕሮፋይል" subtitle="Start with the passport — the form fills itself" />
        <PassportFirst onRead={fromPassport} onSkip={() => { setShowAll(true); setStep('form') }} />
      </div>
    )
  }

  // After the passport: only what the passport cannot tell. "More details" opens the rest.
  const quick = !isEdit && passport && !showAll
  const pf = passport?.fields || {}

  return (
    <div className="mx-auto max-w-4xl animate-fade-up">
      <PageHeader
        title={isEdit ? 'ፕሮፋይል አርም' : 'አዲስ ፕሮፋይል'}
        subtitle={isEdit ? 'የደንበኛ ዝርዝሮችን ያዘምኑ' : 'አዲስ ደንበኛ ወደ ስራ ቦታዎ ያክሉ'}
      />

      <form onSubmit={handleSubmit} className="panel space-y-5 p-5 sm:p-6 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/60 rounded-xl shadow-sm">

        {/* ---- Labor ID first ---- */}
        <div className="rounded-xl p-[2px] bg-gradient-to-r from-teal-500 via-sky-500 to-indigo-500">
          <div className="rounded-[10px] bg-white dark:bg-slate-900 p-3">
            <label className="mb-1.5 block text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-teal-600 via-sky-600 to-indigo-600 bg-clip-text text-transparent" htmlFor="labor_id">Labor ID *</label>
            <input id="labor_id" required className={inputClass + ' font-mono text-base font-semibold'} value={form.labor_id} onChange={setField('labor_id')} />
          </div>
        </div>

        {passport && !isEdit && (
          <div className="rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20 p-4">
            <p className="mb-3 text-xs font-semibold text-emerald-800 dark:text-emerald-200">
              {passport.verified ? '✓ Read from the passport (its check digits match)' : 'Read from the passport — check these, the passport lines did not fully verify'}
              <span className="ml-2 font-normal text-emerald-700/70 dark:text-emerald-300/70">
                {(passport.ms / 1000).toFixed(1)}s{passport.source ? ` · ${passport.source}` : ''}
              </span>
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {quick && (
                <div className="sm:col-span-2">
                  <label className={labelClass} htmlFor="full_name_q">ሙሉ ስም *</label>
                  <input id="full_name_q" required className={inputClass} value={form.full_name} onChange={setField('full_name')} />
                </div>
              )}
              {[['Passport number', form.passport_number], ['Date of birth', form.date_of_birth], ['Sex', form.gender === 'F' ? 'Female' : form.gender === 'M' ? 'Male' : ''],
                ['Place of birth', form.place_of_birth], ['Region', [form.region, form.zone_subcity].filter(Boolean).join(' · ')], ['Passport expires', pf.passport_expiry_date]]
                .map(([k, v]) => (
                  <div key={k} className="text-sm">
                    <span className="block text-[11px] text-slate-500">{k}</span>
                    <span className="font-medium text-slate-800 dark:text-slate-100">{v || '—'}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {quick && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="phone_number">ስልክ ቁጥር *</label>
              <input id="phone_number" required type="tel" className={inputClass} placeholder="09XX XXX XXX" value={form.phone_number} onChange={setField('phone_number')} />
            </div>
              <div>
              <label className={labelClass} htmlFor="religion">Religion *</label>
              <select id="religion" required className={inputClass} value={form.religion} onChange={setField('religion')}>
                <option value="">— Select —</option>
                <option value="Muslim">Muslim</option>
                <option value="Orthodox">Orthodox</option>
                <option value="Protestant">Protestant</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="marital_status">Marital status *</label>
              <select id="marital_status" required className={inputClass} value={form.marital_status} onChange={setField('marital_status')}>
                <option value="">— Select —</option>
                <option value="SINGLE">Single</option>
                <option value="MARRIED">Married</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="destination_country_q">Destination country *</label>
              <select id="destination_country_q" required className={inputClass} value={form.destination_country} onChange={setField('destination_country')}>
                <option value="">— Select —</option>
                {['Kuwait', 'Saudi Arabia', 'Jordan', 'UAE', 'Qatar', 'Bahrain', 'Oman'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="broker_id_q">ደላላ *</label>
              <select id="broker_id_q" required className={inputClass} value={form.broker_id} onChange={setField('broker_id')}>
                <option value="">— Select —</option>
                {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <button type="button" onClick={() => setShowAll(true)} className="text-xs text-teal-700 dark:text-teal-300 hover:underline">
                More details (experience, guardian, languages…) ▸
              </button>
            </div>
          </div>
        )}

        {!quick && <>
        {/* ---- Core ---- */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor="full_name">ሙሉ ስም *</label>
            <input id="full_name" required className={inputClass} value={form.full_name} onChange={setField('full_name')} />
          </div>
          <div>
            <label className={labelClass} htmlFor="order_id">Order ID</label>
            <input id="order_id" className={inputClass} value={form.order_id} onChange={setField('order_id')} />
          </div>
          <div>
            <label className={labelClass} htmlFor="phone_number">ስልክ ቁጥር *</label>
            <input id="phone_number" required type="tel" className={inputClass} placeholder="251 9XX XXX XXX" value={form.phone_number} onChange={setField('phone_number')} />
          </div>
          <div>
            <label className={labelClass} htmlFor="phone_number_2">Second phone</label>
            <input id="phone_number_2" type="tel" className={inputClass} value={form.phone_number_2} onChange={setField('phone_number_2')} />
          </div>
          <div>
            <label className={labelClass} htmlFor="status">ሁኔታ</label>
            <select id="status" className={inputClass} value={form.status} onChange={setField('status')}>
              {STATUS_OPTIONS_AM.filter(s => !s.group).map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              <optgroup label="ሕክምና · Medical (Wafid)">
                {STATUS_OPTIONS_AM.filter(s => s.group === 'medical').map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </optgroup>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="national_id">ብሔራዊ መታወቂያ</label>
            <input id="national_id" className={inputClass} value={form.national_id} onChange={setField('national_id')} />
          </div>
          <div>
            <label className={labelClass} htmlFor="passport_number">ፓስፖርት ቁጥር</label>
            <input id="passport_number" className={inputClass} value={form.passport_number} onChange={setField('passport_number')} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor="broker_id">ደላላ *</label>
            <select id="broker_id" required className={inputClass} value={form.broker_id} onChange={setField('broker_id')}>
              <option value="">ያልተመደበ</option>
              {brokers.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        </div>

        {/* ---- CV fields ---- */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor="destination_country">
              Destination Country *
              <span className="ml-2 text-[10px] text-teal-600 font-semibold">
                (Kuwait auto-starts Police Clearance)
              </span>
            </label>
            <select
              id="destination_country"
              required
              className={inputClass}
              value={form.destination_country}
              onChange={setField('destination_country')}
            >
              <option value="">— Select —</option>
              <option value="Kuwait">Kuwait</option>
              <option value="Saudi Arabia">Saudi Arabia</option>
              <option value="Jordan">Jordan</option>
              <option value="UAE">UAE</option>
              <option value="Qatar">Qatar</option>
              <option value="Bahrain">Bahrain</option>
              <option value="Oman">Oman</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="religion">Religion *</label>
            <select id="religion" required className={inputClass} value={form.religion} onChange={setField('religion')}>
              <option value="">— Select —</option>
              <option value="Muslim">Muslim</option>
              <option value="Orthodox">Orthodox</option>
              <option value="Protestant">Protestant</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="marital_status">Marital status *</label>
            <select id="marital_status" required className={inputClass} value={form.marital_status} onChange={setField('marital_status')}>
              <option value="">— Select —</option>
              <option value="SINGLE">Single</option>
              <option value="MARRIED">Married</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="gender">Gender</label>
            <select id="gender" className={inputClass} value={form.gender} onChange={setField('gender')}>
              <option value="">— Select —</option>
              <option value="M">Male</option>
              <option value="F">Female</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="children_count">Children count</label>
            <input id="children_count" type="number" min="0" className={inputClass} value={form.children_count} onChange={setField('children_count')} />
          </div>
          <div>
            <label className={labelClass} htmlFor="work_experience">Work experience</label>
            <select id="work_experience" className={inputClass} value={form.work_experience}
              onChange={e => setForm(f => {
                const has = e.target.value === 'Have experience'
                return { ...f, work_experience: e.target.value, experience_country: has ? f.experience_country : '', experience_years: has ? f.experience_years : '' }
              })}>
              {EXPERIENCE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          {form.work_experience === 'Have experience' && (
            <div>
              <label className={labelClass} htmlFor="experience_country">Experience country *</label>
              <select id="experience_country" required className={inputClass} value={form.experience_country} onChange={setField('experience_country')}>
                <option value="">— Select —</option>
                {EXPERIENCE_COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          {form.work_experience === 'Have experience' && (
            <div>
              <label className={labelClass} htmlFor="experience_years">Years Of Experience *</label>
              <input id="experience_years" type="number" min="1" max="40" required className={inputClass}
                value={form.experience_years} onChange={setField('experience_years')} />
            </div>
          )}
          <div>
            <label className={labelClass} htmlFor="personal_number">Personal number (auto from broker)</label>
            <input id="personal_number" className={inputClass} value={form.personal_number} onChange={setField('personal_number')} />
          </div>
          <div>
            <label className={labelClass} htmlFor="cooking_skill">Cooking skill</label>
            <select id="cooking_skill" className={inputClass} value={form.cooking_skill} onChange={setField('cooking_skill')}>
              <option value="None">None</option>
              <option value="Cooking">Cooking</option>
              <option value="Cooking Helper">Cooking Helper</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="speaks_english">Speaks English</label>
            <select id="speaks_english" className={inputClass} value={form.speaks_english ? 'yes' : 'no'}
              onChange={e => setForm(f => ({ ...f, speaks_english: e.target.value === 'yes' }))}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="speaks_arabic">Speaks Arabic</label>
            <select id="speaks_arabic" className={inputClass} value={form.speaks_arabic ? 'yes' : 'no'}
              onChange={e => setForm(f => ({ ...f, speaks_arabic: e.target.value === 'yes' }))}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="emergency_name">Guardian / Emergency name (auto from middle)</label>
            <input id="emergency_name" className={inputClass} value={form.emergency_name} onChange={setField('emergency_name')} />
          </div>
          <div>
            <label className={labelClass} htmlFor="emergency_phone">Emergency phone (auto from broker)</label>
            <input id="emergency_phone" className={inputClass} value={form.emergency_phone} onChange={setField('emergency_phone')} />
          </div>
          <div>
            <label className={labelClass} htmlFor="emergency_gender">Emergency gender</label>
            <select id="emergency_gender" className={inputClass} value={form.emergency_gender} onChange={setField('emergency_gender')}>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="emergency_relationship">Emergency relationship</label>
            <select id="emergency_relationship" className={inputClass} value={form.emergency_relationship} onChange={setField('emergency_relationship')}>
              <option value="Father">Father</option>
              <option value="Mother">Mother</option>
              <option value="Brother">Brother</option>
              <option value="Sister">Sister</option>
              <option value="Spouse">Spouse</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </div>

        {/* ---- Rarely used: kept, editable, folded away ---- */}
        <details className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 group">
          <summary className="cursor-pointer text-sm font-semibold text-slate-600 dark:text-slate-300 select-none">More details (optional) — second phone, height, weight, parents, region, education …</summary>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
              <label className={smallLabel} htmlFor="phone_number_2">Second phone</label>
              <input id="phone_number_2" type="tel" className={smallInput} placeholder="09XX XXX XXX" value={form.phone_number_2} onChange={setField('phone_number_2')} />
            </div>
          <div>
            <label className={smallLabel} htmlFor="weight">Weight</label>
            <input id="weight" className={smallInput} value={form.weight} onChange={setField('weight')} placeholder="Normal" />
          </div>
          <div>
            <label className={smallLabel} htmlFor="height">Height</label>
            <input id="height" className={smallInput} value={form.height} onChange={setField('height')} placeholder="Normal" />
          </div>
          <div>
            <label className={smallLabel} htmlFor="education_level">Education</label>
            <input id="education_level" className={smallInput} value={form.education_level} onChange={setField('education_level')} />
          </div>
          <div>
            <label className={smallLabel} htmlFor="mother_name">Mother's name</label>
            <input id="mother_name" className={smallInput} value={form.mother_name} onChange={setField('mother_name')} />
          </div>
          <div>
            <label className={smallLabel} htmlFor="father_name">Father's name</label>
            <input id="father_name" className={smallInput} value={form.father_name} onChange={setField('father_name')} />
          </div>
          <div>
            <label className={smallLabel} htmlFor="region">Region</label>
            <select id="region" className={smallInput} value={form.region}
              onChange={e => setForm(f => ({ ...f, region: e.target.value, zone_subcity: '' }))}>
              <option value="">— Select —</option>
              {REGIONS.map(r => <option key={r.name} value={r.name}>{r.name}</option>)}
            </select>
          </div>
          <div>
            <label className={smallLabel} htmlFor="zone_subcity">{regionByName(form.region)?.label || 'Zone / Sub-city'}</label>
            <select id="zone_subcity" className={smallInput} value={form.zone_subcity} onChange={setField('zone_subcity')} disabled={!form.region}>
              <option value="">— Select —</option>
              {(regionByName(form.region)?.areas || []).map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label className={smallLabel} htmlFor="complexion">Complexion</label>
            <input id="complexion" className={smallInput} value={form.complexion} onChange={setField('complexion')} />
          </div>
          <div>
            <label className={smallLabel} htmlFor="spouse_name">Spouse's name</label>
            <input id="spouse_name" className={smallInput} value={form.spouse_name} onChange={setField('spouse_name')} />
          </div>
          <div>
            <label className={smallLabel} htmlFor="skills">Skills</label>
            <input id="skills" className={smallInput} value={form.skills} onChange={setField('skills')} />
          </div>
          <div>
            <label className={smallLabel} htmlFor="previous_employment">Previous employment</label>
            <input id="previous_employment" className={smallInput} value={form.previous_employment} onChange={setField('previous_employment')} />
          </div>
          </div>
        </details>

        {/* ---- Visa & Contract: from the Musaned employment request ---- */}
        {isEdit && (
          <section className="rounded-xl border-2 border-indigo-200 dark:border-indigo-800 p-4 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-display text-lg font-bold">🛂 Visa &amp; Contract</h3>
              {contract.chosen_at
                ? <span className="rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 px-3 py-0.5 text-xs font-semibold">Chosen {new Date(contract.chosen_at).toLocaleDateString()}</span>
                : <span className="rounded-full bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300 px-3 py-0.5 text-xs">Not chosen yet</span>}
              {form.musaned_stage && <span className="rounded-full bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300 px-3 py-0.5 text-xs font-semibold">{form.musaned_stage}</span>}
              <button type="button" disabled={checkingContract} onClick={checkContractNow}
                className="ml-auto rounded-lg border border-indigo-300 px-3 py-1.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 disabled:opacity-50">
                {checkingContract ? 'Looking on Musaned…' : 'Check Musaned now'}
              </button>
            </div>
            <p className="text-xs text-slate-500">Filled by itself every 4 hours from Musaned (Employment Requests → passport → Details). The contract PDFs go into the Contract documents. You can correct anything here.</p>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <div>
              <label className={labelClass} htmlFor="contract_number">Contract number</label>
              <input id="contract_number" className={inputClass} value={form.contract_number} onChange={setField('contract_number')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="visa_number">Visa number</label>
              <input id="visa_number" className={inputClass} value={form.visa_number} onChange={setField('visa_number')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="tawassut_number">Tawassut contract no.</label>
              <input id="tawassut_number" className={inputClass} value={form.tawassut_number} onChange={setField('tawassut_number')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="musaned_stage">Musaned stage</label>
              <input id="musaned_stage" className={inputClass} value={form.musaned_stage} onChange={setField('musaned_stage')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="musaned_payment">Payment</label>
              <input id="musaned_payment" className={inputClass} value={form.musaned_payment} onChange={setField('musaned_payment')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="contract_date">Contract date</label>
              <input id="contract_date" className={inputClass} value={form.contract_date} onChange={setField('contract_date')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="employer_name">Employer name</label>
              <input id="employer_name" className={inputClass} value={form.employer_name} onChange={setField('employer_name')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="employer_id">Employer national ID</label>
              <input id="employer_id" className={inputClass} value={form.employer_id} onChange={setField('employer_id')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="employer_phone">Employer mobile</label>
              <input id="employer_phone" className={inputClass} value={form.employer_phone} onChange={setField('employer_phone')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="employer_address">Employer address</label>
              <input id="employer_address" className={inputClass} value={form.employer_address} onChange={setField('employer_address')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="work_city">City of work</label>
              <input id="work_city" className={inputClass} value={form.work_city} onChange={setField('work_city')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="salary">Salary</label>
              <input id="salary" className={inputClass} value={form.salary} onChange={setField('salary')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="issuing_authority">Issuing authority</label>
              <input id="issuing_authority" className={inputClass} value={form.issuing_authority} onChange={setField('issuing_authority')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="job_title">Job</label>
              <input id="job_title" className={inputClass} value={form.job_title} onChange={setField('job_title')} />
            </div>
            <div>
              <label className={labelClass} htmlFor="musaned_pro">PRO / recruitment office</label>
              <input id="musaned_pro" className={inputClass} value={form.musaned_pro} onChange={setField('musaned_pro')} />
            </div>
            </div>
            {contract.extra.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold text-slate-500">Everything else Musaned shows ({contract.extra.length})</summary>
                <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2 text-sm">
                  {contract.extra.map(([k, v]) => <div key={k} className="flex gap-2"><dt className="text-slate-500 shrink-0">{k}:</dt><dd className="font-medium break-words">{v}</dd></div>)}
                </dl>
              </details>
            )}
            {contract.checked_at && <p className="text-[11px] text-slate-400">Last looked: {new Date(contract.checked_at).toLocaleString()}</p>}
          </section>
        )}

        </>}

        {!quick && <div>
          <label className={labelClass} htmlFor="notes">ማስታወሻዎች</label>
          <textarea id="notes" rows={4} className={`${inputClass} resize-y`} placeholder="ስለዚህ ደንበኛ ጠቃሚ የሆኑ መረጃዎች…" value={form.notes} onChange={setField('notes')} />
        </div>}

        <div className="flex flex-wrap gap-3 border-t border-slate-200 dark:border-slate-700 pt-5">
          <button type="submit" className="px-5 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-medium text-sm transition-colors disabled:opacity-50" disabled={saving}>
            {saving ? 'በማስቀመጥ ላይ…' : isEdit ? 'ለወጦችን አስቀምጥ' : 'ፕሮፋይል ፍጠር'}
          </button>
          <button type="button" className="px-5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium text-sm transition-colors" onClick={() => navigate(isEdit ? `/profiles/${id}` : '/profiles')}>
            ሰርዝ
          </button>
        </div>
      </form>
    </div>
  )
}