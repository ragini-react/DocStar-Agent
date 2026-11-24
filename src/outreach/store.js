// Cold-email sending: tables, settings and read models. Created on the Mac and on the hosted copy (the tables are
// mirrored, so the hosted dashboard shows the queue, limits and pauses; changes made there are relayed to the Mac).
//
//   outreach_inboxes      sending inboxes (separate from support@), their limits, state and DNS check
//   outreach_batches      one owner approval (at most 30 emails)
//   outreach_sequences    one company: first email + up to 2 follow-ups, on one inbox
//   outreach_messages     each scheduled/sent email of a sequence
//   outreach_suppression  never email again: an address, or a whole '@domain'
//   outreach_events       bounces, complaints, replies, opt-outs, pauses (what the monitor saw)
import { getSetting, now, setSetting } from '../db/index.js'
import { DEFAULTS, cleanSettings, domainOf } from './policy.js'

export const OUTREACH_TABLES = ['outreach_inboxes', 'outreach_batches', 'outreach_sequences', 'outreach_messages', 'outreach_suppression', 'outreach_events']
export const OUTREACH_KEYS = { outreach_suppression: 'entry' }
const SETTINGS_KEY = 'outreach_settings'

export function ensureOutreachSchema(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS outreach_inboxes (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL UNIQUE, from_name TEXT NOT NULL,
    hourly_limit INTEGER NOT NULL, daily_limit INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'setup', pause_reason TEXT,
    dkim_selector TEXT NOT NULL DEFAULT 'google', dns TEXT, dns_ok INTEGER NOT NULL DEFAULT 0, dns_checked_at TEXT,
    connected INTEGER NOT NULL DEFAULT 0, next_send_at TEXT, last_scan_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS outreach_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, size INTEGER NOT NULL, approved_at TEXT NOT NULL, note TEXT);
  CREATE TABLE IF NOT EXISTS outreach_sequences (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL UNIQUE, batch_id INTEGER NOT NULL,
    inbox_id INTEGER NOT NULL, company TEXT NOT NULL, to_email TEXT NOT NULL, domain TEXT NOT NULL, subject TEXT NOT NULL, tz TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active', stop_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS outreach_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sequence_id INTEGER NOT NULL, step INTEGER NOT NULL,
    inbox_id INTEGER NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, due_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'scheduled',
    message_id TEXT, thread_id TEXT, sent_at TEXT, error TEXT, UNIQUE (sequence_id, step));
  CREATE INDEX IF NOT EXISTS outreach_messages_due ON outreach_messages (state, due_at);
  CREATE INDEX IF NOT EXISTS outreach_messages_sent ON outreach_messages (inbox_id, sent_at);
  CREATE TABLE IF NOT EXISTS outreach_suppression (entry TEXT PRIMARY KEY, reason TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS outreach_events (id INTEGER PRIMARY KEY AUTOINCREMENT, inbox_id INTEGER, kind TEXT NOT NULL, email TEXT,
    sequence_id INTEGER, detail TEXT, at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS outreach_events_kind ON outreach_events (inbox_id, kind, at);`)
}

export function createOutreachStore(db) {
  ensureOutreachSchema(db)
  const settings = () => { try { return { ...DEFAULTS, ...JSON.parse(getSetting(db, SETTINGS_KEY, '{}') || '{}') } } catch { return { ...DEFAULTS } } }
  const event = (kind, { inboxId = null, email = null, sequenceId = null, detail = null } = {}) =>
    db.prepare('INSERT INTO outreach_events (inbox_id, kind, email, sequence_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)').run(inboxId, kind, email, sequenceId, detail, now())

  const store = {
    settings,
    saveSettings(input) {
      const c = cleanSettings(input); delete c.hourly_limit; delete c.daily_limit // those are per inbox
      const next = { ...settings(), ...c }
      if (next.gap_max_sec < next.gap_min_sec) throw new Error('The longest gap must be at least the shortest')
      if (next.business_end <= next.business_start) throw new Error('Business hours must end after they start')
      const own = Object.fromEntries(Object.keys(DEFAULTS).filter(k => k !== 'hourly_limit' && k !== 'daily_limit').map(k => [k, next[k]]))
      setSetting(db, SETTINGS_KEY, JSON.stringify(own))
      return settings()
    },
    event,

    inboxes: () => db.prepare('SELECT * FROM outreach_inboxes ORDER BY id').all().map(r => ({ ...r, dns: r.dns ? JSON.parse(r.dns) : null })),
    inbox: id => { const r = db.prepare('SELECT * FROM outreach_inboxes WHERE id = ?').get(id); return r && { ...r, dns: r.dns ? JSON.parse(r.dns) : null } },
    addInbox({ address, from_name, dkim_selector }) {
      const a = String(address || '').trim().toLowerCase()
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(a)) throw new Error('Enter the sending address, e.g. hello@mail.docstar.io')
      if (/^support@docstar\.io$/.test(a)) throw new Error('Use a separate sending inbox, not support@docstar.io')
      const s = settings(), at = now()
      const r = db.prepare(`INSERT INTO outreach_inboxes (address, from_name, hourly_limit, daily_limit, dkim_selector, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(a, String(from_name || 'DocStar by Walkover').slice(0, 80), s.hourly_limit, s.daily_limit, String(dkim_selector || 'google').replace(/[^a-z0-9_-]/gi, '') || 'google', at, at)
      return store.inbox(r.lastInsertRowid)
    },
    updateInbox(id, input) {
      const box = store.inbox(id); if (!box) throw new Error('No such inbox')
      const c = cleanSettings({ hourly_limit: input.hourly_limit, daily_limit: input.daily_limit })
      const hourly = c.hourly_limit ?? box.hourly_limit, daily = c.daily_limit ?? box.daily_limit
      if (hourly > daily) throw new Error('The hourly limit cannot be above the daily limit')
      db.prepare('UPDATE outreach_inboxes SET hourly_limit = ?, daily_limit = ?, from_name = ?, updated_at = ? WHERE id = ?')
        .run(hourly, daily, input.from_name ? String(input.from_name).slice(0, 80) : box.from_name, now(), id)
      return store.inbox(id)
    },
    setInboxState(id, state, reason = null) {
      db.prepare('UPDATE outreach_inboxes SET state = ?, pause_reason = ?, updated_at = ? WHERE id = ?').run(state, reason, now(), id)
      if (state === 'paused') event('paused', { inboxId: id, detail: reason })
      if (state === 'active') event('resumed', { inboxId: id })
    },
    removeInbox(id) {
      const live = db.prepare("SELECT COUNT(*) c FROM outreach_messages WHERE inbox_id = ? AND state = 'scheduled'").get(id).c
      if (live) throw new Error(`${live} email(s) are still scheduled from this inbox: pause it, or cancel them first`)
      db.prepare('DELETE FROM outreach_inboxes WHERE id = ?').run(id)
    },

    suppressed: () => new Set(db.prepare('SELECT entry FROM outreach_suppression').all().map(r => r.entry)),
    suppress(entry, reason, source = 'manual') {
      const e = String(entry || '').trim().toLowerCase()
      if (!/^[^@\s]*@[^@\s]+\.[a-z]{2,}$/.test(e)) throw new Error('Enter an address (name@company.com) or a domain (@company.com)')
      db.prepare('INSERT INTO outreach_suppression (entry, reason, source, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(entry) DO NOTHING').run(e, String(reason || 'manual').slice(0, 200), source, now())
      // Nothing more goes to a suppressed address (or domain): its scheduled emails are cancelled now.
      const seqs = db.prepare(`SELECT id FROM outreach_sequences WHERE state = 'active' AND ${e.startsWith('@') ? 'domain = ?' : 'to_email = ?'}`).all(e.startsWith('@') ? e.slice(1) : e)
      for (const s of seqs) store.stopSequence(s.id, `suppressed: ${reason}`)
      return { entry: e, stopped: seqs.length }
    },
    unsuppress: entry => db.prepare('DELETE FROM outreach_suppression WHERE entry = ?').run(String(entry).toLowerCase()).changes,
    stopSequence(id, reason) {
      db.transaction(() => {
        db.prepare("UPDATE outreach_sequences SET state = 'stopped', stop_reason = ?, updated_at = ? WHERE id = ? AND state = 'active'").run(reason, now(), id)
        db.prepare("UPDATE outreach_messages SET state = 'cancelled', error = ? WHERE sequence_id = ? AND state = 'scheduled'").run(reason, id)
      })()
    },

    /** Compliance context for new approvals. */
    ctx: () => ({
      suppressed: store.suppressed(),
      activeDomains: new Set(db.prepare("SELECT domain FROM outreach_sequences WHERE state = 'active'").all().map(r => r.domain)),
      emailed: new Set([...db.prepare('SELECT to_email FROM outreach_sequences').all().map(r => r.to_email.toLowerCase()),
        ...(hasTable(db, 'gtm_outreach') ? db.prepare('SELECT to_email FROM gtm_outreach').all().map(r => String(r.to_email).toLowerCase()) : [])])
    }),

    /** What both dashboards show. */
    overview() {
      const day = new Date(Date.now() - 86400_000).toISOString(), hour = new Date(Date.now() - 3600_000).toISOString()
      const sentSince = (id, t) => db.prepare("SELECT COUNT(*) c FROM outreach_messages WHERE inbox_id = ? AND state = 'sent' AND sent_at > ?").get(id, t).c
      const win = new Date(Date.now() - settings().monitor_window_days * 86400_000).toISOString()
      return {
        settings: settings(),
        inboxes: store.inboxes().map(b => ({ ...b, sentHour: sentSince(b.id, hour), sentDay: sentSince(b.id, day),
          scheduled: db.prepare("SELECT COUNT(*) c FROM outreach_messages WHERE inbox_id = ? AND state = 'scheduled'").get(b.id).c,
          window: { sent: sentSince(b.id, win),
            bounces: db.prepare("SELECT COUNT(*) c FROM outreach_events WHERE inbox_id = ? AND kind = 'bounce' AND at > ?").get(b.id, win).c,
            complaints: db.prepare("SELECT COUNT(*) c FROM outreach_events WHERE inbox_id = ? AND kind = 'complaint' AND at > ?").get(b.id, win).c } })),
        queue: db.prepare(`SELECT m.id, m.step, m.state, m.due_at, m.sent_at, m.error, m.to_email, m.subject, s.company, s.tz, s.n, s.id sequence_id, b.address inbox
          FROM outreach_messages m JOIN outreach_sequences s ON s.id = m.sequence_id LEFT JOIN outreach_inboxes b ON b.id = m.inbox_id
          WHERE m.state = 'scheduled' OR m.sent_at > ? OR (m.state IN ('failed','cancelled') AND m.due_at > ?) ORDER BY COALESCE(m.sent_at, m.due_at) DESC LIMIT 300`).all(new Date(Date.now() - 14 * 86400_000).toISOString(), new Date(Date.now() - 14 * 86400_000).toISOString()),
        sequences: db.prepare("SELECT state, COUNT(*) c FROM outreach_sequences GROUP BY state").all(),
        suppression: db.prepare('SELECT * FROM outreach_suppression ORDER BY created_at DESC LIMIT 500').all(),
        events: db.prepare('SELECT e.*, b.address inbox FROM outreach_events e LEFT JOIN outreach_inboxes b ON b.id = e.inbox_id ORDER BY e.id DESC LIMIT 100').all(),
        batches: db.prepare('SELECT * FROM outreach_batches ORDER BY id DESC LIMIT 20').all(),
        sequencedNs: db.prepare('SELECT n FROM outreach_sequences').all().map(r => r.n)
      }
    }
  }
  return store
}
const hasTable = (db, t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t))
export { domainOf }
