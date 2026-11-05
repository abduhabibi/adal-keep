import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { vaultKey } from './accountVault.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SECRETS_PATH = process.env.SECRETS_PATH || path.join(__dirname, '../../data/secrets.enc')
const SALT = 'adal-keep-secret-store-v1'
// Secrets are locked with the vault's key, which moves with the data. The first
// ones were locked with this machine's name and network card: "v2:" tells them apart.
const V2 = 'v2:'
const portableKey = () => Buffer.from(vaultKey(), 'base64')

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
  const cipher = crypto.createCipheriv('aes-256-gcm', portableKey(), iv)
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  store[name] = V2 + Buffer.concat([iv, tag, ct]).toString('base64')
  writeStore(store)
}

/** Secrets still tied to this machine go over to the portable key. Returns how many. */
export function moveSecretsToVault() {
  let moved = 0
  for (const [name, blob] of Object.entries(readStore())) {
    if (String(blob).startsWith(V2)) continue
    const text = getSecret(name)
    if (text !== null) { setSecret(name, text); moved++ }
  }
  return moved
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
    const v2 = String(blob).startsWith(V2)
    const buf = Buffer.from(v2 ? blob.slice(V2.length) : blob, 'base64')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const ct = buf.subarray(28)
    const d = crypto.createDecipheriv('aes-256-gcm', v2 ? portableKey() : machineKey(), iv)
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
