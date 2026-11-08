/**
 * Dragging profiles anywhere in Adal Keep (search results, the list, the tray)
 * onto a checklist or the tray. One drag carries one or many profiles.
 */
export const PROFILES_TYPE = 'application/x-adal-profiles'

/** Starts a drag of these profiles ([{id, full_name}] or ids). */
export function dragProfiles(e, profiles) {
  const list = (Array.isArray(profiles) ? profiles : [profiles]).map(p => (typeof p === 'object' ? p : { id: p }))
  e.dataTransfer.setData(PROFILES_TYPE, JSON.stringify(list.map(p => p.id)))
  e.dataTransfer.setData('application/x-adal-profile-names', JSON.stringify(list.map(p => ({ id: p.id, full_name: p.full_name || '', phone_number: p.phone_number || '' }))))
  if (list.length === 1) e.dataTransfer.setData('profileId', String(list[0].id))
  e.dataTransfer.setData('text/plain', list.map(p => p.full_name || `#${p.id}`).join(', '))
  e.dataTransfer.effectAllowed = 'copyMove'
}

/** True while what is dragged is profiles (works during dragover, when data is hidden). */
export const isProfileDrag = (e) => Array.from(e.dataTransfer?.types || []).some(t => t === PROFILES_TYPE || t === 'profileid')

/** The profile ids dropped. */
export function profilesDropped(e) {
  try {
    const ids = JSON.parse(e.dataTransfer.getData(PROFILES_TYPE) || '[]')
    if (ids.length) return ids.map(Number).filter(Boolean)
  } catch {}
  const one = Number(e.dataTransfer.getData('profileId'))
  return one ? [one] : []
}

/** The profiles dropped, with their names when the drag carried them. */
export function profileCardsDropped(e) {
  try {
    const list = JSON.parse(e.dataTransfer.getData('application/x-adal-profile-names') || '[]')
    if (list.length) return list
  } catch {}
  return profilesDropped(e).map(id => ({ id, full_name: '', phone_number: '' }))
}
