import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import sessionConfig from './config/session.js'
// import { developerBypass } from './middleware/developerAccess.js'
// import { licenseLockMiddleware } from './middleware/licenseLock.js'
// import authRoutes from './routes/auth.js'
// import userRoutes from './routes/users.js'
import licenseRoutes from './routes/license.js'
import profileRoutes from './routes/profiles.js'
import fileRoutes from './routes/files.js' 
import locationRoutes from './routes/locations.js'
import auditRoutes from './routes/audit.js'
import dashboardRoutes from './routes/dashboard.js'
import logger from './utils/logger.js'
import employeeRoutes from './routes/employee.js'
import brokerRoutes from './routes/brokers.js'
import systemRoutes from './routes/system.js'
import updateRoutes from './routes/update.js'
// ...
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

// 1. Parsing & Core Config
app.use(express.json())
app.use(sessionConfig)
app.use('/api/employee', employeeRoutes)
app.use('/api/brokers', brokerRoutes)
app.use('/api/system', systemRoutes)
app.use('/api/update', updateRoutes)

// 2. Early Bypass Rules
// app.use(developerBypass)

// 3. Public License Endpoints
app.use('/api/license', licenseRoutes)

// 4. Lock Middleware
// app.use(licenseLockMiddleware)

// 5. Protected Static Assets & App Routes
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))
app.use('/api/dashboard', dashboardRoutes)
// app.use('/api/auth', authRoutes)
// app.use('/api/users', userRoutes)
app.use('/api/profiles', profileRoutes)
app.use('/api/files', fileRoutes)
app.use('/api/locations', locationRoutes)
app.use('/api/audit', auditRoutes)
app.get('/api/ping', (req, res) => res.json({ status: 'ok' }))

// 6. Error Handling (Must be dead last)
app.use((err, req, res, next) => {
  logger.error(err.message, { stack: err.stack, url: req.originalUrl })
  res.status(500).json({ error: 'Internal Server Error' })
})

export default app