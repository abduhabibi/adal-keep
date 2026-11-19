/**
 * The Adal Keep phone app (Android) has everything the PC has, except a
 * profile's AI actions (the robots run only on the PC).
 */
export const isPhoneApp = () => import.meta.env.VITE_PHONE === '1' && !onCompanionOnline() && !!window.Capacitor?.isNativePlatform?.()
/**
 * The phone app, whatever pages it shows (its own, or the PC's on the office
 * Wi-Fi: the app adds "AdalKeepPhone" to every page's user agent). The phone
 * itself reaches no portal: buttons that send Adal Keep to a website
 * (Musaned, Wafid, LMIS …) are not shown there (asked on 2026-11-15).
 */
/**
 * An Adal Companion PC's own online pages (AdalKeep.exe serves the phone
 * build on 127.0.0.1:47801 while the main PC cannot be reached directly). It
 * is a PC, not a phone: every page and button the main PC has is shown, and
 * what must run on the main PC goes there through the online link.
 */
export const onCompanionOnline = () => typeof location !== 'undefined' && location.host === '127.0.0.1:47801'
/** A phone (or Adal Admin) working on the online copy — not an Adal Companion. */
export const phoneCloud = () => !!window.__ADAL_CLOUD && !onCompanionOnline()
export const onPhone = () => !onCompanionOnline() && (import.meta.env.VITE_PHONE === '1' || !!window.Capacitor?.isNativePlatform?.() || /AdalKeepPhone/.test(navigator.userAgent || ''))
