# Publishing AgentATS to GitHub (no coding required)

This folder is ready to publish as-is. It contains **code and docs only** — no API keys, no spreadsheet IDs, no personal data. Keep it that way: **Script Property values (GEMINI_KEY, WEBHOOK_SECRET, SHEET_ID, FOLDER_ID) live only inside your Apps Script project and must never be committed.**

## Easiest path — the GitHub website (5 minutes)

1. Create a free account at [github.com](https://github.com) if you don't have one.
2. Click the **+** (top-right) → **New repository**.
   - Repository name: `agentats` (or any name you like)
   - Description: *"An open-source, AI-native ATS that runs entirely inside your own Google account — free forever."*
   - Visibility: **Public**
   - Leave everything else unticked → **Create repository**.
3. On the new empty-repo page, click the link **"uploading an existing file"**.
4. Open this `agentats-oss` folder on your computer and **drag all the files** into the browser window:
   `README.md`, `SETUP.md`, `LICENSE`, `CONTRIBUTING.md`, `PUBLISH_TO_GITHUB.md` (optional), `.gitignore`, `appsscript.json`, `Code.gs`, `TalentRubric.gs`, `CvForwarder.gs`, `Index.html`, `Apply.html`, `Source.html`.
   *(Tip: hidden files like `.gitignore` — press Cmd-Shift-. in Finder / enable "Hidden items" in Windows Explorer to see it.)*
5. Commit message: `Initial release` → click **Commit changes**.

Done — your README appears automatically as the project homepage. Add topics like `ats`, `recruiting`, `apps-script`, `hr` under ⚙ *About* so people can find it.

## Alternative — git command line

```bash
cd agentats-oss
git init
git add .
git commit -m "Initial release"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/agentats.git
git push -u origin main
```

## Before you ever push an update

- Never add screenshots containing real candidate names/emails.
- Never paste your web app `/exec` URL, Sheet URL, or any Script Property value into code, issues, or docs.
- If a secret ever slips into a commit: rotate it immediately (new GEMINI_KEY / WEBHOOK_SECRET) — deleting the commit is not enough.
