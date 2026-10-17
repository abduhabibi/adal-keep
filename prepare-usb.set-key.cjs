#!/usr/bin/env node
// Machine-bound AES-256-GCM writer for DeepSeek key.
// MUST match machineKey() in adal-keep-backend/src/services/secretStore.js.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const SALT = 'adal-keep-secret-store-v1'
function machineKey() {
  const ifaces = os.networkInterfaces()
  const mac = Object.values(ifaces).flat()
    .find(i => i && !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')?.mac || ''
  const parts = [os.hostname(), os.platform(), os.arch(), mac].join('|')
  return crypto.createHash('sha256').update(SALT + '|' + parts).digest()
}

const key = process.argv[2]
if (!key) { console.error('[set-key] no key'); process.exit(1) }

const dataDir = path.join(process.cwd(), 'data')
const secretsPath = path.join(dataDir, 'secrets.enc')
const store = (() => { try { return JSON.parse(fs.readFileSync(secretsPath, 'utf8')) } catch { return {} } })()

const iv = crypto.randomBytes(12)
const cipher = crypto.createCipheriv('aes-256-gcm', machineKey(), iv)
const ct = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()])
const tag = cipher.getAuthTag()
store.DEEPSEEK_API_KEY = Buffer.concat([iv, tag, ct]).toString('base64')

fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(secretsPath, JSON.stringify(store, null, 2), { mode: 0o600 })
console.log('[set-key] key encrypted to', secretsPath)
