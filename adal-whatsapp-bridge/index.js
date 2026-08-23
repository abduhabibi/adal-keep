import express from 'express'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

dotenv.config({ path: path.join(__dirname, '..', 'adal-keep-backend', '.env') })

const PORT = process.env.WHATSAPP_BRIDGE_PORT || 3001
const BACKEND_URL = process.env.BACKEND_WEBHOOK_URL || 'http://localhost:4000'
const AUTH_DIR = path.join(__dirname, 'auth-state')

const app = express()
app.use(express.json({ limit: '50mb' }))

let sock = null
let isConnected = false

async function startSocket() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()

    console.log('🔄 Connecting to WhatsApp...')

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      // Use pino with silent level — Baileys requires a real pino logger
      logger: (await import('pino')).default({ level: 'silent' }),
    })

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        console.log('\n' + '='.repeat(50))
        console.log('📱 SCAN THIS QR CODE WITH WHATSAPP:')
        console.log('   Open WhatsApp → Settings → Linked Devices → Link a Device')
        console.log('='.repeat(50) + '\n')
        
        try {
          const asciiQr = await QRCode.toString(qr, { type: 'terminal', small: true })
          console.log(asciiQr)
        } catch (e) {
          console.log('QR URL:', qr)
        }
        console.log('\n⏳ Waiting for scan... (QR expires in ~60 seconds)\n')
      }

      if (connection === 'close') {
        isConnected = false
        const reason = lastDisconnect?.error?.output?.statusCode
        console.log(`❌ Connection closed (code: ${reason})`)

        if (reason !== DisconnectReason.loggedOut) {
          console.log('🔄 Reconnecting in 5 seconds...')
          setTimeout(startSocket, 5000)
        } else {
          console.log('⚠️ Logged out. Delete auth-state/ folder and restart to re-link.')
        }
      } else if (connection === 'open') {
        isConnected = true
        console.log('\n✅ WhatsApp connected successfully!')
        console.log(`📨 Forwarding messages to: ${BACKEND_URL}/api/whatsapp/webhook\n`)
      }
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return

      for (const msg of messages) {
        if (msg.key.fromMe) continue

        const from = msg.key.remoteJid
        const senderNumber = from?.split('@')[0] || ''
        if (!senderNumber) continue

        let body = ''
        let mediaUrl = null
        let mimeType = null
        let filename = null

        if (msg.message?.conversation) {
          body = msg.message.conversation
        } else if (msg.message?.extendedTextMessage?.text) {
          body = msg.message.extendedTextMessage.text
        } else if (msg.message?.imageMessage?.caption) {
          body = msg.message.imageMessage.caption
        } else if (msg.message?.documentMessage?.caption) {
          body = msg.message.documentMessage.caption
        }

        const imageMsg = msg.message?.imageMessage
        const docMsg = msg.message?.documentMessage

        if (imageMsg) {
          try {
            const buffer = await sock.downloadMediaMessage(msg)
            const base64 = buffer.toString('base64')
            mimeType = imageMsg.mimetype || 'image/jpeg'
            filename = imageMsg.fileName || `photo_${Date.now()}.jpg`
            mediaUrl = `data:${mimeType};base64,${base64}`
          } catch (err) {
            console.error(`Failed to download image from ${senderNumber}:`, err.message)
          }
        } else if (docMsg) {
          try {
            const buffer = await sock.downloadMediaMessage(msg)
            const base64 = buffer.toString('base64')
            mimeType = docMsg.mimetype || 'application/pdf'
            filename = docMsg.fileName || `doc_${Date.now()}.pdf`
            mediaUrl = `data:${mimeType};base64,${base64}`
          } catch (err) {
            console.error(`Failed to download document from ${senderNumber}:`, err.message)
          }
        }

        console.log(`📨 Message from ${senderNumber}: ${body?.substring(0, 60) || '[media only]'}`)

        try {
          const response = await fetch(`${BACKEND_URL}/api/whatsapp/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: senderNumber, body, mediaUrl, mimeType, filename }),
          })
          const result = await response.json().catch(() => ({}))
          console.log(`   → Backend responded: ${result.status || response.status}`)
        } catch (err) {
          console.error(`   → Failed to forward to backend: ${err.message}`)
        }
      }
    })
  } catch (err) {
    console.error('❌ Failed to start socket:', err.message)
    console.log('🔄 Retrying in 10 seconds...')
    setTimeout(startSocket, 10000)
  }
}

app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    user: sock?.user?.name || null,
    phoneNumber: sock?.user?.id?.split(':')[0] || null,
  })
})

app.post('/send', async (req, res) => {
  const { to, message } = req.body
  if (!to || !message) return res.status(400).json({ error: 'Missing "to" or "message"' })
  if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp not connected' })

  try {
    const jid = `${to.replace(/^\+/, '')}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    console.log(`📤 Sent to ${to}: ${message.substring(0, 60)}`)
    res.json({ sent: true, to })
  } catch (err) {
    console.error(`📤 Failed to send to ${to}:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`\n🔗 WhatsApp Bridge running on http://localhost:${PORT}`)
  console.log(`🎯 Backend webhook: ${BACKEND_URL}/api/whatsapp/webhook\n`)
  startSocket()
})
