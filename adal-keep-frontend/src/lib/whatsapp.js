/**
 * Whose WhatsApp: the employee chosen on this PC or phone (none → the agency's
 * owner). Sent as ?u= so it also reaches the PC through the phone's online copy.
 */
import api from '../services/api'

export function waUser() {
  try {
    const e = JSON.parse(localStorage.getItem('adal_active_employee') || 'null')
    if (e?.id != null && Number(e.id) > 0) return String(e.id)
  } catch {}
  return undefined
}

const withU = (cfg = {}) => ({ ...cfg, params: { ...(cfg.params || {}), u: waUser() } })
export const wa = {
  get: (url, cfg) => api.get(url, withU(cfg)),
  post: (url, body, cfg) => api.post(url, body, withU(cfg)),
  patch: (url, body, cfg) => api.patch(url, body, withU(cfg)),
  delete: (url, cfg) => api.delete(url, withU(cfg)),
}
