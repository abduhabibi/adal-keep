import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'

export default function MusanedAccountPicker({ value, onChange }) {
  const [accounts, setAccounts] = useState([])
  const [editing, setEditing] = useState(null)
  const [showAdd, setShowAdd] = useState(false)

  const load = async () => {
    try {
      const r = await api.get('/musaned/accounts')
      setAccounts(r.data || [])
    } catch {}
  }
  useEffect(() => { load() }, [])

  const save = async (acct) => {
    try {
      if (acct.id) await api.patch(`/musaned/accounts/${acct.id}`, acct)
      else await api.post('/musaned/accounts', acct)
      toast.success('Saved')
      load(); setEditing(null); setShowAdd(false)
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to save') }
  }

  const remove = async (id) => {
    if (!confirm('Delete this Musaned account?')) return
    try { await api.delete(`/musaned/accounts/${id}`); load() } catch {}
  }

  const defaultAccount = accounts.find(a => a.is_default) || accounts[0]
  useEffect(() => {
    if (!value && defaultAccount) onChange(defaultAccount.id)
  }, [defaultAccount, value, onChange])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          className="field flex-1"
          value={value || ''}
          onChange={e => onChange(Number(e.target.value))}
        >
          <option value="">— Pick Musaned account —</option>
          {accounts.map(a => (
            <option key={a.id} value={a.id}>
              {a.name}{a.username ? ' · ' + a.username : ''}{a.is_default ? ' (default)' : ''}
            </option>
          ))}
        </select>

        {value && (
          <button
            type="button"
            onClick={() => {
              const a = accounts.find(x => x.id === Number(value))
              if (a && confirm('Delete "' + a.name + '"?')) {
                remove(a.id).then(() => onChange(null))
              }
            }}
            className="px-2 py-1.5 rounded-lg border border-red-300 text-red-600 text-xs font-semibold hover:bg-red-50 dark:hover:bg-red-900/20"
            title="Delete selected"
          >🗑</button>
        )}

        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="px-3 py-1.5 rounded-lg bg-teal-600 text-white text-xs font-semibold hover:bg-teal-700"
        >+ Add</button>
      </div>

      {(showAdd || editing) && (
        <MusanedAccountForm
          initial={editing || { name: '', username: '', password: '', phone: '', notes: '', is_default: accounts.length === 0 }}
          onSave={save}
          onCancel={() => { setShowAdd(false); setEditing(null) }}
        />
      )}
    </div>
  )
}

function MusanedAccountForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState(initial)
  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs'
  const lbl = 'text-[11px] font-medium text-slate-600 dark:text-slate-300 block mb-1'

  return (
    <div className="rounded-lg border border-teal-300 bg-teal-50/50 dark:bg-teal-900/20 p-3 space-y-2">
      <div className="space-y-2">
        <div>
          <label className={lbl}>Name</label>
          <input className={field} value={form.name} onChange={e => upd('name', e.target.value)} placeholder="Nuzla Musaned" />
        </div>
        <div>
          <label className={lbl}>Username (email or ID)</label>
          <input className={field} value={form.username} onChange={e => upd('username', e.target.value)} />
        </div>
        <div>
          <label className={lbl}>Password</label>
          <input type="text" className={field} value={form.password} onChange={e => upd('password', e.target.value)} />
        </div>
        <div>
          <label className={lbl}>Phone (optional)</label>
          <input className={field} value={form.phone} onChange={e => upd('phone', e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={!!form.is_default} onChange={e => upd('is_default', e.target.checked)} />
          Set as default
        </label>
      </div>
      <div className="flex gap-2 justify-end pt-1">
        <button onClick={onCancel} className="px-3 py-1 text-xs rounded-md border">Cancel</button>
        <button onClick={() => onSave(form)} className="px-3 py-1 text-xs rounded-md bg-teal-600 text-white hover:bg-teal-700">Save</button>
      </div>
    </div>
  )
}