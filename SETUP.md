# AgentATS — Setup Guide

Two ways to install. Path A is for anyone comfortable copy-pasting text. Path B is the zero-effort route once a template is published.

---

## Path A — Install from this repository (~10 minutes, no coding)

### 1. Create the Apps Script project

1. Sign in to the Google account that should *own* the ATS (all data will live in this account).
2. Go to **[script.google.com](https://script.google.com)** and click **New project**.
3. Name it (top-left) — e.g. `AgentATS`.

### 2. Paste the files

For each file below: in the editor's left sidebar click **+** next to *Files*, pick the right type, name it **exactly** as shown, then paste the full contents from this repo and save (Ctrl/Cmd-S).

| File in this repo | Type to create | Name it |
|---|---|---|
| `Code.gs` | Script | `Code` |
| `TalentRubric.gs` | Script | `TalentRubric` |
| `Index.html` | HTML | `Index` |
| `Apply.html` | HTML | `Apply` |
| `Source.html` | HTML | `Source` |

(`Code.gs` already exists in a new project — just replace its contents. `CvForwarder.gs` is **not** pasted here; it goes into a *separate* project later — see below.)

### 3. Add your Gemini API key

1. Get a free key at **[aistudio.google.com](https://aistudio.google.com)** → *Get API key*.
2. In Apps Script: **⚙ Project Settings → Script Properties → Add script property**:
   - Property: `GEMINI_KEY`
   - Value: *(paste your key)*

Keys live only in Script Properties. Never paste a key into a code file.

### 4. Run `firstRun()` — the self-provisioning step

1. Back in the **Editor**, in the function dropdown (toolbar), choose **`firstRun`**.
2. Click **Run**. Google will ask you to authorize — review and allow (it needs Sheets, Drive, Gmail, Calendar for its features; the code is all in front of you).
3. When it finishes, open **Executions** (left sidebar) or the log: it prints the URL of your brand-new tracker spreadsheet.

What `firstRun()` did for you — no manual IDs anywhere:
- Created a spreadsheet **"AgentATS Tracker"** and a Drive folder **"AgentATS CVs"** in your account.
- Stored their ids in Script Properties (`SHEET_ID`, `FOLDER_ID`) — the app reads them from there forever after.
- Built every tab (Tracker, Requisitions, Users, headers, candidate IDs).
- Added **you** as the Admin user with a personal access token.

It's safe to run again — it never overwrites an existing install. **Run it before deploying.**

### 5. Deploy the web app

1. **Deploy → New deployment → ⚙ Select type → Web app.**
2. *Execute as:* **Me**. *Who has access:* **Anyone**. (Required so your public careers page works. Your data stays protected — every internal action is checked server-side against the Users tab and per-person tokens.)
3. Click **Deploy** and copy the web app URL (ends in `/exec`).

Open the URL — that's your ATS. In the app, use the **Team** section to add colleagues; each gets a personal link (`...?u=THEIRTOKEN`). Share those links privately, like passwords.

### 6. Enable the public careers page

It's already live: your web app URL + **`?page=apply`**

`https://script.google.com/macros/s/…/exec?page=apply`

Put that link on your website, LinkedIn, or job posts. Applications (with CV upload) land directly in your pipeline, get parsed and scored automatically. Intake is rate-capped (200/day) and CVs are limited to 5 MB.

### 7. Enable CV-by-email (optional — `CvForwarder.gs`)

If you have a `careers@yourcompany.com` (or any) mailbox that receives CVs:

1. In the **main** AgentATS project, add a Script Property `WEBHOOK_SECRET` with a long random value (20+ characters — mash the keyboard).
2. Sign in **as the careers@ account**, go to script.google.com → **New project**, and paste all of `CvForwarder.gs`.
3. At the top of that file, fill in the two clearly marked values:
   - `APP_EXEC_URL` → your web app URL from step 5 (the one ending in `/exec`).
   - `INGEST_SECRET` → the same value you put in `WEBHOOK_SECRET`.
4. Run `setup` once and authorize. Done — every emailed CV is now parsed into the ATS within 5 minutes, with automatic retries and a daily alert email if anything ever backs up.

### 8. Optional extras

- **Interview feedback form**: run `createFeedbackForm` once from the editor.
- **Notifications**: in-app **🏢 Company** settings — add an alerts email and/or a Google Chat webhook URL.
- **Analytics dashboard**: in **📈 Analytics**, click *Build / refresh dashboard data*, then connect Looker Studio to the generated tab.

---

## Path B — "Make a copy" template (easiest, for non-technical users)

The friendliest distribution is a **template spreadsheet with the script attached**: the user opens a link, clicks **File → Make a copy**, and gets the whole system in their own account — no pasting at all. Then they only do steps 3–5 above (add `GEMINI_KEY`, run `firstRun`, deploy).

**For maintainers — how to publish one:**
1. Do a fresh Path A install in a clean Google account, but as a *container-bound* script: create a blank Sheet → **Extensions → Apps Script** → paste the files there.
2. Make sure Script Properties are **empty** (properties don't copy anyway — which is exactly why no secrets can leak through a template).
3. Set the Sheet's sharing to *Anyone with the link — Viewer* and publish the copy link:
   `https://docs.google.com/spreadsheets/d/TEMPLATE_ID/copy`
4. Every "Make a copy" gives the user their own private copy of both the Sheet and the code.

---

## Troubleshooting

- **"GEMINI_KEY not set in Script Properties"** — step 3 was skipped; add the property and retry.
- **App loads but says you need a personal access link** — open it through your `?u=` link (see Team section), or as the account owner just sign in with the owning Google account.
- **Careers page won't upload a CV** — files must be PDF/DOC/DOCX under 5 MB.
- **CV forwarder does nothing** — run its `setup` again; it refuses to run until both config values are truly filled in (that's deliberate, so CVs are never silently dropped).
- **Changed the code after deploying?** — Deploy → Manage deployments → ✏ Edit → *New version* → Deploy. The URL stays the same.
