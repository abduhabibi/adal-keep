/**
 * The Adal Keep phone app (Android) has everything the PC has, except a
 * profile's AI actions (the robots run only on the PC).
 */
export const isPhoneApp = () => import.meta.env.VITE_PHONE === '1' && !!window.Capacitor?.isNativePlatform?.()
/**
 * The phone app, whatever pages it shows (its own, or the PC's on the office
 * Wi-Fi: the app adds "AdalKeepPhone" to every page's user agent). The phone
 * itself reaches no portal: buttons that send Adal Keep to a website
 * (Musaned, Wafid, LMIS …) are not shown there (asked on 2026-11-15).
 */
export const onPhone = () => import.meta.env.VITE_PHONE === '1' || !!window.Capacitor?.isNativePlatform?.() || /AdalKeepPhone/.test(navigator.userAgent || '')
