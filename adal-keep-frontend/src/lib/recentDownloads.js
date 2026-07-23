export const getRecentDownloads = () => {
  const stored = localStorage.getItem('adal_recent_downloads')
  return stored ? JSON.parse(stored) : []
}

export const addRecentDownload = (file) => {
  let recent = getRecentDownloads()
  // Remove if already exists to avoid duplicates and move to top
  recent = recent.filter((f) => f.id !== file.id)
  recent.unshift(file)
  // Keep only last 10
  recent = recent.slice(0, 10)
  localStorage.setItem('adal_recent_downloads', JSON.stringify(recent))
}