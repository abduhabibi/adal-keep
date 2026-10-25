/**
 * Settings → Insurance (FetaP): the Insurance Branch the certificate form
 * chooses for every profile.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'

// FetaP's branch names, as its "Insurance Branch" list shows them.
export const INSURANCE_BRANCHES = [
  'Arada', 'Head Office (LH)', 'Main Wuhalimat', 'Beklobet CXH', 'Bole CXH', 'Eastern (Gerji)', 'Gola Sefer',
  'Kera', 'Kality', 'Merkato', 'Kazanchis', 'Megenagna', 'Lafto', 'Lideta', 'Ras Desta', 'Beherawi',
  'Arada Giorgis', 'Misrak Ber-Lemi Kur', 'Arat Kilo',
]

// Addis Ababa's sub cities, and woredas 01–15.
export const SUB_CITIES = ['Addis Ketema', 'Akaky Kaliti', 'Arada', 'Bole', 'Gullele', 'Kirkos', 'Kolfe Keranio', 'Lemi Kura', 'Lideta', 'Nifas Silk-Lafto', 'Yeka']
export const WOREDAS = Array.from({ length: 15 }, (_, i) => String(i + 1).padStart(2, '0'))

export default function InsuranceCard() {
  const [s, setS] = useState(null)
  useEffect(() => {
    api.get('/settings')
      .then(r => setS({ insurance_branch: r.data?.insurance_branch || '', insurance_sub_city: r.data?.insurance_sub_city || '', insurance_woreda: r.data?.insurance_woreda || '' }))
      .catch(() => setS({ insurance_branch: '', insurance_sub_city: '', insurance_woreda: '' }))
  }, [])
  const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm'
  if (s === null) return null
  const save = (key) => async (v) => {
    const value = String(v).trim()
    if (value === s[key]) return
    setS(prev => ({ ...prev, [key]: value }))
    try { await api.put('/settings', { [key]: value }); toast.success('Saved') } catch { toast.error('Could not save') }
  }
  const pick = (title, key, list, hint) => (
    <label className="text-sm block" translate="no">{title}
      <select className={field} value={s[key]} onChange={e => save(key)(e.target.value)}>
        <option value="">— choose —</option>
        {list.map(b => <option key={b}>{b}</option>)}
      </select>
      {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
    </label>
  )
  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>🛡</span> Insurance (FetaP)</h2>
      <p className="text-sm text-slate-500 mb-4" translate="no">
        “Insurance certificate” signs in to agency.niscofetap.com, opens New Certificate and fills it (Region: Addis Ababa), then rings. You add the member and the beneficiary and finish it.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {pick('Insurance Branch', 'insurance_branch', INSURANCE_BRANCHES)}
        {pick('Sub City', 'insurance_sub_city', SUB_CITIES, 'used when the profile has no sub city')}
        {pick('Woreda', 'insurance_woreda', WOREDAS)}
      </div>
    </Card>
  )
}
