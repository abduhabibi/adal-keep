import { useEffect, useState } from 'react'

/**
 * True once the server has a newer build of the page than the one this tab
 * is running (the page keeps running the version it loaded until reloaded).
 */
export default function useNewVersion() {
  const [newer, setNewer] = useState(false)
  useEffect(() => {
    const mine = document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute('src')
    if (!mine) return // development server: always current
    const check = async () => {
      try {
        const html = await (await fetch('/', { cache: 'no-store' })).text()
        const now = html.match(/\/assets\/index-[^"']+\.js/)?.[0]
        if (now && !mine.endsWith(now)) setNewer(true)
      } catch {}
    }
    const t = setInterval(check, 60000)
    window.addEventListener('focus', check)
    return () => { clearInterval(t); window.removeEventListener('focus', check) }
  }, [])
  return newer
}
