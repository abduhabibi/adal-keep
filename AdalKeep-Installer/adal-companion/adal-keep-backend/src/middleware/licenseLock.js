import fs from 'fs'
import path from 'path'

const LOCK_FILE = path.join(process.cwd(), '.subscription_lock')

export function licenseLockMiddleware(req, res, next) {
  const db = req.app.locals.db

  // Always allow these endpoints
  const openPaths = [
    '/api/license',
    '/api/health',
    '/api/subscription/status',
    '/api/subscription/activate-trial',
    '/api/subscription/submit-payment'
  ]

  if (openPaths.some(p => req.path.startsWith(p))) {
    return next()
  }

  // Check hardware lock
  if (req.app.locals.licenseLocked) {
    return res.status(403).json({
      error: 'locked',
      message: 'Hardware mismatch — server locked.'
    })
  }

  // Check subscription expiry (works OFFLINE using local clock)
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
      const now = Date.now()

      if (lockData.locked && now > lockData.lastCheck + 3600000) {
        // Re-check with server if possible, but stay locked if offline
        // The frontend will sync when connection returns
      }

      if (lockData.locked) {
        return res.status(403).json({
          error: 'subscription_expired',
          message: 'ደንበኝነት ምዝገባዎ አልቋል። እባክዎ ያድሱ።',
          days_remaining: 0
        })
      }
    }
  } catch {
    // If lock file is corrupted, allow access (fail-open for safety)
  }

  next()
}

/**
 * Called by frontend after checking /api/subscription/status
 * Updates local lock file so offline checks work
 */
export function updateLocalLock(status, daysRemaining) {
  try {
    const lockData = {
      locked: status === 'expired' || status === 'locked',
      status,
      daysRemaining,
      lastCheck: Date.now()
    }
    fs.writeFileSync(LOCK_FILE, JSON.stringify(lockData), 'utf8')
  } catch {
    // Silent fail — don't crash the app
  }
}