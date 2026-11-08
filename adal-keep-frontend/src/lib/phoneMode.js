/**
 * The Adal Keep phone app (Android): it is for adding profiles and for the
 * notifications. The robots (AI actions), the Downloads watcher and the file
 * tray are PC things — they are not shown in the app.
 */
export const isPhoneApp = () => import.meta.env.VITE_PHONE === '1' && !!window.Capacitor?.isNativePlatform?.()

/** The pages the phone app has (its menu, and where its links go). */
export const PHONE_PAGES = ['/profiles', '/notifications', '/settings']
