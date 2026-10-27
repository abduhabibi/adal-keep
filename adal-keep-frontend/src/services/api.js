import axios from 'axios'

const api = axios.create({
  baseURL: '/api', // Vite proxy will forward this to http://localhost:4000/api
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // Required for cookies/sessions
})

// Who is working (the employee chosen on this PC): the Trash shows who deleted what.
api.interceptors.request.use((config) => {
  try {
    const e = JSON.parse(localStorage.getItem('adal_active_employee') || 'null')
    const who = e?.name || e?.full_name || e?.username
    if (who) config.headers['X-Adal-Who'] = encodeURIComponent(String(who).slice(0, 80))
  } catch {}
  return config
})

// Public demo build (vite --mode demo): answer in the browser with made-up
// data instead of calling a server. See src/demo/server.js.
if (import.meta.env.VITE_DEMO === '1') {
  api.interceptors.request.use(async (config) => {
    config.adapter = (await import('../demo/server.js')).demoAdapter
    return config
  })
}

// Phone app with its PC off or far away: the pages work on the agency's
// online copy (src/cloud/adapter.js) instead of the PC.
if (import.meta.env.VITE_PHONE === '1') {
  api.interceptors.request.use(async (config) => {
    if (window.__ADAL_CLOUD === true) config.adapter = (await import('../cloud/adapter.js')).cloudAdapter
    return config
  })
}

// Global error handler (optional but helpful for debugging)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    // Trial over and not unlocked: the app swaps itself for the lock screen.
    if (error.response?.status === 402 && error.response?.data?.error === 'locked') {
      window.dispatchEvent(new Event('adal-locked'))
    }
    if (error.response?.status === 503) {
      console.error('⚠️ Server is locked due to hardware mismatch.')
    } else if (error.code === 'ERR_NETWORK') {
      console.error('❌ Cannot connect to backend. Is the server running on port 4000?')
    }
    return Promise.reject(error)
  }
)

export default api