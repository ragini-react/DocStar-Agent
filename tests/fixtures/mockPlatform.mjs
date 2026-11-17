// A local mock platform for the browser integration tests. Two servers:
//   platform (127.0.0.1): home with "Continue with Google" (opens a popup), dashboard, a submit form that resets the
//     pricing type after a logo upload (like DevHunt), a tagline with hidden validation, a fetch-based submit that
//     answers 422 for the wrong pricing and 409 for a second submission, and the listing page once submitted.
//   auth (localhost): a Google-like account chooser and consent screen; the callback closes the popup.
import http from 'node:http'

export async function startMockPlatform({ alreadyListed = false, email = 'support@docstar.io', signedIn = true } = {}) {
  const state = { submissions: [], posts: 0, sessions: new Set(), listed: alreadyListed, emailsSent: 0 }
  const page = (title, body, script = '') => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}${script ? `<script>${script}</script>` : ''}</body></html>`
  const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))
  let platformUrl, authUrl

  const auth = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = html => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html) }
    const back = url.searchParams.get('redirect') || ''
    if (url.pathname === '/o/oauth2/chooser') {
      if (!signedIn) return send(page('Sign in', '<input type="email" id="identifierId"><button>Next</button>'))
      return send(page('Choose an account', `<ul><li><div role="link" tabindex="0" data-identifier="${email}" onclick="location='/o/oauth2/consent?redirect=${encodeURIComponent(back)}'">DocStar Team ${email}</div></li></ul>`))
    }
    if (url.pathname === '/o/oauth2/consent') return send(page('Mock Platform wants to access your Google Account', `<button onclick="location='${back}'">Continue</button>`))
    send(page('Not found', ''))
  })

  const platform = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const cookie = String(req.headers.cookie || '')
    const sid = cookie.match(/sid=(\w+)/)?.[1]
    const signed = sid && state.sessions.has(sid)
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      const send = (html, code = 200, headers = {}) => { res.writeHead(code, { 'Content-Type': 'text/html', ...headers }); res.end(html) }
      const json = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (url.pathname === '/robots.txt') return send('User-agent: *\nDisallow: /admin\n')
      if (url.pathname === '/') return send(page('Mock Platform', signed ? '<a href="/dashboard">Dashboard</a>'
        : `<p>List your developer tool.</p><button id="g" onclick="window.open('${authUrl}/o/oauth2/chooser?redirect=${encodeURIComponent(platformUrl + '/oauth/callback')}', 'google', 'width=500,height=600')">Continue with Google</button>`))
      if (url.pathname === '/oauth/callback') {
        const id = Math.random().toString(36).slice(2)
        state.sessions.add(id)
        return send(page('Signing you in', '', "if (window.opener) { window.opener.location = '/dashboard'; window.close() } else location = '/dashboard'"), 200, { 'Set-Cookie': `sid=${id}; Path=/` })
      }
      if (url.pathname === '/dashboard') return signed ? send(page('Your dashboard', '<a href="/submit">Submit your tool</a>')) : send('', 302, { Location: '/' })
      if (url.pathname === '/submit') {
        if (!signed) return send('', 302, { Location: '/' })
        return send(page('Submit your tool', `<form id="f" novalidate>
          <label>Tool name <input name="name" required></label>
          <label>Website <input name="website" type="url" required></label>
          <label>Tagline <input name="tagline" id="tagline"></label>
          <label>Pricing type <select name="pricing" id="pricing"><option>Free</option><option>Subscription</option></select></label>
          <label>Logo <input type="file" name="logo" id="logo" accept="image/*"></label>
          <button type="submit" id="send">Submit tool</button></form><div id="msg" role="status"></div>`,
        `const t = document.getElementById('tagline');
         const mark = () => t.setAttribute('aria-invalid', t.value.trim() ? 'false' : 'true'); mark(); t.addEventListener('input', mark);
         document.getElementById('logo').addEventListener('change', () => { document.getElementById('pricing').value = 'Free' });
         document.getElementById('f').addEventListener('submit', async e => {
           e.preventDefault();
           const data = Object.fromEntries(new FormData(e.target)); delete data.logo;
           const r = await fetch('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
           const j = await r.json();
           document.getElementById('msg').textContent = r.ok ? 'Thanks! Your tool is under review.' : '';
           if (!r.ok) { const d = document.createElement('div'); d.setAttribute('role', 'alert'); d.textContent = j.error; document.body.appendChild(d) }
         })`))
      }
      if (url.pathname === '/api/submit' && req.method === 'POST') {
        state.posts++
        const data = JSON.parse(body || '{}')
        if (state.listed) return json({ error: 'DocStar is already submitted' }, 409)
        if (data.pricing !== 'Subscription') return json({ error: 'Pricing type must be Subscription for paid tools' }, 422)
        if (!data.tagline) return json({ error: 'Tagline is required' }, 422)
        state.submissions.push(data)
        state.listed = true
        return json({ ok: true, url: '/listing/docstar' })
      }
      if (url.pathname === '/listing/docstar') return state.listed ? send(page('DocStar — API docs', '<p>DocStar listing</p><a href="https://docstar.io/" rel="nofollow">DocStar</a>')) : send(page('Not found', ''), 404)
      send(page('Not found', ''), 404)
    })
  })

  const pp = await listen(platform)
  const ap = await listen(auth)
  platformUrl = `http://127.0.0.1:${pp}`
  authUrl = `http://localhost:${ap}`
  return { state, platformUrl, authUrl, close: () => { platform.close(); auth.close() } }
}
