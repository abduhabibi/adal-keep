// Temporary permissive auth for local development
// Makes sure req.auth always exists so Employees & AI routes work

export function authenticate(req, res, next) {
  req.auth = {
    userId: 1,
    companyId: 1,
    branchId: 1,
    role: 'owner',
    username: 'admin'
  }
  req.user = req.auth
  next()
}

export function requireAuth(req, res, next) {
  req.auth = {
    userId: 1,
    companyId: 1,
    branchId: 1,
    role: 'owner',
    username: 'admin'
  }
  req.user = req.auth
  next()
}

export default function(req, res, next) {
  req.auth = {
    userId: 1,
    companyId: 1,
    branchId: 1,
    role: 'owner',
    username: 'admin'
  }
  req.user = req.auth
  next()
}
