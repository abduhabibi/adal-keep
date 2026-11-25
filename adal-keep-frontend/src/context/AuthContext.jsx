import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'
import api from '../services/api'
import { off } from '../lib/offSwitch'

const AuthContext = createContext()

function loadStoredEmployee() {
  try {
    const raw = localStorage.getItem('adal_active_employee')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// What this window last was: open, for which agency. It opens as it was and asks the PC
// behind (a white page with only the logo until the PC answered — 2026-11-25). Never kept
// for a locked or suspended PC; the phone, the demo and the online copy start as before.
const OPEN = 'adal-last-open'
const mayOpen = () => typeof window !== 'undefined' && !off('open') && !window.__ADAL_CLOUD && !(import.meta.env.VITE_PHONE === '1' || import.meta.env.VITE_ADMIN === '1' || import.meta.env.VITE_DEMO === '1')
const lastOpen = () => { try { return mayOpen() ? JSON.parse(localStorage.getItem(OPEN) || 'null') : null } catch { return null } }
const rememberOpen = (o) => { try { if (o && mayOpen()) localStorage.setItem(OPEN, JSON.stringify(o)); else localStorage.removeItem(OPEN) } catch {} }

export function AuthProvider({ children }) {
  const [state, setState] = useState(() => lastOpen() ? 'ready' : 'loading')
  const [company, setCompany] = useState(() => lastOpen()?.company || null)
  // Open from what was last seen, the PC not answering: said in a small line.
  const [quiet, setQuiet] = useState(false)
  const [subscription, setSubscription] = useState(null)
  const [user, setUser] = useState(null)
  const [activeEmployee, setActiveEmployeeState] = useState(loadStoredEmployee)

  const setActiveEmployee = useCallback((emp) => {
    setActiveEmployeeState(emp)
    if (emp && emp.id) {
      localStorage.setItem(
        'adal_active_employee',
        JSON.stringify({
          id: emp.id,
          name: emp.name,
          username: emp.username,
          role: emp.role || 'employee',
          role_id: emp.role_id ?? null,
          role_name: emp.role_name || null,
          staff_token: emp.staff_token || null,
        })
      )
    } else {
      localStorage.removeItem('adal_active_employee')
    }
    // Her staff role decides the buttons (lib/staffPerms.js).
    window.dispatchEvent(new Event('adal-staff-changed'))
    // Each employee has their own language (Settings → Look & language).
    import('../lib/i18n').then(m => m.followUser()).catch(() => {})
  }, [])

  const forgetOpen = useCallback(() => rememberOpen(null), [])

  const setCurrentUser = useCallback((u) => {
    setUser(u)
  }, [])

  const asking = useRef(null)   // one look at a time
  const look = useCallback(async () => {
    setState(s => s === 'ready' ? s : 'loading')   // (never a page taken away to look at the PC)
    for (let i = 0; i < 5; i++) {
      try {
        const st = await api.get('/setup/status')
        setCompany(st.data.companyName)
        setSubscription(st.data.subscription)
        setState(st.data.state); setQuiet(false)
        rememberOpen(st.data.state === 'ready' && st.data.subscription?.mode !== 'locked' ? { company: st.data.companyName } : null)
        try {
          const me = await api.get('/auth/me')
          setUser(me.data)
        } catch {
          setUser(null)
        }
        return
      } catch {
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
    setState(s => s === 'ready' ? (setQuiet(true), s) : 'error')
  }, [])
  const refresh = useCallback(() => asking.current ||= look().finally(() => { asking.current = null }), [look])

  // Signed in before staff roles (2026-11-22): the window keeps her name but has no staff key,
  // so the PC took it as signed out. Its device asks once for her key (asked on 2026-11-23).
  useEffect(() => {
    const e = loadStoredEmployee()
    let serial = null
    try { serial = localStorage.getItem('adal_device_serial') } catch {}
    if (!(e?.id > 0) || e.staff_token || !serial) return
    api.post('/employees/device-resume', { deviceSerial: serial })
      .then(r => { if (r.data?.user?.id === e.id) setActiveEmployee(r.data.user) })
      .catch(() => {})
  }, [setActiveEmployee])

  useEffect(() => {
    refresh()
  }, [refresh])

  // The trial can end (or Adal can suspend this PC) while the app is open: check often, and at
  // once when the server refuses a request because the app is locked.
  useEffect(() => {
    const check = () => api.get('/subscription/status').then(r => setSubscription(r.data)).catch(() => {})
    // Every 5 s while the page is shown: a suspension (or a month given) in Adal Keep Admin shows within seconds.
    const t = setInterval(() => { if (!document.hidden) check() }, 5000)
    window.addEventListener('adal-locked', check)
    return () => { clearInterval(t); window.removeEventListener('adal-locked', check) }
  }, [])
  // On the lock screen: every 3 s, so "Allow" or a month given in Adal Admin opens the app within seconds.
  const locked = subscription?.mode === 'locked'
  useEffect(() => { if (locked) rememberOpen(null) }, [locked])
  // Opened from what was last seen: asked again until the PC answers.
  useEffect(() => {
    if (!quiet) return
    const t = setInterval(() => refresh(), 10000)
    return () => clearInterval(t)
  }, [quiet, refresh])
  useEffect(() => {
    if (!locked) return
    const t = setInterval(() => api.get('/subscription/status').then(r => setSubscription(r.data)).catch(() => {}), 3000)
    return () => clearInterval(t)
  }, [locked])

  // Brand the window title once the company is known, e.g. "Adal Sunrise Recruitment".
  // Components read `company` from this context directly — no DOM patching needed.
  useEffect(() => {
    if (state === 'ready' && company) {
      document.title = `Adal ${company}`
    }
  }, [state, company])

  const completeSetup = async (payload) => {
    const r = await api.post('/setup/company', payload)
    await look()
    return r.data
  }

  const unlock = async (code) => {
    const r = await api.post('/subscription/unlock', { code })
    await look()
    return r.data
  }

  return (
    <AuthContext.Provider
      value={{
        state,
        company,
        subscription,
        user,
        setCurrentUser,
        activeEmployee,
        setActiveEmployee,
        refresh,
        quiet,
        forgetOpen,
        completeSetup,
        unlock,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
export default AuthContext
