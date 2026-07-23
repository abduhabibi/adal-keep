// Only these exact paths are allowed when the server is locked
const ALLOWED_WHEN_LOCKED = [
  '/api/license/status',
  '/api/license/reset',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/ping',
]

export function licenseLockMiddleware(req, res, next) {
  // If the server is NOT locked, allow everything
  if (!req.app.locals.licenseLocked) {
    return next()
  }

  // Server IS locked — only allow whitelisted paths
  if (ALLOWED_WHEN_LOCKED.includes(req.path)) {
    return next()
  }

  // Everything else is blocked
  return res.status(503).json({
    error: 'SERVER_LOCKED',
    message: 'Hardware fingerprint mismatch. Enter dev password to unlock.',
  })
}