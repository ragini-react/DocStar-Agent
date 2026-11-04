// A local practice directory for testing the browser agent without touching real platforms.
// Pages: / (home), /signup (email + password), /check-email, /submit (listing form with logo), /captcha, /listing/docstar.
import http from 'node:http'

export function startPracticeSite(port = 4321) {
  const state = { signups: [], submissions: [] }
  const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(body))
      const send = (html, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html' }); res.end(html) }
      if (url.pathname === '/') return send(page('Practice Directory', '<p>The best place to list developer tools. Free listings for everyone.</p><a href="/signup">Sign up</a> <a href="/submit">Submit your tool</a> <a href="/pricing">Pricing</a>'))
      if (url.pathname === '/signup' && req.method === 'GET') return send(page('Create an account', '<form method="post"><label>Email <input name="email" type="email" required></label><label>Password <input name="password" type="password" required></label><label><input type="checkbox" name="terms" required> I accept the terms</label><button type="submit">Create account</button></form>'))
      if (url.pathname === '/signup') { state.signups.push({ email: form.email, hasPassword: Boolean(form.password), terms: form.terms }); return send(page('Welcome', '<p>Your account is ready.</p><a href="/submit">Submit your tool</a>')) }
      if (url.pathname === '/submit' && req.method === 'GET') return send(page('Submit your tool', `<form method="post" enctype="multipart/form-data">
        <label>Tool name <input name="name" required></label><label>Website <input name="website" type="url" required></label>
        <label>Short description <input name="short" maxlength="160" required></label><label>Description <textarea name="long"></textarea></label>
        <label>Category <select name="cat"><option value="">Choose</option><option>Developer tools</option><option>Marketing</option></select></label>
        <label><input type="checkbox" name="featured"> Featured placement ($49)</label>
        <button type="submit">Submit tool</button></form>`))
      if (url.pathname === '/submit') { state.submissions.push(body.length); return send(page('Thanks!', `<p>Your tool is live: <a href="/listing/docstar">http://127.0.0.1:${port}/listing/docstar</a></p>`)) }
      if (url.pathname === '/listing/docstar') return send(page('DocStar', '<p>API docs your agent writes.</p><a href="https://docstar.io/" rel="nofollow ugc">DocStar</a>'))
      if (url.pathname === '/captcha') return send(page('Verify', '<div class="g-recaptcha" data-sitekey="x"></div><button>Continue</button>'))
      send(page('Not found', ''), 404)
    })
  })
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, state, url: `http://127.0.0.1:${port}` })))
}
