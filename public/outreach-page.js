// Outreach page: Ready to send and Sent lists. Works on the local agent and on the hosted dashboard (where a Send is
// queued for the Mac, which sends it within seconds; the list updates when the Mac reports back).
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
async function call(u, o = {}) {
  const r = await fetch(u, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-DocStar-CSRF': '1' }, ...o })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || r.status)
  return j
}
const waiting = new Map() // n → hosted command id; sends queued from the hosted dashboard, not yet reported back
const tag = e => (e.role === 'founder' ? `<span class="tag founder">Founder${e.contact_name ? `: ${esc(e.contact_name)}` : ''}</span>` : '<span class="tag">Support / contact</span>') + (e.icp ? `<span class="tag">ICP: ${esc(e.icp)}</span>` : '')
const head = e => `<b>${esc(e.company)}</b>${tag(e)}<div>To: ${esc(e.to)}</div><div>Subject: ${esc(e.subject)}</div>`
// The preview is the branded HTML exactly as sent (sandboxed: no scripts, links open nothing here).
const body = e => `<details><summary>Show email</summary>${e.html ? `<iframe sandbox title="Email preview" srcdoc="${esc(e.html)}" style="width:100%;height:900px;border:1px solid #ddd;border-radius:8px;background:#fff"></iframe>` : `<pre>${esc(e.body)}</pre>`}</details>`
async function load() {
  let d
  try { d = await call('/api/outreach') } catch (e) { document.getElementById('list').textContent = `Sign in to the dashboard first (${e.message}).`; return }
  const sent = d.emails.filter(e => e.sent)
  for (const e of sent) waiting.delete(e.n)
  document.getElementById('hdr').textContent = `From: ${d.from} · ${sent.length} of ${d.emails.length} sent${d.enabled ? '' : ' · SENDING DISABLED'}`
  const ready = d.emails.filter(e => !e.sent)
  const done = sent.sort((a, b) => b.sent.sent_at.localeCompare(a.sent.sent_at))
  document.getElementById('list').innerHTML =
    `<h2>Ready to send (${ready.length})</h2>` + (ready.length ? ready.map(e => `<div class="card">${head(e)}${e.prepared ? '<div class="muted small">Found by the ICP search: read it before sending.</div>' : ''}${body(e)}` +
      (waiting.has(e.n) ? '<button disabled>Queued: the Mac is sending…</button>' : `<button class="primary" data-n="${e.n}" data-to="${esc(e.to)}">Send</button>`) + '</div>').join('') : '<p class="muted">Nothing waiting. Use "Find companies & prepare emails" in the Growth section.</p>') +
    `<h2>Sent (${done.length})</h2>` + (done.length ? done.map(e => `<div class="card">${head(e)}<button class="done" disabled>Done</button> <span class="muted">sent ${esc(new Date(e.sent.sent_at).toLocaleString())}</span>${body(e)}</div>`).join('') : '<p class="muted">Nothing sent yet.</p>')
  if (waiting.size) {
    // A queued send that failed on the Mac (e.g. Gmail refused it) comes back as a failed command: say why.
    try {
      const cmds = await call('/api/commands?limit=50')
      for (const [n, id] of waiting) {
        const c = cmds.find(x => x.id === id)
        if (c?.state === 'failed') { waiting.delete(n); alert(`Not sent to ${d.emails.find(e => e.n === n)?.to}: ${c.result}`); return load() }
      }
    } catch {}
    setTimeout(load, 3000)
  }
}
document.addEventListener('click', async ev => {
  const b = ev.target.closest('button[data-n]')
  if (!b || !confirm(`Send this email to ${b.dataset.to} now?`)) return
  b.disabled = true; b.textContent = 'Sending…'
  try {
    const r = await call(`/api/outreach/${b.dataset.n}/send`, { method: 'POST', body: JSON.stringify({ confirm: true }) })
    if (r.queued) waiting.set(Number(b.dataset.n), r.id)
    await load()
  } catch (e) { alert(`Not sent: ${e.message}`); b.disabled = false; b.textContent = 'Send' }
})
// Sender controls: Send all ready (spaced, under the daily cap) and the auto-sender toggle.
async function loadSender() {
  let st; try { st = await call('/api/outreach/sender') } catch { document.getElementById('sender').hidden = true; return }
  document.getElementById('sender').innerHTML = `<b>Sending</b> from support@docstar.io on the Mac · ${st.sentToday} sent in the last 24 h (cap ${st.cap}) · ${st.ready} ready${st.sending ? ' · <b>sending now…</b>' : ''}
    <div style="margin-top:8px"><button class="primary" id="send-all" ${st.ready ? '' : 'disabled'}>Send all ready (${st.ready})</button>
    <label style="margin-left:12px"><input type="checkbox" id="auto" ${st.auto ? 'checked' : ''}> Auto-send new emails as the ICP search prepares them</label>
    <label style="margin-left:12px">Daily cap <input id="cap" type="number" min="1" max="200" value="${st.cap}" style="width:60px"></label></div>
    <div class="muted small" style="margin-top:6px">Emails go one at a time, about ${Math.round(st.gapSeconds || 90)} s apart, never twice to the same address, so Gmail does not flag the account.</div>`
}
document.addEventListener('change', async ev => {
  if (ev.target.id === 'auto') { if (ev.target.checked && !confirm('Turn on auto-send? Every new email from the ICP search will be sent without a click (spaced out, up to the daily cap).')) { ev.target.checked = false; return }
    await call('/api/outreach/sender', { method: 'POST', body: JSON.stringify({ auto: ev.target.checked }) }).catch(e => alert(e.message)); loadSender() }
  if (ev.target.id === 'cap') { await call('/api/outreach/sender', { method: 'POST', body: JSON.stringify({ cap: Number(ev.target.value) }) }).catch(e => alert(e.message)); loadSender() }
})
document.addEventListener('click', async ev => {
  if (ev.target.id !== 'send-all') return
  if (!confirm('Send every ready email now? They go one at a time, spaced out, up to the daily cap.')) return
  ev.target.disabled = true
  try { await call('/api/outreach/send-all', { method: 'POST', body: JSON.stringify({ confirm: true }) }) } catch (e) { alert(e.message) }
  loadSender()
})
loadSender(); setInterval(loadSender, 15000)
load()
setInterval(() => { if (!waiting.size) load() }, 15000)
