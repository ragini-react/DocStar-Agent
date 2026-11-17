// DocStar dashboard. Plain ES module, no build step. Every value from the server is escaped before it
// reaches the page: platform names and URLs come from the open web.
//
// Changes made on a hosted copy are run by the agent: each one is shown as pending at once and turns into
// "Applied" or "Failed: <reason>" when the agent reports back. Views refresh live on every relevant event,
// row by row, without touching a field someone is typing in.
import { connect, loadConnectScript } from '/vendor/viasocket-browser.js'
import { STATUSES, label } from '/labels.js'

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
const TITLES = { overview: 'Overview', platforms: 'Platforms', queue: 'Needs you', added: 'Successfully added', failed: 'Failed', company: 'DocStar profile', activity: 'Activity',
  integrations: 'Integrations', credentials: 'Credentials', settings: 'Settings' }
const loaders = {}
const currentView = () => { const v = location.hash.slice(1).split('?')[0] || 'overview'; return TITLES[v] ? v : 'overview' }
const hashParams = () => new URLSearchParams(location.hash.split('?')[1] || '')
function route() {
  const name = currentView()
  for (const v of Object.keys(TITLES)) { const el = $(`#view-${v}`); if (el) el.hidden = v !== name }
  for (const a of $$('#nav a')) a.classList.toggle('active', a.dataset.view === name)
  $('#view-title').textContent = TITLES[name]
  if (name === 'platforms') {
    const p = hashParams()
    $('#f-group').value = p.get('group') || ''
    $('#f-status').value = p.get('status') || ''
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
  if (['overview', 'platforms', 'queue', 'added', 'failed', 'credentials'].includes(view)) run(loaders[view])({ soft: true })
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
  ['discovered', 'Platforms discovered', '', '#platforms'], ['qualified', 'Qualified', '', '#platforms'], ['freeSelected', 'Free platforms selected'],
  ['paidSkipped', 'Paid, skipped', '', '#platforms?status=paid_skipped'], ['registered', 'Accounts registered', '', '#credentials'],
  ['inProgress', 'In progress', '', '#platforms?group=in_progress'], ['awaitingYou', 'Awaiting your approval', 'alert', '#queue'],
  ['approvedWaiting', 'Approved, not yet submitted', '', '#platforms?group=pipeline'], ['successfullyAdded', 'Successfully added', 'accent', '#added'],
  ['pendingPlatformApproval', 'Awaiting platform review', '', '#platforms?status=pending_platform_review'], ['liveBacklinks', 'Live backlinks', 'accent', '#platforms?status=live_backlink'],
  ['dofollow', 'Dofollow', 'accent'], ['nofollow', 'Nofollow'], ['lost', 'Backlinks lost', 'alert', '#platforms?status=backlink_lost'],
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
  bars($('#by-category'), o.byCategory.map(r => ({ name: r.name, n: r.n })))
  renderFeed($('#overview-activity'), await api('/api/activity?limit=8'))
}
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
    <td><strong>${esc(p.name)}</strong><div class="sub">${link(p.url, p.domain)} · ${esc(p.source)}</div></td>
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
      <div class="muted small">Stopped ${ago(t.status_changed_at)}${t.resumesAt ? ` · Resume continues at: ${esc(t.resumesAt)}` : ''}</div>
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
    <div class="muted small">Submits at: ${a.submission_url ? link(a.submission_url) : 'found by the agent'} · links to https://docstar.io/ with anchor text "${esc(l.anchor_text)}"</div>
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

// ---------- successfully added ----------
const timeline = t => `<div class="timeline">${t.map(m => `<span class="${m.at ? 'done' : 'todo'}" title="${esc(m.at ? fmtTime(m.at) : 'not yet')}">${m.at ? '✓' : '○'} ${esc(m.name)}${m.at ? ` ${fmtDate(m.at)}` : ''}</span>`).join('')}</div>`
const who = r => `${r.account_email ? esc(r.account_email) : '—'}${r.login_method ? `<div class="sub">${esc(label(r.login_method))}</div>` : ''}${r.manual ? '<div class="sub">recorded by a person</div>' : ''}`
loaders.added = async () => {
  const a = await api('/api/added')
  const name = r => `<strong>${esc(r.name)}</strong><div class="sub">${esc(r.domain)}</div>${timeline(r.timeline)}`
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
  }).join('') || '<p class="muted">No profile yet: press "Re-draft from docstar.io".</p>'
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
  if (!confirm('Re-draft unapproved fields from docstar.io? Approved fields are kept.')) return
  toast('Reading docstar.io…')
  act(e.currentTarget, '/api/company/draft', { method: 'POST' }, () => { toast('Draft ready', 'ok'); loaders.company() })
})

// ---------- activity ----------
function feedItem(e) {
  return `<li><span class="ts">${fmtTime(e.ts)}</span><span class="lvl ${esc(e.level)}" title="${esc(e.level)}"></span><span>${esc(e.message)}<span class="ev">${esc(e.event)}</span></span></li>`
}
function renderFeed(el, entries) { el.innerHTML = entries.length ? entries.map(feedItem).join('') : '<li class="muted">No activity yet.</li>' }
loaders.activity = async () => {
  const level = $('#f-level').value
  renderFeed($('#activity'), await api(`/api/activity?limit=50${level ? `&level=${level}` : ''}`))
}
$('#f-level').addEventListener('change', run(loaders.activity))
let stream
function openStream() {
  stream?.close()
  stream = new EventSource('/api/activity/stream')
  stream.onopen = () => { $('#stream-state').textContent = 'live' }
  stream.onerror = () => { $('#stream-state').textContent = 'reconnecting…' }
  stream.onmessage = m => {
    const e = JSON.parse(m.data)
    const level = $('#f-level').value
    if (currentView() === 'activity' && (!level || level === e.level)) {
      const list = $('#activity')
      if (list.firstElementChild?.classList.contains('muted')) list.innerHTML = ''
      list.insertAdjacentHTML('afterbegin', feedItem(e))
    }
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
  if (!confirm('Remove the Gmail connection from DocStar? Email verification stops until it is connected again.')) return
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
    ? rows.map(r => `<div class="list-item" data-account="${r.id}"><div><strong>${esc(r.platform)}</strong> · ${esc(r.email)} · ${esc(label(r.login_method))} sign-up
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
  for (const el of e.target.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : Number(el.value)
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
