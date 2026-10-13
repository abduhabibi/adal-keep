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

}

export function listWorkflows() {
  return Object.values(WORKFLOWS)
}

export function getWorkflow(id) {
  return WORKFLOWS[id] || null
}