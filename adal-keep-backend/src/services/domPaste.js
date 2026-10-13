/**
 * domPaste.js — fast, paste-like text injection for automation inputs.
 *
 * The old hot path typed character-by-character with a per-keystroke delay
 * (`element.type(text, { delay: 40 })`), which is what made the Musaned /
 * LMIS forms slow. A single "paste" event carrying the whole string is what
 * Angular/PrimeNG/React value accessors need, so they fire once and settle
 * immediately.
 *
 * IMPORTANT — Playwright vs Puppeteer
 * ----------------------------------
 * `page.keyboard.insertText()` is a **Playwright-only** API. This project
 * drives the browser with **puppeteer-core** (see services/browser.js), whose
 * Keyboard exposes `sendCharacter()` instead. Calling `insertText()` on a
 * Puppeteer page throws `TypeError: page.keyboard.insertText is not a
 * function`, which used to silently push every paste onto the slow
 * native-setter fallback below.
 *
 * `insertTextCompat()` probes for whichever API the current page actually
 * implements, so the same code is correct on both drivers.
 */

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * Paste-like single-event text entry that works on Puppeteer AND Playwright.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {string} text
 * @returns {Promise<boolean>} true when a keyboard API actually ran
 */
export async function insertTextCompat(page, text) {
  const v = String(text ?? '')
  if (!v) return false
  const kb = page && page.keyboard
  if (!kb) return false

  // Puppeteer: one character event per char, no key events — closest match to
  // a real paste and the exact analogue of Playwright's insertText().
  if (typeof kb.sendCharacter === 'function') {
    try {
      for (const ch of v) await kb.sendCharacter(ch)
      return true
    } catch { /* fall through */ }
  }

  // Playwright: genuine insertText().
  if (typeof kb.insertText === 'function') {
    try { await kb.insertText(v); return true } catch { /* fall through */ }
  }

  // Either way, `type()` exists — slowest but still correct.
  if (typeof kb.type === 'function') {
    try { await kb.type(v); return true } catch { /* fall through */ }
  }

  return false
}

/**
 * Replace the current value of `input` with `text` as fast as a paste.
 *
 * @param {import('puppeteer-core').Page} page
 * @param {import('puppeteer-core').ElementHandle} input
 * @param {string} text
 * @returns {Promise<string>} the value actually present afterwards
 */
export async function pasteText(page, input, text) {
  const v = String(text ?? '')

  // Select whatever is already there and delete it (Ctrl+A, Backspace).
  try { await input.click({ clickCount: 3, delay: 8 }) } catch {}
  await page.keyboard.down('Control').catch(() => {})
  await page.keyboard.press('KeyA').catch(() => {})
  await page.keyboard.up('Control').catch(() => {})
  await page.keyboard.press('Backspace').catch(() => {})

  // Paste-like: one bulk insert event for the whole string (no per-char delay).
  const ok = await insertTextCompat(page, v)

  await sleep(70)
  let actual = await input.evaluate(n => n.value).catch(() => '')

  // Fallback: native prototype setter + input/change events.
  if (!ok || actual !== v) {
    await input.evaluate((node, val) => {
      const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set
      setter.call(node, val)
      node.dispatchEvent(new Event('input',  { bubbles: true }))
      node.dispatchEvent(new Event('change', { bubbles: true }))
      node.dispatchEvent(new Event('blur',   { bubbles: true }))
    }, v).catch(() => {})
    await sleep(50)
    actual = await input.evaluate(n => n.value).catch(() => actual)
  }

  return actual
}

/**
 * Same as {@link pasteText} but accepts a plain Node/Element (resolved via
 * `page.evaluate`), useful when the caller already has a DOM reference.
 */
export async function pasteIntoSelector(page, selector, text) {
  const el = await page.$(selector)
  if (!el) return null
  return pasteText(page, el, text)
}

/**
 * Paste `text` into `input` and then COMMIT it the way a human does:
 * press `ArrowDown` (highlight the first suggestion) followed by `Enter`
 * (select it). On a plain input this is a harmless no-op; on an
 * Angular/PrimeNG autocomplete, calendar or typeahead it is what makes the
 * pasted value actually "stick" instead of being reverted when the field
 * loses focus. This is the "click the down arrow and Enter after a paste to
 * save everything" behaviour the operator asked for.
 *
 * @returns {Promise<string>} the value present AFTER commit (may differ from
 *   the pasted text when the widget substituted a matched option).
 */
export async function pasteAndCommit(page, input, text) {
  const before = await pasteText(page, input, text)

  // Make sure the field we just filled is the focused one so the ArrowDown /
  // Enter land on the right control.
  try { await input.click({ delay: 10 }) } catch {}
  await sleep(60)

  try { await page.keyboard.press('ArrowDown') } catch {}
  await sleep(80)
  try { await page.keyboard.press('Enter') } catch {}
  await sleep(120)

  const after = await input.evaluate(n => n.value).catch(() => before)
  return after
}
