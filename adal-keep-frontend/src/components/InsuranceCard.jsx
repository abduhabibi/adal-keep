/**
 * Settings → Insurance (FetaP): the Insurance Branch the certificate form
 * chooses for every profile.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'

// FetaP's branch names, as its "Insurance Branch" list shows them.
export const INSURANCE_BRANCHES = []

export default function InsuranceCard() {
  const [branch, setBranch] = useState(null)
  useEffect(() => { api.get('/settings').then(r => setBranch(r.data?.insurance_branch || '')).catch(() => setBranch('')) }, [])
  if (branch === null) return null
  const save = async (v) => {
    const value = v.trim()
    if (value === branch) return
    setBranch(value)
    try { await api.put('/settings', { insurance_branch: value }); toast.success('Saved') } catch { toast.error('Could not save') }
  }
  const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm'
  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>🛡</span> Insurance (FetaP)</h2>
      <p className="text-sm text-slate-500 mb-4" translate="no">
        “Insurance certificate” signs in to agency.niscofetap.com, opens New Certificate and fills it (Region: Addis Ababa), then rings. You add the member and the beneficiary and finish it.
      </p>
      <label className="text-sm block max-w-md" translate="no">Insurance Branch
        {INSURANCE_BRANCHES.length ? (
          <select className={field} value={branch} onChange={e => save(e.target.value)}>
            <option value="">— choose —</option>
            {INSURANCE_BRANCHES.map(b => <option key={b}>{b}</option>)}
          </select>
        ) : (
          <input className={field} defaultValue={branch} placeholder="the branch name exactly as FetaP lists it" onBlur={e => save(e.target.value)} />
        )}
      </label>
    </Card>
  )
}
