import { Link } from 'react-router-dom'

const links = [
  { to: '/profiles/new', label: 'አዲስ ፕሮፋይል', icon: '👤', bg: 'bg-teal-500' },
  { to: '/tasks', label: 'ተግባሮች', icon: '📌', bg: 'bg-blue-500' },
  { to: '/brokers', label: 'አመቻቾች', icon: '🤝', bg: 'bg-purple-500' },
  { to: '/checklist', label: 'የክትትል ዝርዝር', icon: '✅', bg: 'bg-green-500' },
  { to: '/updates', label: 'ማሳወቂያዎች', icon: '🔔', bg: 'bg-yellow-500' },
]

export default function QuickLinks() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 mb-6">
      {links.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          className="flex flex-col items-center justify-center gap-2 p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 hover:border-teal-500/40 hover:scale-[1.03] transition-all duration-200"
        >
          <div className={`w-10 h-10 rounded-xl ${link.bg} flex items-center justify-center text-white text-lg shadow-md`}>
            {link.icon}
          </div>
          <span className="text-xs font-semibold text-white/90 text-center leading-tight">{link.label}</span>
        </Link>
      ))}
    </div>
  )
}
