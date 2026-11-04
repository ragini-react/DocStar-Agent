// The dashboard's admin password, one field everywhere. Locally it is DOCSTAR_ADMIN_PASSWORD from .env. A hosted
// copy uses that variable when the host has it set; otherwise it checks the same password against seed/admin-password.json,
// a salted scrypt hash written by scripts/export-seed.mjs. The password itself never leaves the Mac.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { safeEqual } from './crypto.js'

export function hashAdminPassword(password) {
  const salt = randomBytes(16)
  return { salt: salt.toString('base64'), hash: scryptSync(password, salt, 64).toString('base64') }
}

export function createAdminPassword({ config }) {
  const hashFile = path.join(path.dirname(config.seedPath), 'admin-password.json')
  const shipped = config.hosted && existsSync(hashFile) ? JSON.parse(readFileSync(hashFile, 'utf8')) : null

  return {
    isSet: () => Boolean(config.adminPassword || shipped),
    verify(password) {
      if (typeof password !== 'string' || !password) return false
      if (config.adminPassword) return safeEqual(password, config.adminPassword)
      if (!shipped) return false
      const hash = scryptSync(password, Buffer.from(shipped.salt, 'base64'), 64)
      return timingSafeEqual(hash, Buffer.from(shipped.hash, 'base64'))
    }
  }
}
