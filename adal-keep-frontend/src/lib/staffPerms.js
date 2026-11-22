/**
 * What the employee signed in here may do (Employees → Roles): the PC says
 * (/staff-roles/me); the last answer is kept on this device so the buttons
 * are right at once. The PC refuses the rest anyway — hiding a button only
 * saves a click that would be refused.
 */
import { useEffect, useState } from 'react'
import api from '../services/api'

const KEY = 'adal_staff_perms'
const ALL = { delete_profiles: true, edit_templates: true, run_robots: true, change_settings: true, manage_staff: true, export_backup: true }
const saved = () => { try { return { ...ALL, ...(JSON.parse(localStorage.getItem(KEY) || 'null') || {}) } } catch { return { ...ALL } } }

let perms = saved()
const listeners = new Set()
const set = (p) => {
  perms = { ...ALL, ...(p || {}) }
  try { localStorage.setItem(KEY, JSON.stringify(perms)) } catch {}
  listeners.forEach(f => f(perms))
}

let asking = null
export function refreshPerms() {
  if (!asking) {
    asking = api.get('/staff-roles/me', { adalNoCache: true })
      .then(r => { if (r.data?.perms) set(r.data.perms) })
      .catch(() => {})   // the PC off: what was saved last
      .finally(() => { asking = null })
  }
  return asking
}

/** The toggles (all true for no employee signed in), live. */
export function usePerms() {
  const [p, setP] = useState(perms)
  useEffect(() => {
    listeners.add(setP)
    if (listeners.size === 1) refreshPerms()
    return () => listeners.delete(setP)
  }, [])
  return p
}

/** One toggle: can('delete_profiles'). */
export const useCan = (perm) => usePerms()[perm] !== false

if (typeof window !== 'undefined') {
  // Signing in or out, or a role changed here: asked again at once; and every minute.
  window.addEventListener('adal-staff-changed', () => refreshPerms())
  setInterval(() => { if (!document.hidden && listeners.size) refreshPerms() }, 60000)
}
