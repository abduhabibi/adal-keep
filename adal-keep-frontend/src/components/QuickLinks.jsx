import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'

const IconPlus = ({ className = "w-5 h-5" }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
)

const IconX = ({ className = "w-5 h-5" }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

const DEFAULT_LINKS = [
  { id: '1', name: 'LMIS', url: 'https://lmis.gov.et' },
]

// Helper to get the real website favicon
const getFaviconUrl = (url) => {
  try {
    const domain = new URL(url).hostname
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
  } catch {
    return null
  }
}

export default function QuickLinks() {
  const [links, setLinks] = useState(() => {
    try {
      const saved = localStorage.getItem('adal_quick_links')
      return saved ? JSON.parse(saved) : DEFAULT_LINKS
    } catch {
      return DEFAULT_LINKS
    }
  })

  const [isExpanded, setIsExpanded] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const [newLink, setNewLink] = useState({ name: '', url: 'https://' })
  const [hoveredLink, setHoveredLink] = useState(null)
  
  const menuRef = useRef(null)
  const hoverTimeoutRef = useRef(null) // Fixes the disappearing tooltip
  const navigate = useNavigate()

  useEffect(() => {
    localStorage.setItem('adal_quick_links', JSON.stringify(links))
  }, [links])

  const handleAddLink = () => {
    if (!newLink.name.trim() || !newLink.url.trim()) {
      toast.error('Name and URL are required')
      return
    }
    
    // Ensure URL starts with http
    let finalUrl = newLink.url
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      finalUrl = 'https://' + finalUrl
    }

    setLinks([...links, {
      id: Date.now().toString(),
      name: newLink.name,
      url: finalUrl,
    }])
    
    setNewLink({ name: '', url: 'https://' })
    setIsAdding(false)
    toast.success('Link added successfully')
  }

  const handleDeleteLink = (e, id) => {
    e.stopPropagation() // CRITICAL: Prevents opening the link when clicking delete
    setLinks(links.filter(link => link.id !== id))
    setHoveredLink(null)
    toast.success('Link removed')
  }

  const handleLinkClick = (e, link) => {
    e.preventDefault()
    if (link.url.startsWith('http')) {
      window.open(link.url, '_blank')
    } else {
      navigate(link.url)
    }
  }

  // FIX 1: Grace period for tooltip
  const handleMouseEnter = (link) => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
    setHoveredLink(link)
  }

  const handleMouseLeave = () => {
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredLink(null)
    }, 400) // 400ms delay gives you time to move mouse to the tooltip
  }

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsExpanded(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Fan out upwards and to the left (180deg to 270deg)
  const positions = links.map((_, index) => {
    const total = Math.max(links.length - 1, 1)
    const angle = Math.PI + (index / total) * (Math.PI / 2) // 180° to 270°
    const radius = 70
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius
    }
  })

  return (
    <div ref={menuRef} className="fixed bottom-6 right-6 z-50">
      {/* Tooltip Popup */}
      {hoveredLink && (
        <div 
          className="absolute bottom-16 right-0 bg-white rounded-xl shadow-xl p-3 border border-slate-200 z-50 min-w-[220px]"
          onMouseEnter={() => {
            if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
          }}
          onMouseLeave={handleMouseLeave}
        >
          <div className="flex items-center gap-3 mb-3">
            {/* FIX 2: Real Website Favicon Thumbnail */}
            <img 
              src={getFaviconUrl(hoveredLink.url) || 'https://via.placeholder.com/32'} 
              alt="icon" 
              className="w-8 h-8 rounded-lg object-contain bg-slate-50 p-1 border border-slate-100 shrink-0"
              onError={(e) => { e.target.src = 'https://via.placeholder.com/32?text=Link' }}
            />
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-slate-800 text-sm truncate">{hoveredLink.name}</h3>
              <p className="text-[10px] text-slate-400 truncate">{hoveredLink.url}</p>
            </div>
          </div>
          <div className="flex justify-between items-center pt-2 border-t border-slate-100">
            <button 
              onClick={(e) => handleDeleteLink(e, hoveredLink.id)}
              className="text-xs text-red-600 hover:text-red-700 font-medium flex items-center gap-1 px-2 py-1 rounded hover:bg-red-50 transition-colors"
            >
              <IconX className="w-3 h-3" /> Remove
            </button>
            <a 
              href={hoveredLink.url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xs text-teal-600 hover:text-teal-700 font-medium flex items-center gap-1 px-2 py-1 rounded hover:bg-teal-50 transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              <span>Open</span>
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" />
              </svg>
            </a>
          </div>
        </div>
      )}

      {/* Scattered Links */}
      <div className="relative">
        {links.map((link, index) => (
          <button
            key={link.id}
            onClick={(e) => handleLinkClick(e, link)}
            onMouseEnter={() => handleMouseEnter(link)}
            onMouseLeave={handleMouseLeave}
            className={`absolute top-1 left-1 w-11 h-11 rounded-full bg-white text-slate-700 shadow-lg border border-slate-100 flex items-center justify-center transition-all duration-300 transform hover:bg-teal-50 hover:text-teal-600 hover:scale-110 ${
              isExpanded ? 'scale-100 opacity-100 pointer-events-auto' : 'scale-0 opacity-0 pointer-events-none'
            }`}
            style={{
              transform: isExpanded 
                ? `translate(${positions[index]?.x || 0}px, ${positions[index]?.y || 0}px)` 
                : 'translate(0, 0)',
              transitionDelay: `${index * 40}ms`
            }}
            title={link.name}
          >
            {/* Real Favicon in the button too */}
            <img 
              src={getFaviconUrl(link.url) || 'https://via.placeholder.com/24'} 
              alt={link.name} 
              className="w-6 h-6 rounded object-contain"
              onError={(e) => { e.target.style.display = 'none' }} 
            />
          </button>
        ))}

        {/* Add Button */}
        {isExpanded && (
          <button
            onClick={() => setIsAdding(true)}
            className="absolute top-1 left-1 w-11 h-11 rounded-full bg-teal-100 text-teal-700 shadow-md flex items-center justify-center hover:bg-teal-200 transition-all transform -translate-y-24"
            title="Add link"
          >
            <IconPlus className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Toggle Main FAB */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`w-14 h-14 rounded-full bg-teal-600 text-white shadow-xl flex items-center justify-center transition-all duration-200 ${
          isExpanded ? 'bg-teal-700 ring-4 ring-teal-200 rotate-90' : 'hover:scale-105'
        }`}
        aria-label="Toggle Quick Links"
      >
        {isExpanded ? <IconX className="w-6 h-6" /> : <IconPlus className="w-6 h-6" />}
      </button>

      {/* Modal */}
      {isAdding && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden animate-fade-up">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center">
              <h3 className="font-bold text-slate-800 text-base">Add Quick Link</h3>
              <button onClick={() => setIsAdding(false)} className="text-slate-400 hover:text-slate-600">
                <IconX className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Name</label>
                <input
                  type="text"
                  value={newLink.name}
                  onChange={(e) => setNewLink({ ...newLink, name: e.target.value })}
                  placeholder="e.g., LMIS Portal"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-teal-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">URL</label>
                <input
                  type="url"
                  value={newLink.url}
                  onChange={(e) => setNewLink({ ...newLink, url: e.target.value })}
                  placeholder="https://example.com"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-teal-500 focus:outline-none"
                />
              </div>
            </div>
            <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsAdding(false)}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddLink}
                className="px-3 py-1.5 text-xs font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors"
              >
                Add Link
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}