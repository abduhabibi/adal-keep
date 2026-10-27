/**
 * Adal Keep opened inside the phone app (adal-phone): its WebView adds
 * "AdalKeepPhone" to the user agent. The app's own pairing screen lives at
 * http://localhost/ inside the phone.
 */
export const IN_PHONE_APP = typeof navigator !== 'undefined' && /AdalKeepPhone/.test(navigator.userAgent || '')
export const PAIR_PAGE = 'http://localhost/connect.html?pair=1'
