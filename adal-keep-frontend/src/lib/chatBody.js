// Old chat messages that carried a profile (a removed feature): their file is
// not shown and the line with its key is hidden.
export const isSharedProfile = (m) => m?.file_mime === 'application/x-adal-profile'
export const cleanBody = (body) => String(body || '').split('\n').filter(l => !/^\[adal-profile/.test(l)).join('\n')
