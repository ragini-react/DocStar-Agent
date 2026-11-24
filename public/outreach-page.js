// Outreach page: sending inboxes (limits, DNS, connect, pause), batch approval, the queue, sending rules, suppression and
// the monitor. Works on the Mac and on the hosted dashboard; there every change is queued for the Mac, which applies it
// within seconds (the page refreshes when it has).
import { connect, loadConnectScript } from '/vendor/viasocket-browser.js'

const $ = s => document.querySelector(s)
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
async function call(u, o = {}) {
  const r = await fetch(u, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-DocStar-CSRF': '1' }, ...o, body: o.body ? JSON.stringify(o.body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || r.status)
  return j
}
const when = s => (s ? new Date(s).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
const pill = (t, k) => `<span class="pill ${k}">${esc(t)}</span>`
async function act(fn, okMsg) {
  try { const r = await fn(); if (r?.queued) flash('Sent to the Mac: it applies this in a few seconds.'); else if (okMsg) flash(okMsg(r)); await load(); return r }
  catch (e) { alert(e.message) }
}
function flash(msg) { $('#alerts').innerHTML = `<div class="card">${esc(msg)}</div>`; setTimeout(() => { $('#alerts').innerHTML = '' }, 8000) }

let sys = null, emails = [], picked = new Set()

async function load() {
  let o
  try { [sys, o] = await Promise.all([call('/api/outreach/system'), call('/api/outreach')]) }
  catch (e) { $('#inboxes').textContent = `Sign in to the dashboard first (${e.message}).`; return }
  emails = o.emails
  const active = sys.inboxes.filter(b => b.state === 'active')
  $('#hdr').textContent = `${active.length} active inbox(es) · ${sys.queue.filter(q => q.state === 'scheduled').length} scheduled · ` +
    `${sys.suppression.length} suppressed${sys.sending ? '' : ' · this copy does not send (the Mac does)'}`
  const paused = sys.inboxes.filter(b => b.state === 'paused' && /^Automatic/.test(b.pause_reason || ''))
  if (paused.length && !$('#alerts').innerHTML) $('#alerts').innerHTML = paused.map(b => `<div class="card err"><b>${esc(b.address)} paused.</b> ${esc(b.pause_reason)}. Check the monitor below, fix the cause, then resume.</div>`).join('')
  renderInboxes(); renderReady(); renderQueue(); if (!document.activeElement?.closest?.('#settings')) renderSettings(); renderSuppression(); renderEvents()
}

// ── Inboxes ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const dnsCell = b => {
  if (!b.dns) return pill('not checked', '')
  if (b.dns.error) return pill('lookup failed', 'bad')
  return ['spf', 'dkim', 'dmarc'].map(k => pill(`${k.toUpperCase()} ${b.dns[k]?.ok ? '✓' : '✗'}`, b.dns[k]?.ok ? 'ok' : 'bad')).join(' ') +
    ['spf', 'dkim', 'dmarc'].filter(k => b.dns[k] && !b.dns[k].ok).map(k => `<div class="small muted">${esc(b.dns[k].fix)}</div>`).join('') +
    (b.dns.dmarc?.note ? `<div class="small muted">${esc(b.dns.dmarc.note)}</div>` : '')
}
function renderInboxes() {
  const rows = sys.inboxes.map(b => `<tr data-id="${b.id}">
    <td><b>${esc(b.address)}</b><div class="small muted">${esc(b.from_name)}</div>
      ${pill(b.state, b.state === 'active' ? 'ok' : b.state === 'paused' ? 'bad' : 'mid')} ${pill(b.connected ? 'connected' : 'not connected', b.connected ? 'ok' : 'mid')}
      ${b.pause_reason ? `<div class="small">${esc(b.pause_reason)}</div>` : ''}</td>
    <td>${dnsCell(b)}</td>
    <td><div class="row"><label class="f">Per hour<input type="number" min="1" max="50" name="hourly_limit" value="${b.hourly_limit}"></label>
      <label class="f">Per day<input type="number" min="1" max="500" name="daily_limit" value="${b.daily_limit}"></label><button data-a="limits">Save</button></div>
      <div class="small muted">Sent: ${b.sentHour} in the last hour, ${b.sentDay} in 24 h · ${b.scheduled} scheduled</div></td>
    <td class="small">${b.window.sent} sent · ${b.window.bounces} bounces · ${b.window.complaints} complaints<div class="muted">last ${sys.settings.monitor_window_days} days</div></td>
    <td><div class="row">
      <button data-a="connect">${b.connected ? 'Reconnect' : 'Connect'}</button><button data-a="dns">Check DNS</button>
      ${b.state === 'active' ? '<button data-a="pause">Pause</button>' : `<button class="primary" data-a="activate">${b.state === 'setup' ? 'Activate' : 'Resume'}</button>`}
      <button class="danger" data-a="remove">Remove</button></div></td></tr>`).join('')
  $('#inboxes').innerHTML = `${sys.inboxes.length ? `<div class="scroll"><table><tr><th>Inbox</th><th>SPF / DKIM / DMARC</th><th>Limits</th><th>Health</th><th></th></tr>${rows}</table></div>` : '<p class="muted">No sending inbox yet.</p>'}
    <form id="add-inbox" class="row" style="margin-top:12px"><input name="address" placeholder="hello@mail.docstar.io" required size="28">
      <input name="from_name" placeholder="From name (DocStar by Walkover)" size="26"><input name="dkim_selector" placeholder="DKIM selector (google)" size="18">
      <button class="primary">Add inbox</button></form>
    <p class="small muted">Use a separate Google Workspace inbox on a sending domain (e.g. mail.docstar.io), never support@. New inboxes start at ${sys.settings.hourly_limit}/hour and ${sys.settings.daily_limit}/day.
    An inbox activates only when it's connected as its own address and SPF, DKIM and DMARC all pass. To send more, add inboxes rather than raising one inbox's limits.</p>`
}
document.addEventListener('submit', ev => {
  if (ev.target.id === 'add-inbox') { ev.preventDefault(); const f = new FormData(ev.target); act(() => call('/api/outreach/inboxes', { method: 'POST', body: Object.fromEntries(f) }), () => 'Inbox added. Connect it, set up DNS, then activate.') }
  if (ev.target.id === 'settings-form') { ev.preventDefault(); saveSettings(ev.target) }
  if (ev.target.id === 'suppress-form') { ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target)); act(() => call('/api/outreach/suppression', { method: 'POST', body: f }), r => `Suppressed ${r.entry}${r.stopped ? `, ${r.stopped} sequence(s) stopped` : ''}`) }
  if (ev.target.id === 'complaint-form') { ev.preventDefault(); const f = Object.fromEntries(new FormData(ev.target)); if (confirm(`Record a spam complaint from ${f.email}? Their domain is suppressed and the inbox may pause.`)) act(() => call('/api/outreach/complaints', { method: 'POST', body: f }), r => (r.paused ? `Recorded. Inbox paused: ${r.paused}` : 'Complaint recorded and suppressed')) }
})
async function connectInbox(id) {
  let info
  try { info = await call(`/api/outreach/inboxes/${id}/connect-token`); loadConnectScript() } catch (e) { return alert(e.message) }
  const save = authId => act(() => call(`/api/outreach/inboxes/${id}/connected`, { method: 'POST', body: { authId } }), b => `${b.address} connected`)
  try {
    const { authId } = await connect({ embedToken: info.token, serviceId: info.serviceId, actions: info.actions, skipActionSelection: true,
      ...(info.reconnectAuthId ? { authId: info.reconnectAuthId } : {}), onLateSuccess: ({ authId }) => save(authId) })
    await save(authId)
  } catch (e) { if (e.code !== 'closed') alert(e.message) }
}

// ── Batch approval ──────────────────────────────────────────────────────────────────────────────────────────────────
function renderReady() {
  const done = new Set(sys.sequencedNs)
  const ready = emails.filter(e => !e.sent && !done.has(e.n))
  for (const n of picked) if (!ready.some(e => e.n === n)) picked.delete(n)
  const max = sys.settings.batch_size
  $('#ready').innerHTML = !ready.length ? '<p class="muted card">Nothing waiting. Use "Find companies & prepare emails" in the Growth section.</p>' :
    `<div class="card row"><button id="pick-next">Select next ${Math.min(max, ready.length)}</button><button id="pick-none">Clear</button>
      <button class="primary" id="approve" ${picked.size ? '' : 'disabled'}>Approve batch (${picked.size}/${max})</button>
      <span class="small muted">Read each email first. Every one is checked again before it is sent.</span></div>` +
    ready.map(e => `<div class="card"><label class="row"><input type="checkbox" data-n="${e.n}" ${picked.has(e.n) ? 'checked' : ''}>
      <b>${esc(e.company)}</b>${e.icp ? `<span class="tag">ICP: ${esc(e.icp)}</span>` : ''}${e.prepared ? '<span class="tag">from ICP search</span>' : ''}</label>
      <div>To: ${esc(e.to)}</div><div>Subject: ${esc(e.subject)}</div>
      <details><summary>Show email</summary>${e.html ? `<iframe sandbox title="Email preview" srcdoc="${esc(e.html)}" style="width:100%;height:900px;border:1px solid #ddd;border-radius:8px;background:#fff"></iframe>` : `<pre>${esc(e.body)}</pre>`}</details></div>`).join('')
}
document.addEventListener('change', ev => {
  const c = ev.target.closest('input[data-n]'); if (!c) return
  const n = Number(c.dataset.n)
  if (c.checked && picked.size >= sys.settings.batch_size) { c.checked = false; return alert(`A batch is at most ${sys.settings.batch_size} emails`) }
  c.checked ? picked.add(n) : picked.delete(n)
  $('#approve').disabled = !picked.size; $('#approve').textContent = `Approve batch (${picked.size}/${sys.settings.batch_size})`
})

// ── Queue ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function renderQueue() {
  const step = s => (s === 0 ? 'First email' : `Follow-up ${s}`)
  const st = q => pill(q.state, q.state === 'sent' ? 'ok' : q.state === 'scheduled' ? 'mid' : q.state === 'failed' ? 'bad' : '')
  $('#queue').innerHTML = !sys.queue.length ? '<p class="muted">Nothing scheduled or sent in the last 14 days.</p>' :
    `<table><tr><th>Company</th><th>Email</th><th>State</th><th>When</th><th>Inbox</th><th></th></tr>${sys.queue.map(q => `<tr>
      <td><b>${esc(q.company)}</b><div class="small muted">${esc(q.to_email)} · ${esc(q.tz)}</div></td><td>${step(q.step)}<div class="small muted">${esc(q.subject)}</div></td>
      <td>${st(q)}${q.error ? `<div class="small muted">${esc(q.error)}</div>` : ''}</td>
      <td class="small">${q.state === 'sent' ? `sent ${when(q.sent_at)}` : `due ${when(q.due_at)}`}</td><td class="small">${esc(q.inbox)}</td>
      <td>${q.state === 'scheduled' ? `<button class="small" data-stop="${q.sequence_id}">Stop</button>` : ''}</td></tr>`).join('')}</table>`
}

// ── Settings ────────────────────────────────────────────────────────────────────────────────────────────────────────
function renderSettings() {
  const s = sys.settings
  const f = (name, label, val, attrs = '') => `<label class="f">${label}<input name="${name}" value="${esc(val)}" ${attrs}></label>`
  $('#settings').innerHTML = `<form id="settings-form"><div class="grid">
    ${f('gap_min_min', 'Shortest gap between sends (minutes)', s.gap_min_sec / 60, 'type="number" min="1" step="0.5"')}
    ${f('gap_max_min', 'Longest gap between sends (minutes)', s.gap_max_sec / 60, 'type="number" min="1" step="0.5"')}
    ${f('business_start', 'Recipient business hours start (0–23)', s.business_start, 'type="number" min="0" max="23"')}
    ${f('business_end', 'Business hours end (1–24)', s.business_end, 'type="number" min="1" max="24"')}
    ${f('default_tz', 'Time zone for .com/.io domains', s.default_tz)}
    ${f('max_followups', 'Follow-ups (0–2)', s.max_followups, 'type="number" min="0" max="2"')}
    ${f('fu1', 'Follow-up 1 after (days)', s.followup_days[0], 'type="number" min="1" max="30"')}
    ${f('fu2', 'Follow-up 2 after follow-up 1 (days)', s.followup_days[1], 'type="number" min="1" max="30"')}
    ${f('batch_size', 'Emails per approval (max 30)', s.batch_size, 'type="number" min="1" max="30"')}
    ${f('domain_daily_cap', 'Emails per company per day', s.domain_daily_cap, 'type="number" min="1" max="5"')}
    ${f('bounce_pct', 'Pause above bounce rate (%)', +(s.bounce_pause_rate * 100).toFixed(2), 'type="number" min="0.5" max="20" step="0.5"')}
    ${f('bounce_pause_count', 'Or pause at bounces', s.bounce_pause_count, 'type="number" min="1" max="50"')}
    ${f('complaint_pause_count', 'Pause at spam complaints', s.complaint_pause_count, 'type="number" min="1" max="10"')}
    ${f('monitor_window_days', 'Health window (days)', s.monitor_window_days, 'type="number" min="1" max="30"')}
  </div><p class="row"><button class="primary">Save rules</button><span class="small muted">Per-inbox hourly and daily limits are set on each inbox above.
  EU/UK addresses are emailed only at role addresses (hello@, contact@…), and every email carries an opt-out and the company address.</span></p></form>`
}
function saveSettings(form) {
  const v = Object.fromEntries(new FormData(form))
  const body = { gap_min_sec: v.gap_min_min * 60, gap_max_sec: v.gap_max_min * 60, business_start: v.business_start, business_end: v.business_end, default_tz: v.default_tz,
    max_followups: v.max_followups, followup_days: [v.fu1, v.fu2], batch_size: v.batch_size, domain_daily_cap: v.domain_daily_cap,
    bounce_pause_rate: v.bounce_pct / 100, bounce_pause_count: v.bounce_pause_count, complaint_pause_count: v.complaint_pause_count, monitor_window_days: v.monitor_window_days }
  act(() => call('/api/outreach/settings', { method: 'PUT', body }), () => 'Rules saved')
}

// ── Suppression and monitor ─────────────────────────────────────────────────────────────────────────────────────────
function renderSuppression() {
  $('#suppression').innerHTML = `<form id="suppress-form" class="row"><input name="entry" placeholder="name@company.com or @company.com" size="30" required>
      <input name="reason" placeholder="Reason" size="20"><button>Suppress</button></form>
    <form id="complaint-form" class="row" style="margin-top:8px"><input name="email" placeholder="Complaint from (address or @domain)" size="30" required>
      <button class="danger">Record spam complaint</button><span class="small muted">For complaints seen in Google Postmaster Tools or forwarded abuse reports.</span></form>
    ${sys.suppression.length ? `<table style="margin-top:10px"><tr><th>Never email</th><th>Why</th><th>Added</th><th></th></tr>${sys.suppression.map(x => `<tr><td>${esc(x.entry)}</td><td>${esc(x.reason)} <span class="small muted">(${esc(x.source)})</span></td><td class="small">${when(x.created_at)}</td>
      <td><button class="small" data-unsuppress="${esc(x.entry)}">Remove</button></td></tr>`).join('')}</table>` : '<p class="muted">Empty.</p>'}`
}
function renderEvents() {
  const k = { bounce: 'bad', complaint: 'bad', optout: 'mid', reply: 'ok', paused: 'bad', resumed: 'ok' }
  $('#events').innerHTML = sys.events.length ? `<table><tr><th>When</th><th>What</th><th>Who</th><th>Inbox</th></tr>${sys.events.map(e => `<tr><td class="small">${when(e.at)}</td>
    <td>${pill(e.kind, k[e.kind] || '')}${e.detail ? ` <span class="small muted">${esc(e.detail)}</span>` : ''}</td><td>${esc(e.email || '')}</td><td class="small">${esc(e.inbox || '')}</td></tr>`).join('')}</table>`
    : '<p class="muted">No bounces, replies or complaints yet. Inboxes are checked every 10 minutes.</p>'
}

// ── Clicks ──────────────────────────────────────────────────────────────────────────────────────────────────────────
document.addEventListener('click', ev => {
  const t = ev.target
  if (t.id === 'pick-next') { ev.preventDefault(); const done = new Set(sys.sequencedNs); for (const e of emails.filter(e => !e.sent && !done.has(e.n))) { if (picked.size >= sys.settings.batch_size) break; picked.add(e.n) } return renderReady() }
  if (t.id === 'pick-none') { picked.clear(); return renderReady() }
  if (t.id === 'approve') {
    if (!confirm(`Approve ${picked.size} email(s)? They'll be sent automatically within the inbox limits, with up to ${sys.settings.max_followups} follow-ups each unless they reply.`)) return
    return act(() => call('/api/outreach/batches', { method: 'POST', body: { ns: [...picked] } }), r => {
      picked.clear()
      return `${r.queued.length} scheduled.` + (r.skipped.length ? ` Skipped: ${r.skipped.map(s => `${s.to || s.n} (${s.reason})`).join('; ')}` : '')
    })
  }
  if (t.dataset.stop) return confirm('Stop this sequence? Nothing more is sent to this company.') && act(() => call(`/api/outreach/sequences/${t.dataset.stop}/stop`, { method: 'POST', body: {} }))
  if (t.dataset.unsuppress) return confirm(`Remove ${t.dataset.unsuppress} from the suppression list? Only do this if they asked to hear from you.`) && act(() => call(`/api/outreach/suppression/${encodeURIComponent(t.dataset.unsuppress)}`, { method: 'DELETE' }))
  const a = t.dataset.a; if (!a) return
  const tr = t.closest('tr[data-id]'), id = tr.dataset.id
  if (a === 'limits') return act(() => call(`/api/outreach/inboxes/${id}`, { method: 'PUT', body: { hourly_limit: tr.querySelector('[name=hourly_limit]').value, daily_limit: tr.querySelector('[name=daily_limit]').value } }), b => `Limits: ${b.hourly_limit}/hour, ${b.daily_limit}/day`)
  if (a === 'connect') return connectInbox(id)
  if (a === 'dns') return act(() => call(`/api/outreach/inboxes/${id}/dns`, { method: 'POST', body: {} }), b => (b.dns_ok ? 'SPF, DKIM and DMARC all pass' : 'DNS not complete yet: see the fixes listed'))
  if (a === 'activate') return act(() => call(`/api/outreach/inboxes/${id}/activate`, { method: 'POST', body: {} }), b => `${b.address} is active`)
  if (a === 'pause') return act(() => call(`/api/outreach/inboxes/${id}/pause`, { method: 'POST', body: {} }), () => 'Paused')
  if (a === 'remove') return confirm('Remove this inbox?') && act(() => call(`/api/outreach/inboxes/${id}`, { method: 'DELETE' }))
})

load()
setInterval(() => { if (!document.activeElement || document.activeElement === document.body) load() }, 20000)
