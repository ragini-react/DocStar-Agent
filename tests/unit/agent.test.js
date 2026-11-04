import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyseLinks } from '../../src/agent/backlinks.js'
import { parseHtml, assertPublicUrl } from '../../src/agent/fetchPage.js'
import { isPaymentPage, fill } from '../../src/agent/browserAgent.js'
import { validateBrowserAction } from '../../src/ai/actionSchema.js'

test('backlink analysis: dofollow preferred, rel and noindex read', () => {
  const links = [{ href: 'https://docstar.io/', rel: 'nofollow', text: 'site' }, { href: 'https://www.docstar.io/pricing', rel: '', text: 'DocStar' }, { href: 'https://evil-docstar.io/', rel: '', text: 'x' }]
  const a = analyseLinks(links, { robots: 'index,follow' })
  assert.equal(a.present, true); assert.equal(a.dofollow, true); assert.equal(a.anchor, 'DocStar'); assert.equal(a.count, 2)
  assert.equal(analyseLinks([{ href: 'https://docstar.io', rel: 'sponsored', text: '' }]).sponsored, true)
  assert.equal(analyseLinks([], { robots: 'noindex' }).indexable, false)
  assert.equal(analyseLinks([{ href: 'https://notdocstar.io/', rel: '', text: '' }]).present, false)
})

test('html parsing finds links with rel and robots meta', () => {
  const p = parseHtml('<title>T</title><meta name="robots" content="noindex"><a href="/x" rel="ugc nofollow">A &amp; B</a>', new URL('https://s.com/a'))
  assert.equal(p.title, 'T'); assert.equal(p.robots, 'noindex'); assert.deepEqual(p.links[0], { href: 'https://s.com/x', rel: 'ugc nofollow', text: 'A & B' })
})

test('fetcher refuses private and non-http targets', async () => {
  for (const u of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'file:///etc/passwd', 'http://169.254.169.254/']) await assert.rejects(assertPublicUrl(u))
})

test('payment pages are recognised', () => {
  assert.ok(isPaymentPage('https://checkout.stripe.com/c/pay/x'))
  assert.ok(isPaymentPage('https://site.com/checkout?plan=pro'))
  assert.ok(!isPaymentPage('https://site.com/submit'))
})

test('placeholders fill; upload, skip and complete values are checked', () => {
  assert.equal(fill('{{company.name}} – {{x}}', { 'company.name': 'DocStar' }), 'DocStar – ')
  const ctx = { refs: new Set(['e1']), allowedHosts: ['a.com'], placeholders: new Set(['company.logo']), approvedTexts: new Set(), listingApproved: true }
  const base = { reason: 'r', confidence: 0.9, requiresHumanApproval: false }
  assert.ok(validateBrowserAction({ ...base, action: 'upload', target: 'e1', value: '{{company.logo}}' }, ctx).ok)
  assert.ok(!validateBrowserAction({ ...base, action: 'upload', target: 'e1', value: '/etc/passwd' }, ctx).ok)
  assert.ok(validateBrowserAction({ ...base, action: 'skip', target: null, value: 'paid' }, ctx).ok)
  assert.ok(!validateBrowserAction({ ...base, action: 'skip', target: null, value: 'because' }, ctx).ok)
  assert.ok(validateBrowserAction({ ...base, action: 'complete', target: null, value: 'https://a.com/l/docstar' }, ctx).ok)
  assert.ok(!validateBrowserAction({ ...base, action: 'complete', target: null, value: 'javascript:alert(1)' }, ctx).ok)
  assert.ok(validateBrowserAction({ ...base, action: 'verify_email', target: null, value: null }, ctx).ok)
})

test('discovery fallback reads names and URLs from a markdown list', async () => {
  const { parseCandidates } = await import('../../src/agent/discovery.js')
  const text = `- **SaaSHub** — https://www.saashub.com/  \n  **Submission:** https://www.saashub.com/submit  \n  Accepts software listings.\n\n- **DevHunt** — https://devhunt.org/\n  Submission: https://devhunt.org/submit\n  Dev tools.\n\n1. LibHunt (https://www.libhunt.com/) - developer discovery`
  const c = parseCandidates(text, 'dev_tools')
  assert.deepEqual(c.map(x => [x.name, x.homepage, x.submit_url]), [
    ['SaaSHub', 'https://www.saashub.com/', 'https://www.saashub.com/submit'],
    ['DevHunt', 'https://devhunt.org/', 'https://devhunt.org/submit'],
    ['LibHunt', 'https://www.libhunt.com/', '']
  ])
})

test('list entries are read and subreddits dropped', async () => {
  const { listEntries } = await import('../../src/agent/discovery.js')
  const md = '* /r/IMadeThis - https://reddit.com/r/imadethis\n* BetaList - https://betalist.com/\n- [DevHunt](https://devhunt.org/)\nplain text'
  assert.deepEqual(listEntries(md), [{ name: 'BetaList', url: 'https://betalist.com/' }, { name: 'DevHunt', url: 'https://devhunt.org/' }])
})
