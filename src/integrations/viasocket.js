import { ViaSocket } from 'viasocket-apps'
import { viasocketConfigured } from '../config/index.js'

// Without the three keys (a hosted copy before its settings are added), every viaSocket call fails with one
// clear message instead of the app failing to start.
const notConfigured = new Proxy({}, {
  get: (_, key) => (key === 'then' ? undefined : key === 'catalog' ? notConfigured : () => {
    throw new Error('viaSocket keys are not set on this server')
  })
})

export const viasocket = viasocketConfigured()
  ? new ViaSocket({
    orgId: process.env.VIASOCKET_ORG_ID,
    projectId: process.env.VIASOCKET_PROJECT_ID,
    secret: process.env.VIASOCKET_EMBED_SECRET
  })
  : notConfigured

// catalog.serviceIdFor('gmail') currently fails: its lookup endpoint answers with no plugins (reported to
// viaSocket 2026-11-02). Fall back to the catalog list, which carries each app's slug.
export async function serviceIdFor(slug) {
  try {
    return await viasocket.catalog.serviceIdFor(slug)
  } catch (error) {
    const apps = await viasocket.catalog.list()
    const app = apps.find(a => a.slug === slug)
    if (!app) throw error
    return app.serviceId
  }
}
