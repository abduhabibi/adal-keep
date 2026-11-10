/**
 * workflows.js — metadata for the UI.
 * The actual step logic lives in lmisWorkflow.js and musanedWorkflow.js.
 *
 * Three user-facing workflows:
 *   - police_certificate    → LMIS police clearance
 *   - musaned_add_candidate → Musaned login (manual captcha) + Add Candidate flow
 */

export const WORKFLOWS = {
  police_certificate: {
    id: 'police_certificate',
    name: 'Make Police Certificate',
    description: 'LMIS → Organizations → EOW → Police Certificate → Add New → uploads',
    target: 'https://lmis.gov.et',
    consts: {},
    stepCount: 9,
  },

  musaned_add_candidate: {
    id: 'musaned_add_candidate',
    name: 'Make Musaned (add candidate)',
    description:
      'Log in to Musaned (you solve reCAPTCHA + OTP), then auto-click agency → ADD NEW CANDIDATE → fill the pre-check form',
    target: 'https://tawtheeq.musaned.com.sa',
    consts: {},
    stepCount: 4,
  },

  musaned_check_chosen: {
    id: 'musaned_check_chosen',
    name: 'Check if chosen',
    description:
      'Musaned sign-in (a person types the code) → Employment Requests → search her passport → if she is there: DETAILS → contract details and the PDFs (template.pdf and the signed contracts) saved to the profile',
    target: 'https://tawtheeq.musaned.com.sa/employment-requests',
    consts: {},
    stepCount: 3,
  },

  musaned_epro_approve: {
    id: 'musaned_epro_approve',
    name: 'EPRO approve',
    description:
      'After Wafid FIT: Musaned → Employment Requests → her passport → DETAILS → APPROVE → the agency\'s signed contract (Settings → Integrations) uploaded in Contract Upload. SAVE is never pressed: a person looks it over and saves.',
    target: 'https://tawtheeq.musaned.com.sa/employment-requests',
    consts: {},
    stepCount: 4,
  },

  musaned_cv_import: {
    id: 'musaned_cv_import',
    name: 'Add from Musaned',
    description:
      'Musaned sign-in (a person types the code) → HR Pool → search her passport → VIEW → her passport and photo copied to the profile, every empty field filled from the passport → her CV made',
    target: 'https://tawtheeq.musaned.com.sa/hr-pool',
    consts: {},
    stepCount: 4,
  },

  musaned_delete: {
    id: 'musaned_delete',
    name: 'Delete from Musaned',
    description:
      'Musaned sign-in → HR Pool → search her passport → Delete. Says so if she is not there. Her profile here stays.',
    target: 'https://tawtheeq.musaned.com.sa/hr-pool',
    consts: {},
    stepCount: 3,
  },

  mofa_visa: {
    id: 'mofa_visa',
    name: 'Make visa (Enjaz)',
    description:
      'Visa platform (visa.mofa.gov.sa) → a person types the sign-in captcha → New Application → Agree → the whole form from the profile and her Musaned contract → a person types the captcha and presses Save',
    target: 'https://visa.mofa.gov.sa/Account/Login',
    consts: {},
    stepCount: 4,
  },

  mofa_find_app: {
    id: 'mofa_find_app',
    name: 'Find application number (Enjaz)',
    description:
      'Visa platform → a person types the sign-in captcha → the list of visa applications → her passport number → her Application Number, and whether the fees are paid (Print | Edit)',
    target: 'https://visa.mofa.gov.sa/SmartForm',
    consts: {},
    stepCount: 3,
  },

  mofa_pay: {
    id: 'mofa_pay',
    name: 'Pay visa fees (Enjaz)',
    description:
      'Visa platform → a person types the sign-in captcha → Pay Visa Fees → her application number and passport number → Search → rings: a person checks and pays',
    target: 'https://visa.mofa.gov.sa/Account/Login/enjazcompany',
    consts: {},
    stepCount: 3,
  },

  wafid_check: {
    id: 'wafid_check',
    name: 'Check Wafid result',
    description: 'wafid.com/en/medical-status-search → her passport + nationality → Check → FIT / UNFIT written on the profile',
    target: 'https://wafid.com/en/medical-status-search/',
    consts: {},
    stepCount: 2,
  },

  wafid_slip: {
    id: 'wafid_slip',
    name: 'Appointment slip',
    description: 'wafid.com/en/search-slip → her passport + nationality → Search → the slip pops up → PDF → saved in Appointment Slip, ready to print',
    target: 'https://wafid.com/en/search-slip/',
    consts: {},
    stepCount: 2,
  },

  insurance_certificate: {
    id: 'insurance_certificate',
    name: 'Insurance certificate',
    description: 'FetaP (agency.niscofetap.com) sign-in → Draft Certificates → New Certificate → the whole form (Region Addis Ababa) → a person adds the member, the beneficiary and finishes it',
    target: 'https://agency.niscofetap.com/certificate/draft',
    consts: {},
    stepCount: 3,
  },

  wafid_book: {
    id: 'wafid_book',
    name: 'Book Wafid medical',
    description:
      'Wafid → appointment location → Standard Appointment → fill every detail + "I confirm…" → a person presses Save And Continue, enters the SMS code and pays',
    target: 'https://wafid.com/en/book-appointment/',
    consts: {},
    stepCount: 3,
  },

}

export function listWorkflows() {
  return Object.values(WORKFLOWS)
}

export function getWorkflow(id) {
  return WORKFLOWS[id] || null
}