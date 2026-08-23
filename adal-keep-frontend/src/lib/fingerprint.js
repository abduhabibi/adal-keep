/**
 * Generates a browser fingerprint for subscription tracking.
 * Uses stable browser properties that persist across sessions.
 */
export async function generateFingerprint() {
  const components = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.hardwareConcurrency || '',
    navigator.deviceMemory || ''
  ]

  const raw = components.join('|')

  // Simple hash (no crypto needed — just identification, not security)
  let hash = 0
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }

  return 'web-' + Math.abs(hash).toString(36)
}