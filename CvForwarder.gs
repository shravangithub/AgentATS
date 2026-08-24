/**
 * AgentATS — Inbound CV forwarder (runs ON the careers@ mailbox).
 *
 * C-5 FIX — this script now feeds THIS Apps Script ATS, not the new brain:
 *  · CVs are POSTed to the production web app's own /exec endpoint
 *    (doPost action:'ingest_cv' → parseDocument_/candidate row in the Tracker),
 *    so email applicants land in the same sheet as everyone else.
 *  · A thread is labeled processed ONLY when every CV in it was accepted
 *    (HTTP 200 + ok:true). On any failure the thread stays unlabeled and is
 *    retried automatically on the next run — CVs are never silently lost.
 *  · No placeholder secret: setup() and every run REFUSE to work until both
 *    CONFIG values are really filled in. The secret must equal the Script
 *    Property WEBHOOK_SECRET of the main AgentATS project.
 *  · After 3 consecutive failing runs, the mailbox owner gets ONE alert email
 *    per day ("CVs are queuing up") instead of failing silently.
 *
 * SETUP (5 minutes, no terminal):
 *  1. While signed in as careers@…, open script.google.com → New project.
 *  2. Paste ALL of this file. Fill in the two CONFIG values below:
 *       APP_EXEC_URL  = the AgentATS web app /exec URL (Deploy → Manage deployments).
 *       INGEST_SECRET = the exact value of Script Property WEBHOOK_SECRET
 *                       in the main AgentATS Apps Script project.
 *  3. Run `setup` once (authorize when asked) — it validates the config, does a
 *     first pass, and creates the every-5-minutes trigger. Done.
 *
 * SECURITY: this script runs inside the careers@ account; the secret travels
 * only from Google to your own web app over HTTPS. It reads mail and adds one
 * label; it never deletes or sends anything.
 */

// ── CONFIG — fill these two in ────────────────────────────────────────────
var APP_EXEC_URL  = 'PASTE-YOUR-EXEC-URL';   // the AgentATS web app URL ending in /exec (Deploy → Manage deployments)
var INGEST_SECRET = 'PASTE-YOUR-WEBHOOK_SECRET';  // MUST equal Script Property WEBHOOK_SECRET in the main AgentATS project
// ──────────────────────────────────────────────────────────────────────────

var LABEL_DONE = 'agentats-processed';
var CV_MIMES = {
  'application/pdf': true,
  'application/msword': true,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': true
};
var MAX_BYTES = 5 * 1024 * 1024;   // 5 MB — same cap as the ATS
var ALERT_AFTER_FAILED_RUNS = 3;   // consecutive failing runs before the owner is emailed

// C-5: hard fail on placeholder config — never run half-configured (the old version
// happily POSTed with a placeholder secret, got 401s, and still labeled threads done).
function assertConfigured_() {
  if (!/^https:\/\/script\.google\.com\/.+\/exec/.test(APP_EXEC_URL))
    throw new Error('CONFIG ERROR: APP_EXEC_URL is not filled in — paste the AgentATS web app /exec URL at the top of CvForwarder.gs.');
  if (!INGEST_SECRET || INGEST_SECRET.indexOf('PASTE-') === 0 || INGEST_SECRET.length < 12)
    throw new Error('CONFIG ERROR: INGEST_SECRET is not filled in — paste the WEBHOOK_SECRET value (12+ chars) from the AgentATS Script Properties.');
}

/** Run ONCE by hand: validates config, creates the label + the every-5-minutes trigger. */
function setup() {
  assertConfigured_();
  if (!GmailApp.getUserLabelByName(LABEL_DONE)) GmailApp.createLabel(LABEL_DONE);  // idempotent: don't recreate if it already exists
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(5).create();
  processInbox();                                   // first pass right away
  Logger.log('Setup complete — CV forwarding to the AgentATS ATS is live.');
}

/**
 * The worker: new inbox threads with attachments → AgentATS ATS → label done.
 * C-5: label ONLY on success; failures stay unlabeled and are retried every 5 min
 * (search window 7d, so even a multi-day outage loses nothing).
 */
function processInbox() {
  assertConfigured_();
  var label = GmailApp.getUserLabelByName(LABEL_DONE) || GmailApp.createLabel(LABEL_DONE);
  var threads = GmailApp.search(
    'in:inbox has:attachment newer_than:7d -label:' + LABEL_DONE, 0, 20);
  var anyFailure = false;
  threads.forEach(function (thread) {
    var ok = false;
    try {
      ok = forwardThread_(thread);                  // true = every CV in the thread accepted
    } catch (e) {
      ok = false;
      Logger.log('thread failed (WILL retry next run): ' + e);
    }
    if (ok) label.addToThread(thread);              // C-5: success only — never label a failure
    else anyFailure = true;
  });
  trackFailures_(anyFailure);
}

/** Returns true only if EVERY qualifying CV attachment in the thread was accepted by the ATS. */
function forwardThread_(thread) {
  var allOk = true;
  thread.getMessages().forEach(function (msg) {
    var atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
    for (var i = 0; i < atts.length; i++) {
      var att = atts[i];
      var mime = String(att.getContentType() || '').toLowerCase().split(';')[0];
      if (!CV_MIMES[mime]) continue;                // images/invoices in odd formats: skip
      if (att.getSize() > MAX_BYTES) continue;      // the ATS would refuse it anyway
      var payload = {
        action: 'ingest_cv',                        // routed by AgentATS doPost → ingestCvFromEmail_
        secret: INGEST_SECRET,                      // H-3/C-5: authenticated against WEBHOOK_SECRET
        from_email: extractAddress_(msg.getFrom()),
        subject: String(msg.getSubject() || '').slice(0, 300),
        body_text: String(msg.getPlainBody() || '').slice(0, 2000),
        attachment_base64: Utilities.base64Encode(att.getBytes()),
        attachment_mime: mime,
        attachment_name: String(att.getName() || 'resume').slice(0, 120)
      };
      var res = UrlFetchApp.fetch(APP_EXEC_URL, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        followRedirects: true,                      // /exec answers via a 302 to a content URL
        muteHttpExceptions: true                    // never crash the trigger; failure = retry
      });
      var code = res.getResponseCode(), body = String(res.getContentText() || '');
      var j = null; try { j = JSON.parse(body); } catch (e) { j = null; }
      // Success = HTTP 2xx AND the app said ok:true (a deliberate "not a CV" skip counts as done).
      if (code < 200 || code >= 300 || !j || j.ok !== true) {
        allOk = false;
        Logger.log('ingest_cv REJECTED (' + code + ') — will retry: ' + body.slice(0, 200));
      } else {
        Logger.log('ingest_cv → ok' + (j.candId ? ' (' + j.candId + (j.updated ? ', existing candidate updated' : '') + ')' : (j.skipped ? ' (skipped: ' + (j.reason || 'not a CV') + ')' : '')));
      }
    }
  });
  return allOk;
}

/** C-5: after N consecutive failing runs, email the mailbox owner once a day instead of failing silently. */
function trackFailures_(anyFailure) {
  var p = PropertiesService.getScriptProperties();
  if (!anyFailure) { p.deleteProperty('CVFWD_FAILS'); return; }
  var n = parseInt(p.getProperty('CVFWD_FAILS') || '0', 10) + 1;
  p.setProperty('CVFWD_FAILS', String(n));
  if (n < ALERT_AFTER_FAILED_RUNS) return;
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  if (p.getProperty('CVFWD_ALERTED') === today) return;       // max one alert per day
  p.setProperty('CVFWD_ALERTED', today);
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      '⚠️ AgentATS CV forwarder: CVs are queuing up',
      'The careers@ CV forwarder has failed ' + n + ' runs in a row.\n' +
      'No CV is lost — unprocessed threads stay unlabeled and retry every 5 minutes — ' +
      'but nothing is reaching the ATS right now.\n\n' +
      'Check: (1) the AgentATS web app is deployed and APP_EXEC_URL is current;\n' +
      '(2) INGEST_SECRET here equals Script Property WEBHOOK_SECRET in the AgentATS project;\n' +
      '(3) the Apps Script executions log of both projects for errors.');
  } catch (e) { Logger.log('alert email failed: ' + e); }
}

function extractAddress_(from) {
  var m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}
