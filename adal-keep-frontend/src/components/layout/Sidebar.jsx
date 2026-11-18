import { NavLink } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import toast from 'react-hot-toast'
import api from '../../services/api'
import { onPhone } from '../../lib/phoneMode'
import CompanionSwitchPC from '../CompanionSwitchPC'

export const links = [
  {
    to: '/',
    end: true,
    label: 'ዳሽቦርድ',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 13h7V4H4v9Zm9 7h7v-9h-7v9ZM4 20h7v-5H4v5Zm9-9h7V4h-7v7Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/profiles',
    label: 'ፕሮፋይሎች',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M16 19v-1.2A3.8 3.8 0 0 0 12.2 14H7.8A3.8 3.8 0 0 0 4 17.8V19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="10" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
        <path d="M19 11v6M16 14h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: '/brokers',
    label: 'አመቻቾች',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M17 20h5v-2a3 3 0 0 0-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 0 1 5.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 0 1 9.288 0M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM7 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/employees',
    label: 'ሰራተኞች',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M17 20h5v-2a3 3 0 0 0-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 0 1 5.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 0 1 9.288 0M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM7 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/checklist',
    label: 'የክትትል ዝርዝር',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9 11l3 3L22 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/tasks',
    label: 'ተግባሮች',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9 11l3 3L22 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/cvs',
    label: 'ሲቪዎች',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/chat',
    label: 'ቻት',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/notifications',
    label: 'ማሳወቂያዎች',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
]

// The Trash: only in the menu on the main PC itself (it opens only there).
// The phone app is served from http://localhost too: it is never the main PC.
/** Quit Adal Keep on the main PC: the server, the agents, WhatsApp, the Companions' connection. */
async function quitAdalKeep() {
  if (!window.confirm('Quit Adal Keep?\n\nThe server, the agents and WhatsApp stop on this PC, and the Companions and phones cannot connect until Adal Keep is opened again from its icon.')) return
  try { await api.post('/app/quit') } catch {}
  toast.success('Adal Keep is stopping. Open it again from its icon.')
}

export const onMainPC = () => ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) && !onPhone() && !window.Capacitor?.isNativePlatform?.()
export const trashLink = {
  to: '/trash',
  label: 'መጣያ',
  icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
}

export const settingsLink = {
  to: '/settings',
  label: 'ማስተካከያዎች',
  icon: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
}

export default function Sidebar({ isOpen, onToggle, collapsed: narrowWanted, onToggleCollapse }) {
  const collapsed = narrowWanted && (window.matchMedia?.('(min-width: 768px)').matches ?? true)
  const { company } = useAuth()
  // Before setup completes we show "Adal Keep"; afterwards "Adal <Company name>".
  const brand = company ? `Adal ${company}` : 'Adal Keep'

  const getLinkClass = ({ isActive }) =>
    `ak-side-link${isActive ? ' is-on' : ''}`

  return (
    <>
      {/* Mobile overlay */}
      <div
        className={`fixed inset-0 z-[75] bg-black/40 transition-all duration-300 md:hidden ${
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onToggle}
        aria-hidden="true"
      />

      <aside
        className={`
          flex flex-col shrink-0
          ak-side
          h-screen
          ${collapsed ? 'w-[72px]' : 'w-[248px]'}
          fixed inset-y-0 left-0 z-[80] shadow-xl
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
          md:relative md:translate-x-0 md:shadow-none md:z-auto
        `}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-5 border-b ak-side-sep min-h-[72px]">
          <div className={`flex items-center gap-3 overflow-hidden ${collapsed ? 'justify-center w-full' : ''}`}>
            {!collapsed && (
              <div className="w-9 h-9 rounded-xl overflow-hidden ak-side-logo shrink-0">
                <img src="/adal-logo.png" alt="Adal" className="h-full w-full object-cover" draggable={false} />
              </div>
            )}
            <div className={`${collapsed ? 'opacity-0 w-0 overflow-hidden' : 'opacity-100 w-auto'}`}>
              <div
                className="ak-side-brand text-[17px] font-extrabold tracking-tight whitespace-nowrap truncate max-w-[150px]"
                title={brand}
              >
                {brand}
              </div>
              <p className="ak-side-sub text-[10px] font-semibold uppercase tracking-[0.14em] leading-tight">ፕሪሚየም CRM</p>
            </div>
          </div>

          <button
            type="button"
            onClick={onToggleCollapse}
            className={`ak-side-toggle hidden md:flex p-1.5 rounded-lg shrink-0 ${
              collapsed ? 'absolute right-2 top-6' : ''
            }`}
            aria-label="ሳይድባር ቀይር"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`${collapsed ? 'rotate-180' : ''}`}>
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        </div>

        <div className="ak-tibeb ak-side-tibeb" aria-hidden="true" />
        {/* Navigation */}
        <nav className="flex-1 space-y-1 px-3 py-4 overflow-y-auto custom-scrollbar">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              onClick={() => { if (window.innerWidth < 768) onToggle() }}
              className={({ isActive }) => {
                const base = getLinkClass({ isActive })
                return collapsed ? `${base} justify-center px-0` : base
              }}
              title={collapsed ? link.label : ''}
            >
              <span className="shrink-0">{link.icon}</span>
              {!collapsed && <span className="truncate">{link.label}</span>}
            </NavLink>
          ))}

          <div className={`pt-3 mt-3 border-t ak-side-sep space-y-1 ${collapsed ? 'px-0' : ''}`}>
            {onMainPC() && [trashLink].map(link => (
              <NavLink key={link.to} to={link.to}
                onClick={() => { if (window.innerWidth < 768) onToggle() }}
                className={({ isActive }) => { const base = getLinkClass({ isActive }); return collapsed ? `${base} justify-center px-0` : base }}
                title={collapsed ? link.label : ''}>
                <span className="shrink-0">{link.icon}</span>
                {!collapsed && <span className="truncate">{link.label}</span>}
              </NavLink>
            ))}
            <NavLink
              to={settingsLink.to}
              onClick={() => { if (window.innerWidth < 768) onToggle() }}
              className={({ isActive }) => {
                const base = getLinkClass({ isActive })
                return collapsed ? `${base} justify-center px-0` : base
              }}
              title={collapsed ? settingsLink.label : ''}
            >
              <span className="shrink-0">{settingsLink.icon}</span>
              {!collapsed && <span className="truncate">{settingsLink.label}</span>}
            </NavLink>
            {/* The main PC (Windows): closing the window keeps Adal Keep working in
                the background; this stops it all, after a Yes. */}
            {onMainPC() && /Windows/i.test(navigator.userAgent) && import.meta.env.VITE_DEMO !== '1' && import.meta.env.VITE_ADMIN !== '1' && (
              <button type="button" onClick={quitAdalKeep}
                className={`${getLinkClass({ isActive: false })} w-full ${collapsed ? 'justify-center px-0' : ''}`}
                title={collapsed ? 'Quit Adal Keep' : ''}>
                <span className="shrink-0">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 3v9M7.05 6.05a7 7 0 1 0 9.9 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </span>
                {!collapsed && <span className="truncate">Quit Adal Keep</span>}
              </button>
            )}
            {/* An Adal Companion only: log out of its main PC, connect to another. */}
            <CompanionSwitchPC compact={collapsed} />
            {/* Daily tutor: hover to open (public demo has none) */}
          </div>
        </nav>

        <div className={`border-t ak-side-sep ak-side-sub px-4 py-3 text-[10px] shrink-0 ${collapsed ? 'text-center' : ''}`}>
          {collapsed ? 'v2.0' : 'የአካባቢ የስራ ቦታ · SQLite'}
        </div>
      </aside>
    </>
  )
}
