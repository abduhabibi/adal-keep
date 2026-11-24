/**
 * No browser window on Linux (the owner, 2026-11-23: "stop this brave window opening again
 * and again and never do it in any way"). Linux window managers ignore --window-position, so
 * an "off-screen" robot or WhatsApp window showed up and took the focus. On Linux every
 * browser Adal Keep starts is headless: the robots' pages are seen through the live view
 * (its pictures come from the tab itself), and nothing opens a window unless the person
 * opens Adal Keep. ADAL_SHOW_WINDOWS=1 shows them again (for a developer, by hand).
 */
// (Adal Robots with its window switched on for this PC: browser.js robotWindow.)
export const noWindows = () => process.platform === 'linux' && process.env.ADAL_SHOW_WINDOWS !== '1' &&
  !(process.env.ADAL_ROBOT_PROCESS === '1' && process.env.ADAL_ROBOTS_WINDOW === '1')
/** puppeteer.launch's `headless` for a browser that would otherwise show a window. */
export const headlessHere = () => (noWindows() ? true : false)
/** Command-line flags for a browser started by hand (spawn). */
export const headlessArgs = () => (noWindows() ? ['--headless=new'] : [])
