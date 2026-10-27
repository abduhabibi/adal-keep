/**
 * tgStore.js — documents of the online copy live in Telegram, not Supabase.
 *
 * A bot (TELEGRAM_BOT_TOKEN) posts each document into a private channel
 * (TELEGRAM_STORAGE_CHAT) — free and without a size limit for the agency.
 * Every file is encrypted first (AES-256-GCM) with the agency's own key
 * (Supabase keep_secrets, readable only by the agency's PC and phones), so
 * Telegram and anyone holding the bot token see only noise.
 *
 *   object in keep_files = "tg:<file_id>:<message_id>"
 *   file bytes           = "AK1" + iv(12) + tag(16) + ciphertext
 * Phones and Adal Keep Admin download through the Bot API and decrypt on the
 * device (frontend src/cloud/adapter.js does the same in the browser).
 */
import crypto from 'crypto'

const API = 'https://api.telegram.org'
const MAGIC = Buffer.from('AK1')
export const TG_MAX_DOWNLOAD = 20 * 1024 * 1024   // Bot API getFile limit
const token = () => process.env.TELEGRAM_BOT_TOKEN || ''
const chat = () => process.env.TELEGRAM_STORAGE_CHAT || ''
export const tgReady = () => !!(token() && chat())
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export function encrypt(buf, keyB64) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv)
  const data = Buffer.concat([c.update(buf), c.final()])
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), data])
}
export function decrypt(buf, keyB64) {
  if (!buf.subarray(0, 3).equals(MAGIC)) throw new Error('not an Adal Keep file')
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), buf.subarray(3, 15))
  d.setAuthTag(buf.subarray(15, 31))
  return Buffer.concat([d.update(buf.subarray(31)), d.final()])
}

/** Bot API call; waits and tries again when Telegram says "too many requests". */
async function bot(method, body, tries = 5) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${API}/bot${token()}/${method}`, body instanceof FormData
      ? { method: 'POST', body } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    const j = await r.json().catch(() => ({}))
    if (j.ok) return j.result
    const wait = j.parameters?.retry_after
    if (wait && i < tries) { await sleep((wait + 1) * 1000); continue }
    throw new Error(`Telegram ${method}: ${j.description || r.status}`)
  }
}

/** Encrypt and post; returns the keep_files object ("tg:<file_id>:<message_id>"). */
export async function tgPut(buf, name, keyB64) {
  const form = new FormData()
  form.append('chat_id', chat())
  form.append('disable_notification', 'true')
  form.append('document', new Blob([encrypt(buf, keyB64)], { type: 'application/octet-stream' }), `${String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(-60)}.ak`)
  const m = await bot('sendDocument', form)
  return `tg:${m.document.file_id}:${m.message_id}`
}

export async function tgGet(object, keyB64) {
  const [, fileId] = String(object).split(':')
  const f = await bot('getFile', { file_id: fileId })
  const r = await fetch(`${API}/file/bot${token()}/${f.file_path}`)
  if (!r.ok) throw new Error(`Telegram file: ${r.status}`)
  return decrypt(Buffer.from(await r.arrayBuffer()), keyB64)
}

export async function tgDelete(object) {
  const msg = String(object).split(':')[2]
  if (msg) await bot('deleteMessage', { chat_id: chat(), message_id: Number(msg) }, 1).catch(() => {})
}

/**
 * The storage channel: the first channel the bot was made admin of and that
 * someone wrote in (getUpdates). Saved to .env by the caller.
 */
export async function findStorageChat() {
  const ups = await bot('getUpdates', { allowed_updates: ['channel_post', 'my_chat_member'] })
  for (const u of ups.reverse()) {
    const c = u.channel_post?.chat || u.my_chat_member?.chat
    if (c?.type === 'channel') return { id: String(c.id), title: c.title }
  }
  return null
}
