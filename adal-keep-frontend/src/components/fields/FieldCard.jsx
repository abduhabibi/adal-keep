import { useState, useRef } from 'react'
import toast from 'react-hot-toast'
import api from '../../services/api'
import { useFileCapture } from '../../context/FileCaptureContext'

export default function FieldCard({ field, profileId, onFileUpdate }) {
  const { capturedFiles } = useFileCapture()
  const [uploading, setUploading] = useState(false)
  const [pendingFile, setPendingFile] = useState(null)
  const [downloadFiles, setDownloadFiles] = useState([])
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false)
  const fileInputRef = useRef(null)

  const handleFileSelect = (file) => {
    if (!file) return
    setPendingFile(file)
  }

  const handleFormatChoice = async (targetFormat) => {
    if (!pendingFile) return
    setUploading(true)
    const formData = new FormData()
    formData.append('file', pendingFile)
    if (targetFormat) formData.append('targetFormat', targetFormat)

    try {
      const res = await api.post(`/profiles/${profileId}/fields/${field.id}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      toast.success(`Uploaded and converted!`)
      onFileUpdate(field.id, res.data.files)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed')
    } finally {
      setUploading(false)
      setPendingFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDrop = async (e) => {
    e.preventDefault()
    let fileToUpload = null

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      fileToUpload = e.dataTransfer.files[0]
    } else {
      const indexStr = e.dataTransfer.getData('capturedFileIndex')
      if (indexStr) {
        const index = parseInt(indexStr, 10)
        const capturedFile = capturedFiles[index]
        if (capturedFile && capturedFile.blob) fileToUpload = capturedFile.blob
      }
    }
    if (fileToUpload) handleFileSelect(fileToUpload)
  }

  const handleDelete = async (fileId) => {
    if (!confirm('Delete this specific file?')) return
    try {
      await api.delete(`/files/${fileId}`)
      toast.success('File deleted')
      
      // Fetch the latest fields to ensure UI is perfectly in sync
      const res = await api.get(`/profiles/${profileId}/fields`)
      const updatedField = res.data.find(f => f.id === field.id)
      
      // Pass the updated files array directly to the parent
      onFileUpdate(field.id, updatedField ? updatedField.files : [])
    } catch (err) {
      console.error('Delete error:', err)
      toast.error('Delete failed')
    }
  }

  const handleDownloadClick = async () => {
    try {
      const res = await api.get(`/profiles/${profileId}/fields/${field.id}/files`)
      setDownloadFiles(res.data)
      setIsDownloadModalOpen(true)
    } catch {
      toast.error('Failed to load files')
    }
  }

  const isImage = (f) => f?.mimetype?.startsWith('image/')

  return (
    <div 
      className="panel p-4 flex flex-col gap-3 relative bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-sm"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <h3 className="font-display text-sm font-bold text-slate-800 dark:text-slate-100">{field.name}</h3>
        {field.files?.length > 0 && (
          <span className="chip bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400 ring-1 ring-teal-200 dark:ring-teal-800 text-[10px] px-2 py-0.5 rounded-full font-medium">
            {field.files.length} file{field.files.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Content Area */}
      {field.files?.length > 0 ? (
        <div className="flex flex-col gap-3">
          {/* Main Preview (First File) */}
          <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
            {isImage(field.files[0]) ? (
              <img src={`/api/files/${field.files[0].id}/thumbnail`} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center text-slate-400 dark:text-slate-500 gap-2">
                <svg className="h-10 w-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                <span className="text-xs font-medium">Document</span>
              </div>
            )}
          </div>
          
          {/* File List with Individual Actions */}
          <div className="space-y-2 max-h-32 overflow-y-auto custom-scrollbar pr-1">
            {field.files.map(f => (
              <div key={f.id} className="flex items-center justify-between p-2 bg-slate-50 dark:bg-slate-900/50 rounded-lg border border-slate-200 dark:border-slate-700 group">
                <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
                  <div className={`w-6 h-6 rounded flex items-center justify-center shrink-0 ${isImage(f) ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>
                    {isImage(f) ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                    )}
                  </div>
                  <span className="text-xs text-slate-600 dark:text-slate-300 truncate font-medium" title={f.original_name}>
                    {f.original_name}
                  </span>
                </div>
                <div className="flex gap-1 shrink-0 ml-2">
                  <a 
                    href={`/api/files/${f.id}/download`} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-900/30 rounded-md transition-colors"
                    title="Download"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                  </a>
                  <button 
                    type="button" 
                    onClick={() => handleDelete(f.id)}
                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-md transition-colors"
                    title="Delete this file"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.133 21H7.867a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Empty State */
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50 py-6 text-center transition hover:border-teal-400 hover:bg-teal-50/50 dark:hover:bg-teal-900/10">
          <svg className="h-8 w-8 text-slate-300 dark:text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
          <label className="cursor-pointer text-xs font-semibold text-teal-700 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300">
            {uploading ? 'Processing...' : 'Click or drag to upload'}
            <input type="file" ref={fileInputRef} className="hidden" accept="image/*,application/pdf" onChange={(e) => handleFileSelect(e.target.files[0])} disabled={uploading} />
          </label>
          <span className="text-[10px] text-slate-400 dark:text-slate-500">Max 10MB (Image or PDF)</span>
        </div>
      )}

      {/* Upload Format Modal */}
      {pendingFile && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden border border-slate-200 dark:border-slate-700">
            <div className="p-5 border-b border-slate-100 dark:border-slate-700">
              <h4 className="font-bold text-slate-800 dark:text-white text-lg">Choose Save Format</h4>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate">File: {pendingFile.name}</p>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-sm text-slate-600 dark:text-slate-300 text-center">
                We will save both the original and the converted version.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <button 
                  onClick={() => handleFormatChoice('image')} 
                  className="flex flex-col items-center gap-2 p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800 rounded-xl hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
                >
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  <span className="font-semibold text-sm">Image</span>
                </button>
                <button 
                  onClick={() => handleFormatChoice('pdf')} 
                  className="flex flex-col items-center gap-2 p-4 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-xl hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                >
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                  <span className="font-semibold text-sm">PDF</span>
                </button>
              </div>
            </div>
            <div className="p-4 bg-slate-50 dark:bg-slate-900/50 border-t border-slate-100 dark:border-slate-700 flex justify-end">
              <button onClick={() => setPendingFile(null)} className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Download Format Modal */}
      {isDownloadModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden border border-slate-200 dark:border-slate-700">
            <div className="p-5 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center">
              <h3 className="font-bold text-slate-800 dark:text-white text-lg">Download Format</h3>
              <button onClick={() => setIsDownloadModalOpen(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-4 space-y-2 max-h-80 overflow-y-auto custom-scrollbar">
              {downloadFiles.map(f => (
                <a 
                  key={f.id}
                  href={`/api/files/${f.id}/download`}
                  className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-teal-50 dark:hover:bg-teal-900/20 hover:border-teal-300 dark:hover:border-teal-800 transition-colors group"
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${isImage(f) ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'}`}>
                    {isImage(f) ? (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{f.original_name}</p>
                    <p className="text-xs text-slate-400 dark:text-slate-500">{f.mimetype?.includes('pdf') ? 'PDF Document' : 'Image File'}</p>
                  </div>
                  <svg className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}