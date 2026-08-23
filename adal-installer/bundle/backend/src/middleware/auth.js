// No authentication - everyone is admin
export function authenticate(req, res, next) {
  req.user = { id: null, role: 'admin' }
  next()
}

export function requireAuth(req, res, next) {
  req.user = { id: null, role: 'admin' }
  next()
}

// Default export for backward compatibility
export default function(req, res, next) {
  req.user = { id: null, role: 'admin' }
  next()
}