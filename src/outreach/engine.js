// The cold-email sender (Mac only). Approved batches become sequences (first email + at most 2 follow-ups), spread
// over the active sending inboxes. Every 30 s each inbox may send ONE due email, and only if every rule passes:
//   - the inbox is active, connected as its own address, and its domain passes SPF, DKIM and DMARC
//   - its hourly and daily limits allow it, and the random 2–6 minute gap since its last send has passed
//   - it is business hours in the recipient's time zone (otherwise the email moves to the next business morning)
//   - the recipient (or their domain) is not suppressed, has not replied, opted out, bounced or complained
//   - no more than `domain_daily_cap` emails go to one company per day
// A monitor reads each inbox for bounces and replies; opt-outs and complaints suppress, replies stop the sequence,
// and an inbox whose bounce or complaint numbers cross the thresholds is paused automatically.
import { now } from '../db/index.js'
import { maskError } from '../security/mask.js'
import { checkDomainAuth } from './dns.js'
import { classifyReply, complianceProblem, domainOf, followupDueAt, followupEmail, inBusinessHours, limitCheck, nextBusinessTime,
  nextGapMs, parseBounce, pauseReason, timezoneFor } from './policy.js'

const TICK_MS = 30_000, MONITOR_MS = 10 * 60_000, DNS_EVERY_MS = 24 * 3600_000, REPLY_DOMAINS_PER_SCAN = 25
const iso = ms => new Date(ms).toISOString(), ms = s => (s ? Date.parse(s) : 0)

/**
 * @param {object} o
 * @param o.gmailFor     inbox → a Gmail client for that inbox's own connection
 * @param o.render       ({company, to, subject, body}) → HTML in the branded template (every email uses it)
 * @param o.emailFor     n → the approved email ({company, to, subject, body}) or null
 * @param o.onFirstSent  (n, {to, subject, messageId, threadId, at}) → records the first send in the Growth pipeline
 * @param o.onReply      (email, kind) → updates the lead's status
 */
export function createOutreachEngine({ db, store, activity, gmailFor, render, emailFor, onFirstSent = () => {}, onReply = () => {},
  sendEnabled = () => process.env.GTM_OUTREACH === '1', checkDns = checkDomainAuth, clock = () => Date.now(), rand = Math.random }) {
  let timer = null, monitorTimer = null, ticking = false, monitoring = false

  // ── Approval ───────────────────────────────────────────────────────────────────────────────────────────────────
  /** Queues an approved batch. Each email is checked now and again just before it is sent. */
  function approveBatch(ns) {
    const s = store.settings()
    const list = [...new Set([].concat(ns).map(Number).filter(Number.isInteger))]
    if (!list.length) throw new Error('Pick the emails to approve')
    if (list.length > s.batch_size) throw new Error(`A batch is at most ${s.batch_size} emails (you picked ${list.length})`)
    const inboxes = store.inboxes().filter(b => b.state === 'active')
    if (!inboxes.length) throw new Error('No active sending inbox: add one, connect it and pass the DNS check first')
    const ctx = store.ctx(), skipped = [], queued = []
    const load = new Map(inboxes.map(b => [b.id, db.prepare("SELECT COUNT(*) c FROM outreach_messages WHERE inbox_id = ? AND state = 'scheduled'").get(b.id).c]))
    const t = clock()
    db.transaction(() => {
      const batch = db.prepare('INSERT INTO outreach_batches (size, approved_at) VALUES (?, ?)').run(0, iso(t)).lastInsertRowid
      for (const n of list) {
        const e = emailFor(n)
        if (!e) { skipped.push({ n, reason: 'no such email' }); continue }
        if (db.prepare('SELECT 1 FROM outreach_sequences WHERE n = ?').get(n)) { skipped.push({ n, to: e.to, reason: 'already approved' }); continue }
        const problem = complianceProblem(e.to, ctx)
        if (problem) { skipped.push({ n, to: e.to, reason: problem }); continue }
        const to = e.to.trim().toLowerCase(), domain = domainOf(to), tz = timezoneFor(to, s, e.tz)
        const inbox = [...load.entries()].sort((a, b) => a[1] - b[1])[0][0] // least loaded; follow-ups stay on it
        load.set(inbox, load.get(inbox) + 1)
        const seq = db.prepare(`INSERT INTO outreach_sequences (n, batch_id, inbox_id, company, to_email, domain, subject, tz, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(n, batch, inbox, e.company, to, domain, e.subject, tz, iso(t), iso(t)).lastInsertRowid
        db.prepare('INSERT INTO outreach_messages (sequence_id, step, inbox_id, to_email, subject, due_at) VALUES (?, 0, ?, ?, ?, ?)')
          .run(seq, inbox, to, e.subject, iso(nextBusinessTime(t, tz, s)))
        ctx.activeDomains.add(domain); ctx.emailed.add(to)
        queued.push({ n, to, tz })
      }
      db.prepare('UPDATE outreach_batches SET size = ? WHERE id = ?').run(queued.length, batch)
      if (!queued.length) db.prepare('DELETE FROM outreach_batches WHERE id = ?').run(batch)
    })()
    activity.info('outreach_batch', `Batch approved: ${queued.length} email(s) scheduled${skipped.length ? `, ${skipped.length} skipped` : ''}`)
    return { queued, skipped }
  }

  // ── Sending ────────────────────────────────────────────────────────────────────────────────────────────────────
  const sentTimes = id => db.prepare("SELECT sent_at FROM outreach_messages WHERE inbox_id = ? AND state = 'sent' AND sent_at > ?")
    .all(id, iso(clock() - 86400_000)).map(r => ms(r.sent_at))
  const domainSentToday = d => db.prepare(`SELECT COUNT(*) c FROM outreach_messages m JOIN outreach_sequences s ON s.id = m.sequence_id
    WHERE s.domain = ? AND m.state = 'sent' AND m.sent_at > ?`).get(d, iso(clock() - 86400_000)).c
  const ready = b => b.state === 'active' && b.connected && b.dns_ok

  /** One send attempt per active inbox. Returns what happened (for tests and the log). */
  async function tick() {
    if (ticking) return []
    ticking = true
    const out = []
    try {
      if (!sendEnabled()) return out
      const s = store.settings()
      for (const box of store.inboxes().filter(ready)) {
        const lim = limitCheck({ sentTimes: sentTimes(box.id), hourly: box.hourly_limit, daily: box.daily_limit, nextAllowedAt: ms(box.next_send_at), now: clock() })
        if (!lim.ok) { out.push({ inbox: box.id, wait: lim.reason }); continue }
        const r = await sendNext(box, s)
        if (r) out.push({ inbox: box.id, ...r })
      }
    } finally { ticking = false }
    return out
  }

  async function sendNext(box, s) {
    const t = clock()
    const due = db.prepare(`SELECT m.*, s.company, s.tz, s.domain, s.n, s.state seq_state FROM outreach_messages m JOIN outreach_sequences s ON s.id = m.sequence_id
      WHERE m.inbox_id = ? AND m.state = 'scheduled' AND m.due_at <= ? ORDER BY m.due_at LIMIT 20`).all(box.id, iso(t))
    const suppressed = store.suppressed()
    for (const m of due) {
      if (m.seq_state !== 'active') { db.prepare("UPDATE outreach_messages SET state = 'cancelled', error = 'sequence stopped' WHERE id = ?").run(m.id); continue }
      if (suppressed.has(m.to_email) || suppressed.has(`@${m.domain}`)) { store.stopSequence(m.sequence_id, 'suppressed'); continue }
      if (!inBusinessHours(t, m.tz, s)) { reschedule(m, nextBusinessTime(t, m.tz, s)); continue }
      if (domainSentToday(m.domain) >= s.domain_daily_cap) { reschedule(m, nextBusinessTime(t + 86400_000, m.tz, s)); continue }
      if (m.step > s.max_followups) { store.stopSequence(m.sequence_id, 'follow-up limit'); continue }
      if (m.step > 0 && await repliedSince(box, m)) continue // the reply check stopped the sequence
      return send(box, m, s)
    }
    return null
  }
  const reschedule = (m, at) => db.prepare('UPDATE outreach_messages SET due_at = ? WHERE id = ?').run(iso(at), m.id)

  async function send(box, m, s) {
    const base = emailFor(m.n)
    if (!base) { store.stopSequence(m.sequence_id, 'email no longer exists'); return { skipped: m.id, reason: 'email removed' } }
    const e = m.step === 0 ? base : { ...base, ...followupEmail(m.step, { company: m.company, subject: base.subject }) }
    // Claimed before the network call, so a crash mid-send can never send it twice.
    if (!db.prepare("UPDATE outreach_messages SET state = 'sending' WHERE id = ? AND state = 'scheduled'").run(m.id).changes) return null
    const t = clock()
    try {
      const html = render({ company: m.company, to: m.to_email, subject: e.subject, body: e.body })
      const r = await gmailFor(box).sendEmail({ to: m.to_email, subject: e.subject, body: html, fromName: box.from_name })
      const at = iso(clock())
      db.transaction(() => {
        db.prepare("UPDATE outreach_messages SET state = 'sent', sent_at = ?, message_id = ?, thread_id = ?, subject = ? WHERE id = ?").run(at, r.id, r.threadId, e.subject, m.id)
        db.prepare('UPDATE outreach_inboxes SET next_send_at = ?, updated_at = ? WHERE id = ?').run(iso(clock() + nextGapMs(s, rand)), at, box.id)
        const next = m.step + 1
        if (next <= s.max_followups) {
          db.prepare('INSERT OR IGNORE INTO outreach_messages (sequence_id, step, inbox_id, to_email, subject, due_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(m.sequence_id, next, box.id, m.to_email, followupEmail(next, { company: m.company, subject: base.subject }).subject, iso(nextBusinessTime(followupDueAt(next, ms(at), s, rand), m.tz, s)))
        } else db.prepare("UPDATE outreach_sequences SET state = 'done', updated_at = ? WHERE id = ?").run(at, m.sequence_id)
      })()
      if (m.step === 0) onFirstSent(m.n, { to: m.to_email, subject: e.subject, messageId: r.id, threadId: r.threadId, at })
      activity.success('outreach_sent', `${m.step ? `Follow-up ${m.step}` : 'Email'} sent to ${m.company} (${m.to_email}) from ${box.address}`)
      return { sent: m.id, step: m.step, to: m.to_email }
    } catch (err) {
      const msg = maskError(err)
      db.prepare("UPDATE outreach_messages SET state = 'scheduled', due_at = ?, error = ? WHERE id = ?").run(iso(t + 30 * 60_000), msg, m.id)
      // A refusal from Gmail (auth, quota, rate) is about the inbox, not this email: stop the inbox until someone looks.
      if (/permission|scope|not connected|quota|limit|rate|suspend|disabled|invalid_grant|unauthor/i.test(msg)) store.setInboxState(box.id, 'paused', `Gmail refused a send: ${msg}`)
      activity.error('outreach_failed', `Email to ${m.to_email} from ${box.address} failed: ${msg}`)
      return { failed: m.id, error: msg }
    }
  }

  // ── Monitoring ─────────────────────────────────────────────────────────────────────────────────────────────────
  /** Reads the recipient's domain for mail since the sequence's first send. True when the sequence was stopped. */
  async function repliedSince(box, m) {
    const first = db.prepare("SELECT sent_at FROM outreach_messages WHERE sequence_id = ? AND step = 0 AND state = 'sent'").get(m.sequence_id)
    if (!first) return false
    let mail
    try { mail = await gmailFor(box).searchPlatform({ domain: m.domain, since: first.sent_at, includeSpam: true, max: 5 }) } catch { return false }
    const fromThem = mail.filter(x => domainOf(String(x.from).match(/<([^>]+)>/)?.[1] || x.from) .endsWith(m.domain))
    if (!fromThem.length) return false
    handleReply(box, { sequence_id: m.sequence_id, to_email: m.to_email, domain: m.domain }, fromThem[0])
    return true
  }
  function handleReply(box, seq, mail) {
    const text = mail.body?.plain || String(mail.body?.html || '').replace(/<[^>]+>/g, ' ')
    const kind = classifyReply(`${mail.subject}\n${text}`)
    if (kind === 'complaint') {
      store.event('complaint', { inboxId: box.id, email: seq.to_email, sequenceId: seq.sequence_id, detail: 'reply reads as a spam complaint' })
      store.suppress(`@${seq.domain}`, 'spam complaint', 'monitor')
    } else if (kind === 'optout') {
      store.event('optout', { inboxId: box.id, email: seq.to_email, sequenceId: seq.sequence_id })
      store.suppress(`@${seq.domain}`, 'asked not to be contacted', 'reply')
    } else {
      store.event('reply', { inboxId: box.id, email: seq.to_email, sequenceId: seq.sequence_id })
      store.stopSequence(seq.sequence_id, 'replied')
    }
    onReply(seq.to_email, kind)
    activity.info('outreach_reply', `${seq.to_email} ${kind === 'reply' ? 'replied: follow-ups stopped' : kind === 'optout' ? 'opted out: suppressed' : 'complained: suppressed and inbox checked'}`)
  }

  /** Bounces and replies for one inbox, a DNS re-check once a day, then the automatic-pause rule. */
  async function monitorInbox(box) {
    const s = store.settings(), t = clock()
    if (box.state !== 'setup' && t - ms(box.dns_checked_at) > DNS_EVERY_MS) await refreshDns(box.id)
    if (!box.connected) return
    const since = box.last_scan_at || iso(t - 7 * 86400_000)
    const gm = gmailFor(box)
    try {
      for (const mail of await gm.searchPlatform({ domain: 'googlemail.com', since, includeSpam: false, max: 25 })) {
        const b = parseBounce({ from: mail.from, subject: mail.subject, text: mail.body?.plain || String(mail.body?.html || '').replace(/<[^>]+>/g, ' ') })
        if (!b) continue
        const seq = db.prepare('SELECT * FROM outreach_sequences WHERE to_email = ? AND inbox_id = ?').get(b.email, box.id)
        if (!seq || db.prepare("SELECT 1 FROM outreach_events WHERE kind = 'bounce' AND email = ? AND inbox_id = ?").get(b.email, box.id)) continue
        store.event('bounce', { inboxId: box.id, email: b.email, sequenceId: seq.id })
        store.suppress(b.email, 'hard bounce', 'monitor')
        activity.warn('outreach_bounce', `Bounce from ${b.email} (${box.address}): suppressed`)
      }
      // Replies to live sequences (a few domains per scan, oldest checked first).
      const live = db.prepare(`SELECT s.id sequence_id, s.to_email, s.domain, MIN(m.sent_at) first FROM outreach_sequences s JOIN outreach_messages m ON m.sequence_id = s.id
        WHERE s.inbox_id = ? AND s.state = 'active' AND m.state = 'sent' GROUP BY s.id ORDER BY s.updated_at LIMIT ?`).all(box.id, REPLY_DOMAINS_PER_SCAN)
      for (const seq of live) {
        db.prepare('UPDATE outreach_sequences SET updated_at = ? WHERE id = ?').run(iso(clock()), seq.sequence_id)
        let mail; try { mail = await gm.searchPlatform({ domain: seq.domain, since: seq.first, includeSpam: true, max: 5 }) } catch { continue }
        const theirs = mail.filter(x => domainOf(String(x.from).match(/<([^>]+)>/)?.[1] || x.from).endsWith(seq.domain))
        if (theirs.length) handleReply(box, seq, theirs[0])
      }
      db.prepare('UPDATE outreach_inboxes SET last_scan_at = ? WHERE id = ?').run(iso(t), box.id)
    } catch (e) { activity.warn('outreach_monitor', `Could not read ${box.address} for bounces and replies: ${maskError(e)}`) }
    checkPause(box.id)
  }
  function checkPause(id) {
    const box = store.inbox(id); if (!box || box.state !== 'active') return null
    const s = store.settings(), win = iso(clock() - s.monitor_window_days * 86400_000)
    const sent = db.prepare("SELECT COUNT(*) c FROM outreach_messages WHERE inbox_id = ? AND state = 'sent' AND sent_at > ?").get(id, win).c
    const count = k => db.prepare('SELECT COUNT(*) c FROM outreach_events WHERE inbox_id = ? AND kind = ? AND at > ?').get(id, k, win).c
    const why = pauseReason({ sent, bounces: count('bounce'), complaints: count('complaint') }, s)
    if (why) { store.setInboxState(id, 'paused', `Automatic pause: ${why}`); activity.error('outreach_paused', `${box.address} paused automatically: ${why}`) }
    return why
  }
  async function refreshDns(id) {
    const box = store.inbox(id); if (!box) throw new Error('No such inbox')
    let r
    try { r = await checkDns(domainOf(box.address), { dkimSelector: box.dkim_selector }) } catch (e) { r = { ok: false, error: maskError(e), checkedAt: now() } }
    db.prepare('UPDATE outreach_inboxes SET dns = ?, dns_ok = ?, dns_checked_at = ? WHERE id = ?').run(JSON.stringify(r), r.ok ? 1 : 0, r.checkedAt, id)
    if (!r.ok && box.state === 'active') store.setInboxState(id, 'paused', 'Automatic pause: SPF, DKIM or DMARC no longer passes')
    return { ...store.inbox(id) }
  }

  /** Resume (or first activation): only with a matching connection and passing DNS. */
  async function activate(id) {
    const box = await refreshDns(id)
    if (!box.connected) throw new Error(`Connect ${box.address} first (sign in as that address)`)
    if (!box.dns_ok) throw new Error('SPF, DKIM and DMARC must all pass first: see the DNS check')
    store.setInboxState(id, 'active')
    activity.success('outreach_inbox', `${box.address} is active (${box.hourly_limit}/hour, ${box.daily_limit}/day)`)
    return store.inbox(id)
  }

  /** A complaint learned elsewhere (e.g. Google Postmaster Tools, a forwarded abuse report). */
  function recordComplaint(email) {
    const e = String(email || '').trim().toLowerCase()
    const seq = db.prepare('SELECT * FROM outreach_sequences WHERE to_email = ? OR domain = ? ORDER BY id DESC').get(e, e.replace(/^@/, ''))
    store.event('complaint', { inboxId: seq?.inbox_id ?? null, email: e, sequenceId: seq?.id ?? null, detail: 'recorded by the owner' })
    store.suppress(seq ? `@${seq.domain}` : e, 'spam complaint', 'manual')
    return seq ? checkPause(seq.inbox_id) : null
  }

  return {
    approveBatch, tick, monitorInbox, checkPause, refreshDns, activate, recordComplaint,
    async monitorAll() { if (monitoring) return; monitoring = true; try { for (const b of store.inboxes().filter(x => x.state !== 'setup')) await monitorInbox(b) } finally { monitoring = false } },
    start() {
      // A send interrupted by a restart is not retried blindly: it goes back to the queue only if Gmail never got it.
      db.prepare("UPDATE outreach_messages SET state = 'failed', error = 'interrupted by a restart: check Sent mail, then cancel or re-approve' WHERE state = 'sending'").run()
      if (!timer) timer = setInterval(() => tick().catch(e => activity.error('outreach_tick', maskError(e))), TICK_MS)
      if (!monitorTimer) monitorTimer = setInterval(() => this.monitorAll().catch(() => {}), MONITOR_MS)
      setTimeout(() => this.monitorAll().catch(() => {}), 15_000)
    },
    stop() { clearInterval(timer); clearInterval(monitorTimer); timer = monitorTimer = null }
  }
}
