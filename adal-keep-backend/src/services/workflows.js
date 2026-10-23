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
    name: 'Add Candidate on Musaned',
    description:
      'Log in to Musaned (you solve reCAPTCHA + OTP), then auto-click agency → ADD NEW CANDIDATE → fill the pre-check form',
    target: 'https://tawtheeq.musaned.com.sa',
    consts: {},
    stepCount: 4,
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