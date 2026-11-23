# DocStar — go-to-market plan

Status: **DRAFT, awaiting approval. No outreach has happened.**

## 1. Who to go after first (by expected return)

| Wave | ICPs | Why first |
|---|---|---|
| 1 | AI startups, MCP builders, API-first startups with weak or no docs (Segment B) | Strongest fit with DocStar's unique features (agent-written docs, hosted MCP, llms.txt); fast decisions by founders; free plan removes friction |
| 2 | SaaS with partner APIs, devtools on another docs platform (Segment A), CLI/SDK teams | Bigger accounts; message is "add MCP + CLI + drift detection on top of what you have" |
| 3 | Agencies (white-label, recurring), OSS maintainers, indie devs, students | Volume and word of mouth; lower revenue per account |
| 4 | Enterprise | Longer cycle; start after 3–5 case studies |

## 2. Outreach sequence (after approval)

- Day 0: personalised first email (template by ICP, first line from research).
- Day 4–5: F1 nudge. Day 11–12: F1b close-out. Stop after that.
- Reply → F2/F3/F4 by reply type; record the status in the dashboard.
- Start with 20–30 emails/day from a warmed sending domain (a subdomain like `hello.docstar.io`, with SPF/DKIM/DMARC), not support@.
- Prefer a real person as sender (founder or PM), not "DocStar Team".

## 3. Compliance (must-haves before sending)

- Only published business addresses; source URL kept for each (already in the lead data).
- Physical address and a one-line opt-out in every email; keep a suppression list and honour it immediately.
- EU/UK leads: legitimate-interest B2B basis, short message, easy opt-out (GDPR/PECR). India: DPDP Act. US: CAN-SPAM.
- No scraping of LinkedIn and no automated LinkedIn messaging (against LinkedIn's terms). Manual, personal notes only.
- OSS maintainers: don't open GitHub issues to pitch. Use a published email or Discussions only if the project invites it.

## 4. Channels beyond email (see Channels table in the dashboard; not yet verified)

1. **Product Hunt launch.** Position as "API docs that AI agents can use: docs + MCP server + CLI from your code." Prepare the gallery, a 60-second demo and maker comment; line up early supporters.
2. **Show HN.** A plain technical post: "Show HN: Your coding agent writes your API docs, MCP server and CLI." Be in the thread all day.
3. **MCP ecosystem.** List DocStar's own MCP server on registries (Smithery, mcp.so, Glama, the official MCP servers list) and in Cursor/Claude communities. Every docs site we host adds MCP install buttons, which is built-in distribution.
4. **Content / SEO.** "How to add llms.txt to your API docs", "Turn an OpenAPI file into an MCP server", "Mintlify vs ReadMe vs DocStar" comparison pages, "API docs checklist for AI agents".
5. **Free tool as a lead magnet.** An "Agent-readiness checker": enter your docs URL, see if llms.txt, markdown, MCP and OpenAPI are present. It produces leads and gives the first line for outreach. (The backlink agent here could run it.)
6. **Partnerships.** API gateways, backend frameworks (e.g. Hono, FastAPI, NestJS communities), coding-agent tools, hackathon organisers, accelerators (startup-perk listings), GitHub Marketplace for the sync app.
7. **Design partners.** Offer 10 early adopters free Pro for 6 months in exchange for feedback, a logo and a case study. Pick them from the High-priority leads.
8. **Creators.** API/devtools YouTubers and newsletter writers: give them a sponsored or free walkthrough with real APIs.
9. **Directory backlinks.** The existing backlink agent already covers this.

## 5. Things you may have missed

- **Sending infrastructure.** No outreach mailbox or domain warm-up is set up yet; Gmail here is support@ with read-only permissions. Decide the sender and tool (e.g. Apollo/Instantly/HubSpot). Those connectors need authorising in claude.ai settings.
- **Email finding.** Most companies don't publish personal emails. Getting decision-maker emails at scale needs a verification provider (Apollo, Hunter); the leads currently carry only published addresses.
- **Proof.** No case studies, testimonials or numbers yet. Design partners fix that, and the first 5 matter more than 500 emails.
- **Sign-up attribution.** Add UTM links per template (`docstar.io/?utm_source=outreach&utm_campaign={icp}`) so registrations and conversions in the dashboard can be filled from real data.
- **Demand-side growth.** Developers who install the DocStar MCP to *use* APIs make DocStar more valuable to publishers. Market that side too.
- **Rebrand.** If the name changes, run the rebrand script before any public launch so outreach and listings match.

## 6. KPIs to track (dashboard)

Researched → qualified → outreach-ready → sent → replied → interested → demo → signed up → converted. Targets for the first
month: 300 qualified leads, 8–12% reply rate, 30 sign-ups, 5 design partners.
