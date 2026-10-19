import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import api from '../services/api'

const AuthContext = createContext()

function loadStoredEmployee() {
  try {
    const raw = localStorage.getItem('adal_active_employee')
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }) {
  const [state, setState] = useState('loading')
  const [company, setCompany] = useState(null)
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
        })
      )
    } else {
      localStorage.removeItem('adal_active_employee')
    }
  }, [])

  const setCurrentUser = useCallback((u) => {
    setUser(u)
  }, [])

  const refresh = useCallback(async () => {
    setState('loading')
    for (let i = 0; i < 5; i++) {
      try {
        const st = await api.get('/setup/status')
        setCompany(st.data.companyName)
        setSubscription(st.data.subscription)
        setState(st.data.state)
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
    setState('error')
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // The trial can end while the app is open: check every 5 minutes, and at
  // once when the server refuses a request because the app is locked.
  useEffect(() => {
    const check = () => api.get('/subscription/status').then(r => setSubscription(r.data)).catch(() => {})
    const t = setInterval(check, 5 * 60000)
    window.addEventListener('adal-locked', check)
    return () => { clearInterval(t); window.removeEventListener('adal-locked', check) }
  }, [])

  // Brand the window title once the company is known, e.g. "Adal Sunrise Recruitment".
  // Components read `company` from this context directly — no DOM patching needed.
  useEffect(() => {
    if (state === 'ready' && company) {
      document.title = `Adal ${company}`
    }
  }, [state, company])

  const completeSetup = async (payload) => {
    const r = await api.post('/setup/company', payload)
    await refresh()
    return r.data
  }

  const unlock = async (code) => {
    const r = await api.post('/subscription/unlock', { code })
    await refresh()
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
