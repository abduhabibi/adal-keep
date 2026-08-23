import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import api from '../services/api'

const AuthContext = createContext()

export function AuthProvider({ children }) {
  const [state, setState] = useState('loading') // loading | setup | destroyed | ready | error
  const [company, setCompany] = useState(null)
  const [subscription, setSubscription] = useState(null)
  const [user, setUser] = useState(null)

  const refresh = useCallback(async () => {
    setState('loading')
    for (let i = 0; i < 5; i++) {
      try {
        // 1. Company / subscription status
        const st = await api.get('/setup/status')
        setCompany(st.data.companyName)
        setSubscription(st.data.subscription)
        setState(st.data.state)

        // 2. Current logged-in employee (if any)
        try {
          const me = await api.get('/auth/me')
          setUser(me.data)
        } catch {
          setUser(null)
        }
        return
      } catch {
        await new Promise(r => setTimeout(r, 1500))
      }
    }
    setState('error')
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Live brand swap for the sidebar H2
  useEffect(() => {
    if (!company || state !== 'ready') return
    const swap = () => document.querySelectorAll('h2').forEach(el => {
      const t = el.textContent.trim()
      if ((t === 'አዳል ኬፕ' || t === 'አዳል ኬ') || t === 'Adal Keep' || el.dataset.adalBrand) {
        el.textContent = company
        el.dataset.adalBrand = '1'
      }
    })
    swap()
    const obs = new MutationObserver(swap)
    obs.observe(document.body, { childList: true, subtree: true })
    return () => obs.disconnect()
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

  // Helper so any page can force a user refresh after login/logout
  const setCurrentUser = (u) => setUser(u)

  return (
    <AuthContext.Provider value={{
      state,
      company,
      subscription,
      user,
      setCurrentUser,
      refresh,
      completeSetup,
      unlock
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
export default AuthContext
