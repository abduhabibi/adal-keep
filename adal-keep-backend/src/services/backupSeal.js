/**
 * The agency's backup key in the cloud, sealed.
 *
 * Every backup piece is already locked on the PC (AES-256-GCM, a key made for
 * that agency alone) before it leaves. But the key itself was kept in the
 * agency's own Supabase row beside the index, so anyone who could read that row
 * (the agency's other devices, or someone with the database) held both the lock
 * and its key. With ADAL_BACKUP_SEAL=1 (or flags.json {"backup_seal": true})
 * the row holds the key only SEALED to Adal's recovery public key (X25519 +
 * HKDF + AES-256-GCM, a fresh ephemeral key for each seal): the cloud then has
 * the locked pieces and a sealed key that only Adal's own PC can open
 * (scripts/unseal-backup-key.mjs, private key in ~/.adal-keep/backup-escrow.pem).
 * A PC that already has the key (its own secrets) restores as before.
 */
import crypto from 'crypto'
import fs from 'fs'
import { localFlag } from './agencyConfig.js'

// Adal's recovery PUBLIC key. The private half stays on Adal's PC and is never regenerated.
export const ESCROW_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VuAyEA1FGWobfV2XpnytcNvZWU+O5+E0GGE3twFF6Q2K5ZAyU=
-----END PUBLIC KEY-----`

export const sealOn = () => process.env.ADAL_BACKUP_SEAL === '1' || localFlag('backup_seal')

const kdf = (shared, epk) => Buffer.from(crypto.hkdfSync('sha256', shared, epk, 'adal-backup-seal-v1', 32))

/** Seal a key (string) to a public key; returns "s1.<epk>.<iv>.<tag>.<ct>" (base64url parts). */
export function seal(secret, publicPem = ESCROW_PUBLIC_PEM) {
  const eph = crypto.generateKeyPairSync('x25519')
  const epk = eph.publicKey.export({ type: 'spki', format: 'der' })
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: crypto.createPublicKey(publicPem) })
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', kdf(shared, epk), iv)
  const ct = Buffer.concat([c.update(String(secret), 'utf8'), c.final()])
  return ['s1', epk, iv, c.getAuthTag(), ct].map((p, i) => (i ? Buffer.from(p).toString('base64url') : p)).join('.')
}

/** Open a sealed key with the private key (Adal's PC only). */
export function unseal(sealed, privatePem) {
  const [v, epk, iv, tag, ct] = String(sealed).split('.')
  if (v !== 's1' || !ct) throw new Error('not a sealed backup key')
  const epkDer = Buffer.from(epk, 'base64url')
  const shared = crypto.diffieHellman({ privateKey: crypto.createPrivateKey(privatePem), publicKey: crypto.createPublicKey({ key: epkDer, format: 'der', type: 'spki' }) })
  const d = crypto.createDecipheriv('aes-256-gcm', kdf(shared, epkDer), Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
}

/** What goes in the cloud row: with the flag on, `key` becomes `key_sealed` (and any old plain `key` is cleared). */
export function forCloud(data) {
  if (!sealOn() || !data || !data.key) return data
  const { key, ...rest } = data
  return { ...rest, key: null, key_sealed: seal(key) }
}

export const loadPrivate = (file = process.env.ADAL_ESCROW_KEY || `${process.env.HOME}/.adal-keep/backup-escrow.pem`) => fs.readFileSync(file, 'utf8')
