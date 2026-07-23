import axios from 'axios'

const api = axios.create({
  baseURL: '/api', // Vite proxy will forward this to http://localhost:4000/api
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // Required for cookies/sessions
})

// Global error handler (optional but helpful for debugging)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 503) {
      console.error('⚠️ Server is locked due to hardware mismatch.')
    } else if (error.code === 'ERR_NETWORK') {
      console.error('❌ Cannot connect to backend. Is the server running on port 4000?')
    }
    return Promise.reject(error)
  }
)

export default api