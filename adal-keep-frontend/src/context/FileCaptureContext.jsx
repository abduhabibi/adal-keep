import { createContext, useContext, useState, useCallback, useEffect } from 'react'

// Profiles kept in the tray (only ids and names, on this computer): they stay
// until dragged onto a checklist or taken out.
const PROFILES_KEY = 'adal-tray-profiles'
const readTray = () => { try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]') } catch { return [] } }

// This device, as each tray card names it.
const DEVICE = (() => {
  try {
    if (import.meta.env.VITE_DEMO === '1') return 'Main PC'
    if (import.meta.env.VITE_PHONE === '1' || /AdalKeepPhone/.test(navigator.userAgent || '')) return 'Phone'
    if (location.host === '127.0.0.1:47801') return 'Companion PC'
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return 'Companion PC'
  } catch {}
  return 'Main PC'
})()

const FileCaptureContext = createContext()

export function FileCaptureProvider({ children }) {
  const [capturedFiles, setCapturedFiles] = useState([])
  const [trayProfiles, setTrayProfiles] = useState(readTray)
  useEffect(() => { try { localStorage.setItem(PROFILES_KEY, JSON.stringify(trayProfiles)) } catch {} }, [trayProfiles])
  const addProfiles = useCallback((list) => {
    const have = new Set(trayProfiles.map(p => p.id))
    const fresh = list.filter(p => p?.id && !have.has(p.id))
    if (fresh.length) setTrayProfiles(prev => [...prev, ...fresh.filter(p => !prev.some(x => x.id === p.id)).map(p => ({ id: p.id, full_name: p.full_name || '', phone_number: p.phone_number || '' }))])
    return fresh.length
  }, [trayProfiles])
  const removeProfile = useCallback((id) => setTrayProfiles(prev => prev.filter(p => p.id !== id)), [])
  const clearProfiles = useCallback(() => setTrayProfiles([]), [])

  // The last files that came in: the arrival pop-up (TrayArrival.jsx) shows them.
  const [arrival, setArrival] = useState(null) // { files, at }
  const addFiles = useCallback((fileList, { source = 'Added', pop = true } = {}) => {
    const filesArray = Array.from(fileList).filter(f => f instanceof File)
    if (filesArray.length === 0) return 0

    const newFiles = filesArray.map(file => {
      // Attach metadata directly onto the File object without spreading
      // This preserves the native File prototype for FormData.append()
      if (!file.id) {
        file.id = `tray-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      }
      if (!file.preview && file.type?.startsWith('image/')) {
        file.preview = URL.createObjectURL(file)
      }
      // Where it came from and when (shown on its tray card).
      if (!file.source) file.source = source
      if (!file.device) file.device = DEVICE
      if (!file.addedAt) file.addedAt = Date.now()
      return file
    })

    setCapturedFiles(prev => [...prev, ...newFiles])
    // Files coming one after the other (a scan of several pages): one pop-up.
    if (pop) setArrival(prev => prev && Date.now() - prev.at < 8000
      ? { files: [...prev.files, ...newFiles], at: Date.now() }
      : { files: newFiles, at: Date.now() })
    return newFiles.length
  }, [])

  const removeFile = useCallback((index) => {
    setCapturedFiles(prev => {
      const file = prev[index]
      if (file?.preview) URL.revokeObjectURL(file.preview)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  /** Takes these files (ids) out of the tray: they were put on a profile. */
  const removeFilesById = useCallback((ids) => {
    const out = new Set(ids)
    setCapturedFiles(prev => prev.filter(f => {
      if (!out.has(f.id)) return true
      if (f.preview) setTimeout(() => URL.revokeObjectURL(f.preview), 60000) // the pop-up may still show it
      return false
    }))
  }, [])

  const clearAll = useCallback(() => {
    setCapturedFiles(prev => {
      prev.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview) })
      return []
    })
  }, [])

  return (
    <FileCaptureContext.Provider value={{ capturedFiles, setCapturedFiles, addFiles, removeFile, removeFilesById, clearAll, arrival, setArrival, trayProfiles, addProfiles, removeProfile, clearProfiles }}>
      {children}
    </FileCaptureContext.Provider>
  )
}

export const useFileCapture = () => {
  const context = useContext(FileCaptureContext)
  if (!context) throw new Error('useFileCapture must be used within FileCaptureProvider')
  return context
}

export default FileCaptureContext
