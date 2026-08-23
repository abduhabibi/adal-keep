import session from 'express-session'

export default session({
  secret: process.env.SESSION_SECRET || 'flex-local-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  },
})
