/**
 * The Adal Keep phone app (Android) has everything the PC has, except a
 * profile's AI actions (the robots run only on the PC).
 */
export const isPhoneApp = () => import.meta.env.VITE_PHONE === '1' && !!window.Capacitor?.isNativePlatform?.()
