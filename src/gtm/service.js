// ICP research and lead pipeline (Growth view). Research lives in gtm/*.json and gtm/leads/*.json; the database keeps
// each lead's outreach status and notes. Nothing here sends email: sending lives in the local outreach module.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { now } from '../db/index.js'

export const LEAD_STATUSES = [
  ['researched', 'Researched'], ['no_contact', 'No contact found'], ['outreach_ready', 'Outreach ready'],
  ['sent', 'Email sent'], ['replied', 'Replied'], ['interested', 'Interested'], ['demo_requested', 'Demo requested'],
  ['signed_up', 'Signed up'], ['converted', 'Converted (active user)'], ['not_interested', 'Not interested'],
]
const STATUS_KEYS = new Set(LEAD_STATUSES.map(([k]) => k))
// Statuses at or past each funnel step, for the cumulative counts.
const REACHED = {
  sent: ['sent', 'replied', 'interested', 'demo_requested', 'signed_up', 'converted', 'not_interested'],
  replied: ['replied', 'interested', 'demo_requested', 'signed_up', 'converted', 'not_interested'],
  interested: ['interested', 'demo_requested', 'signed_up', 'converted'],
  demo_requested: ['demo_requested'], signed_up: ['signed_up', 'converted'], converted: ['converted'],
}

const keyOf = l => String(l.website || l.name || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '')
const hasEmail = l => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(l.email || '').trim())
const readJson = f => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }

export function createGtm({ db, root }) {
  const dir = path.join(root, 'gtm')
  db.exec(`CREATE TABLE IF NOT EXISTS gtm_leads (
    key TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'researched',
    notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
  // Outreach emails (ready to send) and what was sent. Rows are written by the local outreach module and mirrored to
  // the hosted dashboard; the files they come from (gtm/email-drafts.md, gtm/leads/) are never in Git.
  db.exec(`CREATE TABLE IF NOT EXISTS gtm_emails (n INTEGER PRIMARY KEY, company TEXT NOT NULL, to_email TEXT NOT NULL,
    subject TEXT NOT NULL, body TEXT NOT NULL, icp TEXT, prepared INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`)
  // The email exactly as it goes out (rendered in the branded template on the Mac), so both dashboards preview it.
  // role: 'support' (the company's published contact) or 'founder'; contact_name: the founder's name and title.
  for (const [c, def] of [['html', 'TEXT'], ['role', "TEXT NOT NULL DEFAULT 'support'"], ['contact_name', 'TEXT']])
    if (!db.prepare('PRAGMA table_info(gtm_emails)').all().some(x => x.name === c)) db.exec(`ALTER TABLE gtm_emails ADD COLUMN ${c} ${def}`)
  db.exec(`CREATE TABLE IF NOT EXISTS gtm_outreach (n INTEGER NOT NULL, kind TEXT NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL,
    message_id TEXT, thread_id TEXT, sent_at TEXT NOT NULL, PRIMARY KEY (n, kind))`)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS gtm_outreach_n ON gtm_outreach (n)') // one first email per draft; the mirror upserts on n

  // New leads are added; research fields of known leads are refreshed; status and notes are never overwritten.
  function importLeads() {
    const leadsDir = path.join(dir, 'leads')
    if (!existsSync(leadsDir)) return { added: 0, total: 0 }
    const upsert = db.prepare(`INSERT INTO gtm_leads (key, data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    let added = 0, total = 0
    db.transaction(() => {
      for (const f of readdirSync(leadsDir).filter(f => f.endsWith('.json')).sort()) {
        for (const lead of readJson(path.join(leadsDir, f)) || []) {
          const key = keyOf(lead)
          if (!key) continue
          total++
          const exists = db.prepare('SELECT 1 FROM gtm_leads WHERE key = ?').get(key)
          const initial = hasEmail(lead) ? 'researched' : 'no_contact'
          upsert.run(key, JSON.stringify({ ...lead, email: hasEmail(lead) ? lead.email.trim() : '', source_file: f }), initial, now(), now())
          if (!exists) added++
        }
      }
    })()
    return { added, total }
  }

  function leads() {
    return db.prepare('SELECT key, data, status, notes, updated_at FROM gtm_leads ORDER BY key').all()
      .map(r => ({ ...JSON.parse(r.data), key: r.key, status: r.status, notes: r.notes, updated_at: r.updated_at }))
  }

  function update(key, { status, notes }) {
    if (status !== undefined && !STATUS_KEYS.has(status)) throw new Error(`unknown status: ${status}`)
    const row = db.prepare('SELECT 1 FROM gtm_leads WHERE key = ?').get(key)
    if (!row) throw new Error('lead not found')
    db.prepare(`UPDATE gtm_leads SET status = COALESCE(?, status), notes = COALESCE(?, notes), updated_at = ? WHERE key = ?`)
      .run(status ?? null, notes ?? null, now(), key)
  }

  function summary() {
    const all = leads()
    const icps = readJson(path.join(dir, 'icps.json')) || []
    const count = fn => all.filter(fn).length
    const reached = s => count(l => REACHED[s].includes(l.status))
    const by = field => all.reduce((m, l) => { const k = l[field] || '—'; m[k] = (m[k] || 0) + 1; return m }, {})
    return {
      icpCount: icps.length,
      researched: all.length,
      qualified: count(l => l.priority === 'High' || l.priority === 'Medium'),
      verifiedEmails: count(l => l.email_status === 'published-personal'),
      genericEmails: count(l => l.email_status === 'generic-published'),
      noContact: count(l => !l.email),
      founderContacts: all.reduce((n, l) => n + (Array.isArray(l.founders) ? l.founders.length : 0), 0),
      highPriority: count(l => l.priority === 'High'),
      outreachReady: count(l => l.status === 'outreach_ready'),
      sent: reached('sent'), replied: reached('replied'), interested: reached('interested'),
      demos: reached('demo_requested'), signups: reached('signed_up'), converted: reached('converted'),
      bySegment: by('segment'), byIcp: by('icp'), byPriority: by('priority'),
    }
  }

  const doc = name => {
    const f = path.join(dir, `${name}.md`)
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }

  return {
    importLeads, leads, update, summary, statuses: LEAD_STATUSES,
    /** Every outreach email with its sent record (null while it is ready to send). */
    outreachEmails: () => db.prepare(`SELECT e.*, o.sent_at, o.message_id FROM gtm_emails e LEFT JOIN gtm_outreach o ON o.n = e.n AND o.kind = 'first' ORDER BY e.n`).all()
      .map(r => ({ n: r.n, company: r.company, to: r.to_email, subject: r.subject, body: r.body, icp: r.icp, prepared: Boolean(r.prepared), role: r.role || 'support', contact_name: r.contact_name, html: r.html,
        sent: r.sent_at ? { sent_at: r.sent_at, message_id: r.message_id } : null })),
    icps: () => readJson(path.join(dir, 'icps.json')) || [],
    channels: () => readJson(path.join(dir, 'channels.json')) || [],
    doc: name => (['email-drafts', 'messaging', 'email-templates', 'strategy'].includes(name) ? doc(name) : ''),
  }
}
