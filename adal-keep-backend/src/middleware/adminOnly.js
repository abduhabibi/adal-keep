// No authentication - all users are admin
export function requireAdmin(req, res, next) {
  next()
}

export function requireAdminOrDeveloper(req, res, next) {
  next()
}

// Default export for backward compatibility
export default function(req, res, next) {
  next()
}