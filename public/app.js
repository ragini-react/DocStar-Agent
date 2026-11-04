// DocStar dashboard. Plain ES module, no build step. Every value from the server is escaped before it
// reaches the page: platform names and URLs will come from the open web.
import { connect, loadConnectScript } from '/vendor/viasocket-browser.js'

const $ = (sel, root = document) => root.querySelector(sel)
let hosted = false // set from /api/session: a hosted copy has no Chrome
let mirrorOn = false // hosted and mirroring the Mac: Chrome and Gmail are the Mac's, reached through it
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const label = s => String(s ?? '').replace(/_/g, ' ')
const fmtTime = ts => (ts ? new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const safeHref = u => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '#')

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-DocStar-CSRF': '1' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  })
  if (res.status === 401 && path !== '/api/login' && !path.includes('/reveal')) { showLogin(); throw new Error('Signed out') }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, data })
  // Hosted mirror: the change was handed to the agent on the Mac. Say so, and stop the caller from rendering it.
  if (res.status === 202 && data?.queued) { toast(data.message); throw Object.assign(new Error(QUEUED), { queued: true }) }
  return data
}
const QUEUED = 'queued for the Mac'

let toastTimer
function toast(msg, isErr = false) {
  const t = $('#toast')
  t.textContent = msg
  t.className = `toast${isErr ? ' err' : ''}`
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.hidden = true), 4500)
}
const run = fn => async (...args) => { try { await fn(...args) } catch (e) { if (e.message !== 'Signed out' && !e.queued) toast(e.message, true) } }

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
const TITLES = { overview: 'Overview', platforms: 'Platforms', queue: 'Needs you', company: 'DocStar profile', activity: 'Activity', integrations: 'Integrations', credentials: 'Credentials', settings: 'Settings' }
const loaders = {}
function route() {
  const view = (location.hash.slice(1) || 'overview')
  const name = TITLES[view] ? view : 'overview'
  for (const v of Object.keys(TITLES)) $(`#view-${v}`).hidden = v !== name
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.view === name)
  $('#view-title').textContent = TITLES[name]
  run(loaders[name] || (async () => {}))()
}
window.addEventListener('hashchange', route)

// ---------- automation controls ----------
const STATE_PILL = { running: 'ok', paused: 'warn', stopped: '' }
function renderAutomation(state) {
  const p = $('#automation-state')
  p.textContent = state === 'running' ? '● Running' : state === 'paused' ? 'Paused' : 'Stopped'
  p.className = `pill ${STATE_PILL[state] ?? ''}`
  const can = { start: state === 'stopped', pause: state === 'running', resume: state === 'paused', stop: state !== 'stopped' }
  for (const b of document.querySelectorAll('[data-automation]')) b.disabled = !can[b.dataset.automation]
}
for (const b of document.querySelectorAll('[data-automation]')) {
  b.addEventListener('click', run(async () => {
    b.disabled = true
    const { state } = await api(`/api/automation/${b.dataset.automation}`, { method: 'POST' })
    renderAutomation(state)
    refreshStatus()
  }))
}

// ---------- overview ----------
const KPIS = [
  ['discovered', 'Platforms discovered'], ['qualified', 'Qualified'], ['freeSelected', 'Free platforms selected'], ['paidSkipped', 'Paid, skipped'],
  ['registered', 'Accounts registered'], ['verificationPending', 'Awaiting email verification'], ['submitted', 'Submissions completed'],
  ['awaitingYou', 'Awaiting your approval', 'alert'], ['pendingPlatformApproval', 'Pending platform review'], ['liveBacklinks', 'Published backlinks', 'accent'],
  ['dofollow', 'Dofollow', 'accent'], ['nofollow', 'Nofollow'], ['failed', 'Failed', 'alert'], ['lost', 'Lost or unavailable', 'alert'], ['needsYou', 'Needs you', 'alert']
]
function bars(el, rows) {
  const max = Math.max(1, ...rows.map(r => r.n))
  el.innerHTML = rows.length
    ? rows.map(r => `<div class="bar-row"><span>${esc(r.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${(r.n / max) * 100}%"></div></div><span class="n">${r.n}</span></div>`).join('')
    : '<p class="muted">Nothing yet.</p>'
}
loaders.overview = async () => {
  const o = await api('/api/overview')
  renderAutomation(o.automation)
  $('#kpis').innerHTML = KPIS.map(([k, l, cls]) => `<div class="kpi ${o[k] && cls ? cls : ''}"><div class="label">${l}</div><div class="value">${o[k]}</div></div>`).join('')
  bars($('#by-status'), Object.entries(o.byStatus).map(([s, n]) => ({ name: label(s), n })).sort((a, b) => b.n - a.n))
  bars($('#by-category'), o.byCategory.map(r => ({ name: r.name, n: r.n })))
  renderFeed($('#overview-activity'), await api('/api/activity?limit=8'))
}

// ---------- platforms ----------
const STATUSES = ['discovered', 'qualified', 'approval_required', 'registration_pending', 'registered', 'email_verification_pending',
  'ready_for_submission', 'submitted', 'pending_approval', 'live_backlink', 'no_backlink', 'failed', 'paid_skipped', 'needs_you', 'rejected']
const STATUS_TONE = { live_backlink: 'ok', registered: 'info', submitted: 'info', pending_approval: 'warn', approval_required: 'warn', needs_you: 'err', failed: 'err', paid_skipped: '', rejected: '' }
$('#f-status').insertAdjacentHTML('beforeend', STATUSES.map(s => `<option value="${s}">${label(s)}</option>`).join(''))
let categoriesLoaded = false

loaders.platforms = async () => {
  if (!categoriesLoaded) {
    const cats = await api('/api/categories')
    const opts = cats.map(c => `<option value="${esc(c.slug)}">${esc(c.name)}</option>`).join('')
    $('#f-category').insertAdjacentHTML('beforeend', opts)
    $('#add-category').insertAdjacentHTML('beforeend', opts)
    categoriesLoaded = true
  }
  const qs = new URLSearchParams()
  for (const [id, key] of [['#f-q', 'q'], ['#f-status', 'status'], ['#f-category', 'category'], ['#f-pricing', 'pricing']]) if ($(id).value) qs.set(key, $(id).value)
  const rows = await api(`/api/platforms?${qs}`)
  $('#platforms-empty').hidden = rows.length > 0
  $('#platforms-table tbody').innerHTML = rows.map(p => `<tr data-id="${p.id}">
    <td><strong>${esc(p.name)}</strong><div class="sub"><a href="${safeHref(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.domain)}</a> · ${esc(p.source)}</div></td>
    <td>${esc(p.category_name || '—')}</td>
    <td>${p.quality_score ?? '—'}</td>
    <td>${esc(p.pricing)}</td>
    <td><span class="pill ${STATUS_TONE[p.status] ?? ''}">${esc(label(p.status))}</span></td>
    <td>${p.account_email ? `${esc(p.account_email)}<div class="sub">${esc(p.account_status)}</div>` : '—'}</td>
    <td>${p.listing_submission_url ? `<a href="${safeHref(p.listing_submission_url)}" target="_blank" rel="noopener noreferrer">open</a><div class="sub">${esc(label(p.submission_status))}</div>` : esc(label(p.submission_status) || '—')}</td>
    <td>${p.backlink_url ? `<a href="${safeHref(p.backlink_url)}" target="_blank" rel="noopener noreferrer">open</a><div class="sub">${esc(p.backlink_status)}${p.is_dofollow === 1 ? ' · dofollow' : p.is_dofollow === 0 ? ' · nofollow' : ''}</div>` : '—'}</td>
    <td>${fmtTime(p.last_checked_at)}</td>
    <td><select class="row-action" aria-label="Actions for ${esc(p.name)}">
      <option value="">Actions</option>
      ${p.status !== 'rejected' ? '<option value="rejected">Reject</option>' : ''}
      ${p.status !== 'paid_skipped' ? '<option value="paid_skipped">Mark paid / skip</option>' : ''}
      ${p.status !== 'discovered' ? '<option value="discovered">Back to discovered</option>' : ''}
      ${['discovered', 'failed', 'rejected'].includes(p.status) ? '<option value="qualify">Evaluate now</option>' : ''}
      ${p.status === 'failed' || p.status === 'needs_you' || p.submission_status === 'approved' ? '<option value="retry">Retry submission</option>' : ''}
      ${p.submission_status ? '<option value="listing-url">Set listing URL…</option>' : ''}
      ${p.backlink_url ? '<option value="check-backlink">Check backlink now</option>' : ''}
      ${!p.account_status && !p.submission_status ? '<option value="delete">Delete</option>' : ''}
    </select></td></tr>`).join('')
}
let searchTimer
$('#f-q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(run(loaders.platforms), 250) })
for (const id of ['#f-status', '#f-category', '#f-pricing']) $(id).addEventListener('change', run(loaders.platforms))
$('#platforms-table').addEventListener('change', run(async e => {
  if (!e.target.classList.contains('row-action') || !e.target.value) return
  const id = e.target.closest('tr').dataset.id
  const action = e.target.value
  if (action === 'delete') {
    if (!confirm('Delete this platform record?')) { e.target.value = ''; return }
    await api(`/api/platforms/${id}`, { method: 'DELETE' })
  } else if (action === 'qualify' || action === 'retry') {
    await api(`/api/platforms/${id}/${action}`, { method: 'POST' })
    toast(action === 'qualify' ? 'Queued for evaluation' : 'Submission queued again'); return loaders.platforms()
  } else if (action === 'listing-url') {
    const url = prompt('Public URL of the DocStar listing on this platform')
    if (!url) { e.target.value = ''; return }
    await api(`/api/platforms/${id}/listing-url`, { method: 'POST', body: { url } })
  } else if (action === 'check-backlink') {
    const r = await api(`/api/platforms/${id}/check-backlink`, { method: 'POST' })
    toast(`Backlink: ${r.status}${r.present ? ` (${r.dofollow ? 'dofollow' : r.rel || 'nofollow'})` : ''}`)
    return loaders.platforms()
  } else {
    await api(`/api/platforms/${id}`, { method: 'PATCH', body: { status: action } })
  }
  toast('Saved')
  await loaders.platforms()
}))
$('#btn-add').addEventListener('click', () => { $('#add-form').hidden = false; $('#add-form [name=name]').focus() })
$('#add-cancel').addEventListener('click', () => { $('#add-form').hidden = true })
$('#add-form').addEventListener('submit', run(async e => {
  e.preventDefault()
  const f = new FormData(e.target)
  try {
    await api('/api/platforms', { method: 'POST', body: Object.fromEntries(f) })
    toast('Platform added')
    e.target.reset(); e.target.hidden = true
  } catch (err) {
    if (err.status === 409) toast(err.data?.reason || 'Already tracked', true); else throw err
  }
  await loaders.platforms()
}))
$('#btn-discover').addEventListener('click', run(async () => {
  const r = await api('/api/discovery/run', { method: 'POST' })
  toast(r.queued ? 'Discovery queued; it runs while the agent is started' : 'A discovery run is already queued')
}))
$('#btn-seeds').addEventListener('click', run(async () => {
  const r = await api('/api/platforms/import-seeds', { method: 'POST' })
  toast(`Seed list: ${r.added} added, ${r.total - r.added} already tracked`)
  await loaders.platforms()
}))

// ---------- needs you ----------
loaders.queue = async () => {
  const [approvals, tasks, queued] = await Promise.all([api('/api/approvals'), api('/api/tasks?state=needs_you'), hosted ? api('/api/tasks?state=queued') : []])
  const waiting = queued.filter(t => t.type === 'submit')
  $('#browser-queue-card').hidden = !hosted
  $('#browser-queue').innerHTML = waiting.length
    ? waiting.map(t => `<div class="list-item"><div><strong>${esc(t.platform)}</strong><div class="muted small">approved ${fmtTime(t.updated_at)}</div></div></div>`).join('')
    : '<p class="muted">None waiting.</p>'
  $('#approvals').innerHTML = approvals.length ? approvals.map(approvalCard).join('') : '<p class="muted">Nothing waiting for your approval.</p>'
  $('#needs-you').innerHTML = tasks.length
    ? tasks.map(t => `<div class="list-item" data-task="${t.id}"><div><strong>${esc(t.platform || 'Task')}</strong> · ${esc(t.type)}<div class="muted small">${esc(t.last_error || '')}</div></div>
        <div class="row"><button class="btn" data-open-chrome>Open browser</button><button class="btn primary" data-resume>Resume</button></div></div>`).join('')
    : '<p class="muted">No task is waiting for you.</p>'
}
function approvalCard(a) {
  const l = a.listing || {}
  const s = a.payload?.score || {}
  const field = (k, label, long) => `<label>${label}${long ? `<textarea name="${k}" rows="${k === 'long_description' ? 7 : 2}">${esc(l[k])}</textarea>` : `<input name="${k}" value="${esc(l[k])}">`}</label>`
  return `<form class="approval" data-approval="${a.id}">
    <div class="meta"><strong>${esc(a.name)}</strong><a href="${safeHref(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.domain)}</a>
      <span class="pill">${esc(a.pricing)}</span>${s.overall != null ? `<span class="pill info">score ${s.overall}</span>` : ''}${s.seo_value ? `<span class="pill">SEO ${esc(s.seo_value)}</span>` : ''}</div>
    <div class="scores">${['relevance', 'domain_reputation', 'audience_quality', 'credibility', 'backlink_quality'].map(k => `<span>${label(k)} <b>${s[k] ?? '—'}</b></span>`).join('')}</div>
    <div class="muted small">${esc(a.registration_requirements || '')}${a.submission_requirements ? ` · asks for: ${esc(a.submission_requirements)}` : ''}${a.pricing_notes ? ` · ${esc(a.pricing_notes)}` : ''}</div>
    <div class="muted small">Submits at: ${a.submission_url ? `<a href="${safeHref(a.submission_url)}" target="_blank" rel="noopener noreferrer">${esc(a.submission_url)}</a>` : 'found by the agent'} · links to https://docstar.io/ with anchor text "${esc(l.anchor_text)}"</div>
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
  const body = decision === 'approve' ? { listing: Object.fromEntries(new FormData(form)) } : { note: prompt(`Why ${decision}? (optional)`) || undefined }
  await api(`/api/approvals/${form.dataset.approval}/${decision}`, { method: 'POST', body })
  toast(decision === 'approve' ? 'Approved: registration and submission queued' : `Platform ${decision === 'skip' ? 'skipped' : 'rejected'}`)
  await loaders.queue(); refreshStatus()
}))
$('#needs-you').addEventListener('click', run(async e => {
  if (e.target.matches('[data-open-chrome]')) { await api('/api/chrome/front', { method: 'POST' }); return }
  if (e.target.matches('[data-resume]')) {
    await api(`/api/tasks/${e.target.closest('[data-task]').dataset.task}/resume`, { method: 'POST' })
    toast('Handed back to the agent')
    await loaders.queue(); refreshStatus()
  }
}))

// ---------- DocStar profile ----------
loaders.company = async () => {
  const c = await api('/api/company')
  const long = new Set(['short_description', 'long_description', 'features', 'social_links', 'audience'])
  $('#company-form').innerHTML = c.fields.map(([k, label]) => {
    const v = c.values[k] || {}
    return `<label>${esc(label)} ${v.approved ? '<span class="ok">✓ approved</span>' : ''}${long.has(k)
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
$('#company-save').addEventListener('click', run(async () => {
  const changes = companyChanges()
  if (!Object.keys(changes).length) return toast('No changes')
  await api('/api/company', { method: 'PUT', body: changes }); toast('Saved; approve the profile again'); loaders.company(); refreshStatus()
}))
$('#company-approve').addEventListener('click', run(async () => {
  const changes = companyChanges()
  if (Object.keys(changes).length) await api('/api/company', { method: 'PUT', body: changes })
  const r = await api('/api/company/approve', { method: 'POST' }); toast(`Profile approved (${r.approved} fields)`); loaders.company(); refreshStatus()
}))
$('#company-draft').addEventListener('click', run(async () => {
  if (!confirm('Re-draft unapproved fields from docstar.io? Approved fields are kept.')) return
  toast('Reading docstar.io…'); await api('/api/company/draft', { method: 'POST' }); toast('Draft ready'); loaders.company()
}))

// ---------- activity ----------
function feedItem(e) {
  return `<li><span class="ts">${fmtTime(e.ts)}</span><span class="lvl ${esc(e.level)}" title="${esc(e.level)}"></span><span>${esc(e.message)}<span class="ev">${esc(e.event)}</span></span></li>`
}
function renderFeed(el, entries) { el.innerHTML = entries.length ? entries.map(feedItem).join('') : '<li class="muted">No activity yet.</li>' }
loaders.activity = async () => {
  const level = $('#f-level').value
  renderFeed($('#activity'), await api(`/api/activity?limit=200${level ? `&level=${level}` : ''}`))
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
    if (!level || level === e.level) {
      const list = $('#activity')
      if (list.firstElementChild?.classList.contains('muted')) list.innerHTML = ''
      list.insertAdjacentHTML('afterbegin', feedItem(e))
    }
    if (/task_|automation_|platform_|gmail_|chrome_|needs_you/.test(e.event)) refreshStatus()
  }
  // Hosted mirror: new numbers from the Mac. Reload the open view, unless someone is typing in it.
  stream.addEventListener('sync', () => {
    refreshStatus()
    const view = location.hash.slice(1) || 'overview'
    const typing = document.activeElement?.closest?.(`#view-${view}`) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)
    if (!typing && Date.now() - lastSyncReload > 4000 && ['overview', 'platforms', 'queue', 'activity', 'integrations', 'credentials'].includes(view)) {
      lastSyncReload = Date.now()
      if (view !== 'activity') run(loaders[view] || (async () => {}))() // the activity list is already fed live
    }
  })
}
let lastSyncReload = 0

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
  pill.textContent = c.attached ? 'Connected' : c.running ? 'Running (not attached)' : 'Not running'
  pill.className = `pill ${c.attached ? 'ok' : c.running ? 'warn' : ''}`
  dl($('#chrome-details'), [['Version', c.version], ['Open tabs', c.pages],
    ['Google session', c.attached && c.googleSignedIn != null ? (c.googleSignedIn ? 'Signed in' : 'Not signed in') : null], ['Note', c.note]])
  for (const id of ['#chrome-google', '#chrome-front', '#chrome-close']) $(id).disabled = !c.running
  setDot('#dot-chrome', c.attached ? (c.googleSignedIn ? 'ok' : 'warn') : '')
}
function setDot(sel, tone) { $(sel).className = `dot ${tone}` }

$('#gmail-connect').addEventListener('click', async () => {
  if (!connectInfo) return toast('Still preparing Connect, try again in a second', true)
  const save = async authId => {
    renderGmail(await api('/api/gmail/connected', { method: 'POST', body: { authId } }))
    toast('Gmail connected')
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
$('#gmail-test').addEventListener('click', run(async () => {
  $('#gmail-result').textContent = 'Testing…'
  const r = await api('/api/gmail/test', { method: 'POST' })
  $('#gmail-result').textContent = `Search works: ${r.matched} message found in ${r.tookMs} ms${r.latestDate ? `, latest ${fmtTime(r.latestDate)}` : ''}. Read/unread left unchanged${r.unreadPreserved === null ? '' : r.unreadPreserved ? ' (still unread)' : ''}.`
}))
$('#gmail-disconnect').addEventListener('click', run(async () => {
  if (!confirm('Remove the Gmail connection from DocStar?')) return
  await api('/api/gmail/disconnect', { method: 'POST' })
  renderGmail({ connected: false })
}))
for (const [id, path, msg] of [['#chrome-launch', '/api/chrome/launch', 'Chrome is ready'], ['#chrome-google', '/api/chrome/google-signin', 'Sign in to Google in the Chrome window'],
  ['#chrome-front', '/api/chrome/front', 'Chrome brought to front'], ['#chrome-close', '/api/chrome/close', 'Chrome closed']]) {
  $(id).addEventListener('click', run(async () => {
    $(id).disabled = true
    try { await api(path, { method: 'POST' }); toast(msg) } finally { renderChrome(await api('/api/chrome/status')) }
  }))
}

// ---------- credentials ----------
loaders.credentials = async () => {
  const rows = await api('/api/credentials')
  $('#credentials').innerHTML = rows.length
    ? rows.map(r => `<div class="list-item" data-account="${r.id}"><div><strong>${esc(r.platform)}</strong> · ${esc(r.email)} · ${esc(r.login_method === 'google' ? 'Google sign-in' : 'email + password')}
        <div class="muted small">${esc(r.status)} · created ${fmtTime(r.created_at)}${r.revealed_at ? ` · last revealed ${fmtTime(r.revealed_at)}` : ''}</div><code class="secret" hidden></code></div>
        ${r.has_password ? '<button class="btn" data-reveal>Reveal password</button>' : ''}</div>`).join('')
    : '<p class="muted">No platform accounts yet. Accounts are created from Phase 3, each after your approval.</p>'
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
    if (el.type === 'checkbox') el.checked = v === 1; else el.value = v
  }
}
$('#settings-form').addEventListener('submit', run(async e => {
  e.preventDefault()
  const body = {}
  for (const el of e.target.elements) if (el.name) body[el.name] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : Number(el.value)
  await api('/api/settings', { method: 'PATCH', body })
  toast('Settings saved')
}))

// ---------- status polling ----------
async function refreshStatus() {
  try {
    if (hosted) fetch('/api/session').then(r => r.json()).then(s => showMirror(s.mirror)).catch(() => {})
    const [o, g, c, ov] = await Promise.all([api('/api/automation'), api('/api/gmail/status'), hosted && !mirrorOn ? {} : api('/api/chrome/status').catch(() => ({})), api('/api/overview')])
    $('#badge-company').hidden = Boolean(ov.companyApproved)
    renderAutomation(o.state)
    const n = (o.tasks.needs_you || 0) + (ov.awaitingYou || 0)
    $('#badge-queue').hidden = !n; $('#badge-queue').textContent = n
    setDot('#dot-gmail', g.connected && !g.expired ? 'ok' : g.connected ? 'warn' : '')
    setDot('#dot-chrome', c.attached ? (c.googleSignedIn ? 'ok' : 'warn') : '')
  } catch {}
}

let started = false
async function start() {
  $('#login').hidden = true
  $('#app').hidden = false
  route()
  openStream()
  refreshStatus()
  if (!started) setInterval(refreshStatus, 15_000)
  started = true
}

const session = await fetch('/api/session').then(r => r.json())
hosted = session.hosted
$('#hosted-banner').hidden = !hosted
const BANNER = $('#hosted-banner').textContent
// Hosted and mirroring the Mac: its Chrome and Gmail are usable from here, and the numbers are the Mac's.
function showMirror(m) {
  mirrorOn = Boolean(hosted && m?.on)
  $('#chrome-card').hidden = hosted && !mirrorOn
  $('#mini-chrome').hidden = hosted && !mirrorOn
  if (!hosted) return
  if (mirrorOn) {
    const ago = m.lastPush ? Math.max(0, Math.round((Date.now() - Date.parse(m.lastPush)) / 1000)) : null
    $('#hosted-banner').textContent = m.online
      ? `Live mirror of the agent on the Mac (updated ${ago}s ago). Buttons here, including Open Chrome and Connect Gmail, are carried out on the Mac.`
      : `The Mac is offline (last update ${m.lastPush ? fmtTime(m.lastPush) : 'never'}). These are its last numbers; buttons pressed now run when it reconnects.`
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
