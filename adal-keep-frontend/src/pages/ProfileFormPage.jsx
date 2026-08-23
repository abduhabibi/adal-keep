import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'

const STATUS_OPTIONS_AM = [
  { value: 'pending', label: 'በመጠባበቅ ላይ' },
  { value: 'in_progress', label: 'በሂደት ላይ' },
  { value: 'completed', label: 'የተጠናቀቀ' },
]

const emptyForm = {
  full_name: '',
  phone_number: '',
  national_id: '',
  passport_number: '',
  status: 'pending',
  broker_id: '',
  notes: '',
  room: '',
  table_name: '',
  box_number: '',
}

export default function ProfileFormPage() {
  const { id } = useParams()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const [form, setForm] = useState(emptyForm)
  const [brokers, setBrokers] = useState([])
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true

    async function boot() {
      try {
        const brokersRes = await api.get('/brokers')
        if (!alive) return
        setBrokers(brokersRes.data)

        if (isEdit) {
          const res = await api.get(`/profiles/${id}`)
          if (!alive) return
          const p = res.data
          setForm({
            full_name: p.full_name || '',
            phone_number: p.phone_number || '',
            national_id: p.national_id || '',
            passport_number: p.passport_number || '',
            status: p.status || 'pending',
            broker_id: p.broker_id ?? '',
            notes: p.notes || '',
            room: p.room || '',
            table_name: p.table_name || '',
            box_number: p.box_number || '',
          })
        }
      } catch {
        toast.error(isEdit ? 'ፕሮፋይሉን መጫን አልተቻለም' : 'የፎርም መረጃዎችን መጫን አልተቻለም')
        if (isEdit) navigate('/profiles')
      } finally {
        if (alive) setLoading(false)
      }
    }

    boot()
    return () => {
      alive = false
    }
  }, [id, isEdit, navigate])

  const setField = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const payload = {
        ...form,
        broker_id: form.broker_id === '' ? null : Number(form.broker_id),
      }

      if (isEdit) {
        await api.put(`/profiles/${id}`, payload)
        toast.success('ፕሮፋይሉ በስኬት ተዘምኗል')
        navigate(`/profiles/${id}`)
      } else {
        const res = await api.post('/profiles', payload)
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

  // Reusable styling for form fields in light & dark mode
  const inputClass = "w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/50 p-2.5 text-sm text-slate-800 dark:text-slate-100 focus:bg-white dark:focus:bg-slate-900 focus:border-teal-500 focus:outline-none transition-colors"

  return (
    <div className="mx-auto max-w-2xl animate-fade-up">
      <PageHeader
        title={isEdit ? 'ፕሮፋይል አርም' : 'አዲስ ፕሮፋይል'}
        subtitle={isEdit ? 'የደንበኛ ዝርዝሮችን እና የፋይል መረጃዎችን ያዘምኑ' : 'አዲስ ደንበኛ ወደ ስራ ቦታዎ ያክሉ'}
      />

      <form onSubmit={handleSubmit} className="panel space-y-5 p-5 sm:p-6 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/60 rounded-xl shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label mb-1.5 block font-medium text-xs text-slate-600 dark:text-slate-300" htmlFor="full_name">ሙሉ ስም *</label>
            <input id="full_name" required className={inputClass} value={form.full_name} onChange={setField('full_name')} />
          </div>
          <div>
            <label className="label mb-1.5 block font-medium text-xs text-slate-600 dark:text-slate-300" htmlFor="phone_number">ስልክ ቁጥር *</label>
            <input id="phone_number" required type="tel" className={inputClass} value={form.phone_number} onChange={setField('phone_number')} />
          </div>
          <div>
            <label className="label mb-1.5 block font-medium text-xs text-slate-600 dark:text-slate-300" htmlFor="status">ሁኔታ</label>
            <select id="status" className={inputClass} value={form.status} onChange={setField('status')}>
              {STATUS_OPTIONS_AM.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label mb-1.5 block font-medium text-xs text-slate-600 dark:text-slate-300" htmlFor="national_id">ብሔራዊ መታወቂያ</label>
            <input id="national_id" className={inputClass} value={form.national_id} onChange={setField('national_id')} />
          </div>
          <div>
            <label className="label mb-1.5 block font-medium text-xs text-slate-600 dark:text-slate-300" htmlFor="passport_number">ፓስፖርት ቁጥር</label>
            <input id="passport_number" className={inputClass} value={form.passport_number} onChange={setField('passport_number')} />
          </div>
          <div className="sm:col-span-2">
            <label className="label mb-1.5 block font-medium text-xs text-slate-600 dark:text-slate-300" htmlFor="broker_id">ደላላ</label>
            <select id="broker_id" className={inputClass} value={form.broker_id} onChange={setField('broker_id')}>
              <option value="">ያልተመደበ</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <p className="label mb-1.5 font-medium text-xs text-slate-600 dark:text-slate-300">የፋይል ቦታ</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <input className={inputClass} placeholder="ክፍል" value={form.room} onChange={setField('room')} />
            <input className={inputClass} placeholder="ጠረጴዛ" value={form.table_name} onChange={setField('table_name')} />
            <input className={inputClass} placeholder="ሳጥን" value={form.box_number} onChange={setField('box_number')} />
          </div>
        </div>

        <div>
          <label className="label mb-1.5 block font-medium text-xs text-slate-600 dark:text-slate-300" htmlFor="notes">ማስታወሻዎች</label>
          <textarea
            id="notes"
            rows={4}
            className={`${inputClass} resize-y`}
            placeholder="ስለዚህ ደንበኛ ጠቃሚ የሆኑ መረጃዎች…"
            value={form.notes}
            onChange={setField('notes')}
          />
        </div>

        <div className="flex flex-wrap gap-3 border-t border-slate-200 dark:border-slate-700 pt-5">
          <button type="submit" className="px-5 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-medium text-sm transition-colors disabled:opacity-50" disabled={saving}>
            {saving ? 'በማስቀመጥ ላይ…' : isEdit ? 'ለወጦችን አስቀምጥ' : 'ፕሮፋይል ፍጠር'}
          </button>
          <button
            type="button"
            className="px-5 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium text-sm transition-colors"
            onClick={() => navigate(isEdit ? `/profiles/${id}` : '/profiles')}
          >
            ሰርዝ
          </button>
        </div>
      </form>
    </div>
  )
}