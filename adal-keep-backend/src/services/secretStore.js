import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SECRETS_PATH = process.env.SECRETS_PATH || path.join(__dirname, '../../data/secrets.enc')
const SALT = 'adal-keep-secret-store-v1'

function machineKey() {
  const ifaces = os.networkInterfaces()
  const mac = Object.values(ifaces).flat()
    .find(i => i && !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')?.mac || ''
  const parts = [os.hostname(), os.platform(), os.arch(), mac].join('|')
  return crypto.createHash('sha256').update(SALT + '|' + parts).digest()
}

export function setSecret(name, plaintext) {
  const store = readStore()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', machineKey(), iv)
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  store[name] = Buffer.concat([iv, tag, ct]).toString('base64')
  writeStore(store)
}

/** Removes a secret completely (nothing of it stays in the file). */
export function removeSecret(name) {
  const store = readStore()
  if (!(name in store)) return false
  delete store[name]
  writeStore(store)
  return true
}

export function getSecret(name) {
  const store = readStore()
  const blob = store[name]
  if (!blob) return null
  try {
    const buf = Buffer.from(blob, 'base64')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const ct = buf.subarray(28)
    const d = crypto.createDecipheriv('aes-256-gcm', machineKey(), iv)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8')
  } catch (e) {
    console.warn('[secretStore] decrypt failed (wrong machine?):', e.message)
    return null
  }
}

function readStore() {
  try { return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8')) } catch { return {} }
}
function writeStore(store) {
  fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true })
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(store, null, 2), { mode: 0o600 })
}
