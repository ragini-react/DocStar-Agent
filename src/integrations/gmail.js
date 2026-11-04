// Gmail through viaSocket: the operator's connection (auth_id and script_id sealed in integration_settings),
// its status, a read-only test, and verification-link extraction. Email bodies stay inside the functions
// here: nothing returned, stored or logged carries a body, only the one link that passed validation.
import { now } from '../db/index.js'
import { maskError } from '../security/mask.js'
import { serviceIdFor } from './viasocket.js'
import { pickVerificationLink, senderDomain } from './verificationLinks.js'

const KEY = 'gmail'
const STATUS_TTL_MS = 60_000

export function createGmail({ db, vault, activity, viasocket, config }) {
  const user = () => viasocket.user(config.operatorUserId) // created on use: a copy without keys still starts
  let statusCache = null

  const read = () => {
    const row = db.prepare('SELECT value_enc, meta, updated_at FROM integration_settings WHERE key = ?').get(KEY)
    if (!row) return null
    return { ...JSON.parse(vault.decrypt(row.value_enc)), meta: JSON.parse(row.meta || '{}'), updatedAt: row.updated_at }
  }
  const write = (secret, meta) => db.prepare(`INSERT INTO integration_settings (key, value_enc, meta, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, meta = excluded.meta, updated_at = excluded.updated_at`)
    .run(KEY, vault.encrypt(JSON.stringify(secret)), JSON.stringify(meta), now())

  async function runAction(action, inputData) {
    const conn = read()
    if (!conn) throw new Error('Gmail is not connected')
    const serviceId = await serviceIdFor(config.gmail.slug)
    const versionId = await viasocket.catalog.versionIdFor(serviceId, action.id, action.version)
    return viasocket.runAction(conn.scriptId, versionId, inputData)
  }

  return {
    serviceId: () => serviceIdFor(config.gmail.slug),
    // The action ids Connect asks consent for: nothing beyond reading mail.
    consentActions: () => [config.gmail.searchAction.id, config.gmail.getMessageAction.id],
    embedToken: () => user().token(),

    /** Called after the dashboard's Connect popup returns an auth_id. Trusts nothing from the browser. */
    async saveConnection(authId) {
      const serviceId = await serviceIdFor(config.gmail.slug)
      const connections = await user().listConnections()
      const match = connections.find(c => c.id === authId && String(c.id).endsWith(`_${serviceId}`))
      if (!match) throw new Error('That connection does not belong to the operator or is not Gmail')
      const scriptId = (await user().findEnabled(serviceId)) ?? (await user().enable(serviceId, authId)).scriptId
      let account = null
      try { account = JSON.parse(match.connection_label || '{}').Email ?? null } catch {}
      write({ authId, scriptId }, { account, connectedAt: now(), isExpired: Boolean(match.isExpired) })
      statusCache = null
      activity.success('gmail_connected', `Gmail connected${account ? ` as ${account}` : ''}`)
      return this.status({ fresh: true })
    },

    async status({ fresh = false } = {}) {
      const conn = read()
      if (!conn) return { connected: false }
      if (!fresh && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value
      let value
      try {
        const live = (await user().listConnections()).find(c => c.id === conn.authId)
        value = live
          ? { connected: true, account: conn.meta.account, connectedAt: conn.meta.connectedAt, expired: Boolean(live.isExpired), checkedAt: now() }
          : { connected: false, revoked: true, account: conn.meta.account }
      } catch (error) {
        value = { connected: true, account: conn.meta.account, connectedAt: conn.meta.connectedAt, error: maskError(error), checkedAt: now() }
      }
      statusCache = { at: Date.now(), value }
      return value
    },

    /** The auth_id, for reconnecting an expired connection in place. Server only. */
    authIdForReconnect: () => read()?.authId ?? null,

    disconnect() {
      db.prepare('DELETE FROM integration_settings WHERE key = ?').run(KEY)
      statusCache = null
      activity.warn('gmail_disconnected', 'Gmail connection removed from DocStar (the connection itself stays in viaSocket)')
    },

    /** Read-only check: one search for Google's own account mail. Returns counts and a date, never content. */
    async test() {
      const started = Date.now()
      const res = await runAction(config.gmail.searchAction, {
        search_mode: 'manual', query: ['domain'], searchFields: { domain: 'accounts.google.com' }, pagination: { maxResults: 1 }
      })
      const emails = Array.isArray(res?.emails) ? res.emails : []
      const result = {
        ok: true,
        tookMs: Date.now() - started,
        matched: emails.length,
        latestDate: emails[0]?.originalSentDate ?? null,
        unreadPreserved: emails[0] ? emails[0].labelIds?.includes('UNREAD') ?? null : null
      }
      activity.info('gmail_tested', `Gmail search works (${result.matched} message found, ${result.tookMs} ms)`)
      return result
    },

    /**
     * Find the verification link a platform sent after `since`. Only mail from that platform's domain is
     * looked at, and only https links whose host is that domain qualify. Returns { link, host } or null.
     */
    async findVerificationLink({ domain, since }) {
      const res = await runAction(config.gmail.searchAction, {
        search_mode: 'manual', query: ['domain'], searchFields: { domain }, pagination: { maxResults: 5 }
      })
      let emails = Array.isArray(res?.emails) ? res.emails : []
      emails = emails.filter(e => senderDomain(e.from)?.endsWith(domain) && e.originalSentDate >= since)
      for (const email of emails) {
        let body = email.body
        if (!body?.html && !body?.plain) {
          const full = await runAction(config.gmail.getMessageAction, { message_id: email.id })
          body = full?.body
        }
        const link = pickVerificationLink(body, domain)
        if (link) return link
      }
      return null
    }
  }
}
