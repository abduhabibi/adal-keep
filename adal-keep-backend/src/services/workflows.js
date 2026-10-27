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

  lmis_contract: {
    id: 'lmis_contract',
    name: 'Create LMIS contract',
    description:
      'LMIS → Contract → search her Labor ID → Open → Create Contract (by itself once an employer chose her and Wafid is FIT); a person continues the contract',
    target: 'https://lmis.gov.et/organization/register/',
    consts: {},
    stepCount: 5,
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