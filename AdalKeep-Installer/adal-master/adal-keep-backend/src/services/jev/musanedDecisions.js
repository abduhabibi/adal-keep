/**
 * musanedDecisions.js — Jev (TypeSafe System One) decisions for Musaned.
 *
 * All exported functions return:
 *   { <field>: value, source: 'jev' | 'fallback' [, probability] }
 *
 * They never throw. On Jev failure (disabled, timeout, bad key) each
 * function falls back to a deterministic heuristic that keeps the
 * workflow running safely.
 *
 * Decision functions:
 *   reviewPostLogin       — post-Sign-In screen classification
 *   reviewHumanSignedIn   — did the human act between two polls?
 *   reviewMusanedScreen   — agency picker / dashboard / login forms / captcha / otp
 *   reviewCandidateForm   — is the candidate pre-check form fully filled?
 *   reviewStageComplete   — generic stage completion verification
 */

import { askJev } from './client.js'

// ═══════════════════════════════════════════════════════════════════════════
// Musaned login & navigation decisions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * After Sign In is clicked, decide what happened.
 * Returns: 'otp_screen' | 'still_login' | 'error' | 'unknown'
 * Fallback on Jev failure: heuristic based on URL + element presence.
 */
export async function reviewPostLogin(pageState) {
  const { ok, answers } = await askJev(
    { workflow: 'musaned_login', page_state: pageState },
    {
      post_login: {
        type: 'Choice',
        instructions: 'What screen is Musaned showing after we clicked Sign In?',
        criteria: {
          otp_screen: 'An OTP / verification code input or "enter the code" text is visible.',
          still_login: 'The username/password form is still fully visible.',
          error: 'A red error banner says invalid credentials or similar.',
          unknown: 'None of the above.',
        },
      },
    }
  )
  if (!ok) {
    // Deterministic fallback: URL change = OTP screen (most common)
    if (pageState.url && !/auth|login|openid-connect/i.test(pageState.url)) {
      return { state: 'otp_screen', source: 'fallback' }
    }
    if (pageState.hasPassword) return { state: 'still_login', source: 'fallback' }
    return { state: 'unknown', source: 'fallback' }
  }
  return { state: answers.post_login?.choice || 'unknown', source: 'jev' }
}

/**
 * Decide if the human has signed in / entered the OTP between two polls.
 * Returns { yes: boolean, source, probability? }.
 * Fallback on Jev failure: URL changed between snapshots.
 */
export async function reviewHumanSignedIn(beforeState, afterState) {
  const { ok, answers } = await askJev(
    { workflow: 'musaned_login', before: beforeState, after: afterState },
    {
      human_signed_in: {
        type: 'Noul',
        instructions: 'Did the human sign in or submit the OTP between these two snapshots?',
        criteria: {
          true: 'The URL changed away from /auth, OR the login form disappeared, OR an OTP screen or dashboard appeared.',
          false: 'Nothing material changed between the two snapshots.',
        },
      },
    }
  )
  if (!ok) return { yes: beforeState?.url !== afterState?.url, source: 'fallback' }
  const p = answers.human_signed_in?.noul ?? 0
  return { yes: p > 0.7, source: 'jev', probability: p }
}

/**
 * Classify the current Musaned / Keycloak page.
 *
 * Returns one of:
 *   'dashboard'       — logged in, on the main dashboard
 *   'agency-picker'   — "Welcome back! Please select the establishment" + agency card
 *   'captcha'         — reCAPTCHA visible (workflow should fill and proceed)
 *   'otp'             — OTP field present
 *   'login-form'      — still on the credentials form
 *   'login-error'     — "invalid username or password"
 *   'unknown'         — none of the above
 */
export async function reviewMusanedScreen(pageState) {
  const { ok, answers } = await askJev(
    { workflow: 'musaned_login', page_state: pageState },
    {
      screen: {
        type: 'Choice',
        options: ['dashboard', 'agency-picker', 'captcha', 'otp', 'login-form', 'login-error', 'unknown'],
        instructions:
          'Classify the current screen.\n' +
          '- dashboard: nav shows Dashboard/Organizations/HR Pool OR "Latest Requests"/"Latest Candidates" list.\n' +
          '- agency-picker: greeting "Welcome back" + "Please select the establishment" + one or more agency cards.\n' +
          '- captcha: "I\'m not a robot" or an image grid challenge.\n' +
          '- otp: single input asking for a verification code / one-time code.\n' +
          '- login-form: username + password inputs visible together.\n' +
          '- login-error: red banner saying invalid credentials or account disabled.\n' +
          '- unknown: none of the above.',
      },
    }
  )

  if (!ok) {
    // Deterministic fallback
    const s = pageState || {}
    if (s.hasLoginError) return { screen: 'login-error', source: 'fallback' }
    if (s.hasCaptcha)    return { screen: 'captcha', source: 'fallback' }
    if (s.hasOtp)        return { screen: 'otp', source: 'fallback' }
    if (s.hasAgencyPicker) return { screen: 'agency-picker', source: 'fallback' }
    if (s.hasDashboardNav) return { screen: 'dashboard', source: 'fallback' }
    if (s.hasPassword && s.hasUsername) return { screen: 'login-form', source: 'fallback' }
    return { screen: 'unknown', source: 'fallback' }
  }
  return { screen: answers.screen?.choice || 'unknown', source: 'jev' }
}

// ═══════════════════════════════════════════════════════════════════════════
// Musaned add-candidate decisions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verify the candidate form is fully filled before we let the human review it.
 * Returns: { ready: boolean, missing: [...], source, probability? }
 * Fallback on Jev failure: deterministic — checks each field is non-empty.
 */
export async function reviewCandidateForm(pageState, expected) {
  const { ok, answers } = await askJev(
    {
      workflow: 'musaned_add_candidate',
      form_state: pageState,
      expected,
    },
    {
      fields_ok: {
        type: 'Noul',
        instructions:
          'Is every required field (ID Number, Passport file, Passport Number, Surname, ' +
          'Given Names, Date of birth) filled with a value that matches the expected profile data?',
        criteria: {
          true: 'All six fields have values, none are empty, and they match the expected data.',
          false: 'At least one field is empty, mismatched, or missing.',
        },
      },
    }
  )
  if (!ok) {
    // Deterministic check
    const missing = []
    for (const k of ['idNumber', 'passportNumber', 'surname', 'givenNames', 'dateOfBirth']) {
      if (!pageState[k] || !String(pageState[k]).trim()) missing.push(k)
    }
    if (!pageState.hasPassportFile) missing.push('passportFile')
    return { ready: missing.length === 0, missing, source: 'fallback' }
  }
  const p = answers.fields_ok?.noul ?? 0
  return { ready: p > 0.7, missing: [], source: 'jev', probability: p }
}

/**
 * After a stage completes, verify it actually succeeded.
 *
 * Input: { stage, expectedSignals, observedSignals }
 * Returns: { complete: boolean, reason: string, source }
 */
export async function reviewStageComplete({ stage, expected, observed }) {
  const { ok, answers } = await askJev(
    { workflow: 'musaned_login', stage, expected, observed },
    {
      complete: {
        type: 'Noul',
        instructions:
          'Is the stage complete? Return true only when ALL expected signals are present ' +
          'in the observed state, with no contradicting evidence.',
        criteria: {
          true: 'Every expected signal is present and nothing contradicts success.',
          false: 'At least one expected signal is missing, OR contradicting evidence is present.',
        },
      },
    }
  )

  if (!ok) {
    // Deterministic: check every expected key
    const missing = []
    for (const [key, want] of Object.entries(expected || {})) {
      const got = observed?.[key]
      if (want === true && got !== true) missing.push(key)
    }
    return {
      complete: missing.length === 0,
      reason: missing.length ? `missing: ${missing.join(', ')}` : 'all signals present',
      source: 'fallback',
    }
  }

  const p = answers.complete?.noul ?? 0
  return {
    complete: p > 0.75,
    reason: `probability ${p.toFixed(2)}`,
    source: 'jev',
  }
}
/**
 * Decide whether the passport upload in the Candidate pre-check modal
 * succeeded, was rejected, or is still processing.
 */
export async function reviewPassportUpload(modalState) {
  const { ok, answers } = await askJev(
    { workflow: 'musaned_add_candidate', modal_state: modalState },
    {
      passport_upload: {
        type: 'Choice',
        options: ['ok', 'rejected', 'processing', 'unknown'],
        instructions:
          'Classify the passport upload field in the Candidate pre-check modal.\n' +
          '- ok: a thumbnail or filename is shown AND there is no error banner.\n' +
          '- rejected: any text about "not clear", "unclear", "needs a clearer image", ' +
          '"rejected", "invalid image", "quality", or "try again" is visible.\n' +
          '- processing: a spinner/progress indicator is shown and no thumbnail yet.\n' +
          '- unknown: none of the above.',
      },
    }
  )

  if (!ok) {
    const text = String(modalState?.modalText || '').toLowerCase()
    const REJECT = /not\s+clear|unclear|clearer|rejected|invalid\s+image|quality|try\s+again|not\s+accepted|must\s+be\s+clear/i
    if (REJECT.test(text)) return { state: 'rejected', reason: text.slice(0, 200), source: 'fallback' }
    if (modalState?.hasPreview) return { state: 'ok', source: 'fallback' }
    if (modalState?.hasSpinner) return { state: 'processing', source: 'fallback' }
    return { state: 'unknown', source: 'fallback' }
  }
  return { state: answers.passport_upload?.choice || 'unknown', source: 'jev' }
}
/**
 * Ask Jev: is the Candidate pre-check modal ready to submit?
 *
 * Input: modal state scraped from the browser:
 *   {
 *     fields: { 'id number': { value, type }, 'passport number': {...}, ... },
 *     hasPassportPreview: boolean,
 *     text: string
 *   }
 *
 * Returns: { ready: boolean, state, reason, source }
 */
export async function reviewPreCheckReady(modalState) {
  const { ok, answers } = await askJev(
    { workflow: 'musaned_add_candidate', modal_state: modalState },
    {
      pre_check: {
        type: 'Choice',
        options: ['ready', 'incomplete', 'rejected', 'unknown'],
        instructions:
          'Look at the "Candidate pre-check" modal state.\n' +
          '- ready: ID Number, Passport Number, Surname, Given Names, and ' +
          '"Date of birth in Gregorian" all have non-empty values, AND the ' +
          'Passport upload shows a thumbnail/preview, AND there is no error text.\n' +
          '- rejected: any text about "not clear", "unclear", "rejected", ' +
          '"invalid image", "quality", "try again", or "must be clear" is visible.\n' +
          '- incomplete: one or more of the required fields above are still ' +
          'empty, or the passport thumbnail is missing, with no error text.\n' +
          '- unknown: cannot tell.',
      },
    }
  )

  if (!ok) {
    const f = modalState?.fields || {}
    const need = ['id number', 'passport number', 'surname', 'given names', 'date of birth in gregorian']
    const missing = need.filter(k => !((f[k]?.value || '').trim()))
    const text = String(modalState?.text || '').toLowerCase()
    if (/not\s+clear|unclear|clearer|rejected|invalid|quality|try\s+again|must\s+be\s+clear/.test(text))
      return { ready: false, state: 'rejected', reason: 'error text in modal', source: 'fallback' }
    if (missing.length)
      return { ready: false, state: 'incomplete', reason: `missing: ${missing.join(', ')}`, source: 'fallback' }
    if (!modalState?.hasPassportPreview)
      return { ready: false, state: 'incomplete', reason: 'no passport preview', source: 'fallback' }
    return { ready: true, state: 'ready', source: 'fallback' }
  }

  const c = answers.pre_check?.choice || 'unknown'
  return {
    ready: c === 'ready',
    state: c,
    reason: c === 'ready' ? null : `Jev classified modal as "${c}"`,
    source: 'jev',
  }
}