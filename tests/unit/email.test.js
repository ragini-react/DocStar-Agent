// Part 6/7: verification links (incl. tracking redirects) and classification of platform emails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEmail, listingUrlFromEmail, pickVerificationLink } from '../../src/integrations/verificationLinks.js'
import { resolveTracker } from '../../src/integrations/emailVerifier.js'

test('tracking-redirect links count only when they resolve to the platform', async () => {
  const body = { html: '<a href="https://u123.ct.sendgrid.net/ls/click?upn=abc">Verify your email</a>' }
  const picked = pickVerificationLink(body, 'example.com')
  assert.deepEqual([picked.host, picked.tracker], ['u123.ct.sendgrid.net', true])
  assert.equal(pickVerificationLink({ html: '<a href="https://evil.io/x">Verify</a>' }, 'example.com'), null)
  const hops = { 'https://u123.ct.sendgrid.net/ls/click?upn=abc': 'https://example.com/verify?t=1', 'https://u1.ct.sendgrid.net/bad': 'https://evil.io/steal' }
  const fetchImpl = async url => ({ status: hops[url] ? 302 : 200, headers: { get: () => hops[url] || null } })
  assert.equal(await resolveTracker('https://u123.ct.sendgrid.net/ls/click?upn=abc', 'example.com', { fetchImpl }), 'https://example.com/verify?t=1')
  assert.equal(await resolveTracker('https://u1.ct.sendgrid.net/bad', 'example.com', { fetchImpl }), null)
})

test('platform emails are classified: approved, live, rejected, received, verification', () => {
  assert.equal(classifyEmail({ subject: 'Please verify your email' }), 'verification')
  assert.equal(classifyEmail({ subject: 'DocStar has been approved!' }), 'approved')
  assert.equal(classifyEmail({ subject: 'Your listing is now live' }), 'live')
  assert.equal(classifyEmail({ subject: 'Update on your submission', text: 'Unfortunately your tool was not approved because it is not a fit.' }), 'rejected')
  assert.equal(classifyEmail({ subject: 'We received your submission', text: 'It is in the review queue.' }), 'received')
  assert.equal(classifyEmail({ subject: 'Weekly newsletter' }), 'other')
  assert.equal(listingUrlFromEmail({ html: '<a href="https://www.example.com/tools/docstar">See it</a>' }, 'example.com'), 'https://www.example.com/tools/docstar')
})
