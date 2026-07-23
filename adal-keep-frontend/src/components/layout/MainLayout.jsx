import { Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { useFileCapture } from '../../context/FileCaptureContext'
import Sidebar from './Sidebar'
import Navbar from './Navbar'
import QuickLinks from '../QuickLinks'
import api from '../../services/api'

export default function MainLayout() {
  const { capturedFiles, setCapturedFiles } = useFileCapture()
  const [wallpaperUrl, setWallpaperUrl] = useState(null)

  const loadWallpaper = async () => {
    try {
      const res = await api.get(`/wallpaper?t=${Date.now()}`, { responseType: 'blob' })
      setWallpaperUrl(URL.createObjectURL(res.data))
    } catch {
      setWallpaperUrl(null)
    }
  }

  useEffect(() => {
    loadWallpaper()
    
    // Listen for wallpaper changes from the Settings page
    const handleWallpaperChange = () => loadWallpaper()
    window.addEventListener('wallpaper-changed', handleWallpaperChange)

    // ... (Keep your existing drag/paste listeners here) ...
    const preventDefault = (e) => { e.preventDefault(); e.stopPropagation() }
    const handleGlobalDrop = (e) => {
      e.preventDefault(); e.stopPropagation()
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const newFiles = Array.from(e.dataTransfer.files).map(file => ({
          name: file.name, type: file.type, size: file.size,
          preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
          blob: file
        }))
        setCapturedFiles(prev => [...newFiles, ...prev])
        toast.success(`Captured ${newFiles.length} file(s)!`)
      }
    }
    const handlePaste = (e) => {
      const items = e.clipboardData?.items
      if (!items) return
      const newFiles = []
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile()
          newFiles.push({
            name: file.name || `Pasted_Image_${Date.now()}.png`,
            type: file.type, size: file.size,
            preview: URL.createObjectURL(file), blob: file
          })
        }
      }
      if (newFiles.length > 0) {
        setCapturedFiles(prev => [...newFiles, ...prev])
        toast.success(`Pasted ${newFiles.length} file(s)!`)
      }
    }

    window.addEventListener('dragover', preventDefault)
    window.addEventListener('drop', handleGlobalDrop)
    window.addEventListener('paste', handlePaste)

    return () => {
      window.removeEventListener('dragover', preventDefault)
      window.removeEventListener('drop', handleGlobalDrop)
      window.removeEventListener('paste', handlePaste)
      window.removeEventListener('wallpaper-changed', handleWallpaperChange)
    }
  }, [setCapturedFiles])

  return (
    // Apply wallpaper to the background here
    <div 
      className="flex h-screen bg-[#f3f6f5] dark:bg-slate-900 bg-cover bg-center bg-no-repeat transition-colors duration-300"
      style={{ backgroundImage: wallpaperUrl ? `url(${wallpaperUrl})` : 'none' }}
    >
      {/* Dark overlay to ensure text readability if wallpaper is bright */}
      {wallpaperUrl && <div className="absolute inset-0 bg-white/40 dark:bg-slate-900/60 pointer-events-none z-0"></div>}

      <div className="relative z-10 flex w-full h-full">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <Navbar />
          <main className="flex-1 overflow-y-auto p-6 custom-scrollbar">
            <Outlet />
          </main>
        </div>
        <QuickLinks />
      </div>
    </div>
  )
}