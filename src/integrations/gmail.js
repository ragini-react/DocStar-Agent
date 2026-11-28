// Gmail through viaSocket: the operator's connection (auth_id and script_id sealed in integration_settings),
// its status, a read-only test, and verification-link extraction. Email bodies stay inside the functions
// here: nothing returned, stored or logged carries a body, only the one link that passed validation.
import { now } from '../db/index.js'
import { maskError } from '../security/mask.js'
import { serviceIdFor } from './viasocket.js'
import { pickVerificationLink, senderDomain } from './verificationLinks.js'
import { BRAND } from '../agent/brand.js'

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
    // The action ids Connect asks consent for: reading mail, plus sending only where outreach is switched on (local).
    consentActions: () => [config.gmail.searchAction.id, config.gmail.getMessageAction.id,
      ...(process.env.GTM_OUTREACH === '1' ? [config.gmail.sendAction.id, config.gmail.replyAction.id, config.gmail.threadAction.id] : [])],
    sendEnabled: () => process.env.GTM_OUTREACH === '1',

    /** Sends one email (HTML when the body has tags) from the connected account. Refused unless GTM_OUTREACH=1. Returns ids only. */
    async sendEmail({ to, subject, body, fromName }) {
      if (process.env.GTM_OUTREACH !== '1') throw new Error('Sending is not enabled here')
      const res = await runAction(config.gmail.sendAction, { to, subject, messageBody: body, ...(fromName ? { fromName } : {}) })
      const out = res?.data ?? res
      // viaSocket returns Google's errors as data, not a throw: only a message id means Gmail sent it.
      if (!out?.id) {
        const msg = out?.originalError?.error?.message || out?.message || 'no message id returned'
        throw new Error(/scope/i.test(msg) ? 'Gmail is connected without send permission: reconnect Gmail and allow sending' : `Gmail did not send: ${msg}`)
      }
      return { id: out.id, threadId: out.threadId ?? null }
    },
    /** Replies in an existing thread (a follow-up), to `to` only. Refused unless GTM_OUTREACH=1. Returns ids only. */
    async replyInThread({ threadId, to, html, fromName }) {
      if (process.env.GTM_OUTREACH !== '1') throw new Error('Sending is not enabled here')
      const res = await runAction(config.gmail.replyAction, { threadId, replyMode: 'specific', to, messageType: 'html', htmlBody: html, ...(fromName ? { fromName } : {}) })
      const out = res?.data ?? res
      if (!out?.id) {
        const msg = out?.originalError?.error?.message || out?.message || 'no message id returned'
        throw new Error(/scope|permission/i.test(msg) ? 'Gmail is connected without reply permission: reconnect Gmail and allow it' : `Gmail did not send the follow-up: ${msg}`)
      }
      return { id: out.id, threadId: out.threadId ?? threadId }
    },

    /** Messages after the first one in a thread: [{ from, date, subject, text }]. Bodies stay in memory. */
    async threadReplies(threadId) {
      const res = await runAction(config.gmail.threadAction, { thread_id: threadId })
      const out = res?.data ?? res
      if (!Array.isArray(out?.replies)) throw new Error(out?.message || 'Gmail returned no thread')
      return out.replies.map(r => ({ from: String(r.from || ''), date: r.date ? new Date(r.date).toISOString() : null, subject: r.subject || '',
        text: String(r.plainBody || String(r.htmlBody || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() }))
    },
    embedToken: () => user().token(),

    /** Called after the dashboard's Connect popup returns an auth_id. Trusts nothing from the browser. */
    async saveConnection(authId) {
      const serviceId = await serviceIdFor(config.gmail.slug)
      const connections = await user().listConnections()
      const match = connections.find(c => c.id === authId && String(c.id).endsWith(`_${serviceId}`))
      if (!match) throw new Error('That connection does not belong to the operator or is not Gmail')
      // The script must run on THIS connection: an older script keeps its old connection and old consent
      // (e.g. read-only), so reusing it after a reconnect silently drops newly granted scopes.
      const flows = (await user().listFlows()).filter(f => f.serviceId === serviceId && (f.status === 'active' || f.status === 'paused'))
      const own = flows.find(f => f.authId === authId)
      if (own?.status === 'paused') await user().setFlowStatus(own.id, 1)
      const scriptId = own?.id ?? (await user().enable(serviceId, authId)).scriptId
      for (const f of flows) if (f.id !== scriptId && f.status === 'active') await user().disableFlow(f.id) // paused, not deleted
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
      activity.warn('gmail_disconnected', `Gmail connection removed from ${BRAND} (the connection itself stays in viaSocket)`)
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
     * Emails from a platform's domain received after `since`, from the inbox and the spam folder (read-only: search and
     * read only, the read/unread state is not changed). Bodies are returned to the caller in memory and never stored.
     */
    async searchPlatform({ domain, since, includeSpam = true, max = 10 }) {
      const searches = [{ search_mode: 'manual', query: ['domain'], searchFields: { domain }, pagination: { maxResults: max } }]
      if (includeSpam) searches.push({ search_mode: 'manual', query: ['domain', 'label'], searchFields: { domain, labelIds: ['SPAM'] }, pagination: { maxResults: max } })
      const seen = new Map()
      for (const input of searches) {
        let res
        try { res = await runAction(config.gmail.searchAction, input) } catch (e) { if (input === searches[0]) throw e; continue } // the spam search is best effort
        for (const e of Array.isArray(res?.emails) ? res.emails : []) {
          if (!senderDomain(e.from)?.endsWith(domain) || (since && e.originalSentDate < since)) continue
          seen.set(e.id, { ...e, spam: (e.labelIds || []).includes('SPAM') })
        }
      }
      const out = []
      for (const e of [...seen.values()].sort((a, b) => String(b.originalSentDate).localeCompare(String(a.originalSentDate)))) {
        let body = e.body
        if (!body?.html && !body?.plain) body = (await runAction(config.gmail.getMessageAction, { message_id: e.id }).catch(() => null))?.body
        out.push({ id: e.id, from: e.from, subject: e.subject || '', receivedAt: e.originalSentDate, spam: e.spam, body })
      }
      return out
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
