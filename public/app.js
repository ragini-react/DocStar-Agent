// DocStar dashboard. Plain ES module, no build step. Every value from the server is escaped before it
// reaches the page: platform names and URLs come from the open web.
//
// Changes made on a hosted copy are run by the agent: each one is shown as pending at once and turns into
// "Applied" or "Failed: <reason>" when the agent reports back. Views refresh live on every relevant event,
// row by row, without touching a field someone is typing in.
import { connect, loadConnectScript } from '/vendor/viasocket-browser.js'
import { STATUSES, label } from '/labels.js'
import { BRAND, SITE_HOST, SITE_URL } from '/brand.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
let hosted = false // set from /api/session
let mirrorOn = false // hosted and mirroring the agent: Chrome and Gmail are the agent's, reached through it
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const fmtTime = ts => (ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const fmtDate = ts => (ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—')
const ago = ts => {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : fmtTime(ts)
}
const safeHref = u => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '#')
const link = (u, text) => (u ? `<a href="${safeHref(u)}" target="_blank" rel="noopener noreferrer">${esc(text ?? u)}</a>` : '—')

// ---------- API and the changes it carries ----------
const commands = new Map() // id -> command row (hosted: changes waiting for the agent)
const waitingButtons = new Map() // command id -> button disabled until the result arrives
const isWaiting = b => [...waitingButtons.values()].includes(b)

/**
 * Call the API. On a hosted copy a write answers 202 with a command: it is shown as pending and the caller gets
 * { queued: true, command } instead of a result (never a success it did not have).
 */
async function api(path, { method = 'GET', body, button = null } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-DocStar-CSRF': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  })
  if (res.status === 401 && path !== '/api/login' && !path.includes('/reveal')) { showLogin(); throw new Error('Signed out') }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, data })
  if (res.status === 202 && data?.queued) {
    trackCommand(data.command)
    if (button && ['queued', 'sent'].includes(data.command.state)) { button.disabled = true; waitingButtons.set(data.command.id, button) }
    toast(data.message, 'pending')
    return { queued: true, command: data.command }
  }
  return data
}

let toastTimer
function toast(msg, kind = '') {
  const t = $('#toast')
  t.textContent = msg
  t.className = `toast${kind === true ? ' err' : kind ? ` ${kind}` : ''}`
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.hidden = true), kind === true ? 8000 : 5000)
}
const run = fn => async (...args) => { try { await fn(...args) } catch (e) { if (e.message !== 'Signed out') toast(e.message, true) } }

/**
 * Run a write from a button: the button is disabled while it is in flight (and, hosted, until the agent answers).
 * `done(result)` runs only for a real result, never for a queued one.
 */
async function act(button, path, opts = {}, done = null) {
  if (button) button.disabled = true
  try {
    const r = await api(path, { ...opts, button })
    if (r?.queued) return r
    if (done) await done(r)
    return r
  } catch (e) {
    if (e.message !== 'Signed out') toast(e.message, true)
  } finally {
    if (button && !isWaiting(button)) button.disabled = false
  }
}

function trackCommand(c) {
  if (!c?.id) return
  const before = commands.get(c.id)
  commands.set(c.id, { ...before, ...c })
  if (['applied', 'failed'].includes(c.state) && before && !['applied', 'failed'].includes(before.state)) {
    toast(c.state === 'applied' ? `Applied: ${c.label}` : `Failed: ${c.label} — ${c.result || 'no reason given'}`, c.state === 'applied' ? 'ok' : true)
    const b = waitingButtons.get(c.id)
    if (b) { b.disabled = false; waitingButtons.delete(c.id) }
    scheduleRefresh('all')
  }
  renderPending()
}
function renderPending() {
  const open = [...commands.values()].filter(c => ['queued', 'sent'].includes(c.state))
  $('#pending-btn').hidden = !hosted || !commands.size
  $('#pending-count').textContent = open.length || ''
  $('#pending-count').hidden = !open.length
  const tone = { queued: 'warn', sent: 'info', applied: 'ok', failed: 'err' }
  const word = { queued: mirrorOnline ? 'Pending' : 'Pending — will apply when the agent is online', sent: 'Sent to the agent', applied: 'Applied', failed: 'Failed' }
  $('#pending-list').innerHTML = [...commands.values()].sort((a, b) => b.id - a.id).slice(0, 40).map(c => `<li>
      <div><span class="pill ${tone[c.state] || ''}">${esc(word[c.state] || c.state)}</span> ${esc(c.label || `${c.method} ${c.path}`)}</div>
      <div class="muted small">${fmtTime(c.created_at)}${c.applied_at ? ` · ${c.state} ${fmtTime(c.applied_at)}` : ''}${c.state === 'failed' && c.result ? ` · ${esc(c.result)}` : ''}</div></li>`).join('')
    || '<li class="muted">No changes made here yet.</li>'
}
async function loadCommands() {
  if (!hosted) return
  for (const c of await api('/api/commands')) commands.set(c.id, c)
  renderPending()
}
$('#pending-btn').addEventListener('click', () => { $('#pending-panel').hidden = !$('#pending-panel').hidden })
$('#pending-close').addEventListener('click', () => { $('#pending-panel').hidden = true })

// ---------- auth ----------
function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#login-password').focus() }
$('#login-form').addEventListener('submit', run(async e => {
  e.preventDefault()
  $('#login-error').textContent = ''
  try {
    await api('/api/login', { method: 'POST', body: { password: $('#login-password').value } })
    $('#login-password').value = ''
    start()
  } catch (err) { $('#login-error').textContent = err.message }
}))
$('#logout').addEventListener('click', run(async () => { await api('/api/logout', { method: 'POST' }); showLogin() }))

// ---------- navigation ----------
const TITLES = { overview: 'Overview', 'activity-list': 'Status board', platforms: 'Platforms', queue: 'Needs you', added: 'Successfully added', failed: 'Failed', company: `${BRAND} profile`, activity: 'Activity', growth: 'Growth: ICP & leads',
  integrations: 'Integrations', credentials: 'Credentials', settings: 'Settings', health: 'Health' }
const loaders = {}
let pendingActivityPlatform = null
let pendingCategory = ''
const currentView = () => { const v = location.hash.slice(1).split('?')[0] || 'overview'; return TITLES[v] ? v : 'overview' }
const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '')
function route() {
  const name = currentView()
  for (const v of Object.keys(TITLES)) { const el = $(`#view-${v}`); if (el) el.hidden = v !== name }
  for (const a of $$('#nav a')) a.classList.toggle('active', a.dataset.view === name)
  $('#view-title').textContent = TITLES[name]
  if (name === 'activity' && hashParams().get('platform')) { pendingActivityPlatform = hashParams().get('platform'); activityOldest = null }
  if (name === 'platforms') {
    const p = hashParams()
    $('#f-group').value = p.get('group') || ''
    $('#f-status').value = p.get('status') || ''
    $('#f-pricing').value = p.get('pricing') || ''
    pendingCategory = p.get('category') || ''
    if (categoriesLoaded) $('#f-category').value = pendingCategory
    page = 0
  }
  run(loaders[name] || (async () => {}))()
}
window.addEventListener('hashchange', route)

// ---------- live refresh ----------
// Events that change what a view shows. The rows they name are reloaded; nothing someone is editing is touched.
const REFRESH = /^(platform_|task_|approval_|listing_|backlink_|needs_you|status_reconciled|manual_|stale_|sweep|data_repaired|registration_|email_|verification_|remote_command)/
let pendingRefresh = new Set()
let refreshTimer = null
function scheduleRefresh(pid) {
  pendingRefresh.add(pid ?? 'all')
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(flushRefresh, 400)
}
async function flushRefresh() {
  const ids = pendingRefresh
  pendingRefresh = new Set()
  refreshStatus()
  const view = currentView()
  if (view === 'platforms' && !ids.has('all')) return run(refreshRows)([...ids].filter(Number.isFinite))
  if (['overview', 'activity-list', 'platforms', 'queue', 'added', 'failed', 'credentials'].includes(view)) run(loaders[view])({ soft: true })
  if (view === 'integrations') run(loaders.integrations)()
}
const editing = root => { const a = document.activeElement; return a && root?.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) ? a : null }

// ---------- automation controls ----------
const STATE_PILL = { running: 'ok', paused: 'warn', stopped: '' }
function renderAutomation(state) {
  const p = $('#automation-state')
  p.textContent = state === 'running' ? '● Running' : state === 'paused' ? 'Paused' : 'Stopped'
  p.className = `pill ${STATE_PILL[state] ?? ''}`
  const can = { start: state === 'stopped', pause: state === 'running', resume: state === 'paused', stop: state !== 'stopped' }
  for (const b of $$('[data-automation]')) if (!isWaiting(b)) b.disabled = !can[b.dataset.automation]
}
for (const b of $$('[data-automation]')) {
  b.addEventListener('click', () => act(b, `/api/automation/${b.dataset.automation}`, { method: 'POST' }, r => { renderAutomation(r.state); refreshStatus() }))
}

// ---------- overview ----------
// Each card opens the list its number counts.
const KPIS = [
  ['discovered', 'Platforms discovered', '', '#platforms'], ['qualified', 'Qualified', '', '#platforms'], ['freeSelected', 'Free platforms selected', '', '#platforms?pricing=free'],
  ['paidSkipped', 'Paid, skipped', '', '#platforms?status=paid_skipped'], ['registered', 'Accounts registered', '', '#credentials'],
  ['inProgress', 'In progress', '', '#platforms?group=in_progress'], ['awaitingYou', 'Awaiting your approval', 'alert', '#queue'],
  ['approvedWaiting', 'Approved, not yet submitted', '', '#platforms?group=pipeline'],
  ['submitted', 'Submitted in total (listed + awaiting review)', '', '#added'], ['successfullyAdded', 'Successfully added (public listing)', 'accent', '#added'],
  ['pendingPlatformApproval', 'Submitted, awaiting platform review', '', '#added'], ['liveBacklinks', 'Live backlinks', 'accent', '#platforms?status=live_backlink'],
  ['dofollow', 'Dofollow', 'accent', '#added'], ['nofollow', 'Nofollow', '', '#added'], ['lost', 'Backlinks lost', 'alert', '#platforms?status=backlink_lost'],
  ['failed', 'Failed', 'alert', '#failed'], ['needsYou', 'Needs you', 'alert', '#queue']
]
function bars(el, rows) {
  const max = Math.max(1, ...rows.map(r => r.n))
  el.innerHTML = rows.length
    ? rows.map(r => `<div class="bar-row"><span>${r.href ? `<a href="${esc(r.href)}">${esc(r.name)}</a>` : esc(r.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${(r.n / max) * 100}%"></div></div><span class="n">${r.n}</span></div>`).join('')
    : '<p class="muted">Nothing yet.</p>'
}
loaders.overview = async () => {
  const o = await api('/api/overview')
  renderAutomation(o.automation)
  $('#kpis').innerHTML = KPIS.map(([k, l, cls, href]) => `<div class="kpi ${o[k] && cls ? cls : ''} ${href ? 'link' : ''}" ${href ? `data-href="${href}" role="link" tabindex="0"` : ''}>
    <div class="label">${l}</div><div class="value">${o[k] ?? 0}</div>${k === 'registered' && o.signupsStarted > o.registered ? `<div class="muted small">${o.signupsStarted - o.registered} started, not finished</div>` : ''}</div>`).join('')
  bars($('#by-status'), Object.entries(o.byStatus).map(([s, n]) => ({ name: label(s), n, href: `#platforms?status=${s}` })).sort((a, b) => b.n - a.n))
  bars($('#by-category'), o.byCategory.map(r => ({ name: r.name, n: r.n, href: r.slug ? `#platforms?category=${encodeURIComponent(r.slug)}` : null })))
  renderFeed($('#overview-activity'), await api('/api/activity?limit=8'))
  await loadActivitySummary()
}

// ---------- product activity list ----------
// "New since your last visit" is remembered per browser; the groups themselves come from the server.
const AL_TONE = { new: 'info', your_approval: 'warn', in_progress: 'info', needs_you: 'warn', failed: 'err', product_added: 'info',
  product_published: 'warn', backlink_completed: 'ok', backlink_lost: 'err', skipped: '' }
const AL_SEEN_KEY = 'docstar.activityListSeenAt'
const store = { get(k) { try { return localStorage.getItem(k) } catch { return null } }, set(k, v) { try { localStorage.setItem(k, v) } catch {} } }
let alFilter = 'active'
let alData = null
let alSince = null
const AL_DONE = new Set(['skipped'])
function alChips(el, data, active, withAll) {
  const activeN = data.items.filter(i => !AL_DONE.has(i.group)).length
  const chips = [...(withAll ? [{ key: 'active', label: 'All except skipped', n: activeN }, { key: 'all', label: 'Everything', n: data.items.length }] : []),
    ...data.groups.filter(g => withAll || (g.key !== 'skipped' && data.counts[g.key])).map(g => ({ ...g, n: data.counts[g.key] }))]
  el.innerHTML = chips.map(c => `<button type="button" class="chip ${c.key === active ? 'active' : ''} ${AL_TONE[c.key] ? `tone-${AL_TONE[c.key]}` : ''}" data-group="${c.key}">${esc(c.label)} <b>${c.n}</b></button>`).join('')
}
function alRow(i) {
  const d = t => (t ? esc(t.slice(0, 10)) : '—')
  const links = [i.listing_url && `<a href="${esc(i.listing_url)}" target="_blank" rel="noopener">Listing page</a>`,
    i.backlink_page && i.backlink_page !== i.listing_url && `<a href="${esc(i.backlink_page)}" target="_blank" rel="noopener">Backlink page</a>`,
    i.backlink_rel != null && i.backlink_status === 'live' && `<span class="sub">${esc(i.is_dofollow ? 'dofollow' : i.backlink_rel || 'nofollow')}</span>`,
    i.indexable === 0 && '<span class="sub">page is noindex</span>'].filter(Boolean).join('<br>')
  const dates = [['Found', i.created_at], ['Submitted', i.submitted_at], ['Published', i.published_at], ['Link live', i.backlink_at]].filter(([, t]) => t)
  return `<tr>
    <td><strong class="platform-link" data-drawer="${i.platform_id}">${esc(i.name)}</strong>${i.newSinceLastVisit ? ' <span class="pill info new-tag">New</span>' : ''}
      <div class="muted small"><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.domain)}</a></div></td>
    <td>${esc(i.statusLabel)}${i.stoppedAt ? `<div class="sub">stopped at: ${esc(i.stoppedAt)}</div>` : ''}</td>
    <td class="note">${i.note ? esc(i.note) : '<span class="muted">—</span>'}${i.todo ? `<div class="sub"><b>To do:</b> ${esc(i.todo)}</div>` : ''}</td>
    <td>${links || '<span class="muted">—</span>'}</td>
    <td>${i.account_email ? `${esc(i.account_email)}${i.login_method ? `<div class="sub">${esc(label(i.login_method))}</div>` : ''}` : '<span class="muted">—</span>'}</td>
    <td class="small">${dates.map(([k, t]) => `${k}: ${d(t)}`).join('<br>')}<div class="sub">Last change: ${d(i.status_changed_at)}</div></td></tr>`
}
function renderActivityList() {
  if (!alData) return
  alChips($('#al-filters'), alData, alFilter, true)
  const q = $('#al-search').value.trim().toLowerCase()
  const shown = g => alFilter === 'all' || (alFilter === 'active' ? !AL_DONE.has(g) : g === alFilter)
  const match = i => !q || `${i.name} ${i.url} ${i.domain}`.toLowerCase().includes(q)
  $('#al-note').textContent = `${alData.total} platforms in total, each in exactly one group below.` + (alData.newSinceLastVisit ? ` ${alData.newSinceLastVisit} found since your last visit are marked "New".` : '')
  const sections = alData.groups.filter(g => shown(g.key)).map(g => {
    const rows = alData.items.filter(i => i.group === g.key && match(i))
    if (!rows.length && (q || alFilter === 'active' || alFilter === 'all')) return ''
    return `<div class="card al-group" id="al-${g.key}">
      <h2><span class="pill ${AL_TONE[g.key] || ''}">${rows.length}</span> ${esc(g.label)}</h2>
      <dl class="al-help"><dt>What it means</dt><dd>${esc(g.help.means)}</dd><dt>What happens next</dt><dd>${esc(g.help.next)}</dd><dt>Who acts</dt><dd>${esc(g.help.who)}</dd></dl>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Platform</th><th>Exact status</th><th>Latest note</th><th>Listing / backlink</th><th>Account</th><th>Dates</th></tr></thead>
        <tbody>${rows.map(alRow).join('')}</tbody></table></div>` : '<p class="muted small">Nothing here right now.</p>'}</div>`
  }).join('')
  $('#al-groups').innerHTML = sections || '<p class="muted">Nothing matches.</p>'
}
loaders['activity-list'] = async ({ soft = false } = {}) => {
  if (!soft) alSince = store.get(AL_SEEN_KEY)
  alData = await api(`/api/product-activity${alSince ? `?since=${encodeURIComponent(alSince)}` : ''}`)
  if (!soft) store.set(AL_SEEN_KEY, new Date().toISOString()) // the next visit marks only URLs found after this one
  renderActivityList()
}
$('#al-filters').addEventListener('click', e => { const c = e.target.closest('[data-group]'); if (c) { alFilter = c.dataset.group; renderActivityList() } })
$('#al-search').addEventListener('input', () => renderActivityList())
async function loadActivitySummary() {
  const since = store.get(AL_SEEN_KEY)
  const data = await api(`/api/product-activity${since ? `?since=${encodeURIComponent(since)}` : ''}`)
  alChips($('#activity-summary-counts'), data, null, false)
  const b = $('#badge-activity-list')
  b.hidden = !data.newSinceLastVisit
  b.textContent = data.newSinceLastVisit || ''
}
$('#activity-summary').addEventListener('click', e => {
  const c = e.target.closest('[data-group]')
  if (c) alFilter = c.dataset.group
  location.hash = '#activity-list'
})
$('#activity-summary').addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = '#activity-list' })

$('#kpis').addEventListener('click', e => { const k = e.target.closest('[data-href]'); if (k) location.hash = k.dataset.href })
$('#kpis').addEventListener('keydown', e => { const k = e.target.closest('[data-href]'); if (k && e.key === 'Enter') location.hash = k.dataset.href })

// ---------- platforms ----------
const STATUS_TONE = { live_backlink: 'ok', published: 'ok', registered: 'info', submitted: 'info', pending_platform_review: 'info', approval_required: 'warn', needs_you: 'err',
  evaluation_failed: 'err', registration_failed: 'err', submission_failed: 'err', backlink_lost: 'err', no_backlink: 'warn', blocked: 'warn', approved: 'info',
  qualifying: 'info', registering: 'info', submitting: 'info', email_verification_pending: 'info' }
$('#f-status').insertAdjacentHTML('beforeend', STATUSES.map(s => `<option value="${s}">${esc(label(s))}</option>`).join(''))
let categoriesLoaded = false
const PAGE = 100
let page = 0
const IN_FLIGHT = new Set(['qualifying', 'registering', 'registered', 'email_verification_pending', 'ready_for_submission', 'submitting'])
const DONE = new Set(['submitted', 'pending_platform_review', 'published', 'live_backlink', 'no_backlink', 'backlink_lost'])

/** Only the actions that apply to this status. */
function actionsFor(p) {
  const a = []
  if (p.status === 'needs_you') a.push(['resume', 'Resume'])
  if (['evaluation_failed', 'registration_failed', 'submission_failed', 'rejected_by_platform'].includes(p.status)) a.push(['retry', 'Retry'])
  if (['discovered', 'rejected', 'paid_skipped', 'evaluation_failed'].includes(p.status)) a.push(['qualify', 'Evaluate now'])
  if (!DONE.has(p.status)) a.push(['manual', 'Mark as done manually…'])
  a.push(['listing-url', p.listing_url ? 'Change listing URL…' : 'Set listing URL…'])
  if (p.backlink_url) a.push(['check-backlink', 'Check backlink now'])
  if (IN_FLIGHT.has(p.status) || p.status === 'approved' || ['evaluation_failed', 'registration_failed', 'submission_failed'].includes(p.status)) a.push(['needs-you', 'Hand to me (needs you)'])
  if (!['rejected', 'paid_skipped'].includes(p.status) && !DONE.has(p.status)) { a.push(['rejected', 'Reject…']); a.push(['paid_skipped', 'Mark paid / skip…']) }
  if (['rejected', 'paid_skipped'].includes(p.status)) a.push(['discovered', 'Back to discovered'])
  if (!p.account_status && !p.submission_status) a.push(['delete', 'Delete…'])
  return a
}
function reasonText(p) {
  if (p.status === 'needs_you' && p.needs_you_reason) { try { return JSON.parse(p.needs_you_reason).what } catch { return p.needs_you_reason } }
  return p.status_reason ? label(p.status_reason) : ''
}
function platformRow(p) {
  const why = reasonText(p)
  return `<tr data-id="${p.id}">
    <td><strong class="platform-link" data-drawer="${p.id}">${esc(p.name)}</strong><div class="sub">${link(p.url, p.domain)} · <span title="${esc(p.source)}">${esc(p.source.startsWith('discovery:') ? 'found by search' : label(p.source))}</span></div></td>
    <td>${esc(p.category_name || '—')}</td>
    <td>${p.quality_score ?? '—'}</td>
    <td>${esc(label(p.pricing))}</td>
    <td><span class="pill ${STATUS_TONE[p.status] ?? ''}">${esc(label(p.status))}</span>${why ? `<div class="sub" title="${esc(why)}">${esc(why.slice(0, 80))}</div>` : ''}</td>
    <td>${p.account_email ? `${esc(p.account_email)}<div class="sub">${esc(p.signup_completed_at ? `${label(p.login_method)} · signed up` : label(p.account_status))}</div>` : '—'}</td>
    <td>${p.listing_url ? `${link(p.listing_url, 'listing')}<div class="sub">${esc(label(p.submission_status))}${p.manual_submission ? ' · by you' : ''}</div>` : esc(p.submission_status ? label(p.submission_status) : '—')}</td>
    <td>${p.backlink_url ? `${link(p.backlink_url, 'page')}<div class="sub">${esc(label(p.backlink_status))}${p.is_dofollow === 1 ? ' · dofollow' : p.is_dofollow === 0 ? ` · ${esc(p.backlink_rel || 'nofollow')}` : ''}</div>` : '—'}</td>
    <td>${fmtTime(p.last_checked_at)}</td>
    <td><select class="row-action" aria-label="Actions for ${esc(p.name)}"><option value="">Actions</option>
      ${actionsFor(p).map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}</select></td></tr>`
}
function platformQuery() {
  const qs = new URLSearchParams()
  for (const [id, key] of [['#f-q', 'q'], ['#f-group', 'group'], ['#f-status', 'status'], ['#f-category', 'category'], ['#f-pricing', 'pricing']]) if ($(id).value) qs.set(key, $(id).value)
  return qs
}
loaders.platforms = async () => {
  if (!categoriesLoaded) {
    const cats = await api('/api/categories')
    const opts = cats.map(c => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')
    $('#f-category').insertAdjacentHTML('beforeend', opts)
    $('#add-category').insertAdjacentHTML('beforeend', opts)
    categoriesLoaded = true
    $('#f-category').value = pendingCategory
  }
  const qs = platformQuery()
  qs.set('limit', PAGE); qs.set('offset', page * PAGE)
  const { rows, total } = await api(`/api/platforms?${qs}`)
  const tbody = $('#platforms-table tbody')
  // Keep the row someone is working in (an open Actions menu) exactly as it is.
  const keep = editing(tbody)?.closest('tr')
  const pendingAdds = [...commands.values()].filter(c => c.method === 'POST' && c.path === '/api/platforms' && ['queued', 'sent'].includes(c.state))
  tbody.innerHTML = pendingAdds.map(c => `<tr class="pending-row"><td colspan="10">${esc(c.label)} — ${mirrorOnline ? 'pending' : 'pending, will apply when the agent is online'}</td></tr>`).join('') + rows.map(platformRow).join('')
  if (keep) { const fresh = tbody.querySelector(`tr[data-id="${keep.dataset.id}"]`); if (fresh) fresh.replaceWith(keep) }
  $('#platforms-empty').hidden = total > 0 || pendingAdds.length > 0
  $('#platforms-count').textContent = total ? `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${total}` : ''
  $('#pg-prev').disabled = page === 0
  $('#pg-next').disabled = (page + 1) * PAGE >= total
}
/** Reload only the rows an event touched; a row being edited is left alone. */
async function refreshRows(ids) {
  if (!ids.length) return
  const { rows } = await api(`/api/platforms?ids=${ids.join(',')}&limit=${ids.length}`)
  const tbody = $('#platforms-table tbody')
  const busy = editing(tbody)?.closest('tr')
  for (const p of rows) {
    const tr = tbody.querySelector(`tr[data-id="${p.id}"]`)
    if (!tr || tr === busy) continue
    const tmp = document.createElement('tbody')
    tmp.innerHTML = platformRow(p)
    tmp.firstElementChild.classList.add('flash')
    tr.replaceWith(tmp.firstElementChild)
  }
}
$('#pg-prev').addEventListener('click', () => { page = Math.max(0, page - 1); run(loaders.platforms)() })
$('#pg-next').addEventListener('click', () => { page++; run(loaders.platforms)() })
let searchTimer
$('#f-q').addEventListener('input', () => { clearTimeout(searchTimer); page = 0; searchTimer = setTimeout(run(loaders.platforms), 250) })
for (const id of ['#f-group', '#f-status', '#f-category', '#f-pricing']) $(id).addEventListener('change', () => { page = 0; run(loaders.platforms)() })

async function platformAction(id, action, button, name = 'this platform') {
  const done = msg => async () => { toast(msg, 'ok'); scheduleRefresh(Number(id)) }
  if (action === 'delete') {
    if (!confirm(`Delete ${name}? This removes its record for good.`)) return
    return act(button, `/api/platforms/${id}`, { method: 'DELETE' }, done('Deleted'))
  }
  if (action === 'rejected' || action === 'paid_skipped') {
    const note = prompt(`${action === 'rejected' ? 'Reject' : 'Skip as paid'} ${name}? Any queued work for it stops. Reason (optional):`)
    if (note === null) return
    return act(button, `/api/platforms/${id}`, { method: 'PATCH', body: { status: action, note: note || undefined } }, done(`${name}: ${label(action)}`))
  }
  if (action === 'discovered') return act(button, `/api/platforms/${id}`, { method: 'PATCH', body: { status: 'discovered' } }, done(`${name}: back to discovered`))
  if (action === 'manual' || action === 'listing-url') return openManual(id, name, action === 'listing-url')
  if (action === 'needs-you') {
    const note = prompt(`Hand ${name} to you? The agent stops working on it. What should you do? (optional)`)
    if (note === null) return
    return act(button, `/api/platforms/${id}/needs-you`, { method: 'POST', body: { note: note || undefined } }, done(`${name}: now on your Needs-you list`))
  }
  if (action === 'check-backlink') return act(button, `/api/platforms/${id}/check-backlink`, { method: 'POST' }, async r => { toast(`Backlink: ${label(r.status)}${r.present ? ` (${r.dofollow ? 'dofollow' : r.rel || 'nofollow'})` : ''}`, 'ok'); scheduleRefresh(Number(id)) })
  const msg = { qualify: 'Queued for evaluation', retry: 'Retry queued', resume: 'Handed back to the agent' }[action]
  return act(button, `/api/platforms/${id}/${action}`, { method: 'POST' }, done(`${name}: ${msg}`))
}
$('#platforms-table').addEventListener('change', run(async e => {
  if (!e.target.classList.contains('row-action') || !e.target.value) return
  const sel = e.target
  const tr = sel.closest('tr')
  const action = sel.value
  sel.value = ''
  sel.blur()
  await platformAction(tr.dataset.id, action, sel, tr.querySelector('strong')?.textContent)
}))

// Mark as done manually / Set listing URL: one dialog, for every platform.
let manualFor = null
function openManual(id, name, urlOnly) {
  manualFor = { id, name, urlOnly }
  const f = $('#manual-form')
  f.reset()
  $('#manual-title').textContent = urlOnly ? `Set the listing URL of ${name}` : `Mark ${name} as done manually`
  for (const n of ['backlinkUrl', 'accountEmail', 'loginMethod', 'notes']) f.elements[n].closest('label').hidden = urlOnly
  f.elements.listingUrl.required = urlOnly
  $('#manual-dialog').showModal()
  f.elements.listingUrl.focus()
}
$('#manual-dialog').addEventListener('close', run(async () => {
  if ($('#manual-dialog').returnValue !== 'save' || !manualFor) return
  const f = $('#manual-form')
  const body = Object.fromEntries([...new FormData(f)].filter(([, v]) => v))
  const { id, name, urlOnly } = manualFor
  manualFor = null
  const path = urlOnly ? `/api/platforms/${id}/listing-url` : `/api/platforms/${id}/manual-complete`
  await act(null, path, { method: 'POST', body: urlOnly ? { url: body.listingUrl } : body }, async r => { toast(`${name}: ${r.message || 'saved'}`, 'ok'); scheduleRefresh(Number(id)) })
}))

$('#btn-add').addEventListener('click', () => { $('#add-form').hidden = false; $('#add-form [name=name]').focus() })
$('#add-cancel').addEventListener('click', () => { $('#add-form').hidden = true })
$('#add-form').addEventListener('submit', run(async e => {
  e.preventDefault()
  const f = new FormData(e.target)
  const button = e.target.querySelector('[type=submit]')
  try {
    const r = await api('/api/platforms', { method: 'POST', body: Object.fromEntries(f), button })
    if (!r?.queued) toast('Platform added', 'ok')
    e.target.reset(); e.target.hidden = true
  } catch (err) {
    if (err.status === 409) toast(err.data?.reason || 'Already tracked', true); else throw err
  }
  await loaders.platforms()
}))
$('#btn-discover').addEventListener('click', e => act(e.currentTarget, '/api/discovery/run', { method: 'POST' },
  r => toast(r.queued ? 'Discovery queued; it runs while the agent is started' : 'A discovery run is already queued', 'ok')))
$('#btn-seeds').addEventListener('click', e => act(e.currentTarget, '/api/platforms/import-seeds', { method: 'POST' },
  async r => { toast(`Seed list: ${r.added} added, ${r.total - r.added} already tracked`, 'ok'); await loaders.platforms() }))

// ---------- needs you ----------
function needsYouItem(t) {
  return `<div class="list-item" data-platform="${t.platform_id}" data-name="${esc(t.name)}" data-where="${esc(t.where || '')}"><div class="reason"><strong>${esc(t.name)}</strong>
      <div class="small"><b>What happened:</b> ${esc(t.reason)}</div>
      <div class="small"><b>What to do:</b> ${esc(t.todo)}</div>
      ${t.where ? `<div class="small">Where: ${link(t.where)}${hosted ? '' : ' <button class="btn small" data-open-here>Open it in the agent\'s Chrome</button>'}</div>` : ''}
      <div class="muted small"><span class="platform-link" data-drawer="${t.platform_id}">details</span> · Stopped ${ago(t.status_changed_at)}${t.resumesAt ? ` · Resume continues at: ${esc(t.resumesAt)}` : ''}</div>
      ${t.error_history?.length ? `<details><summary class="small">Error history (${t.error_history.length})</summary><ol class="history">${t.error_history.map(h => `<li>${fmtTime(h.at)} · attempt ${h.attempt ?? '?'}${h.step ? ` · ${esc(h.step)}` : ''}: ${esc(h.error)}</li>`).join('')}</ol></details>` : ''}</div>
    <div class="row"><button class="btn primary" data-act="resume">Resume</button><button class="btn" data-act="manual">Mark as done…</button><button class="btn danger-ghost" data-act="rejected">Reject…</button></div></div>`
}
loaders.queue = async ({ soft = false } = {}) => {
  const [approvals, items, pipeline] = await Promise.all([api('/api/approvals'), api('/api/needs-you'), api('/api/pipeline')])
  $('#browser-queue').innerHTML = pipeline.length
    ? pipeline.map(t => `<div class="list-item"><div><strong>${esc(t.name)}</strong> <span class="pill info">${esc(t.step)}</span>${t.auto_approved ? ' <span class="pill">auto-approved</span>' : ''}
        <div class="muted small">approved ${fmtTime(t.approved_at)}${t.task_state ? ` · task ${esc(label(t.task_state).toLowerCase())}` : ''}${t.run_after ? ` · next try ${fmtTime(t.run_after)}` : ''}</div></div></div>`).join('')
    : '<p class="muted">None waiting.</p>'
  // Approval forms someone is editing stay as they are.
  const busy = editing($('#approvals'))?.closest('[data-approval]')
  $('#approvals').innerHTML = approvals.length ? approvals.map(approvalCard).join('') : '<p class="muted">Nothing waiting for your approval.</p>'
  if (busy) { const fresh = $(`[data-approval="${busy.dataset.approval}"]`); if (fresh) fresh.replaceWith(busy) }
  $('#needs-you').innerHTML = items.length ? items.map(needsYouItem).join('') : '<p class="muted">Nothing is waiting for you.</p>'
}
function approvalCard(a) {
  const l = a.listing || {}
  const s = a.payload?.score || {}
  const field = (k, text, long) => `<label>${text}${long ? `<textarea name="${k}" rows="${k === 'long_description' ? 7 : 2}">${esc(l[k])}</textarea>` : `<input name="${k}" value="${esc(l[k])}">`}</label>`
  return `<form class="approval" data-approval="${a.id}">
    <div class="meta"><strong>${esc(a.name)}</strong>${link(a.url, a.domain)}
      <span class="pill">${esc(label(a.pricing))}</span>${s.overall != null ? `<span class="pill info">score ${s.overall}</span>` : ''}${s.seo_value ? `<span class="pill">SEO ${esc(s.seo_value)}</span>` : ''}</div>
    <div class="scores">${['relevance', 'domain_reputation', 'audience_quality', 'credibility', 'backlink_quality'].map(k => `<span>${esc(label(k))} <b>${s[k] ?? '—'}</b></span>`).join('')}</div>
    <div class="muted small">${esc(a.registration_requirements || '')}${a.submission_requirements ? ` · asks for: ${esc(a.submission_requirements)}` : ''}${a.pricing_notes ? ` · ${esc(a.pricing_notes)}` : ''}</div>
    ${a.payload?.autoApprovalSkipped ? `<div class="muted small">Not auto-approved: ${esc(a.payload.autoApprovalSkipped)}</div>` : ''}
    <div class="muted small">Submits at: ${a.submission_url ? link(a.submission_url) : 'found by the agent'} · links to ${esc(SITE_URL)} with anchor text "${esc(l.anchor_text)}"</div>
    ${field('title', 'Title')}${field('tagline', 'Tagline')}${field('short_description', 'Short description', true)}${field('long_description', 'Description', true)}
    <label>Tags (comma separated)<input name="tags" value="${esc((l.tags || []).join(', '))}"></label>${field('anchor_text', 'Anchor text')}
    <div class="row"><button class="btn primary" data-decision="approve">Approve and submit</button><button class="btn" data-decision="skip">Skip platform</button><button class="btn danger-ghost" data-decision="reject">Reject</button></div>
  </form>`
}
$('#approvals').addEventListener('click', run(async e => {
  const btn = e.target.closest('[data-decision]')
  if (!btn) return
  e.preventDefault()
  const form = btn.closest('[data-approval]')
  const decision = btn.dataset.decision
  let body
  if (decision === 'approve') body = { listing: Object.fromEntries(new FormData(form)) }
  else {
    const note = prompt(`${decision === 'skip' ? 'Skip' : 'Reject'} this platform? The agent will not register or submit there. Reason (optional):`)
    if (note === null) return
    body = { note: note || undefined }
  }
  await act(btn, `/api/approvals/${form.dataset.approval}/${decision}`, { method: 'POST', body }, async () => {
    toast(decision === 'approve' ? 'Approved: registration and submission queued' : `Platform ${decision === 'skip' ? 'skipped' : 'rejected'}`, 'ok')
    await loaders.queue(); refreshStatus()
  })
}))
$('#needs-you').addEventListener('click', run(async e => {
  const item = e.target.closest('[data-platform]')
  if (!item) return
  if (e.target.matches('[data-open-here]')) return act(e.target, '/api/chrome/open', { method: 'POST', body: { url: item.dataset.where } }, () => toast('Opened in the agent\'s Chrome', 'ok'))
  const a = e.target.closest('[data-act]')?.dataset.act
  if (a) await platformAction(item.dataset.platform, a, e.target, item.dataset.name)
}))


// ---------- growth: ICP & leads (research and tracking only; no sending) ----------
const GTM_KPIS = [['icpCount', 'ICP categories'], ['researched', 'Companies researched'], ['qualified', 'Qualified leads (High/Med)'],
  ['verifiedEmails', 'Published personal emails'], ['genericEmails', 'Published generic emails'], ['noContact', 'No contact found'],
  ['highPriority', 'High priority'], ['outreachReady', 'Outreach ready'], ['sent', 'Emails sent'], ['replied', 'Replies'],
  ['interested', 'Interested'], ['demos', 'Demo requests'], ['signups', 'Sign-ups'], ['converted', 'Converted users']]
let gtmLeads = [], gtmStatuses = []
const gtmBars = (el, obj, field) => { el.innerHTML = Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div class="small gtm-bar" role="link" tabindex="0" data-field="${field}" data-value="${esc(k)}" style="cursor:pointer"><strong>${esc(k)}</strong>: ${n} <span class="muted">→ view</span></div>`).join('') || '<p class="muted small">No leads yet</p>' }
// Each Growth tile opens the matching leads (same rules as the counts in src/gtm/service.js).
const GTM_REACHED = { sent: ['sent', 'replied', 'interested', 'demo_requested', 'signed_up', 'converted', 'not_interested'],
  replied: ['replied', 'interested', 'demo_requested', 'signed_up', 'converted', 'not_interested'],
  interested: ['interested', 'demo_requested', 'signed_up', 'converted'], demo_requested: ['demo_requested'],
  signed_up: ['signed_up', 'converted'], converted: ['converted'] }
const GTM_FILTERS = {
  researched: () => true, qualified: l => l.priority === 'High' || l.priority === 'Medium',
  verifiedEmails: l => l.email_status === 'published-personal', genericEmails: l => l.email_status === 'generic-published',
  noContact: l => !l.email, highPriority: l => l.priority === 'High', outreachReady: l => l.status === 'outreach_ready',
  sent: l => GTM_REACHED.sent.includes(l.status), replied: l => GTM_REACHED.replied.includes(l.status),
  interested: l => GTM_REACHED.interested.includes(l.status), demos: l => GTM_REACHED.demo_requested.includes(l.status),
  signups: l => GTM_REACHED.signed_up.includes(l.status), converted: l => GTM_REACHED.converted.includes(l.status) }
let gtmFilter = null
function setGtmFilter(key) {
  gtmFilter = key
  if (key === 'icpCount') { gtmFilter = null; renderGtmLeads(); return $('#gtm-icps').closest('.card').scrollIntoView({ behavior: 'smooth' }) }
  renderGtmLeads(); $('#gtm-leads').closest('.card').scrollIntoView({ behavior: 'smooth' })
}
function renderGtmLeads() {
  const q = $('#gtm-q').value.toLowerCase(), seg = $('#gtm-fseg').value, pri = $('#gtm-fpri').value
  const f = gtmFilter && GTM_FILTERS[gtmFilter]
  const rows = gtmLeads.filter(l => (!f || f(l)) && (!seg || l.segment === seg) && (!pri || l.priority === pri) && (!q || JSON.stringify(l).toLowerCase().includes(q)))
  $('#gtm-lead-n').textContent = rows.length
  const label = gtmFilter && GTM_KPIS.find(([k]) => k === gtmFilter)?.[1]
  $('#gtm-filter').innerHTML = label ? `Showing: <strong>${esc(label)}</strong> (${rows.length}) · <a href="#growth" id="gtm-clear">Show all</a>` : ''
  $('#gtm-leads').innerHTML = rows.map(l => `<tr>
    <td><a href="${esc(l.website)}" target="_blank" rel="noopener">${esc(l.name)}</a><div class="muted small">${esc(l.industry)} · ${esc(l.size_stage)}</div></td>
    <td class="small">${esc(l.icp)}<div class="muted">Seg ${esc(l.segment)}</div></td>
    <td class="small">${esc(l.docs_status)}<div class="muted">${esc(l.dev_surface)}</div></td>
    <td class="small">${esc(l.contact_name || '—')}<div class="muted">${esc(l.contact_title || '')}</div>${l.email ? `<div>${esc(l.email)} <span class="pill ${l.email_status === 'published-personal' ? 'ok' : 'info'}">${esc(l.email_status)}</span></div>` : '<div class="muted">no published email</div>'}${l.profile_url ? `<a href="${esc(l.profile_url)}" target="_blank" rel="noopener">profile</a>` : ''}</td>
    <td class="small">${esc(l.outreach_angle)}<div class="muted">Pain: ${esc(l.pain_points)}</div></td>
    <td><span class="pill ${l.priority === 'High' ? 'ok' : l.priority === 'Medium' ? 'info' : ''}">${esc(l.priority)}</span></td>
    <td><select data-gtm-key="${esc(l.key)}">${gtmStatuses.map(([k, lab]) => `<option value="${k}" ${k === l.status ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>${l.notes ? `<div class="muted small">${esc(l.notes.replace(/(\d{4}-\d\d-\d\dT[\d:.]+Z)/, m => new Date(m).toLocaleString()))}</div>` : ''}</td></tr>`).join('')
  if (!rows.length) $('#gtm-leads').innerHTML = '<tr><td colspan="7" class="muted">No leads in this list yet.</td></tr>'
}
loaders.growth = async () => {
  const [s, icps, ld, ch] = await Promise.all([api('/api/gtm/summary'), api('/api/gtm/icps'), api('/api/gtm/leads'), api('/api/gtm/channels')])
  $('#gtm-kpis').innerHTML = GTM_KPIS.map(([k, l]) => `<div class="kpi link" data-gtm-filter="${k}" role="link" tabindex="0" title="View the list"><div class="label">${l}</div><div class="value">${s[k] ?? 0}</div></div>`).join('')
  gtmBars($('#gtm-seg'), s.bySegment, 'segment'); gtmBars($('#gtm-pri'), s.byPriority, 'priority')
  $('#gtm-icp-n').textContent = icps.length
  $('#gtm-icps').innerHTML = icps.map(i => `<tr><td>${i.tier}</td><td><strong>${esc(i.name)}</strong><div class="muted small">${esc(i.who)}</div></td><td>${esc(i.segment)}</td><td class="small">${esc(i.pain)}</td><td class="small">${esc(i.docstar_fit)}</td><td class="small">${esc(i.buyer)}</td></tr>`).join('')
  gtmLeads = ld.leads; gtmStatuses = ld.statuses; renderGtmLeads()
  // The Outreach page exists only where sending is set up (the local copy); hidden elsewhere.
  try { const o = await fetch('/api/outreach', { credentials: 'same-origin' }); $('#gtm-outreach-bar').hidden = !o.ok; $('#gtm-find-card').hidden = !o.ok } catch { $('#gtm-outreach-bar').hidden = true; $('#gtm-find-card').hidden = true }
  if ($('#gtm-find-icp').options.length === 1) $('#gtm-find-icp').insertAdjacentHTML('beforeend', icps.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join(''))
  gtmFindPoll()
  $('#gtm-channels').innerHTML = ch.map(c => `<tr><td><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a></td><td>${esc(c.type)}</td><td class="small">${esc(c.why_relevant)}</td><td class="small">${esc(c.how_to_engage)}</td><td>${esc(c.effort)}</td></tr>`).join('')
}
// Local only: the ICP company search runs on the server; this shows its progress.
let gtmFindTimer = null, gtmFindWaitUntil = 0 // on the hosted copy a click reaches the Mac a few seconds later
async function gtmFindPoll() {
  clearTimeout(gtmFindTimer)
  let j; try { const r = await fetch('/api/outreach/find', { credentials: 'same-origin' }); if (!r.ok) return; j = await r.json() } catch { return }
  $('#gtm-find-log').innerHTML = j.log.map(m => `<li>${esc(m)}</li>`).join('')
  $('#gtm-find-btn').disabled = j.running; $('#gtm-find-btn').textContent = j.running ? (j.current ? `Checking ${j.current}…` : 'Searching…') : 'Find companies & prepare emails'
  $('#gtm-find-stop').hidden = !j.running; $('#gtm-find-stop').disabled = Boolean(j.stop); $('#gtm-find-stop').textContent = j.stop ? 'Stopping…' : 'Stop'
  if (j.running || Date.now() < gtmFindWaitUntil) gtmFindTimer = setTimeout(gtmFindPoll, 3000)
  if (j.running) gtmFindWaitUntil = 0
}
$('#gtm-find-btn').addEventListener('click', async () => {
  try { const r = await api('/api/outreach/find', { method: 'POST', body: { icp: $('#gtm-find-icp').value || null, max: 10 } }); if (r?.queued) { gtmFindWaitUntil = Date.now() + 60_000; $('#gtm-find-btn').disabled = true; $('#gtm-find-btn').textContent = 'Sent to the Mac…' } } catch (e) { alert(e.message) }
  gtmFindPoll()
})
$('#gtm-find-stop').addEventListener('click', async () => {
  try { const r = await api('/api/outreach/find/stop', { method: 'POST', body: {} }); if (r?.queued) { gtmFindWaitUntil = Date.now() + 30_000; $('#gtm-find-stop').disabled = true; $('#gtm-find-stop').textContent = 'Stopping…' } } catch (e) { alert(e.message) }
  gtmFindPoll()
})
for (const id of ['#gtm-q', '#gtm-fseg', '#gtm-fpri']) $(id).addEventListener('input', renderGtmLeads)
const gtmActivate = e => {
  const k = e.target.closest('[data-gtm-filter]'); if (k) return setGtmFilter(k.dataset.gtmFilter)
  const b = e.target.closest('.gtm-bar'); if (!b) return
  gtmFilter = null; $(b.dataset.field === 'segment' ? '#gtm-fseg' : '#gtm-fpri').value = b.dataset.value; setGtmFilter(null)
}
for (const id of ['#gtm-kpis', '#gtm-seg', '#gtm-pri']) {
  $(id).addEventListener('click', gtmActivate)
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') gtmActivate(e) })
}
$('#gtm-filter').addEventListener('click', e => { if (e.target.id !== 'gtm-clear') return; e.preventDefault(); gtmFilter = null; $('#gtm-fseg').value = ''; $('#gtm-fpri').value = ''; renderGtmLeads() })
$('#gtm-leads').addEventListener('change', run(async e => {
  const key = e.target.dataset.gtmKey; if (!key) return
  await api(`/api/gtm/leads/${encodeURIComponent(key)}`, { method: 'PATCH', body: { status: e.target.value } })
  toast('Lead status saved', 'ok'); await loaders.growth()
}))
$('#gtm-import').addEventListener('click', run(async e => { const r = await api('/api/gtm/import', { method: 'POST', button: e.currentTarget }); toast(`${r.added} new lead(s), ${r.total} total`, 'ok'); await loaders.growth() }))
document.addEventListener('click', run(async e => {
  const b = e.target.closest('[data-gtm-doc]'); if (!b) return
  const r = await fetch(`/api/gtm/doc/${b.dataset.gtmDoc}`, { credentials: 'same-origin' })
  $('#gtm-doc').textContent = r.ok ? await r.text() : 'Could not load'
}))

// ---------- successfully added ----------
const timeline = t => `<div class="timeline">${t.map(m => `<span class="${m.at ? 'done' : 'todo'}" title="${esc(m.at ? fmtTime(m.at) : 'not yet')}">${m.at ? '✓' : '○'} ${esc(m.name)}${m.at ? ` ${fmtDate(m.at)}` : ''}</span>`).join('')}</div>`
const who = r => `${r.account_email ? esc(r.account_email) : '—'}${r.login_method ? `<div class="sub">${esc(label(r.login_method))}</div>` : ''}${r.manual ? '<div class="sub">recorded by a person</div>' : ''}`
loaders.added = async () => {
  const a = await api('/api/added')
  const name = r => `<strong class="platform-link" data-drawer="${r.platform_id}">${esc(r.name)}</strong><div class="sub">${esc(r.domain)}</div>${timeline(r.timeline)}`
  $('#added-live-n').textContent = a.live.length
  $('#added-pub-n').textContent = a.published.length
  $('#added-wait-n').textContent = a.awaiting.length
  $('#added-live').innerHTML = a.live.map(r => `<tr><td>${name(r)}</td><td>${link(r.listing_url, 'listing')}</td><td>${link(r.backlink_page, 'page')}</td>
    <td><span class="pill ${r.is_dofollow ? 'ok' : ''}">${esc(r.is_dofollow ? 'dofollow' : r.rel || 'nofollow')}</span>${r.link_count > 1 ? `<div class="sub">${r.link_count} links</div>` : ''}</td>
    <td>${esc(r.anchor_text || '—')}</td><td>${fmtDate(r.first_seen_at)}</td><td>${fmtTime(r.last_checked_at)}</td><td>${who(r)}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No live backlinks yet.</td></tr>'
  $('#added-pub').innerHTML = a.published.map(r => `<tr><td>${name(r)}</td><td>${link(r.listing_url, 'listing')}</td><td>${esc(r.found)}</td><td>${fmtTime(r.last_checked_at)}</td><td>${who(r)}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">None.</td></tr>'
  $('#added-wait').innerHTML = a.awaiting.map(r => `<tr><td>${name(r)}</td><td>${fmtDate(r.submitted_at)}</td><td>${r.waitingDays == null ? '—' : `${r.waitingDays} day${r.waitingDays === 1 ? '' : 's'}`}</td><td>${who(r)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">None.</td></tr>'
}

// ---------- health ----------
loaders.health = async () => {
  const days = $('#f-days').value
  const [m, s] = await Promise.all([api(`/api/metrics?days=${days}`), api(`/api/summary?days=7`)])
  const dur = mins => (mins == null ? '—' : mins < 60 ? `${mins} min` : mins < 2880 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`)
  $('#stages').innerHTML = m.stages.map(r => `<tr><td>${esc(r.stage)}</td><td>${r.entered}</td><td>${r.succeeded}</td><td>${r.failed}</td><td>${r.inProgress}</td>
    <td>${r.successRate == null ? '—' : `<span class="pill ${r.successRate >= 70 ? 'ok' : r.successRate >= 40 ? 'warn' : 'err'}">${r.successRate}%</span>`}</td><td>${dur(r.avgMinutes)}</td></tr>`).join('')
  $('#reasons').innerHTML = m.failureReasons.map(r => `<li>${esc(r.reason)} <b>× ${r.count}</b></li>`).join('') || '<li class="muted">No failures.</li>'
  $('#tph').textContent = `${m.tasksPerHour} tasks per hour over the last 24 hours`
  $('#summary').textContent = s.text
  $('#summary-freq').textContent = s.frequency === 'off' ? 'not sent' : `sent ${s.frequency}`
  const a = s.alerts || {}
  $('#alerts-config').textContent = a.slack || a.email ? `Alerts and summaries go to ${[a.slack && 'Slack', a.email && `email (${a.to})`].filter(Boolean).join(' and ')}.`
    : 'No alert channel set: alerts appear in the activity log only. Set ALERT_SLACK_WEBHOOK and/or ALERT_EMAIL_WEBHOOK (see README).'
}
$('#f-days').addEventListener('change', run(loaders.health))

// ---------- failed ----------
loaders.failed = async () => {
  const rows = await api('/api/failed')
  $('#failed-list').innerHTML = rows.length ? rows.map(f => `<div class="list-item" ${f.platform_id ? `data-platform="${f.platform_id}" data-name="${esc(f.name)}"` : ''}><div class="reason">
      <strong>${esc(f.name)}</strong> <span class="pill err">${esc(label(f.status || 'failed'))}</span>${f.status_reason ? ` <span class="pill">${esc(label(f.status_reason))}</span>` : ''}
      <div class="small"><b>Error:</b> ${esc(f.error)}</div>
      <div class="muted small">${f.task_type ? `Step: ${esc(label(f.task_type))}${f.step ? ` · ${esc(f.step)}` : ''} · ` : ''}${fmtTime(f.at)} · ${f.attempts ?? 0} attempt(s)</div>
      ${f.error_history?.length ? `<details><summary class="small">Error history (${f.error_history.length})</summary><ol class="history">${f.error_history.map(h => `<li>${fmtTime(h.at)} · attempt ${h.attempt ?? '?'}: ${esc(h.error)}</li>`).join('')}</ol></details>` : ''}</div>
      ${f.platform_id ? '<div class="row"><button class="btn primary" data-act="retry">Retry</button><button class="btn" data-act="needs-you">Mark needs you…</button><button class="btn danger-ghost" data-act="rejected">Reject…</button></div>' : ''}</div>`).join('')
    : '<p class="muted">Nothing has failed.</p>'
}
$('#failed-list').addEventListener('click', run(async e => {
  const item = e.target.closest('[data-platform]')
  const a = e.target.closest('[data-act]')?.dataset.act
  if (item && a) await platformAction(item.dataset.platform, a, e.target, item.dataset.name)
}))

// ---------- DocStar profile ----------
loaders.company = async () => {
  const c = await api('/api/company')
  const long = new Set(['short_description', 'medium_description', 'long_description', 'features', 'social_links', 'audience', 'screenshots', 'categories', 'tags'])
  $('#company-form').innerHTML = c.fields.map(([k, text]) => {
    const v = c.values[k] || {}
    return `<label>${esc(text)} ${v.approved ? '<span class="ok">✓ approved</span>' : ''}${long.has(k)
      ? `<textarea name="${k}" rows="${k === 'long_description' ? 7 : 3}">${esc(v.value)}</textarea>` : `<input name="${k}" value="${esc(v.value)}">`}</label>`
  }).join('') || `<p class="muted">No profile yet: press "Re-draft from ${SITE_HOST}".</p>`
  const pill = $('#company-pill')
  pill.textContent = c.approved ? 'Approved' : Object.keys(c.values).length ? 'Needs your approval' : 'Not drafted'
  pill.className = `pill ${c.approved ? 'ok' : 'warn'}`
}
const companyChanges = () => {
  const out = {}
  for (const el of $('#company-form').elements) if (el.name && el.value !== el.defaultValue) out[el.name] = el.value
  return out
}
$('#company-save').addEventListener('click', e => {
  const changes = companyChanges()
  if (!Object.keys(changes).length) return toast('No changes')
  act(e.currentTarget, '/api/company', { method: 'PUT', body: changes }, () => { toast('Saved; approve the profile again', 'ok'); loaders.company(); refreshStatus() })
})
$('#company-approve').addEventListener('click', run(async e => {
  const b = e.currentTarget
  const changes = companyChanges()
  if (Object.keys(changes).length) { const r = await api('/api/company', { method: 'PUT', body: changes, button: b }); if (r?.queued) return }
  await act(b, '/api/company/approve', { method: 'POST' }, r => { toast(`Profile approved (${r.approved} fields)`, 'ok'); loaders.company(); refreshStatus() })
}))
$('#company-draft').addEventListener('click', e => {
  if (!confirm(`Re-draft unapproved fields from ${SITE_HOST}? Approved fields are kept.`)) return
  toast(`Reading ${SITE_HOST}…`)
  act(e.currentTarget, '/api/company/draft', { method: 'POST' }, () => { toast('Draft ready', 'ok'); loaders.company() })
})

// ---------- activity ----------
function feedItem(e) {
  return `<li data-id="${e.id ?? ''}"><span class="ts">${fmtTime(e.ts)}</span><span class="lvl ${esc(e.level)}" title="${esc(e.level)}"></span><span>${esc(e.message)}<span class="ev">${esc(e.event)}</span>${e.platformId ? ` <span class="platform-link small" data-drawer="${e.platformId}">details</span>` : ''}</span></li>`
}
function renderFeed(el, entries) { el.innerHTML = entries.length ? entries.map(feedItem).join('') : '<li class="muted">No activity yet.</li>' }
// Grouped by run: a task's step-by-step entries collapse under one line (its first entry), newest run first.
function groupRuns(entries) {
  const out = []
  const byRun = new Map()
  for (const e of entries) {
    if (!e.correlationId) { out.push({ single: e }); continue }
    let g = byRun.get(e.correlationId)
    if (!g) { g = { run: e.correlationId, items: [] }; byRun.set(e.correlationId, g); out.push(g) }
    g.items.push(e)
  }
  return out
}
function renderGroup(g) {
  if (g.single) return feedItem(g.single)
  const head = g.items[0]
  const worst = g.items.some(i => i.level === 'error') ? 'error' : g.items.some(i => i.level === 'warn') ? 'warn' : head.level
  return `<li class="run" data-run="${esc(g.run)}"><details><summary><span class="ts">${fmtTime(head.ts)}</span><span class="lvl ${esc(worst)}"></span>
    <span><b>${esc(head.platform || 'Run')}</b> · ${g.items.length} step(s) · ${esc(head.message)}</span></summary><ol>${g.items.map(feedItem).join('')}</ol></details></li>`
}
let activityOldest = null
let platformNamesLoaded = false
function activityQuery() {
  const qs = new URLSearchParams({ limit: 100 })
  if ($('#f-level').value) qs.set('level', $('#f-level').value)
  if ($('#f-aplatform').value) qs.set('platform', $('#f-aplatform').value)
  if ($('#f-aq').value.trim()) qs.set('q', $('#f-aq').value.trim())
  return qs
}
loaders.activity = async ({ more = false } = {}) => {
  if (!platformNamesLoaded) {
    $('#f-aplatform').insertAdjacentHTML('beforeend', (await api('/api/platform-names')).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join(''))
    platformNamesLoaded = true
  }
  if (pendingActivityPlatform) { $('#f-aplatform').value = pendingActivityPlatform; pendingActivityPlatform = null }
  const qs = activityQuery()
  if (more && activityOldest) qs.set('before', activityOldest)
  const rows = await api(`/api/activity?${qs}`)
  if (rows.length) activityOldest = rows.at(-1).id
  $('#activity-more').hidden = rows.length < 100
  const html = $('#f-group-runs').checked ? groupRuns(rows).map(renderGroup).join('') : rows.map(feedItem).join('')
  if (more) $('#activity').insertAdjacentHTML('beforeend', html)
  else $('#activity').innerHTML = html || '<li class="muted">No activity matches.</li>'
}
for (const id of ['#f-level', '#f-aplatform', '#f-group-runs']) $(id).addEventListener('change', () => { activityOldest = null; run(loaders.activity)() })
let aqTimer
$('#f-aq').addEventListener('input', () => { clearTimeout(aqTimer); aqTimer = setTimeout(() => { activityOldest = null; run(loaders.activity)() }, 300) })
$('#activity-more').addEventListener('click', run(() => loaders.activity({ more: true })))

// ---------- platform drawer: everything about one platform ----------
async function openDrawer(id) {
  const p = await api(`/api/platforms/${id}`)
  $('#drawer-title').textContent = p.name
  const kv = rows => `<dl class="details">${rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
  const ny = p.needsYou
  const l = p.listing || {}
  $('#drawer-body').innerHTML = `
    <section>${kv([['Status', `<span class="pill ${STATUS_TONE[p.status] ?? ''}">${esc(label(p.status))}</span>${p.status_reason ? ` · ${esc(label(p.status_reason))}` : ''}`],
      ['Site', link(p.url, p.domain)], ['Found by', esc(p.source)], ['Score', p.quality_score ?? '—'], ['Pricing', esc(label(p.pricing))], ['Category', esc(p.category_name || '—')],
      ['Resumes at', p.resume_status ? esc(label(p.resume_status)) : null], ['Notes', p.notes ? esc(p.notes) : null]])}
      ${ny ? `<div class="banner warn"><b>Needs you:</b> ${esc(ny.what)}<br>${esc(ny.todo || '')}</div>` : ''}
      ${p.contradictions?.length ? `<div class="banner warn">Inconsistent: ${esc(p.contradictions.join('; '))}</div>` : ''}
      <div class="row">${actionsFor(p).filter(([a]) => !['delete'].includes(a)).map(([a, t]) => `<button class="btn small" data-act="${a}">${esc(t.replace('…', ''))}</button>`).join('')}</div></section>
    <section><h3>Timeline</h3><ol class="tl">${p.timeline.map(t => `<li>${fmtTime(t.at)} · <b>${esc(label(t.to_status))}</b>${t.from_status ? ` <span class="muted">from ${esc(label(t.from_status))}</span>` : ''} <span class="muted">(${esc(t.actor)})</span>${t.reason ? `<div class="muted small">${esc(t.reason)}</div>` : ''}</li>`).join('') || '<li class="muted">No history.</li>'}</ol></section>
    <section><h3>Account</h3>${p.account ? kv([['Email', esc(p.account.email)], ['Signed up with', esc(label(p.account.login_method))], ['Status', esc(label(p.account.status))],
      ['Sign-up finished', p.account.signup_completed_at ? `${fmtTime(p.account.signup_completed_at)}${p.account.signup_inferred ? ' (inferred)' : ''}` : 'not yet'], ['Started', fmtTime(p.account.created_at)]]) : '<p class="muted">No account.</p>'}</section>
    <section><h3>Listing submitted</h3>${p.listing ? kv([['Title', esc(l.title)], ['Tagline', esc(l.tagline)], ['Short description', esc(l.short_description)], ['Tags', esc((l.tags || []).join(', '))],
      ['Anchor text', esc(l.anchor_text)], ['Submission status', esc(label(p.submission_status))], ['Listing', link(p.listing_url)], ['Added by', p.manual_submission ? 'a person' : 'the agent']]) : '<p class="muted">No listing drafted.</p>'}</section>
    <section><h3>Backlink checks</h3>${p.backlinkHistory.length ? `<ol class="history">${p.backlinkHistory.map(h => `<li>${fmtTime(h.checked_at)} · HTTP ${h.http_status ?? '—'} · ${h.link_present ? `link ${esc(h.rel || 'dofollow')}${h.anchor_text ? ` "${esc(h.anchor_text)}"` : ''}` : 'no link'}${h.indexable === 0 ? ' · noindex' : ''}${h.note ? ` · ${esc(h.note)}` : ''}</li>`).join('')}</ol>` : '<p class="muted">Not checked yet.</p>'}</section>
    <section><h3>Emails used</h3>${p.emails.length ? `<ol class="history">${p.emails.map(e => `<li>${fmtTime(e.received_at)} · ${esc(e.sender)} · "${esc(e.subject)}" · ${esc(e.purpose)}</li>`).join('')}</ol>` : '<p class="muted">None.</p>'}</section>
    <section><h3>Screenshots of key steps</h3>${p.screenshots.length ? `<div class="shots">${p.screenshots.map(s => `<a href="/api/screenshots/${s.id}" target="_blank" rel="noopener"><img src="/api/screenshots/${s.id}" alt="${esc(s.step)}" loading="lazy"></a><div class="muted small">${esc(s.step)} · ${fmtTime(s.at)}${s.note ? ` · ${esc(s.note)}` : ''}</div>`).join('')}</div>` : '<p class="muted">None.</p>'}</section>
    <section><h3>Tasks</h3><ol class="history">${p.tasks.map(t => `<li>#${t.id} ${esc(label(t.type))} · ${esc(label(t.state))} · ${t.attempts} attempt(s)${t.step ? ` · ${esc(t.step)}` : ''}${t.last_error ? `<div class="small">${esc(t.last_error)}</div>` : ''}</li>`).join('') || '<li class="muted">None.</li>'}</ol></section>
    ${p.playbook ? `<section><h3>What works here (playbook)</h3>${kv([['Sign-in', esc(p.playbook.signinMethod || '—')], ['Form', link(p.playbook.submitUrl)], ['Required fields', esc((p.playbook.requiredFields || []).join(', '))],
      ['Gotchas', esc((p.playbook.gotchas || []).join(' | '))], ['Last run', esc(p.playbook.lastOutcome || '—')]])}</section>` : ''}
    <section><a class="btn small" href="#activity?platform=${p.id}" data-close>All activity for ${esc(p.name)}</a></section>`
  $('#drawer').hidden = false
  $('#drawer').dataset.id = id
  $('#drawer').dataset.name = p.name
}
document.addEventListener('click', e => {
  const d = e.target.closest('[data-drawer]')
  if (d) { e.preventDefault(); run(openDrawer)(d.dataset.drawer) }
  if (e.target.closest('[data-close]')) $('#drawer').hidden = true
})
$('#drawer-close').addEventListener('click', () => { $('#drawer').hidden = true })
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#drawer').hidden = true })
$('#drawer-body').addEventListener('click', run(async e => {
  const a = e.target.closest('[data-act]')?.dataset.act
  if (!a) return
  await platformAction($('#drawer').dataset.id, a, e.target, $('#drawer').dataset.name)
  setTimeout(() => run(openDrawer)($('#drawer').dataset.id), 600)
}))
let stream
let drawerTimer
function openStream() {
  stream?.close()
  stream = new EventSource('/api/activity/stream')
  stream.onopen = () => { $('#stream-state').textContent = 'live' }
  stream.onerror = () => { $('#stream-state').textContent = 'reconnecting…' }
  stream.onmessage = m => {
    const e = JSON.parse(m.data)
    const level = $('#f-level').value
    const pf = $('#f-aplatform').value
    if (currentView() === 'activity' && (!level || level === e.level) && (!pf || String(e.platformId) === pf) && !$('#f-aq').value.trim()) {
      const list = $('#activity')
      if (list.firstElementChild?.classList.contains('muted')) list.innerHTML = ''
      // A step of a run already shown goes inside that run; anything else on top.
      const runEl = e.correlationId && $('#f-group-runs').checked ? list.querySelector(`[data-run="${CSS.escape(e.correlationId)}"] ol`) : null
      if (runEl) runEl.insertAdjacentHTML('beforeend', feedItem(e))
      else list.insertAdjacentHTML('afterbegin', $('#f-group-runs').checked && e.correlationId ? renderGroup({ run: e.correlationId, items: [e] }) : feedItem(e))
    }
    if (!$('#drawer').hidden && String(e.platformId) === $('#drawer').dataset.id && REFRESH.test(e.event)) { clearTimeout(drawerTimer); drawerTimer = setTimeout(() => run(openDrawer)($('#drawer').dataset.id), 800) }
    if (REFRESH.test(e.event)) scheduleRefresh(e.platformId ?? 'all')
    else if (/automation_|gmail_|chrome_|worker_|mirror_/.test(e.event)) refreshStatus()
  }
  // Hosted mirror: new records from the agent. Reload what they touched (all rows, or the platforms named).
  stream.addEventListener('sync', m => {
    const d = JSON.parse(m.data || '{}')
    if (Array.isArray(d.platforms)) for (const id of d.platforms) scheduleRefresh(id)
    else if (d.platforms === 'all' || d.tables?.length) scheduleRefresh('all')
    refreshSync()
  })
  stream.addEventListener('command', m => trackCommand(JSON.parse(m.data)))
}

// ---------- integrations ----------
let connectInfo = null
async function prepareConnect() {
  connectInfo = await api('/api/viasocket/connect-token') // fetched before the click: the popup must open straight from it
  loadConnectScript()
}
function dl(el, rows) { el.innerHTML = rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') }

// Each card loads on its own: a Chrome problem must never leave Gmail's Connect button unprepared.
loaders.integrations = async () => {
  await Promise.all([
    run(async () => renderGmail(await api('/api/gmail/status?fresh=1')))(),
    hosted && !mirrorOn ? null : run(async () => renderChrome(await api('/api/chrome/status')))(),
    run(prepareConnect)()
  ])
}
function renderGmail(g) {
  const pill = $('#gmail-pill')
  pill.textContent = g.connected ? (g.expired ? 'Expired' : 'Connected') : g.revoked ? 'Revoked' : 'Not connected'
  pill.className = `pill ${g.connected && !g.expired ? 'ok' : g.connected ? 'warn' : g.revoked ? 'err' : ''}`
  dl($('#gmail-details'), [['Account', g.account], ['Connected', g.connectedAt && fmtTime(g.connectedAt)], ['Checked', g.checkedAt && fmtTime(g.checkedAt)], ['Problem', g.error]])
  $('#gmail-connect').textContent = g.connected && !g.expired ? 'Reconnect' : g.expired ? 'Sign in again' : 'Connect Gmail'
  $('#gmail-test').disabled = !g.connected
  $('#gmail-disconnect').disabled = !g.connected
  setDot('#dot-gmail', g.connected && !g.expired ? 'ok' : g.connected ? 'warn' : '')
}
function renderChrome(c) {
  const pill = $('#chrome-pill')
  const health = c.health || {}
  pill.textContent = c.attached ? (health.ok === false ? 'Needs attention' : 'Connected') : c.running ? 'Running (not attached)' : 'Not running'
  pill.className = `pill ${c.attached && health.ok !== false ? 'ok' : c.running || c.attached ? 'warn' : ''}`
  dl($('#chrome-details'), [['Version', c.version], ['Open tabs', c.pages],
    ['Google session', c.attached && c.googleSignedIn != null ? (c.googleSignedIn ? 'Signed in' : 'Not signed in') : null], ['Problem', health.reason], ['Note', c.note]])
  for (const id of ['#chrome-google', '#chrome-front', '#chrome-close']) $(id).disabled = !c.running
  setDot('#dot-chrome', c.attached ? (c.googleSignedIn && health.ok !== false ? 'ok' : 'warn') : '')
}
function setDot(sel, tone) { $(sel).className = `dot ${tone}` }

$('#gmail-connect').addEventListener('click', async () => {
  if (!connectInfo) return toast('Still preparing Connect, try again in a second', true)
  const save = async authId => {
    const r = await api('/api/gmail/connected', { method: 'POST', body: { authId } })
    if (r?.queued) return
    renderGmail(r)
    toast('Gmail connected', 'ok')
    connectInfo = null; run(prepareConnect)()
  }
  try {
    const { authId } = await connect({
      embedToken: connectInfo.token,
      serviceId: connectInfo.serviceId,
      actions: connectInfo.actions,
      skipActionSelection: true,
      ...(connectInfo.reconnectAuthId ? { authId: connectInfo.reconnectAuthId } : {}),
      onLateSuccess: ({ authId }) => run(save)(authId)
    })
    await run(save)(authId)
  } catch (error) {
    if (error.code !== 'closed') toast(error.message, true) // 'closed' can still end in onLateSuccess
  }
})
$('#gmail-test').addEventListener('click', e => {
  $('#gmail-result').textContent = 'Testing…'
  act(e.currentTarget, '/api/gmail/test', { method: 'POST' }, r => {
    $('#gmail-result').textContent = `Search works: ${r.matched} message found in ${r.tookMs} ms${r.latestDate ? `, latest ${fmtTime(r.latestDate)}` : ''}. Read/unread left unchanged${r.unreadPreserved === null ? '' : r.unreadPreserved ? ' (still unread)' : ''}.`
  })
})
$('#gmail-disconnect').addEventListener('click', e => {
  if (!confirm(`Remove the Gmail connection from ${BRAND}? Email verification stops until it is connected again.`)) return
  act(e.currentTarget, '/api/gmail/disconnect', { method: 'POST' }, () => renderGmail({ connected: false }))
})
for (const [id, path, msg, ask] of [['#chrome-launch', '/api/chrome/launch', 'Chrome is ready'], ['#chrome-google', '/api/chrome/google-signin', 'Sign in to Google in the Chrome window'],
  ['#chrome-front', '/api/chrome/front', 'Chrome brought to front'], ['#chrome-close', '/api/chrome/close', 'Chrome closed', 'Close the agent\'s Chrome? Browser tasks wait until it is opened again.']]) {
  $(id).addEventListener('click', async () => {
    if (ask && !confirm(ask)) return
    await act($(id), path, { method: 'POST' }, () => toast(msg, 'ok'))
    run(async () => renderChrome(await api('/api/chrome/status')))()
  })
}

// ---------- credentials ----------
loaders.credentials = async () => {
  const rows = await api('/api/credentials')
  $('#credentials').innerHTML = rows.length
    ? rows.map(r => `<div class="list-item" data-account="${r.id}"><div>${r.platform_id ? `<strong class="platform-link" data-drawer="${r.platform_id}" title="Open details">${esc(r.platform)}</strong>` : `<strong>${esc(r.platform)}</strong>`} · ${esc(r.email)} · ${esc(label(r.login_method))} sign-up
        <div class="small account-links">${link(r.platform_url || (r.domain ? `https://${r.domain}` : ''), r.domain)}${r.profile_url ? ` · ${link(r.profile_url, 'Account profile')}` : ''}${r.listing_url ? ` · ${link(r.listing_url, 'Listing')}` : ''}</div>
        <div class="muted small">${r.signup_completed_at ? `signed up ${fmtDate(r.signup_completed_at)}${r.signup_inferred ? ' (inferred)' : ''}` : `${esc(label(r.status))} · started ${fmtTime(r.created_at)}`}${r.revealed_at ? ` · last revealed ${fmtTime(r.revealed_at)}` : ''}</div><code class="secret" hidden></code></div>
        ${r.has_password && !hosted ? '<button class="btn" data-reveal>Reveal password</button>' : ''}</div>`).join('')
    : '<p class="muted">No platform accounts yet.</p>'
}
$('#credentials').addEventListener('click', run(async e => {
  if (!e.target.matches('[data-reveal]')) return
  const item = e.target.closest('[data-account]')
  const password = prompt('Admin password to reveal this credential')
  if (!password) return
  const r = await api(`/api/credentials/${item.dataset.account}/reveal`, { method: 'POST', body: { password } })
  const code = $('.secret', item)
  code.textContent = r.password; code.hidden = false
  setTimeout(() => { code.textContent = ''; code.hidden = true }, 30_000)
}))

// ---------- settings ----------
loaders.settings = async () => {
  const s = await api('/api/settings')
  for (const [k, v] of Object.entries(s)) {
    const el = $(`#settings-form [name=${k}]`)
    if (!el) continue
    if (el.type === 'checkbox') el.checked = v === 1; else el.value = v
  }
}
$('#settings-form').addEventListener('submit', run(async e => {
  e.preventDefault()
  const body = {}
  for (const el of e.target.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.tagName === 'SELECT' ? el.value : Number(el.value)
  await act(e.target.querySelector('[type=submit]'), '/api/settings', { method: 'PATCH', body }, () => toast('Settings saved', 'ok'))
}))

// ---------- status and sync, on every page ----------
let mirrorOnline = true
async function refreshSync() {
  try {
    const s = await api('/api/sync')
    mirrorOnline = s.agentOnline
    const el = $('#sync-state')
    el.classList.toggle('offline', !s.agentOnline)
    setDot('#sync-dot', s.agentOnline ? (s.mirrorFailing ? 'warn' : 'ok') : 'err')
    const who = s.mirroring ? `Agent ${s.agentOnline ? 'online' : 'offline'}` : `Agent ${s.agentOnline ? 'online' : 'not running'}`
    const synced = s.mirroring ? ` · Last synced: ${ago(s.lastSynced)}` : s.mirrorTarget ? ` · Hosted copy updated ${ago(s.lastSynced)}${s.mirrorFailing ? ' (retrying)' : ''}` : ''
    $('#sync-text').textContent = who + synced
    if (s.mirroring && !s.agentOnline) $('#sync-text').title = `The agent last answered ${fmtTime(s.lastContact)}. Changes made here are pending until it reconnects.`
    renderPending()
  } catch {}
}
async function refreshStatus() {
  try {
    if (hosted) fetch('/api/session').then(r => r.json()).then(s => showMirror(s.mirror)).catch(() => {})
    const [o, g, c, ov] = await Promise.all([api('/api/automation'), api('/api/gmail/status'), hosted && !mirrorOn ? {} : api('/api/chrome/status').catch(() => ({})), api('/api/overview')])
    $('#badge-company').hidden = Boolean(ov.companyApproved)
    renderAutomation(o.state)
    const n = (ov.needsYou || 0) + (ov.awaitingYou || 0)
    $('#badge-queue').hidden = !n; $('#badge-queue').textContent = n
    $('#badge-failed').hidden = !ov.failed; $('#badge-failed').textContent = ov.failed
    $('#badge-added').hidden = !ov.successfullyAdded; $('#badge-added').textContent = ov.successfullyAdded
    setDot('#dot-gmail', g.connected && !g.expired ? 'ok' : g.connected ? 'warn' : '')
    setDot('#dot-chrome', c.attached ? (c.googleSignedIn && c.health?.ok !== false ? 'ok' : 'warn') : '')
  } catch {}
  refreshSync()
}

let started = false
async function start() {
  $('#login').hidden = true
  $('#app').hidden = false
  route()
  openStream()
  refreshStatus()
  run(loadCommands)()
  if (!started) setInterval(refreshStatus, 15_000)
  started = true
}

const session = await fetch('/api/session').then(r => r.json())
hosted = session.hosted
$('#hosted-banner').hidden = !hosted
const BANNER = $('#hosted-banner').textContent
// Hosted and mirroring the agent: its Chrome and Gmail are usable from here, and the numbers are the agent's.
function showMirror(m) {
  mirrorOn = Boolean(hosted && m?.on)
  $('#chrome-card').hidden = hosted && !mirrorOn
  $('#mini-chrome').hidden = hosted && !mirrorOn
  if (!hosted) return
  if (mirrorOn) {
    $('#hosted-banner').textContent = m.online
      ? 'Live copy of the agent. Changes you make here are applied by the agent within seconds; each shows as pending until it is applied.'
      : `The agent is offline (last update ${m.lastPush ? fmtTime(m.lastPush) : 'never'}). These are its last numbers; changes you make here show as pending and apply when it reconnects.`
    $('#hosted-banner').classList.toggle('warn', !m.online)
  } else {
    $('#hosted-banner').textContent = BANNER + (session.viasocket ? '' : ' viaSocket keys are not set on this server yet, so AI, discovery and Gmail are off.')
  }
}
showMirror(session.mirror)
if (session.authenticated) start()
else {
  showLogin()
  if (session.hosted && !session.signInOpen) {
    $('#login-hint').textContent = 'Sign-in is closed until the owner sets an admin password for this hosted copy.'
    for (const el of $('#login-form').elements) el.disabled = true
  }
}
