// AES-256-GCM for everything secret at rest: platform passwords, the Gmail auth_id and script_id,
// verification links. Stored as "v1:<iv>:<tag>:<ciphertext>" (base64url), so a key rotation can add v2.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHash } from 'node:crypto'

export function createVault(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('vault key must be 32 bytes')
  return {
    encrypt(plain) {
      if (typeof plain !== 'string') throw new Error('encrypt takes a string')
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return ['v1', iv, cipher.getAuthTag(), data].map(x => (typeof x === 'string' ? x : x.toString('base64url'))).join(':')
    },
    decrypt(sealed) {
      const [v, iv, tag, data] = String(sealed).split(':')
      if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('not a sealed value')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
    }
  }
}

export function generatePassword(length = 24) {
  // Letters, digits and a few symbols most sign-up forms accept; at least one of each class.
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*-_']
  const all = sets.join('')
  const pick = s => s[randomBytes(4).readUInt32BE() % s.length]
  const chars = sets.map(pick)
  while (chars.length < length) chars.push(pick(all))
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE() % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}
