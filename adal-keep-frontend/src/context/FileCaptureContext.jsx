import { createContext, useContext } from 'react'

const FileCaptureContext = createContext()

export const useFileCapture = () => {
  const context = useContext(FileCaptureContext)
  if (!context) {
    throw new Error('useFileCapture must be used within FileCaptureProvider')
  }
  return context
}

export default FileCaptureContext