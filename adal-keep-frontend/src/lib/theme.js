/**
 * Themes: 'light', 'dark', 'gradient' (black UI with moving gradients).
 *
 * `data-theme` drives the CSS variables in index.css and the `dark` class
 * drives Tailwind's dark: styles. Both must change together: the old code
 * restored only data-theme after a reload, so dark backgrounds showed with
 * light-mode (dark) text on top.
 */
export const THEMES = ['light', 'dark', 'gradient']
const KEY = 'adal-theme'

export function getTheme() {
  try {
    const t = localStorage.getItem(KEY)
    return THEMES.includes(t) ? t : 'light'
  } catch { return 'light' }
}

export function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : 'light'
  const root = document.documentElement
  root.setAttribute('data-theme', t)
  root.classList.toggle('dark', t !== 'light')
  try { localStorage.setItem(KEY, t) } catch {}
  window.dispatchEvent(new CustomEvent('adal-theme', { detail: t }))
  return t
}
