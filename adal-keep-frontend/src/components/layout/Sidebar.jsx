import { NavLink } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import BrowsersSection from '../BrowsersSection'
import { onPhone, onCompanionOnline } from '../../lib/phoneMode'
import { inCompanion } from '../../lib/companionOnline'
import Icon from '../shared/Icon'

export const links = [
  {
    to: '/',
    end: true,
    label: 'ዳሽቦርድ',
    icon: <Icon name="home" />,
  },
  {
    to: '/profiles',
    label: 'ፕሮፋይሎች',
    icon: <Icon name="profiles" />,
  },
  {
    to: '/brokers',
    label: 'አመቻቾች',
    icon: <Icon name="brokers" />,
  },
  {
    to: '/employees',
    label: 'ሰራተኞች',
    icon: <Icon name="employees" />,
  },
  {
    to: '/checklist',
    label: 'የክትትል ዝርዝር',
    icon: <Icon name="checklist" />,
  },
  {
    to: '/tasks',
    label: 'ተግባሮች',
    icon: <Icon name="tasks" />,
  },
  {
    to: '/cvs',
    label: 'ሲቪዎች',
    icon: <Icon name="cv" />,
  },
  {
    to: '/chat',
    label: 'ቻት',
    icon: <Icon name="chat" />,
  },
  {
    to: '/notifications',
    label: 'ማሳወቂያዎች',
    icon: <Icon name="bell" />,
  },
]

export const onMainPC = () => ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) && !onPhone() && !onCompanionOnline() && !window.Capacitor?.isNativePlatform?.()
/** The Trash: on the main PC and on its Adal Companions (the same Adal Keep); never on a phone. */
export const showTrash = () => onMainPC() || inCompanion()
export const trashLink = {
  to: '/trash',
  label: 'መጣያ',
  icon: <Icon name="trash" />,
}

export const settingsLink = {
  to: '/settings',
  label: 'ማስተካከያዎች',
  icon: <Icon name="settings" />,
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
            <Icon name="chevronLeft" size={16} className={collapsed ? 'rotate-180' : ''} />
          </button>
        </div>

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
            {showTrash() && [trashLink].map(link => (
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
            {/* Daily tutor: hover to open (public demo has none) */}
          </div>
          {/* Browsers (2026-11-21): every robot browser of the office, opened live here. It took the place of "Quit Adal Keep" (now in Settings). */}
          {!onPhone() && import.meta.env.VITE_DEMO !== '1' && import.meta.env.VITE_ADMIN !== '1' && <BrowsersSection collapsed={collapsed} />}
        </nav>

      </aside>
    </>
  )
}
