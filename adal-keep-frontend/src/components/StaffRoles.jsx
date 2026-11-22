/**
 * Employees → Roles: the admin's roles and their toggles (backend
 * services/staffRoles.js). Admin always has everything; Office and Data
 * entry come ready and can be changed; new roles can be added.
 */
import { useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Button from './shared/Button'
import { refreshPerms } from '../lib/staffPerms'

const err = (e) => e?.response?.data?.error || e.message

export default function StaffRoles({ roles, labels, onChanged }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (fn) => {
    setBusy(true)
    try { await fn(); await onChanged?.(); refreshPerms() } catch (e) { toast.error(err(e)) } finally { setBusy(false) }
  }
  const toggle = (r, k) => run(() => api.put(`/staff-roles/${r.id}`, { perms: { ...r.perms, [k]: !r.perms[k] } }))
  const add = (e) => {
    e.preventDefault()
    if (!name.trim()) return
    run(async () => { await api.post('/staff-roles', { name: name.trim(), perms: {} }); setName('') })
  }
  const rename = (r) => {
    const n = prompt('The role\'s name', r.name)
    if (n && n.trim() && n.trim() !== r.name) run(() => api.put(`/staff-roles/${r.id}`, { name: n.trim() }))
  }
  const remove = (r) => { if (confirm(`Delete the role "${r.name}"?`)) run(() => api.delete(`/staff-roles/${r.id}`)) }

  return (
    <section className="panel p-4">
      <p className="ak-card-title mb-1">Roles</p>
      <p className="mb-3 text-xs text-slate-500">What each role may do. Adding and editing profiles and uploading files is open to every role. Give an employee a role with ✎ on their card.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1 pr-3 font-medium">Role</th>
              {Object.entries(labels).map(([k, l]) => <th key={k} className="px-2 py-1 text-center font-medium capitalize">{l}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {roles.map(r => (
              <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-2 pr-3">
                  <button type="button" className="font-semibold hover:underline" onClick={() => rename(r)} title="Rename">{r.name}</button>
                  <span className="ml-1 text-xs text-slate-400">{r.members}</span>
                </td>
                {Object.keys(labels).map(k => (
                  <td key={k} className="px-2 py-2 text-center">
                    <input type="checkbox" className="h-4 w-4 accent-teal-600" checked={!!r.perms[k]}
                      disabled={busy || r.preset === 'admin'} onChange={() => toggle(r, k)}
                      aria-label={`${r.name}: ${labels[k]}`} />
                  </td>
                ))}
                <td className="py-2 text-right">
                  {!r.preset && <button type="button" onClick={() => remove(r)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Delete">✕</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form onSubmit={add} className="mt-3 flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New role's name"
          className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
        <Button type="submit" variant="secondary" disabled={busy || !name.trim()}>+ Add role</Button>
      </form>
    </section>
  )
}
