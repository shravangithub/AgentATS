# AgentATS

**An open-source, AI-native ATS that runs entirely inside your own Google account — free forever.**

No servers. No database bills. No per-seat pricing. You paste six files into a free Google Apps Script project, run one function, and you have a working applicant tracking system: a hiring web app for your team, a public careers page for candidates, AI resume parsing and scoring, interview scheduling, debriefs, and analytics — all stored in a Google Sheet and Drive folder that *you* own.

---

## Why this exists

Recruiting software is overpriced and locked-in. Small teams pay hundreds of dollars per month for tools whose core job is: keep a list of candidates, read their CVs, schedule interviews, and collect feedback. Your data lives on someone else's servers, exports are painful, and the AI features cost extra.

AgentATS is a gift to the HR and talent-acquisition community. It exists to prove that a genuinely useful, AI-assisted ATS can be free, transparent, and owned end-to-end by the people using it. Read every line of code. Change anything. Your candidate data never leaves your Google account.

## What it does

**Requisitions & pipeline**
- Full requisition management: title, department, location, level, openings, salary band, priority, status, JD attachment, hiring manager and recruiter ownership.
- Kanban-style pipeline with configurable stages, stage-change tracking, and "stuck candidate" SLA alerts on your Today view.
- Archiving keeps large pipelines fast while preserving a year of live data for annual metrics, with search and restore.

**Candidate intake**
- Public careers page (`?page=apply`) — candidates apply with a CV upload; submissions are capped and size-limited to resist abuse.
- CV-by-email: point a `careers@` mailbox at the included forwarder script and every emailed CV is parsed and added automatically — with retry logic so no CV is ever silently lost.
- Manual add, bulk upload, and chat-style commands ("Add Asha Rao, name@example.com, backend engineer").

**AI resume parsing & scoring**
- Gemini-powered CV parsing: name, contact, experience, skills, notice period, compensation, work authorization and more, straight into structured columns.
- A 37-category scoring rubric (`TalentRubric.gs`) with role archetypes and company-type modifiers — tune weights in plain English or per category, with a full change log of who changed what.
- Match grades and fit scores per requisition, benchmark generation from your own hiring bar, and stack ranking.
- Bias-masked screening: evaluate candidates with identifying details hidden.

**Interviews & decisions**
- Interview scheduling with Google Calendar + Meet links, RSVP tracking, and per-requisition interview plans (each role gets its own rounds).
- Structured feedback via Google Forms or Slack-style slash commands.
- Debrief view and a candidate packet PDF for hiring committees.

**Sourcing & analytics**
- Sourcing engine: live opt-in sourcing (e.g. Hacker News "Who wants to be hired") plus an X-ray query builder for LinkedIn, GitHub and resume search.
- Recruiting analytics per hiring manager and per role, interview round metrics, and a one-click Looker Studio data tab for live dashboards.

**Team, trust & safety**
- Role-based access: Admin, Recruiter, Hiring Manager, Interviewer — enforced server-side, with personal access links per teammate.
- Audit trail of changes; formula-injection and abuse protections; secrets kept in Script Properties, never in code.
- Notifications by email or Google Chat webhook; automated backups of your tracker.

## The AI model

AgentATS uses **Google Gemini** through *your own* API key — bring your own key, pay as you go. Parsing and scoring calls cost cents, not seats: a busy month of screening typically costs less than a coffee. The key lives in a Script Property (`GEMINI_KEY`), is never written into code, and never touches any third-party server — calls go directly from your Google account to Google's API. The prompt layer is model-agnostic by design; swapping in another provider is a small, well-contained change.

## How it compares

Honest benchmarking against the tools this replaces for small and mid-size teams:

| | AgentATS | Leading paid ATS platforms |
|---|---|---|
| Price | Free, forever (plus cents of AI usage on your own key) | Roughly $300–$1,000+/month for small teams; enterprise pricing beyond |
| Data ownership | 100% in your Google account — the "database" is a Sheet you can open | Vendor cloud; exports on request |
| AI screening & scoring | Included, transparent 37-category rubric you can read and tune | Paid add-ons or opaque scoring |
| Careers page | Included (`?page=apply`) | Included |
| Email CV intake | Included (forwarder script) | Included |
| Scheduling | Google Calendar + Meet, RSVP tracking | Deeper multi-calendar orchestration |
| Customization | Edit the source | Config within vendor limits |
| Compliance certifications | None (see limitations) | SOC 2, GDPR programs, enterprise SLAs |

**Honest constraints — read before adopting.** We'd rather you know these up front than discover them later. Most are the deliberate tradeoff of a free tool that runs entirely inside your own Google account.

*Platform limits (Google Apps Script)*
- Each action runs in Google's serverless sandbox with a **6-minute execution cap** (30 minutes on Workspace) — very large bulk operations (mass scoring, big backups) can hit it.
- **Daily quotas** apply: outbound API calls, email sends (~100/day on consumer Gmail, ~1,500 on Workspace), and total trigger runtime. Heavy AI or email volume can bump these.
- Apps Script **serializes execution**, so many people acting at the same instant may queue briefly (guarded with locking — reliable, but not a high-concurrency backend).
- The public web app shows Google's small **"created by a Google Apps Script user"** banner (only removable on a paid Workspace domain).

*Scale (Google Sheets as the database)*
- Best for **small-to-mid pipelines** — hundreds to low-thousands of active candidates. Sheets slow down and hit cell limits well before enterprise volumes (the built-in archiver helps).
- It's a spreadsheet, not a real database — **no true transactions**; concurrency is guarded with locks, not an RDBMS.

*AI (bring your own Gemini key)*
- **Not truly zero-cost:** the software is free, but you use *your own* Gemini API key and pay pay-as-you-go (cents for small teams, but not $0).
- **AI actions take a few seconds** (parse a CV, score, draft an email) — assistive, not instant.
- AI is **probabilistic** — it can misjudge; it assists, it doesn't replace human review.
- **Use a paid AI tier for real candidate data** — free tiers may train on your inputs (a privacy call-out, not just cost).

*Security & compliance*
- **Not SOC 2 / ISO 27001 certified**, not third-party pen-tested — **not enterprise-compliance-ready out of the box** (regulated buyers like BFSI will need more).
- Your data lives in **your own Google account** — security depends on your account hygiene (2FA, careful sharing). Access control and audit are app-level: solid, but not infrastructure-grade.
- **Data residency = Google's** (region tied to your account); GDPR / India DPDP obligations for candidate PII are the operator's responsibility.

*Product scope*
- **No built-in job-board integrations** (LinkedIn/Naukri/Indeed) — intake is the public careers page, CV-by-email, or manual.
- **No SSO/SCIM**, no native mobile app (responsive web only); scheduling is basic (work hours + slots, not full calendar round-robin).
- **Single company per install** (single-tenant) — not a multi-tenant SaaS.

*Operations*
- **Community open-source = no SLA, no guaranteed support or uptime.** You self-host and self-support.
- **Upgrades are manual** (re-paste updated files); backups / disaster recovery are your responsibility (a built-in Sheet backup helps).

**In one line:** the most capable ATS you can run for free inside your own Google account, with real AI — built for startups and lean TA teams, not regulated enterprises. You bring a Gemini key and accept a few seconds of AI latency and Google's platform limits in exchange for owning your data and paying nothing for software.

If you're a 2,000-person company with a compliance team, buy an enterprise ATS. If you're a founder, an agency, or a TA team of one to fifteen who wants full control and a $0 software bill — this was built for you. (Scale, latency, compliance, and integrations are exactly what a database-backed successor addresses — see Optional modules.)

## 2-minute setup

AgentATS is fully self-provisioning — you never touch a Sheet ID or folder ID:

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Paste in the six files from this repo (`Code.gs`, `TalentRubric.gs`, `Index.html`, `Apply.html`, `Source.html`, and optionally `CvForwarder.gs` for the careers mailbox).
3. In **Project Settings → Script Properties**, add one property: `GEMINI_KEY` = your Google AI Studio API key (free to create at [aistudio.google.com](https://aistudio.google.com)).
4. In the editor, select **`firstRun`** and click **Run** (authorize when asked). It creates your tracker spreadsheet and CV folder, builds every tab, makes you the Admin, and logs your new Sheet's URL.
5. **Deploy → New deployment → Web app** — Execute as: *Me*, Who has access: *Anyone*. Copy the URL.

That's it. Open the URL: that's your ATS. Add `?page=apply` for your public careers page. Full click-by-click instructions (including a zero-code path for non-technical folks) are in [SETUP.md](SETUP.md).

## Security

- **All data stays in the installer's own Google account** — the spreadsheet, the CV files, the logs. Nothing is sent anywhere except your own Gemini API calls to Google.
- **No secrets in code.** API keys and webhook secrets live only in Script Properties. This repository contains property *names* and instructions — never values.
- **Server-side, role-based access control** with per-teammate access tokens; visitor identity is never trusted from the browser.
- **Hardened intake**: webhook authentication, daily submission caps, file-size limits, and formula-injection sanitization on everything written to the sheet.
- **Audit trail** of who changed what, and automated backups.

## Optional modules

- **`CvForwarder.gs`** — runs in your `careers@` mailbox and forwards every emailed CV into the ATS. Two clearly marked placeholders to fill in; see SETUP.md.
- **External database sync** — a Supabase sync/backup module exists for teams that outgrow Sheets, but it is intentionally *not* part of the open-source core. The OSS release is Google-Sheets-only: one account, one mental model, nothing else to secure.

## Community & contributing

This project is maintained for the HR/TA community, by the HR/TA community. Bug reports, feature requests, translations, rubric improvements, and documentation fixes are all welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). If AgentATS saved your team money, the best thank-you is a contribution (or telling another recruiter it exists).

## License

MIT — free for commercial and personal use. See [LICENSE](LICENSE).
