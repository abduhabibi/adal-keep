import { getLang, setLang } from '../lib/i18n'

// Always on screen (top bar): the language names stay as they are, so a person
// who landed in Arabic or Amharic can always find the way back to English.
const LANGS = [['en', 'EN'], ['am', 'አማ'], ['ar', 'ع']]
const NAMES = { en: 'English', am: 'አማርኛ', ar: 'العربية' }

export default function LanguageSwitch({ className = '' }) {
  const now = getLang()
  return (
    <div translate="no" dir="ltr" className={`inline-flex shrink-0 items-center rounded-full bg-slate-100 p-0.5 text-[11px] font-semibold dark:bg-slate-800 ${className}`}>
      {LANGS.map(([id, label]) => (
        <button key={id} type="button" title={NAMES[id]} aria-label={NAMES[id]} aria-pressed={id === now}
          onClick={() => { if (id !== now) setLang(id) }}
          className={`rounded-full px-2 py-0.5 ${id === now ? 'bg-white text-teal-700 shadow-sm dark:bg-slate-600 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'}`}>{label}</button>
      ))}
    </div>
  )
}
