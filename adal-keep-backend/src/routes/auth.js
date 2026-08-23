import { Router } from 'express'
import { login, logout, getMe } from '../controllers/authController.js'

const router = Router()

router.post('/login', login)
router.post('/logout', logout)
router.get('/me', getMe)

export default router
