/**
 * /api/chat — the chat page and the lock screen's "send the receipt to Adal".
 * Everything goes through chatCloud.js (the chat server).
 */
import express from 'express'
import multer from 'multer'
import * as chat from '../services/chatCloud.js'
import { unlockApproved, statusPayload } from '../services/subscription.js'

const router = express.Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(file.mimetype)),
})

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, req.app.locals.db)) }
  catch (e) { res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message }) }
}

router.get('/chat/status', wrap(async (req, db) => {
  if (!chat.chatConfigured()) return { configured: false }
  return { configured: true, me: await chat.me(db) }
}))
router.get('/chat/agencies', wrap((req, db) => chat.agencies(db)))
router.get('/chat/conversations', wrap((req, db) => chat.conversations(db)))
router.get('/chat/messages', wrap((req, db) => chat.messages(db, req.query.conversation, req.query.after)))
router.post('/chat/direct/:agencyId', wrap(async (req, db) => ({ id: await chat.openDirect(db, req.params.agencyId) })))
router.post('/chat/send', upload.single('image'), wrap((req, db) =>
  chat.send(db, req.body.conversation, req.body.body, req.file ? { buffer: req.file.buffer, mimetype: req.file.mimetype } : null)))

router.get('/chat/image', async (req, res) => {
  try {
    const img = await chat.image(req.app.locals.db, req.query.path)
    res.set('Content-Type', img.type).set('Cache-Control', 'private, max-age=86400').send(img.body)
  } catch (e) { res.status(e.status || 500).end() }
})

// Lock screen: the receipt goes to Adal; once Adal approves, this PC unlocks.
router.post('/chat/unlock-request', upload.single('image'), wrap(async (req, db) => {
  if (!req.file) throw new chat.ChatError('Choose the picture of the payment receipt.', 400)
  return chat.sendUnlockRequest(db, { buffer: req.file.buffer, mimetype: req.file.mimetype })
}))
router.get('/chat/unlock-status', wrap(async (req, db) => {
  if (!chat.chatConfigured()) return { configured: false }
  const r = await chat.unlockStatus(db)
  if (r?.status === 'approved') { unlockApproved(); return { ...r, unlocked: true } }
  return r || { status: 'none' }
}))

// A PC Adal marked paid unlocks itself, also during the trial (not only
// from the lock screen): checked a minute after start, then every 30 minutes.
export function watchPaid(db) {
  const check = async () => {
    try {
      if (!chat.chatConfigured() || statusPayload().mode === 'active') return
      if (await chat.paidByAdal(db)) { unlockApproved(); console.log('[chat] Adal marked this PC paid — unlocked') }
    } catch {}
  }
  setTimeout(check, 60 * 1000).unref?.()
  setInterval(check, 30 * 60 * 1000).unref?.()
}

export default router
