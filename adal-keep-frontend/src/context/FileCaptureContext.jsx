import { createContext, useContext, useState, useCallback } from 'react'

const FileCaptureContext = createContext()

export function FileCaptureProvider({ children }) {
  const [capturedFiles, setCapturedFiles] = useState([])

  const addFiles = useCallback((fileList) => {
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
      return file
    })

    setCapturedFiles(prev => [...prev, ...newFiles])
    return newFiles.length
  }, [])

  const removeFile = useCallback((index) => {
    setCapturedFiles(prev => {
      const file = prev[index]
      if (file?.preview) URL.revokeObjectURL(file.preview)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  const clearAll = useCallback(() => {
    setCapturedFiles(prev => {
      prev.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview) })
      return []
    })
  }, [])

  return (
    <FileCaptureContext.Provider value={{ capturedFiles, setCapturedFiles, addFiles, removeFile, clearAll }}>
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
