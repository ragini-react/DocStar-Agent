// Sending-domain authentication check: SPF, DKIM and DMARC records, read from public DNS. An inbox is only activated
// (and stays active) while its domain passes all three. Records are set by the domain owner at the DNS host; this
// only reads them.
import { promises as dns } from 'node:dns'

const txt = async (name, resolve) => {
  try { return (await resolve(name)).map(parts => parts.join('')) } catch (e) { if (['ENOTFOUND', 'ENODATA', 'ENOTIMP'].includes(e.code)) return []; throw e }
}

/**
 * @param {string} domain  the sending address's domain (e.g. mail.docstar.io)
 * @param {{dkimSelector?: string, resolve?: Function}} o  Google Workspace's default selector is "google"
 */
export async function checkDomainAuth(domain, { dkimSelector = 'google', resolve = dns.resolveTxt } = {}) {
  const d = String(domain).toLowerCase()
  const [root, dmarc, dkim] = await Promise.all([txt(d, resolve), txt(`_dmarc.${d}`, resolve), txt(`${dkimSelector}._domainkey.${d}`, resolve)])
  const spfRec = root.filter(r => /^v=spf1\b/i.test(r))
  const spf = spfRec.length === 1 && /include:_spf\.google\.com/i.test(spfRec[0]) && /[~-]all\b/.test(spfRec[0])
    ? { ok: true, record: spfRec[0] }
    : { ok: false, record: spfRec.join(' | ') || null, fix: spfRec.length > 1 ? 'More than one SPF record: merge them into one.' : 'Add TXT: v=spf1 include:_spf.google.com ~all' }
  const dkimRec = dkim.find(r => /v=DKIM1|k=rsa|p=/i.test(r))
  const dkimOut = dkimRec && /p=[A-Za-z0-9+/]{100,}/.test(dkimRec)
    ? { ok: true, selector: dkimSelector }
    : { ok: false, selector: dkimSelector, fix: `Generate a DKIM key in Google Admin (Apps → Gmail → Authenticate email) and add the TXT at ${dkimSelector}._domainkey.${d}, then start authentication.` }
  const dmarcRec = dmarc.find(r => /^v=DMARC1\b/i.test(r))
  const policy = dmarcRec?.match(/\bp=(none|quarantine|reject)/i)?.[1]?.toLowerCase()
  const dmarcOut = policy
    ? { ok: true, record: dmarcRec, policy, note: policy === 'none' ? 'Policy is "none": fine to start, move to quarantine once reports are clean.' : undefined }
    : { ok: false, record: dmarcRec || null, fix: `Add TXT at _dmarc.${d}: v=DMARC1; p=none; rua=mailto:dmarc@${d.split('.').slice(-2).join('.')}` }
  return { domain: d, ok: spf.ok && dkimOut.ok && dmarcOut.ok, spf, dkim: dkimOut, dmarc: dmarcOut, checkedAt: new Date().toISOString() }
}
