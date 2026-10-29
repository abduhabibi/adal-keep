/**
 * A task done on the phone itself: the portal opens in Adal Keep's own
 * browser (adal-phone AdalBrowserActivity) with the agency's sign-in filled
 * (from the locked "/vault") and her details one tap away. The person signs
 * in, types codes and solves captchas; nothing is pressed for them.
 */
import api from '../services/api'

// Where each task starts, and whose sign-in it uses.
// [task, first page, sign-ins, the site the sign-in may be filled on (and its sub-sites)]
const PORTALS = [
  [/^musaned/, 'https://tawtheeq.musaned.com.sa/', '/musaned/accounts', 'musaned.com.sa'],
  [/^police_certificate/, 'https://lmis.gov.et/new-agency/police-certificate', '/lmis/accounts', 'lmis.gov.et'],
  [/^(lmis|contract_import_labour|delete_labour)/, 'https://lmis.gov.et', '/lmis/accounts', 'lmis.gov.et'],
  [/^wafid_book/, 'https://wafid.com/en/book-appointment/', null, 'wafid.com'],
  [/^wafid_check/, 'https://wafid.com/en/medical-status-search/', null, 'wafid.com'],
  [/^wafid_slip/, 'https://wafid.com/en/search-slip/', null, 'wafid.com'],
  [/^insurance/, 'https://agency.niscofetap.com/', '/insurance/accounts', 'niscofetap.com'],
  [/^mofa|^visa/, 'https://visa.mofa.gov.sa/', '/visa/accounts', 'mofa.gov.sa'],
]
export const portalOf = (workflowId) => PORTALS.find(([re]) => re.test(String(workflowId || '')))

export const canOpenOnPhone = () => !!window.Capacitor?.Plugins?.AdalDiscovery?.openBrowser

// Her details for the 📋 sheet (only what she has).
const DETAILS = [
  ['Full name', 'full_name'], ['Passport', 'passport_number'], ['Labor ID', 'labor_id'], ['Phone', 'phone_number'],
  ['Date of birth', 'date_of_birth'], ['Passport issued', 'passport_issue_date'], ['Passport expiry', 'passport_expiry_date'],
  ['Place of birth', 'place_of_birth'], ['National ID', 'national_id'], ['Mother', 'mother_name'], ['Father', 'father_name'],
  ['Religion', 'religion'], ['Marital status', 'marital_status'], ['Visa number', 'visa_number'], ['Contract number', 'contract_number'],
  ['Emergency name', 'emergency_name'], ['Emergency phone', 'emergency_phone'], ['Emergency Labor ID', 'emergency_labor_id'],
  ['Region', 'region'], ['Zone / Sub-city', 'zone_subcity'], ['Education', 'education_level'],
]

/** Open a task's portal on this phone. accountId: the sign-in picked on the profile (else the default one). */
export async function openOnPhone({ workflowId, profileId, accountId, title }) {
  const portal = portalOf(workflowId)
  if (!portal) throw new Error('This step has no website to open yet.')
  const [, url, accountsKey, site] = portal
  let user = '', pass = ''
  if (accountsKey) {
    try {
      const { openVault } = await import('../cloud/adapter.js')
      const list = (await openVault())[accountsKey] || []
      const a = list.find(x => String(x.id) === String(accountId)) || list.find(x => x.is_default) || list[0]
      if (a) { user = a.login_value || a.username || a.phone || ''; pass = a.password || '' }
    } catch {}
  }
  let fields = [], profile = {}, plans = []
  if (profileId) {
    try {
      const p = (await api.get(`/profiles/${profileId}`)).data || {}
      fields = DETAILS.map(([label, k]) => ({ label, value: p[k] == null ? '' : String(p[k]).trim() })).filter(f => f.value)
      // For the ✨ filler (adal-phone assets/adal-fill.js): her details by name,
      // the name also as first / father's / grandfather's (Ethiopian names).
      const words = String(p.full_name || '').trim().split(/\s+/).filter(Boolean)
      profile = Object.fromEntries(Object.entries({
        ...Object.fromEntries(DETAILS.map(([, k]) => [k, p[k]])),
        first_name: words[0], father_name: words[1], grandfather_name: words.slice(2).join(' '),
        gender: p.gender, nationality: p.nationality || 'Ethiopian', children_count: p.children_count, height: p.height, weight: p.weight,
        emergency_relationship: p.emergency_relationship,
      }).filter(([, v]) => v != null && String(v).trim() !== '').map(([k, v]) => [k, String(v).trim()]))
    } catch {}
    // The PC robots' own steps for this portal (same boxes, same values).
    try { plans = ((await api.get(`/profiles/${profileId}/fill-plan`)).data?.plans || []).filter(pl => pl.site === site) } catch {}
  }
  const plugin = window.Capacitor?.Plugins?.AdalDiscovery
  if (!plugin?.openBrowser) { window.open(url, '_blank', 'noopener'); return { opened: 'tab' } }
  await plugin.openBrowser({ url, host: site, user, pass, fields, profile, plans, title: title || '', desktop: false })
  return { opened: 'phone', signIn: !!pass }
}
