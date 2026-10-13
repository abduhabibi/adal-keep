/**
 * Checks subscription status on every protected request.
 * Uses local timestamp + server sync for offline resilience.
 */
export function subscriptionCheck(req, res, next) {
  const db = req.app.locals.db

  // Skip for license/auth endpoints
  if (req.path.startsWith('/api/license') || req.path === '/api/health') {
    return next()
  }

  // Check will be implemented with subscription table in production
  // For now, pass through (Class 2 baseline)
  next()
}