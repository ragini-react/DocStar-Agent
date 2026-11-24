// Dashboard API for cold-email sending. Reads work on the Mac and on the hosted copy (mirrored tables). Writes run on
// the Mac: on the hosted copy the app's mirror middleware queues every POST for the Mac before it reaches these.
import { createGmail } from '../integrations/gmail.js'

export function registerOutreachRoutes(app, { db, vault, activity, viasocket, config, store, engine, outreachOn }) {
  const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => res.status(400).json({ error: e.message }))
  const gate = (req, res, next) => (outreachOn() ? next() : res.status(404).json({ error: 'Not found' }))
  const needEngine = () => { const e = engine(); if (!e) throw new Error('Sending runs on the Mac with GTM_OUTREACH=1'); return e }
  const id = req => { const n = Number(req.params.id); if (!Number.isInteger(n)) throw new Error('Bad inbox id'); return n }
  const gmails = new Map()
  // Each sending inbox has its own Gmail connection, never the support@ one.
  const gmailFor = box => {
    if (!gmails.has(box.id)) gmails.set(box.id, createGmail({ db, vault, activity, viasocket, config, key: `gmail_inbox_${box.id}`, label: box.address, sender: true }))
    return gmails.get(box.id)
  }

  app.get('/api/outreach/system', gate, (req, res) => res.json({ ...store.overview(), sending: Boolean(engine()) }))

  app.put('/api/outreach/settings', gate, wrap((req, res) => res.json(store.saveSettings(req.body || {}))))

  app.post('/api/outreach/inboxes', gate, wrap(async (req, res) => {
    const box = store.addInbox(req.body || {})
    activity.info('outreach_inbox', `Sending inbox added: ${box.address} (connect it and pass the DNS check to activate)`)
    res.json(engine() ? await engine().refreshDns(box.id) : box)
  }))
  app.put('/api/outreach/inboxes/:id', gate, wrap((req, res) => {
    const box = store.updateInbox(id(req), req.body || {})
    activity.info('outreach_inbox', `${box.address}: limits set to ${box.hourly_limit}/hour, ${box.daily_limit}/day`)
    res.json(box)
  }))
  app.post('/api/outreach/inboxes/:id/dns', gate, wrap(async (req, res) => res.json(await needEngine().refreshDns(id(req)))))
  app.post('/api/outreach/inboxes/:id/activate', gate, wrap(async (req, res) => res.json(await needEngine().activate(id(req)))))
  app.post('/api/outreach/inboxes/:id/pause', gate, wrap((req, res) => {
    store.setInboxState(id(req), 'paused', 'Paused by you'); activity.info('outreach_inbox', `${store.inbox(id(req))?.address} paused`); res.json(store.inbox(id(req)))
  }))
  app.delete('/api/outreach/inboxes/:id', gate, wrap(async (req, res) => {
    const box = store.inbox(id(req)); store.removeInbox(id(req))
    if (box?.connected) gmailFor(box).disconnect()
    res.json({ ok: true })
  }))

  // Connect: the same viaSocket popup as the support inbox, with its own connection and send consent.
  app.get('/api/outreach/inboxes/:id/connect-token', gate, wrap(async (req, res) => {
    const box = store.inbox(id(req)); if (!box) throw new Error('No such inbox')
    if (config.hosted) throw new Error('Connect sending inboxes from the dashboard on the Mac')
    const g = gmailFor(box), st = await g.status()
    res.json({ token: await g.embedToken(), serviceId: await g.serviceId(), actions: g.consentActions(), reconnectAuthId: st.expired ? g.authIdForReconnect() : undefined })
  }))
  app.post('/api/outreach/inboxes/:id/connected', gate, wrap(async (req, res) => {
    const box = store.inbox(id(req)); if (!box) throw new Error('No such inbox')
    const authId = req.body?.authId
    if (typeof authId !== 'string' || !/^[A-Za-z0-9_]{6,200}$/.test(authId)) throw new Error('Bad connection id')
    const g = gmailFor(box), st = await g.saveConnection(authId)
    // The connection must be the inbox's own address: sending as anyone else is refused.
    if (String(st.account || '').toLowerCase() !== box.address) {
      g.disconnect()
      throw new Error(`That Google account is ${st.account || 'unknown'}, not ${box.address}: sign in as ${box.address}`)
    }
    db.prepare('UPDATE outreach_inboxes SET connected = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), box.id)
    res.json(store.inbox(box.id))
  }))

  app.post('/api/outreach/batches', gate, wrap((req, res) => res.json(needEngine().approveBatch(req.body?.ns || []))))
  app.post('/api/outreach/sequences/:id/stop', gate, wrap((req, res) => { store.stopSequence(id(req), 'stopped by you'); res.json({ ok: true }) }))

  app.post('/api/outreach/suppression', gate, wrap((req, res) => res.json(store.suppress(req.body?.entry, req.body?.reason || 'added by you'))))
  app.delete('/api/outreach/suppression/:entry', gate, wrap((req, res) => res.json({ removed: store.unsuppress(decodeURIComponent(req.params.entry)) })))
  app.post('/api/outreach/complaints', gate, wrap((req, res) => res.json({ paused: needEngine().recordComplaint(req.body?.email) })))

  return { gmailFor }
}
