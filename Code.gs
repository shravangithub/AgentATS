/***** AgentATS — complete Apps Script backend (Code.gs) *****/

// ---------- CONFIG ----------
// SHEET_ID / FOLDER_ID are NEVER hardcoded. They live in Script Properties and are
// created automatically the first time you run firstRun() (see ONE-TIME SETUP below).
var SHEET_ID     = PropertiesService.getScriptProperties().getProperty('SHEET_ID')  || '';
var FOLDER_ID    = PropertiesService.getScriptProperties().getProperty('FOLDER_ID') || '';
var SEARCH_LABEL = 'Applications';
var DONE_LABEL   = 'AgentATS-Done';
var APPLY_DAILY_CAP = 200;
var MAX_RESUME_MB   = 5;
var GEMINI_MODEL = 'gemini-2.5-flash';

// ---------- SECURITY LAYER (fixes C-1, C-2, C-3) ----------
// The web app must stay deployed "Execute as: me / Who has access: Anyone" so the public
// careers page works. That means Session.getActiveUser() is EMPTY for most visitors, so
// identity comes from each teammate's personal ?u= token (Users sheet, column 5 "Token").
// Index.html automatically appends that token to EVERY server call as one extra final
// argument that looks like "#tok:abc123". The helpers below verify it server-side.
var TOKEN_MARK_ = '#tok:';
var AUTH_USER_ = null; // the verified caller for THIS execution (set once, reused everywhere)

// Pulls the "#tok:..." marker the web page appends as the last argument of a call.
// Internal server-to-server calls never carry the marker, so they are never mistaken for it.
function extractToken_(callerArgs) {
  try {
    if (callerArgs && callerArgs.length) {
      var last = callerArgs[callerArgs.length - 1];
      if (typeof last === 'string' && last.indexOf(TOKEN_MARK_) === 0) return last.slice(TOKEN_MARK_.length);
    }
  } catch (e) {}
  return '';
}

// C-1: looks a token up in the Users sheet. Returns {email, name, role, active, title} or null.
// The ROLE always comes from the sheet — never from anything the browser claims.
function currentUserFromToken_(token) {
  if (!token) return null;
  try {
    var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Users');
    if (!sh) return null;
    var d = sh.getDataRange().getValues();
    for (var i = 1; i < d.length; i++) {
      if (d[i][4] && (d[i][4] || '').toString() === token.toString()) {
        if ((d[i][3] || '').toString().toLowerCase() === 'no') return null; // deactivated
        return { email: (d[i][0] || '').toString().toLowerCase(), name: (d[i][1] || d[i][0] || '').toString(),
                 role: (d[i][2] || '').toString(), active: true, title: (d[i][5] || '').toString() };
      }
    }
  } catch (e) {}
  return null;
}

// Role ladder. Unknown/blank roles rank 0 = no access.
function roleRank_(role) { return { Interviewer: 1, HiringManager: 2, Recruiter: 3, Admin: 4 }[role] || 0; }

// C-1: central authorization check. Returns the verified user, or { error: '...' }.
// minRole: 'Interviewer' (any active team member) < 'HiringManager' < 'Recruiter' < 'Admin'.
function requireRole_(token, minRole) {
  var u = currentUserFromToken_(token);
  if (!u && AUTH_USER_) u = AUTH_USER_;   // already verified earlier in this execution
  if (!u) { var s = currentUser_(); if (s && s.role) u = s; } // Google sign-in fallback (owner)
  if (!u || !u.role) return { error: '🔒 Please open AgentATS through your personal access link (ask your admin for it).' };
  if (roleRank_(u.role) < roleRank_(minRole || 'Interviewer'))
    return { error: '🔒 Sorry ' + (u.name || u.email) + ' — your role (' + u.role + ') is not allowed to do that.' };
  AUTH_USER_ = u;
  return u;
}

// Convenience: pass the calling function's own `arguments` straight in.
function guard_(callerArgs, minRole) { return requireRole_(extractToken_(callerArgs), minRole); }

// C-2: OWASP formula/CSV-injection guard. A value like "=IMPORTXML(...)" written to the
// sheet would EXECUTE as a live formula and could exfiltrate other tabs. Prefixing a single
// apostrophe makes Google Sheets store it as harmless literal text.
function sanitizeCell_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? ("'" + v) : v;
}
function sanitizeRow_(arr) { return (arr || []).map(sanitizeCell_); }

// H-1: serialize ID minting + row appends. The hourly trigger, the public Apply form and
// interactive users all append rows concurrently; without a lock two executions can mint the
// same CAND-XXXX or write their ID/phone into the OTHER execution's row (appendRow+getLastRow
// is not atomic). Every intake path wraps its append+ID block in this.
function withScriptLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // up to 30s; throws if the sheet is that busy (caller surfaces the error)
  try { return fn(); } finally { lock.releaseLock(); }
}

// H-2: ONE canonical stage vocabulary. Debrief decisions used to write 'Advanced (Debrief)' /
// 'Rejected (Debrief)' which existed nowhere in the analytics funnel or the archive terminal
// list, so those candidates were mis-counted forever. All stage READS (analytics, archive)
// normalize through this map, so legacy rows already in the sheet are counted correctly too.
function canonStage_(s) {
  s = (s || '').toString().trim().toLowerCase();
  var MAP = {
    'advanced (debrief)': 'selected',       // legacy debrief-advance → canonical 'Selected'
    'rejected (debrief)': 'debrief reject', // legacy debrief-reject  → canonical 'Debrief Reject'
    'on hold': 'debrief',                   // still under debrief consideration (not terminal)
    'hired': 'onboarded'                    // alias
  };
  return MAP[s] || s;
}

// H-3: authenticate inbound webhooks (Slack slash command, generic JSON, CV forwarder) BEFORE
// any read/write. The secret lives in Script Property WEBHOOK_SECRET and is sent either as a
// ?secret= query param on the webhook URL or as a "secret" field in the JSON body.
// Fails CLOSED: if the property is unset, every doPost write is rejected.
function webhookSecretOk_(e, p) {
  var want = '';
  try { want = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET') || ''; } catch (err) {}
  if (!want) return false;
  var got = (((e && e.parameter && e.parameter.secret) || (p && p.secret) || '')).toString();
  if (!got || got.length !== want.length) return false;
  var diff = 0; // constant-time compare
  for (var i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}


// ---------- WEB APP ENTRY ----------
function doGet(e) {
  var p = (e && e.parameter && e.parameter.page) || '';
  var file = p === 'apply' ? 'Apply' : (p === 'source' ? 'Source' : 'Index');
  return HtmlService.createHtmlOutputFromFile(file)
    .setTitle('AgentATS').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------- PER-REQUISITION INTERVIEW PLAN / RUBRIC ----------
function suggestInterviewPlan(reqId) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return _g.error; // C-1: server-side auth
  var rq = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions').getDataRange().getValues();
  var title = '', level = '';
  for (var i = 1; i < rq.length; i++) if ((rq[i][0] || '').toString() === reqId.toString()) { title = rq[i][1]; level = rq[i][6]; break; }
  return callGemini('Design a structured interview loop for a ' + (level || '') + ' ' + (title || 'role') +
    '. Return ONLY JSON: {"rounds":[{"name":"","type":"","competencies":["",""]}]}. 4-6 rounds in the order they ' +
    'should happen, PLUS a final round named "Debrief" (type debrief, competencies: consolidate scores, hire decision). ' +
    'Types from screen/technical/case/behavioral/panel/hiring_manager/debrief; 3-5 competencies per round; grounded in ' +
    'I/O psychology and role norms (Stripe/FAANG style).', true);
}
function saveReqPlan(reqId, planJson) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return _g.error; // C-1: server-side auth
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), d = sh.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) if ((d[i][0] || '').toString() === reqId.toString()) { sh.getRange(i + 1, 16).setValue(planJson); return '✅ Interview plan saved for ' + reqId + '.'; }
  return 'Requisition not found.';
}
function getReqPlan(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return _g.error; // C-1: server-side auth
  var d = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions').getDataRange().getValues();
  for (var i = 1; i < d.length; i++) if ((d[i][0] || '').toString() === reqId.toString()) return (d[i][15] || '').toString();
  return '';
}
function getAppUrl() { return ScriptApp.getService().getUrl(); }

// ---------- LIVE SOURCING (Hacker News — free, official API, bot-safe) ----------
function reqJDText_(reqId) {
  if (!reqId) return 'General role fit.';
  var d = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions').getDataRange().getValues();
  for (var i = 1; i < d.length; i++) if ((d[i][0] || '').toString() === reqId.toString())
    return (d[i][1] || '') + ' (' + (d[i][6] || '') + ', ' + (d[i][3] || '') + '). ' + (d[i][17] || '');
  return 'General role fit.';
}
function scoreSourced_(items, jd) {
  if (!items.length) return;
  var list = items.map(function (p, i) { return (i + 1) + '. ' + (p.author || '') + ': ' + (p.text || '').substring(0, 500); }).join('\n\n');
  try {
    var arr = JSON.parse(callGemini('Score each candidate snippet 0-100 for fit against this job. Return ONLY a JSON array of numbers in order.\nJOB: ' + jd + '\n\nCANDIDATES:\n' + list, true));
    items.forEach(function (p, i) { p.score = (typeof arr[i] === 'number') ? arr[i] : ''; });
  } catch (e) { items.forEach(function (p) { p.score = ''; }); }
}
function sourceHN(reqId, keywords) {
  try {
    var s = JSON.parse(UrlFetchApp.fetch('https://hn.algolia.com/api/v1/search_by_date?query=' + encodeURIComponent('who wants to be hired') + '&tags=story&hitsPerPage=8', { muteHttpExceptions: true }).getContentText());
    var thread = null;
    (s.hits || []).forEach(function (h) { if (!thread && /who wants to be hired/i.test(h.title || '')) thread = h; });
    if (!thread) return { error: 'No hiring thread found right now.' };
    var it = JSON.parse(UrlFetchApp.fetch('https://hn.algolia.com/api/v1/items/' + thread.objectID, { muteHttpExceptions: true }).getContentText());
    var kws = (keywords || '').toLowerCase().split(/[,\s]+/).filter(Boolean), posts = [];
    (it.children || []).forEach(function (c) {
      if (!c.text) return;
      var txt = c.text.replace(/<[^>]+>/g, ' ').replace(/&#x2F;/g, '/').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
      var low = txt.toLowerCase();
      if (kws.length && !kws.some(function (k) { return low.indexOf(k) > -1; })) return;
      posts.push({ author: c.author || '(anon)', text: txt.substring(0, 700),
        url: 'https://news.ycombinator.com/item?id=' + c.id, date: (c.created_at || '').substring(0, 10), source: 'Hacker News' });
    });
    posts = posts.slice(0, 15);
    scoreSourced_(posts, reqJDText_(reqId));
    posts.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    return { thread: thread.title, count: posts.length, posts: posts };
  } catch (e) { return { error: e.message }; }
}
function addSourcedCandidate(o) {
  var u = currentUser_(arguments);
  if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins can add candidates.';
  var sheet = trackerSheet_();
  var r = withScriptLock_(function () { // H-1: atomic append + ID mint
    sheet.appendRow(sanitizeRow_([new Date(), o.name || '(sourced)', o.email || '', '', o.source || 'Sourced', o.url || '', 'New', o.score || '', (o.notes || '').substring(0, 300), '', ''])); // C-2: sourced (HN) text
    var rr = sheet.getLastRow(); sheet.getRange(rr, 31).setValue(nextCandidateId_()); return rr;
  });
  if (o.reqId) sheet.getRange(r, 12).setValue(sanitizeCell_(o.reqId));
  bustCache_(); // M-3: new candidate must appear in the board/pipeline immediately (caches are keyed on CACHE_VER)
  return '✅ Added ' + (o.name || 'sourced candidate') + ' to the pipeline.';
}

// ---------- ONE-TIME SETUP (run each once from the editor) ----------
/**
 * firstRun() — run this ONCE from the Apps Script editor on a fresh install.
 * Self-provisioning: if no SHEET_ID / FOLDER_ID Script Properties exist yet, it
 * CREATES a new Google Spreadsheet ("AgentATS Tracker") and a Drive folder
 * ("AgentATS CVs"), stores both ids in Script Properties, builds every tab,
 * seeds YOU as the Admin user, and logs the new Sheet URL. No manual ids needed.
 * Safe to re-run: it never overwrites an existing SHEET_ID/FOLDER_ID.
 * Run firstRun() BEFORE you deploy the web app.
 */
function firstRun() {
  var p = PropertiesService.getScriptProperties();

  // 1) Spreadsheet: reuse the stored one, or create a fresh tracker.
  var sheetId = p.getProperty('SHEET_ID') || '';
  if (!sheetId) {
    var created = SpreadsheetApp.create('AgentATS Tracker');
    created.getSheets()[0].setName('Tracker');
    sheetId = created.getId();
    p.setProperty('SHEET_ID', sheetId);
  }
  SHEET_ID = sheetId; // repopulate the global so every openById(SHEET_ID) below works NOW

  // 2) Drive folder for incoming CVs.
  var folderId = p.getProperty('FOLDER_ID') || '';
  if (!folderId) {
    folderId = DriveApp.createFolder('AgentATS CVs').getId();
    p.setProperty('FOLDER_ID', folderId);
  }
  FOLDER_ID = folderId;

  // 3) Base tabs + headers.
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var tracker = ss.getSheetByName('Tracker') || ss.insertSheet('Tracker');
  ensureHeaders(tracker);                                   // cols 1-9 core headers
  tracker.getRange(1, 10, 1, 2).setValues([['Interview Date', 'Dossier']]).setFontWeight('bold');
  var users = ss.getSheetByName('Users') || ss.insertSheet('Users');
  users.getRange(1, 1, 1, 6).setValues([['Email', 'Name', 'Role', 'Active', 'Token', 'Title']]).setFontWeight('bold');

  // 4) Seed the person running this as the Admin (before any guarded setup call).
  var me = (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (users.getLastRow() < 2 && me) users.appendRow([me, 'Recruiting Manager', 'Admin', 'Yes', '', '']);
  ensureUserTokens_();                                      // mint the personal ?u= access token
  AUTH_USER_ = { email: me, name: me || 'Owner', role: 'Admin', active: true }; // editor run = owner

  // 5) Build the full schema (requisitions, candidate columns, candidate ids).
  setupAtsTabs();
  addCandidateIdColumn();

  var url = ss.getUrl();
  Logger.log('AgentATS is ready. Your tracker: ' + url);
  Logger.log('Next: set Script Property GEMINI_KEY, then Deploy > New deployment > Web app.');
  return 'AgentATS is ready. Tracker: ' + url;
}

function setupAtsTabs() {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return _g.error; // C-1: server-side auth
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var reqHeaders = ['Req ID','Title','Department','Line of Business','Location','Employment Type','Level',
    'Hiring Manager','Recruiter','Openings','Priority','Salary Min','Salary Max','Status',
    'Date Opened','Rubric Template','JD Link','Notes',
    'Calibration Files','Calibration Voice','Calibration Transcript','Calibration Brief','Calibration Notes','Fit Config','Benchmark','HM Email',
    'Success Profile','Success Context']; // M-2: cols 27-28 were written headerless → excluded from Supabase sync + backups
  var req = ss.getSheetByName('Requisitions') || ss.insertSheet('Requisitions');
  req.getRange(1, 1, 1, reqHeaders.length).setValues([reqHeaders]).setFontWeight('bold');
  var tracker = ss.getSheetByName('Tracker');
  if (!tracker) throw new Error('No tab named "Tracker" — rename your main tab to Tracker first.');
  var newCols = ['Req ID','Phone','Current Location','Outstation','Willing to Relocate',
    'Work Mode Preference','Current Company','Current Title','Total Experience (yrs)','Skills',
    'Highest Qualification','Notice Period','Current CTC','Expected CTC','Offer in Hand',
    'Work Authorization','Reason for Change','HR Remarks','Gender'];
  tracker.getRange(1, 12, 1, newCols.length).setValues([newCols]).setFontWeight('bold');
  tracker.getRange(1, 32, 1, 4).setValues([['First Name', 'Middle Name', 'Last Name', 'LinkedIn URL']]).setFontWeight('bold');
  tracker.getRange(1, 36, 1, 1).setValue('Skill Graph').setFontWeight('bold');
  tracker.getRange(1, 37, 1, 1).setValue('Highlights').setFontWeight('bold');
  tracker.getRange(1, 38, 1, 1).setValue('GitHub').setFontWeight('bold');
  tracker.getRange(1, 39, 1, 1).setValue('Patents').setFontWeight('bold');
  tracker.getRange(1, 40, 1, 1).setValue('Rubric Snapshot').setFontWeight('bold');
  return 'ATS tabs ready.';
}
// One-time migration: split existing full names into First/Middle/Last for candidates added before the name fields existed.
function backfillCandidates() {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return _g.error; // C-1: server-side auth
  var sh = trackerSheet_(), d = sh.getDataRange().getValues(), n = 0;
  for (var i = 1; i < d.length; i++) {
    if (!d[i][1]) continue;
    var first = (d[i][31] || '').toString().trim();
    if (first) continue; // already split
    var parts = (d[i][1] || '').toString().trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    sh.getRange(i + 1, 32).setValue(parts[0]);
    if (parts.length > 1) sh.getRange(i + 1, 34).setValue(parts[parts.length - 1]);
    if (parts.length > 2) sh.getRange(i + 1, 33).setValue(parts.slice(1, -1).join(' '));
    n++;
  }
  return '✅ Backfilled first/middle/last name for ' + n + ' candidate(s). Empty fields like email or title still need to be filled via Edit.';
}

function setupUsers() {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return _g.error; // C-1: server-side auth
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName('Users') || ss.insertSheet('Users');
  sh.getRange(1, 1, 1, 4).setValues([['Email', 'Name', 'Role', 'Active']]).setFontWeight('bold');
  var me = Session.getActiveUser().getEmail();
  if (sh.getLastRow() < 2 && me) sh.appendRow([me, 'Recruiting Manager', 'Admin', 'Yes']);
  return 'Users ready: ' + me;
}

function addCandidateIdColumn() {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return _g.error; // C-1: server-side auth
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Tracker');
  sh.getRange(1, 31).setValue('Candidate ID').setFontWeight('bold');
  var last = sh.getLastRow(), seq = 0;
  for (var r = 2; r <= last; r++)
    if (!sh.getRange(r, 31).getValue()) { seq++; sh.getRange(r, 31).setValue('CAND-' + ('0000' + seq).slice(-4)); }
  PropertiesService.getScriptProperties().setProperty('CAND_SEQ', String(Math.max(seq, last - 1)));
  return 'Candidate ID column ready.';
}

function repairSheets() {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return _g.error; // C-1: server-side auth
  var ss = SpreadsheetApp.openById(SHEET_ID), feedback = null, tracker = null;
  ss.getSheets().forEach(function (s) {
    var lc = Math.max(1, s.getLastColumn());
    var h = s.getRange(1, 1, 1, lc).getValues()[0].join('|');
    if (h.indexOf('Your name (interviewer)') > -1) feedback = s;
    if (h.indexOf('Date Received') > -1) tracker = s;
  });
  if (!tracker) return 'ERROR: could not find the real tracker (no "Date Received" header). Tell Claude.';
  if (feedback && feedback.getName() === 'Tracker') feedback.setName('Form Responses');
  tracker.setName('Tracker');
  var cols = ['Req ID','Phone','Current Location','Outstation','Willing to Relocate','Work Mode Preference',
    'Current Company','Current Title','Total Experience (yrs)','Skills','Highest Qualification','Notice Period',
    'Current CTC','Expected CTC','Offer in Hand','Work Authorization','Reason for Change','HR Remarks',
    'Gender','Candidate ID']; // M-1/L-1: canonical header is 'Gender' (was 'Gender (optional)' here but 'Gender' in setupAtsTabs — the drift broke chat update_details)
  tracker.getRange(1, 12, 1, cols.length).setValues([cols]).setFontWeight('bold');
  var cleaned = 0;
  if (feedback && feedback.getLastColumn() >= 31) {
    var data = feedback.getDataRange().getValues();
    for (var r = data.length - 1; r >= 1; r--)
      if ((data[r][30] || '').toString().indexOf('CAND-') === 0) { feedback.deleteRow(r + 1); cleaned++; }
  }
  return 'Repaired. "Tracker" now points to the real candidate sheet; cleaned ' + cleaned + ' misplaced rows from the feedback sheet.';
}

function createFeedbackForm() {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return _g.error; // C-1: server-side auth
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var form = FormApp.create('AgentATS — Interview Feedback');
  form.setDescription('Structured candidate feedback. Score on evidence, not impression.');
  form.addTextItem().setTitle('Candidate name').setRequired(true);
  form.addTextItem().setTitle('Candidate email').setRequired(true);
  form.addTextItem().setTitle('Your name (interviewer)').setRequired(true);
  form.addTextItem().setTitle('Role').setRequired(false);
  var scale = ['1 - Weak', '2', '3 - Solid', '4', '5 - Outstanding'];
  ['Technical skill', 'Ownership', 'Communication & collaboration', 'Problem solving'].forEach(function (c) {
    form.addMultipleChoiceItem().setTitle(c).setChoiceValues(scale).setRequired(true);
  });
  form.addParagraphTextItem().setTitle('Key strengths (with evidence)').setRequired(true);
  form.addParagraphTextItem().setTitle('Concerns / risks').setRequired(false);
  form.addMultipleChoiceItem().setTitle('Overall recommendation')
      .setChoiceValues(['Strong Hire', 'Hire', 'No Hire', 'Strong No Hire']).setRequired(true);
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  Logger.log('SHARE THIS FORM: ' + form.getPublishedUrl());
  return form.getPublishedUrl();
}

// ---------- INTAKE (Gmail -> Drive -> Tracker) : give this an hourly trigger ----------
function processApplications() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var sheet  = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Tracker');
  ensureHeaders(sheet);
  var doneLabel = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  var query = 'label:' + SEARCH_LABEL.toLowerCase().replace(/ /g, '-') + ' -label:' + DONE_LABEL.toLowerCase() + ' has:attachment';
  var anyAdded = false;
  GmailApp.search(query, 0, 20).forEach(function (thread) {
    var added = false;
    thread.getMessages().forEach(function (msg) {
      // M-4 FIX: one candidate row per MESSAGE (was: one row per attachment — a CV + cover
      // letter, both .pdf, created 2-3 duplicate rows). The first document is the resume;
      // extra files are saved to Drive and linked in the notes of the same row.
      var from = msg.getFrom(), m = from.match(/^(.*?)\s*<(.+?)>/);
      var candidate = m ? m[1].replace(/"/g, '').trim() : from;
      var email = ((m ? m[2] : from) || '').toString().trim();
      var mainRow = 0, extraFiles = [];
      msg.getAttachments().forEach(function (att) {
        if (!/\.(pdf|docx?|pptx?|rtf|odt|txt|pages)$/i.test(att.getName())) return;
        var file = folder.createFile(att.copyBlob()).setName(att.getName());
        if (mainRow) { extraFiles.push(att.getName() + ': ' + file.getUrl()); return; }
        // M-4 FIX: dedupe by sender email — a reply on the same thread (or a re-send) updates
        // the existing row's resume link instead of minting a duplicate candidate.
        var existing = email ? findCandidateByAny_('', email) : null;
        if (existing) {
          var exRow = findRowById_(sheet, existing.candId);
          if (exRow > 0) {
            sheet.getRange(exRow, 6).setValue(file.getUrl()); // latest resume
            var nc = sheet.getRange(exRow, 9), oldN = (nc.getValue() || '').toString();
            nc.setValue(sanitizeCell_((oldN ? oldN + ' | ' : '') + 'New email ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy') + ': ' + (msg.getSubject() || '').slice(0, 120))); // C-2
            mainRow = exRow; added = true; anyAdded = true;
            return;
          }
        }
        withScriptLock_(function () { // H-1: atomic append + ID mint (this runs on the hourly trigger)
          sheet.appendRow(sanitizeRow_([new Date(), candidate, email, '', 'Email', file.getUrl(), 'New', '', msg.getSubject()])); // C-2: email intake
          mainRow = sheet.getLastRow();
          sheet.getRange(mainRow, 31).setValue(nextCandidateId_());
        });
        added = true; anyAdded = true;
      });
      if (mainRow && extraFiles.length) { // link the extra attachments on the same row
        var xc = sheet.getRange(mainRow, 9), xo = (xc.getValue() || '').toString();
        xc.setValue(sanitizeCell_((xo ? xo + ' | ' : '') + 'Also attached: ' + extraFiles.join('; '))); // C-2
      }
    });
    if (added) thread.addLabel(doneLabel);
  });
  if (anyAdded) bustCache_(); // M-3: make email-intake candidates visible immediately
}
function ensureHeaders(sheet) {
  if (!sheet.getRange(1, 1).getValue())
    sheet.getRange(1, 1, 1, 9).setValues([['Date Received','Candidate Name','Email','Role','Source','Resume Link','Stage','Score','Notes']]);
}

// ---------- SCHEDULING (LEGACY — disabled by default; see M-9) ----------
// M-9 FIX: this old sheet-driven scheduler coexisted with scheduleInterview2 (the real system,
// which writes the Interviews tab + RSVP tracking). If its hourly trigger was still installed,
// candidates with stage "Interview" + a date in col 10 got DOUBLE-BOOKED events invisible to
// getInterviews/metrics. It now no-ops unless you explicitly set Script Property
// LEGACY_SCHEDULER=on. Use 📅 Schedule in the app (scheduleInterview2) instead.
function scheduleInterviews() {
  if (PropertiesService.getScriptProperties().getProperty('LEGACY_SCHEDULER') !== 'on') {
    Logger.log('scheduleInterviews: legacy scheduler disabled (M-9). Use the in-app scheduler; set LEGACY_SCHEDULER=on to re-enable.');
    return;
  }
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Tracker');
  var data = sheet.getDataRange().getValues();
  var cal = CalendarApp.getDefaultCalendar();
  for (var r = 1; r < data.length; r++) {
    var row = data[r], stage = (row[6] || '').toString().trim().toLowerCase(), when = row[9], email = (row[2] || '').toString().trim();
    if (stage === 'interview' && when && email) {
      var start = new Date(when);
      if (isNaN(start.getTime())) { sheet.getRange(r + 1, 10).setNote('Bad date — use 2026-06-06 18:30'); continue; }
      var end = new Date(start.getTime() + 45 * 60000);
      cal.createEvent('Interview: ' + row[1] + (row[3] ? ' — ' + row[3] : ''), start, end,
        { guests: email, sendInvites: true, description: 'AgentATS interview.\nResume: ' + (row[5] || '') });
      sheet.getRange(r + 1, 7).setValue('Interview Scheduled');
    }
  }
}

// ---------- DOSSIER EXPORT ----------
function exportDecidedCandidates() {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return _g.error; // C-1: server-side auth
  var ss = SpreadsheetApp.openById(SHEET_ID), sheet = ss.getSheetByName('Tracker');
  var data = sheet.getDataRange().getValues(), feedback = getFeedbackRows_(ss), folder = getOrCreateFolder_('AgentATS Records');
  for (var r = 1; r < data.length; r++) {
    var row = data[r], stage = (row[6] || '').toString().trim().toLowerCase();
    if (stage === 'selected' || stage === 'rejected') {
      var email = (row[2] || '').toString().trim().toLowerCase();
      var fbs = feedback.filter(function (f) { return f.email.toLowerCase() === email; });
      sheet.getRange(r + 1, 11).setValue(buildDossier_(row, fbs, folder));
    }
  }
}
function getFeedbackRows_(ss) {
  var sh = null;
  ss.getSheets().forEach(function (s) { if (s.getName().indexOf('Form Responses') === 0) sh = s; });
  if (!sh) return [];
  var d = sh.getDataRange().getValues(), h = d[0];
  function I(n) { return h.indexOf(n); }
  var rows = [];
  for (var i = 1; i < d.length; i++) {
    var x = d[i];
    rows.push({ email: (x[I('Candidate email')] || '').toString(), interviewer: x[I('Your name (interviewer)')] || '',
      rec: x[I('Overall recommendation')] || '', tech: x[I('Technical skill')] || '', own: x[I('Ownership')] || '',
      comm: x[I('Communication & collaboration')] || '', prob: x[I('Problem solving')] || '',
      strengths: x[I('Key strengths (with evidence)')] || '', concerns: x[I('Concerns / risks')] || '' });
  }
  return rows;
}
function getOrCreateFolder_(name) { var it = DriveApp.getFoldersByName(name); return it.hasNext() ? it.next() : DriveApp.createFolder(name); }
function buildDossier_(row, fbs, folder) {
  var doc = DocumentApp.create('Dossier - ' + row[1]), b = doc.getBody();
  b.appendParagraph('Candidate Dossier').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  b.appendParagraph(row[1] + '  (' + row[2] + ')');
  b.appendParagraph('Role: ' + (row[3] || '') + '   Decision: ' + row[6] + '   Screening score: ' + (row[7] || 'n/a'));
  b.appendParagraph('Resume: ' + (row[5] || ''));
  b.appendParagraph('Interview Feedback').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  if (!fbs.length) b.appendParagraph('No feedback submitted yet.');
  fbs.forEach(function (f) {
    b.appendParagraph(f.interviewer + ' — ' + f.rec).setHeading(DocumentApp.ParagraphHeading.HEADING3);
    b.appendParagraph('Scores — Tech: ' + f.tech + ', Ownership: ' + f.own + ', Comms: ' + f.comm + ', Problem solving: ' + f.prob);
    b.appendParagraph('Strengths: ' + f.strengths);
    if (f.concerns) b.appendParagraph('Concerns: ' + f.concerns);
  });
  doc.saveAndClose();
  var file = DriveApp.getFileById(doc.getId());
  var pdf = folder.createFile(file.getAs('application/pdf')).setName('Dossier - ' + row[1] + '.pdf');
  file.setTrashed(true);
  return pdf.getUrl();
}

// ---------- CHAT ASSISTANT ----------
function processMessage(message) {
  try {
    var u = currentUser_(arguments);
    if (!u.role) return "🔒 Your account (" + u.email + ") doesn't have access yet. Ask your admin to add you to the Users tab.";
    var parsed = JSON.parse(callGemini(buildIntentPrompt(message), true));
    var intent = (parsed.intent === 'unknown' || !parsed.intent) ? 'help' : parsed.intent;
    if (intent !== 'help' && !allowed_(u.role, intent))
      return "🔒 Sorry " + u.name + " — your role (" + u.role + ") can't do that action.";
    return routeIntent(parsed);
  } catch (e) { return '⚠️ ' + e.message; }
}
function buildIntentPrompt(msg) {
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
  return 'You parse messages for a recruiting ATS. Current date-time is ' + now + '. Return ONLY JSON. Intents:\n' +
  '- create_requisition (title, department, line_of_business, location, employment_type, level, hiring_manager, recruiter, openings, priority, salary_min, salary_max, notes)\n' +
  '- add_candidate (name, email, role, notes)\n' +
  '- update_details: tag candidate to a req or set HR fields. (name, email, fields). "fields" keys EXACTLY any of: "Req ID","Phone","Current Location","Outstation","Willing to Relocate","Work Mode Preference","Current Company","Current Title","Total Experience (yrs)","Skills","Highest Qualification","Notice Period","Current CTC","Expected CTC","Offer in Hand","Work Authorization","Reason for Change","HR Remarks","Gender". Only include mentioned keys.\n' + // M-1: header is 'Gender' — the old '"Gender (optional)"' key never matched, so chat could never set it
  '- update_status (name, email, status). Map the phrase to ONE of: New, CV Screen Reject, Screened, Shortlist, Interview, Interview Scheduled, Interview Reject, Debrief, Debrief Reject, Selected, Offered, Offer Declined, Onboarded, Rejected, On Hold. Examples: "reject at screening"->CV Screen Reject; "reject after interview"->Interview Reject; "reject in debrief"->Debrief Reject; "select/hire"->Selected; "made an offer"->Offered; "declined the offer"->Offer Declined; "joined/onboarded"->Onboarded; "shortlist"->Shortlist; "on hold"->On Hold.\n' +
  '- schedule_interview (name, email, datetime ISO 8601)\n' +
  '- log_feedback (name, email, notes)\n' +
  '- candidate_story (name, email): the full profile + interview-performance story for ONE candidate. Triggers: "tell me about X", "full story on X", "how did X do", "X profile", "brief on X".\n' +
  '- query_status (query)\n- help\n- unknown\n' +
  'JSON: {"intent":"","title":"","department":"","line_of_business":"","location":"","employment_type":"","level":"","hiring_manager":"","recruiter":"","openings":"","priority":"","salary_min":"","salary_max":"","name":"","email":"","role":"","status":"","datetime":"","notes":"","query":"","fields":{}}\n' +
  'Message: ' + msg;
}
function routeIntent(o) {
  switch (o.intent) {
    case 'create_requisition': return createRequisition(o);
    case 'add_candidate':      return addCandidate(o);
    case 'update_details':     return updateDetails(o);
    case 'update_status':      return updateStatus(o);
    case 'schedule_interview': return scheduleFromChat(o);
    case 'log_feedback':       return logFeedback(o);
    case 'candidate_story':    return candidateStory(o);
    case 'query_status':       return queryStatus(o);
    case 'help':               return helpText();
    default:                   return helpText();
  }
}
function trackerSheet_() { return SpreadsheetApp.openById(SHEET_ID).getSheetByName('Tracker'); }
function findRow_(sheet, name, email) {
  var d = sheet.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) if (email && (d[i][2] || '').toString().toLowerCase() === email.toLowerCase()) return i + 1;
  for (var j = 1; j < d.length; j++) if (name && (d[j][1] || '').toString().toLowerCase().indexOf(name.toLowerCase()) > -1) return j + 1;
  return -1;
}
function addCandidate(o) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return _g.error; // C-1: server-side auth
  if (!o.name) return "I need at least a name to add a candidate.";
  var sheet = trackerSheet_();
  var id = withScriptLock_(function () { // H-1: atomic append + ID mint
    sheet.appendRow(sanitizeRow_([new Date(), o.name, o.email || '', o.role || '', 'Manual', '', 'New', '', o.notes || '', '', ''])); // C-2
    var cid = nextCandidateId_();
    sheet.getRange(sheet.getLastRow(), 31).setValue(cid);
    return cid;
  });
  try { sbSyncCandidate_(id); } catch (e) {}
  bustCache_(); // M-3: chat-added candidates must show in the pipeline immediately
  return "✅ Added " + o.name + (o.role ? " (" + o.role + ")" : "") + " as New — " + id + ".";
}
function updateStatus(o) {
  var u = currentUser_(arguments), sheet = trackerSheet_(), row = findRow_(sheet, o.name, o.email);
  if (row < 0) return "I couldn't find " + (o.name || o.email) + " in the tracker.";
  var status = o.status || 'Updated', s = status.toLowerCase(), currentStage = (sheet.getRange(row, 7).getValue() || '').toString();
  var isReject = s.indexOf('reject') > -1, isPositive = (s === 'selected' || s === 'offered');
  if (u.role === 'HiringManager') {
    if (!isReject) return "🔒 " + u.name + ", hiring managers can reject at the interview stage; other changes are the recruiter's.";
    if (!isInterviewStage_(currentStage)) return "🔒 " + u.name + ", you can reject once the candidate is at the interview stage. They're currently \"" + currentStage + "\".";
  } else if (u.role !== 'Admin' && u.role !== 'Recruiter') {
    return "🔒 You don't have permission to change candidate status.";
  }
  sheet.getRange(row, 7).setValue(status);
  recordStage_((sheet.getRange(row, 31).getValue() || '').toString(), sheet.getRange(row, 2).getValue(), status);
  if (isPositive || isReject) notifyChat_((isReject ? '✖' : '✅') + ' ' + sheet.getRange(row, 2).getValue() + ' → ' + status);
  var name = sheet.getRange(row, 2).getValue(), email = (sheet.getRange(row, 3).getValue() || '').toString().trim(), role = sheet.getRange(row, 4).getValue(), extra = '';
  if ((isPositive || isReject) && email) {
    try { var dr = draftDecisionEmail_(name, role, isReject ? 'rejected' : 'selected'); GmailApp.createDraft(email, dr.subject, dr.body);
      extra = ' 📧 A ' + (isReject ? 'rejection' : 'next-steps') + ' email draft is waiting in Gmail.'; }
    catch (e) { extra = ' (email draft failed: ' + e.message + ')'; }
  }
  return '✅ ' + name + ' is now ' + status + '.' + extra;
}
function logFeedback(o) {
  var _g = guard_(arguments, 'HiringManager'); if (_g.error) return _g.error; // C-1: server-side auth
  var sheet = trackerSheet_(), row = findRow_(sheet, o.name, o.email);
  if (row < 0) return "I couldn't find " + (o.name || o.email) + ".";
  var cell = sheet.getRange(row, 9);
  cell.setValue(sanitizeCell_((cell.getValue() ? cell.getValue() + ' | ' : '') + (o.notes || ''))); // C-2
  return "✅ Feedback logged for " + sheet.getRange(row, 2).getValue() + ".";
}
// ---------- INTERVIEWER FEEDBACK (AI-polished + email/Slack intake) ----------
function feedbackSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID), sh = ss.getSheetByName('Interview Feedback');
  if (!sh) {
    sh = ss.insertSheet('Interview Feedback');
    sh.getRange(1, 1, 1, 12).setValues([['Timestamp', 'Candidate ID', 'Candidate Name', 'Candidate Email', 'Interviewer',
      'Stage', 'Rating', 'Recommendation', 'Strengths', 'Concerns', 'Feedback', 'Source']]).setFontWeight('bold');
  }
  return sh;
}
function polishFeedback(raw, candId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  if (!raw || !raw.toString().trim()) return { error: 'Paste the raw feedback first.' };
  var prompt = 'You are a careful copy-editor. Improve ONLY the grammar, spelling, punctuation, clarity and professional tone of the interview notes below. ' +
    'Preserve every point, all the detail, the interviewer\'s own meaning, structure, ordering and length. ' +
    'Do NOT summarize, shorten, condense, reorganize, add opinions, or invent anything. Keep it the same length and number of points as the original — if they wrote 15 lines, return ~15 lines. ' +
    'Return ONLY the polished notes as plain text (no preamble, no JSON).\n\nINTERVIEWER NOTES:\n' + raw;
  var out; try { out = callGemini(prompt, false); } catch (e) { return { error: e.message }; }
  return { text: (out || '').toString().trim() };
}
function saveInterviewFeedback(o) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return _g.error; // C-1: server-side auth
  var u = currentUser_(arguments);
  var sh = trackerSheet_(), row = findRowById_(sh, o.candId);
  var name = o.name || '', email = o.email || '';
  if (row > 0) { name = name || sh.getRange(row, 2).getValue(); email = email || sh.getRange(row, 3).getValue(); }
  feedbackSheet_().appendRow(sanitizeRow_([new Date(), o.candId || '', name, email, o.interviewer || (u.name || u.email || ''), o.stage || '',
    o.rating || '', o.recommendation || '',
    (o.strengths instanceof Array ? o.strengths.join('; ') : (o.strengths || '')),
    (o.concerns instanceof Array ? o.concerns.join('; ') : (o.concerns || '')),
    o.feedback || '', o.source || 'In-app'])); // C-2: feedback text
  if (o.candId) logAudit_(o.candId, 'Interview feedback added (' + (o.stage || '') + (o.recommendation ? ', ' + o.recommendation : '') + ', ' + (o.source || 'In-app') + ')');
  return '✅ Feedback saved for ' + (name || o.candId) + '.';
}
function getInterviewFeedback_(candId) {
  try {
    var d = feedbackSheet_().getDataRange().getValues(), out = [], tz = Session.getScriptTimeZone();
    for (var i = 1; i < d.length; i++) {
      if ((d[i][1] || '').toString() !== candId) continue;
      out.push({ when: (d[i][0] instanceof Date) ? Utilities.formatDate(d[i][0], tz, 'yyyy-MM-dd HH:mm') : String(d[i][0] || ''),
        interviewer: String(d[i][4] || ''), stage: String(d[i][5] || ''), rating: String(d[i][6] || ''),
        recommendation: String(d[i][7] || ''), strengths: String(d[i][8] || ''), concerns: String(d[i][9] || ''),
        feedback: String(d[i][10] || ''), source: String(d[i][11] || '') });
    }
    return out.reverse();
  } catch (e) { return []; }
}
function generateDebrief(candId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var fbs = getInterviewFeedback_(candId);
  if (!fbs.length) return { error: 'No interview feedback yet to debrief.' };
  var name = ''; try { var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row > 0) name = sh.getRange(row, 2).getValue(); } catch (e) {}
  var lines = fbs.map(function (f) { return '- ' + (f.interviewer || '?') + ' [' + (f.stage || '') + '] rec=' + (f.recommendation || '-') + ' rating=' + (f.rating || '-') + ': ' + (f.feedback || '') + ' | strengths: ' + (f.strengths || '') + ' | concerns: ' + (f.concerns || ''); }).join('\n');
  var prompt = 'You are facilitating a hiring debrief for ' + (name || 'a candidate') + '. Consolidate the interviewers\' feedback below into a balanced decision brief. ' +
    'Return ONLY JSON: {"overall_recommendation":"","confidence":"","key_strengths":[],"key_concerns":[],"rationale":"","suggested_decision":""}. ' +
    'overall_recommendation one of Strong Yes/Yes/Lean Yes/Lean No/No/Strong No; suggested_decision one of "Advance","Hold","Reject"; ' +
    'rationale = 3-5 sentences citing the panel and surfacing any disagreement. Be balanced.\n\nFEEDBACK:\n' + lines;
  var j = {}; try { j = JSON.parse(callGemini(prompt, true)); } catch (e) { j = { overall_recommendation: '', confidence: '', key_strengths: [], key_concerns: [], rationale: 'Could not auto-summarize — review the panel below.', suggested_decision: '' }; }
  var nums = fbs.map(function (f) { return parseFloat(f.rating); }).filter(function (x) { return !isNaN(x); });
  var avg = nums.length ? (nums.reduce(function (a, b) { return a + b; }, 0) / nums.length).toFixed(1) : '';
  return { name: name, count: fbs.length, avgRating: avg, panel: fbs,
    overall_recommendation: j.overall_recommendation || '', confidence: j.confidence || '',
    key_strengths: j.key_strengths || [], key_concerns: j.key_concerns || [], rationale: j.rationale || '', suggested_decision: j.suggested_decision || '' };
}
function recordDebriefDecision(candId, decision) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter' && u.role !== 'HiringManager') return '🔒 Not allowed.';
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return 'Candidate not found.';
  // H-2 FIX: write CANONICAL stages so analytics (funnel/reject counters) and archiving see
  // debrief outcomes. Was 'Advanced (Debrief)' / 'Rejected (Debrief)' — strings that existed
  // nowhere in getAnalytics or archiveOldCandidates. 'On Hold' is normalized by canonStage_.
  var stage = decision === 'Advance' ? 'Selected' : (decision === 'Reject' ? 'Debrief Reject' : 'On Hold');
  sh.getRange(row, 7).setValue(stage);
  recordStage_(candId, sh.getRange(row, 2).getValue(), stage);
  notifyChat_('🧑‍⚖️ Debrief: ' + sh.getRange(row, 2).getValue() + ' → ' + decision);
  logAudit_(candId, 'Debrief decision: ' + decision + ' → ' + stage);
  return '✅ Debrief decision recorded: ' + decision + '.';
}
function candidatePacketPdf(candId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var v = getCandidateFull(candId); if (v.error) return { error: v.error };
  var doc = DocumentApp.create('Candidate Packet — ' + (v.name || candId)), b = doc.getBody();
  b.appendParagraph(v.name || 'Candidate').setHeading(DocumentApp.ParagraphHeading.TITLE);
  if (v.resume) b.appendParagraph('Resume: ' + v.resume);
  b.appendParagraph('Profile').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  // M-6 FIX: this packet goes to the interview panel / debrief. Compensation, gender and
  // internal HR notes were being dumped in — contradicting the bias-mask feature and the
  // sensitive-columns policy. Same deny list as SB_SENSITIVE_COLS_ (Supabase.gs).
  var PACKET_HIDE = { 'current ctc': 1, 'expected ctc': 1, 'offer in hand': 1, 'gender': 1, 'hr remarks': 1, 'reason for change': 1, 'notes': 1 };
  Object.keys(v.fields || {}).forEach(function (k) { if (!PACKET_HIDE[k.toString().trim().toLowerCase()]) b.appendParagraph(k + ': ' + v.fields[k]); });
  b.appendParagraph('Interviews').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  (v.interviews || []).forEach(function (it) { b.appendParagraph('• ' + (it.stage || '') + ' — ' + (it.when || '') + ' — ' + (it.interviewers || '')); });
  b.appendParagraph('Interview Feedback').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  (v.appFeedback || []).forEach(function (f) {
    b.appendParagraph((f.stage || '') + ' · ' + (f.recommendation || '') + (f.rating ? ' · ' + f.rating + '/5' : '') + ' (' + (f.interviewer || '') + ')').setHeading(DocumentApp.ParagraphHeading.HEADING2);
    if (f.feedback) b.appendParagraph(f.feedback);
    if (f.strengths) b.appendParagraph('Strengths: ' + f.strengths);
    if (f.concerns) b.appendParagraph('Concerns: ' + f.concerns);
  });
  doc.saveAndClose();
  var pdf = DriveApp.getFileById(doc.getId()).getAs('application/pdf');
  var file = DriveApp.getFolderById(FOLDER_ID).createFile(pdf).setName('Candidate Packet — ' + (v.name || candId) + '.pdf');
  DriveApp.getFileById(doc.getId()).setTrashed(true);
  return { url: file.getUrl() };
}
function findCandidateByAny_(name, email) {
  var sh = trackerSheet_(), d = sh.getDataRange().getValues();
  var em = (email || '').toString().trim().toLowerCase(), nm = (name || '').toString().trim().toLowerCase();
  var hits = [];
  for (var i = 1; i < d.length; i++) {
    var e2 = (d[i][2] || '').toString().trim().toLowerCase(), n2 = (d[i][1] || '').toString().trim().toLowerCase();
    var first = (d[i][31] || '').toString().trim().toLowerCase() || (n2.split(/\s+/)[0] || '');
    var rec = { candId: (d[i][30] || '').toString(), name: String(d[i][1] || ''), email: String(d[i][2] || '') };
    if (em && e2 && e2 === em) return rec;                 // email is exact → return immediately
    if (nm && (n2 === nm || first === nm)) hits.push(rec); // full name or first name match
  }
  if (!hits.length) return null;
  // M-5 FIX: with two "Asha"s in the tracker, a name-only lookup used to silently pick
  // whichever row was higher — feedback could attach to the WRONG person. Flag ambiguity so
  // callers (Slack, email import, webhook) can ask for a full name/email instead of guessing.
  if (hits.length > 1) { hits[0].ambiguous = true; hits[0].count = hits.length; }
  return hits[0];
}
function importFeedbackFromEmail() {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins.';
  var label = 'Feedback', done = 'Feedback-Done', threads;
  try { threads = GmailApp.search('label:' + label.toLowerCase() + ' -label:' + done.toLowerCase()); }
  catch (e) { return '⚠️ Create a Gmail label "Feedback" and apply it to interviewer feedback emails first.'; }
  if (!threads.length) return 'No new feedback emails (label "Feedback", not yet processed). Forward interviewer emails into that label.';
  var doneLabel = GmailApp.getUserLabelByName(done) || GmailApp.createLabel(done);
  var n = 0, skipped = 0, failed = 0; // H-4: track parse failures instead of hiding them
  for (var t = 0; t < threads.length && t < 20; t++) {
    var msgs = threads[t].getMessages(), m = msgs[msgs.length - 1];
    var body = (m.getPlainBody() || '').slice(0, 6000), subj = m.getSubject() || '', from = m.getFrom() || '';
    var j = null;
    try {
      j = JSON.parse(callGemini('Extract interview feedback from this email. Return ONLY JSON: ' +
        '{"candidate_name":"","candidate_email":"","interviewer":"","stage":"","rating":"","recommendation":"","strengths":[],"concerns":[],"summary":""}. ' +
        'recommendation one of Strong Yes/Yes/Lean Yes/Lean No/No/Strong No; rating 1-5; summary = formal 2-4 sentences. ' +
        'Subject: ' + subj + '\nFrom: ' + from + '\nBody:\n' + body, true));
    } catch (e) { j = null; }
    // H-4 FIX: unparseable / unmatchable feedback is never destroyed any more. The raw email
    // text is stored in the Interview Feedback sheet flagged for review, so a human can attach
    // it to the right candidate later. (Previously the thread was labeled Done and the
    // interviewer's feedback silently vanished.)
    if (j) {
      var match = findCandidateByAny_(j.candidate_name, j.candidate_email);
      if (match && match.ambiguous) match = null; // M-5: never guess between same-named candidates — route to NEEDS REVIEW below
      if (match) {
        saveInterviewFeedback({ candId: match.candId, name: match.name, email: match.email, interviewer: j.interviewer || from,
          stage: j.stage || '', rating: j.rating || '', recommendation: j.recommendation || '', strengths: j.strengths || [],
          concerns: j.concerns || [], feedback: j.summary || '', source: 'Email' });
        n++;
      } else {
        saveInterviewFeedback({ candId: '', name: (j.candidate_name || '(unknown candidate)') + ' — NEEDS REVIEW', email: j.candidate_email || '',
          interviewer: j.interviewer || from, stage: j.stage || '', rating: j.rating || '', recommendation: j.recommendation || '',
          strengths: j.strengths || [], concerns: j.concerns || [],
          feedback: (j.summary || '') + '\n--- RAW EMAIL (no candidate match) ---\nSubject: ' + subj + '\nFrom: ' + from + '\n' + body.slice(0, 3000),
          source: 'Email (needs review — unmatched)' });
        skipped++;
      }
    } else {
      saveInterviewFeedback({ candId: '', name: '(unparsed email) — NEEDS REVIEW', email: '',
        interviewer: from, stage: '', rating: '', recommendation: '', strengths: [], concerns: [],
        feedback: 'AI could not parse this feedback email — raw text preserved.\nSubject: ' + subj + '\nFrom: ' + from + '\n' + body.slice(0, 4000),
        source: 'Email (needs review — unparsed)' });
      failed++;
    }
    threads[t].addLabel(doneLabel); // safe to label now: the content is stored either way
  }
  return '✅ Imported ' + n + ' feedback email(s)' +
    (skipped ? ' · ' + skipped + " couldn't be matched — raw text saved in Interview Feedback marked NEEDS REVIEW" : '') +
    (failed ? ' · ' + failed + " couldn't be parsed — raw text saved in Interview Feedback marked NEEDS REVIEW" : '') + '.';
}
function slackMsg_(text) {
  return ContentService.createTextOutput(JSON.stringify({ response_type: 'ephemeral', text: text })).setMimeType(ContentService.MimeType.JSON);
}
// Run this from the editor to prove the Slack feedback backend works WITHOUT Slack/deployment.
function testSlackFeedback() {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return _g.error; // C-1: server-side auth
  var sh = trackerSheet_(), d = sh.getDataRange().getValues(), name = '';
  for (var i = 1; i < d.length; i++) { if (d[i][1]) { name = d[i][1]; break; } }
  if (!name) return 'No candidates in the tracker to test with.';
  // H-3: doPost now requires WEBHOOK_SECRET — include it so the editor test still works.
  var fake = { parameter: { command: '/ivfeedback', text: name + ' | TEST from editor: strong system design and communication, would advance', user_name: 'editor-test', response_url: '', secret: PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET') || '' } };
  var out = doPost(fake).getContent();
  return 'Simulated a Slack /ivfeedback for "' + name + '". doPost returned: ' + out +
    '  → now open the "Interview Feedback" sheet; you should see a new row (source "Slack (raw)"). If yes, the backend works and the issue is the Slack URL/deploy config.';
}
function doPost(e) {
  try {
    var prm = (e && e.parameter) || {};
    var p = {};
    if (e && e.postData && e.postData.contents) { try { p = JSON.parse(e.postData.contents); } catch (_) { p = prm; } }
    else p = prm;
    // H-3 FIX: authenticate BEFORE any lookup or write. Set Script Property WEBHOOK_SECRET and
    // put the same value on the webhook URL (…/exec?secret=YOUR_SECRET) or in the JSON body
    // as {"secret":"…"}. Unauthenticated posts can no longer inject feedback or probe names.
    if (!webhookSecretOk_(e, p)) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'unauthorized — set Script Property WEBHOOK_SECRET and send it as ?secret=… on the webhook URL (or "secret" in the JSON body)' })).setMimeType(ContentService.MimeType.JSON);
    }
    // Webhook calls (Slack etc.) come from an integration, not a browser session. Give them a
    // scoped service identity so the guarded feedback helpers keep working (secret verified above).
    AUTH_USER_ = { email: 'webhook', name: (prm.user_name || 'Webhook'), role: 'Recruiter', webhook: true };
    // --- C-5: CV intake bridge from the careers@ forwarder (CvForwarder.gs) ---
    if (p.action === 'ingest_cv') {
      return ContentService.createTextOutput(JSON.stringify(ingestCvFromEmail_(p))).setMimeType(ContentService.MimeType.JSON);
    }
    // --- Slack slash command (e.g. /feedback Asha R | strong system design...) ---
    if (prm.command || prm.trigger_id) {
      var cmd = prm.command || '/feedback', text = (prm.text || '').toString(), respUrl = prm.response_url || '';
      var bar = text.indexOf('|');
      var msg;
      if (bar < 0) msg = 'Format:  ' + cmd + ' Candidate Name | their feedback';
      else {
        var cname = text.slice(0, bar).trim(), fb = text.slice(bar + 1).trim();
        if (!cname || !fb) msg = 'Format:  ' + cmd + ' Candidate Name | their feedback';
        else {
          var mt = findCandidateByAny_(cname, '');
          if (!mt) msg = 'Couldn\'t find a candidate named "' + cname + '". Check the name (first name works) and try again.';
          else if (mt.ambiguous) msg = '⚠️ ' + mt.count + ' candidates match "' + cname + '" — please use the full name or their email so the feedback lands on the right person.'; // M-5
          else {
            saveInterviewFeedback({ candId: mt.candId, name: mt.name, email: mt.email, interviewer: prm.user_name || 'Slack', feedback: fb, source: 'Slack (raw)' });
            msg = '✅ Feedback logged for ' + mt.name + '. Open AgentATS to polish the English.';
          }
        }
      }
      // Reply via response_url (30-min window) so slow cold-starts never show "operation_timeout".
      if (respUrl) {
        try { UrlFetchApp.fetch(respUrl, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ response_type: 'ephemeral', text: msg }), muteHttpExceptions: true }); } catch (e) {}
        return ContentService.createTextOutput('');
      }
      return slackMsg_(msg);
    }
    var raw = p.feedback || p.text || '';
    var match = findCandidateByAny_(p.candidate || p.candidate_name || '', p.email || p.candidate_email || '');
    if (!match) return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Candidate not found' })).setMimeType(ContentService.MimeType.JSON);
    if (match.ambiguous) return ContentService.createTextOutput(JSON.stringify({ ok: false, error: match.count + ' candidates match that name — include the candidate email to disambiguate' })).setMimeType(ContentService.MimeType.JSON); // M-5
    // H-3 FIX: polishFeedback returns { text: … } — the old code read pol.summary/.rating/etc.
    // (fields that never existed), so the paid polish call was thrown away and raw text saved.
    // Now the polished text is actually stored; structured fields come from the payload itself.
    var pol = null; try { pol = polishFeedback(raw, match.candId); } catch (_) { pol = null; }
    var polished = (pol && pol.text) ? pol.text : raw;
    saveInterviewFeedback({ candId: match.candId, name: match.name, email: match.email, interviewer: p.interviewer || p.user_name || 'Slack',
      stage: p.stage || '', rating: p.rating || '', recommendation: p.recommendation || '',
      strengths: p.strengths || [], concerns: p.concerns || [], feedback: polished, source: p.source || 'Slack' });
    return ContentService.createTextOutput(JSON.stringify({ ok: true, candidate: match.name })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message })).setMimeType(ContentService.MimeType.JSON);
  }
}
// C-5 FIX: inbound CV email intake now lands in THIS app's Tracker (was: POSTed to the new
// brain's /ingest/cv and never reached this sheet). Called from doPost (action:'ingest_cv')
// by CvForwarder.gs, which runs on the careers@ mailbox and authenticates with WEBHOOK_SECRET.
// Design rule: the CV is NEVER lost — Drive save failure returns ok:false (the forwarder
// retries and does NOT label the thread); an AI parse failure is non-fatal (the candidate is
// still created from the sender's email with the raw file attached, flagged for re-parse).
function ingestCvFromEmail_(p) {
  try {
    if (!p.attachment_base64) return { ok: false, error: 'no attachment' };
    var mime = (p.attachment_mime || 'application/pdf').toString();
    var fname = (p.attachment_name || 'resume').toString();
    var fromEmail = (p.from_email || '').toString().trim().toLowerCase();
    var url = '';
    try { url = DriveApp.getFolderById(FOLDER_ID).createFile(Utilities.newBlob(Utilities.base64Decode(p.attachment_base64), mime, fname)).getUrl(); }
    catch (e) { return { ok: false, error: 'Drive save failed: ' + e.message }; }
    var parsed = {}; try { parsed = JSON.parse(parseDocument_(p.attachment_base64, mime)) || {}; } catch (e) { parsed = {}; }
    if (parsed.doc_type && parsed.doc_type !== 'resume') return { ok: true, skipped: true, reason: 'not a CV (' + parsed.doc_type + ') — file kept in Drive' };
    // SDET quality gate: only create a candidate when the parser actually extracted a
    // résumé — a real candidate NAME plus at least one résumé detail. We NO LONGER fall
    // back to the email subject as a name (that created junk candidates like
    // "Hiring Pipeline & Status - Aug 24, 2026"). Non-résumés stay in Drive, no row.
    var pname = (parsed.name || '').toString().trim();
    var titleLike = /\b(19|20)\d\d\b|pipeline|status|report|invoice|newsletter|agenda|minutes|proposal|dashboard|statement|summary|deck|presentation/i.test(pname);
    var hasDetail = !!(parsed.email || parsed.phone || parsed.total_experience || parsed.skills || parsed.current_company || parsed.current_title || parsed.linkedin);
    if (!pname || titleLike || !hasDetail) return { ok: true, skipped: true, reason: 'not a résumé (no candidate details detected) — file kept in Drive' };
    var candName = pname;
    var email = (parsed.email || fromEmail || '').toString();
    // Repeat sender → attach the new CV to the existing row instead of duplicating (mirrors H-8).
    var existing = email ? findCandidateByAny_('', email) : null;
    if (existing) {
      var shx = trackerSheet_(), rowx = findRowById_(shx, existing.candId);
      if (rowx > 0) {
        shx.getRange(rowx, 6).setValue(url);
        var nc = shx.getRange(rowx, 9), oldN = (nc.getValue() || '').toString();
        nc.setValue(sanitizeCell_((oldN ? oldN + ' | ' : '') + 'New CV emailed ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy'))); // C-2
        try { logAudit_(existing.candId, 'New CV received by email — resume link updated'); } catch (e) {}
        bustCache_();
        return { ok: true, candId: existing.candId, updated: true };
      }
    }
    var sheet = trackerSheet_();
    var r = withScriptLock_(function () { // H-1: atomic append + ID mint
      sheet.appendRow(sanitizeRow_([new Date(), candName, email, '', 'Email (careers@)', url, 'New', '', (p.subject || '').toString().slice(0, 200), '', ''])); // C-2: email intake
      var rr = sheet.getLastRow(); sheet.getRange(rr, 31).setValue(nextCandidateId_()); return rr;
    });
    function setP(col, val) { if (val) sheet.getRange(r, col).setValue(sanitizeCell_(val)); } // C-2
    setP(13, parsed.phone); setP(14, parsed.current_location); setP(18, parsed.current_company); setP(19, parsed.current_title);
    setP(20, parsed.total_experience); setP(21, parsed.skills); setP(22, parsed.highest_qualification);
    setP(32, parsed.first_name); setP(33, parsed.middle_name); setP(34, parsed.last_name); setP(35, parsed.linkedin);
    setP(37, parsed.highlights); setP(38, parsed.github);
    var cid = (sheet.getRange(r, 31).getValue() || '').toString();
    try { recordStage_(cid, candName, 'New'); } catch (e) {}
    try { logAudit_(cid, 'Candidate created (Email (careers@) CV intake)' + ((!parsed.name && !parsed.email) ? ' · ⚠️ CV parse failed — raw file saved, run Re-parse' : '')); } catch (e) {}
    bustCache_();
    try { if (PropertiesService.getScriptProperties().getProperty('ORG_ACK') !== '0' && email) sendAck_(email, parsed.name || ''); } catch (e) {}
    notifyChat_('📥 New CV by email: ' + candName + ' (careers@ inbox)');
    return { ok: true, candId: cid };
  } catch (err) { return { ok: false, error: err.message }; }
}
function queryStatus(o) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return _g.error; // C-1: server-side auth
  // M-8 FIX: only Recruiters/Admins get compensation in the chat context. Hiring managers /
  // interviewers could previously ask the chat for every candidate's CTC even though the UI
  // scopes their view — the whole pipeline (incl. comp) was shipped to Gemini for any question.
  var seeComp = roleRank_(_g.role) >= roleRank_('Recruiter');
  var d = trackerSheet_().getDataRange().getValues(), rows = [], counts = {};
  for (var i = 1; i < d.length; i++) {
    if (!d[i][1]) continue;
    var stage = (d[i][6] || 'New').toString();
    counts[stage] = (counts[stage] || 0) + 1;
    rows.push([d[i][1], d[i][3] || '-', stage, d[i][7] || '-', d[i][11] || '-',
      d[i][17] || '-', d[i][19] || '-', d[i][20] || '-',
      seeComp ? (d[i][23] || '-') : '(restricted)', seeComp ? (d[i][24] || '-') : '(restricted)', // M-8
      d[i][22] || '-', d[i][13] || '-'].join(' | '));
  }
  var summary = Object.keys(counts).map(function (k) { return k + ': ' + counts[k]; }).join(', ') || 'none';
  var data = 'STAGE COUNTS: ' + summary + '\nTOTAL CANDIDATES: ' + rows.length +
    '\n\nCANDIDATES (Name | Role | Stage | Score | Req | Current Company | Experience | Skills | Current CTC | Expected CTC | Notice | Location):\n' +
    (rows.join('\n') || '(no candidates yet)');
  return callGemini('You are a recruiting analytics assistant. Use ONLY the data below. Give specific numbers and names. ' +
    'For "compare", lay the candidates side by side on the relevant fields and end with a recommendation. ' +
    'For pipeline / "how many", report the per-stage counts. Be concise and friendly.\n\n' +
    data + '\n\nQUESTION: ' + (o.query || 'summarize the pipeline'), false);
}
function candidateStory(o) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return _g.error; // C-1: server-side auth
  var ss = SpreadsheetApp.openById(SHEET_ID), tr = ss.getSheetByName('Tracker');
  var d = tr.getDataRange().getValues(), H = d[0], ri = -1;
  for (var i = 1; i < d.length; i++) {
    var em = (d[i][2] || '').toString().toLowerCase(), nm = (d[i][1] || '').toString().toLowerCase();
    if ((o.email && em === o.email.toLowerCase()) || (o.name && nm.indexOf(o.name.toLowerCase()) > -1)) { ri = i; break; }
  }
  if (ri < 0) return "I couldn't find " + (o.name || o.email) + " in the pipeline.";
  var row = d[ri], email = (row[2] || '').toString().toLowerCase(), profile = {};
  // M-8 FIX: comp + HR-internal fields only reach the AI context for Recruiters/Admins, and
  // Gender never does when the bias guard is on (mirrors the sensitive-columns policy).
  var _seeComp = roleRank_(_g.role) >= roleRank_('Recruiter');
  var _biasOn = false; try { _biasOn = PropertiesService.getScriptProperties().getProperty('BIAS_MASK') === '1'; } catch (e) {}
  var STORY_HIDE = { 'current ctc': !_seeComp, 'expected ctc': !_seeComp, 'offer in hand': !_seeComp, 'hr remarks': !_seeComp, 'reason for change': !_seeComp, 'gender': (!_seeComp || _biasOn) };
  H.forEach(function (h, i) { if (h && row[i] !== '' && row[i] != null && !STORY_HIDE[h.toString().trim().toLowerCase()]) profile[h] = row[i]; });
  var req = '(not tagged to a requisition)', reqId = row[11];
  if (reqId) {
    var rq = ss.getSheetByName('Requisitions').getDataRange().getValues();
    for (var j = 1; j < rq.length; j++)
      if ((rq[j][0] || '').toString() === reqId.toString()) { req = rq[j][1] + ' (' + rq[j][3] + ', ' + rq[j][6] + ', HM ' + rq[j][7] + ')'; break; }
  }
  var fbs = [];
  ss.getSheets().forEach(function (s) {
    if (s.getName().indexOf('Form Responses') !== 0) return;
    var fd = s.getDataRange().getValues(), fh = fd[0], ec = -1;
    for (var c = 0; c < fh.length; c++) if ((fh[c] || '').toString().toLowerCase().indexOf('candidate email') > -1) ec = c;
    for (var k = 1; k < fd.length; k++) {
      if (ec > -1 && (fd[k][ec] || '').toString().toLowerCase() === email) {
        var fo = {}; fh.forEach(function (hh, ci) { if (hh && fd[k][ci] !== '') fo[hh] = fd[k][ci]; }); fbs.push(fo);
      }
    }
  });
  var ctx = 'CANDIDATE PROFILE:\n' + JSON.stringify(profile) + '\n\nREQUISITION: ' + req +
    '\n\nINTERVIEW FEEDBACK (' + fbs.length + ' submitted):\n' + (fbs.length ? JSON.stringify(fbs) : 'none yet');
  return callGemini('You are a senior recruiter writing a candidate brief for a hiring decision. Using ONLY the data below, ' +
    'write a clear, structured story: (1) Snapshot — role, experience, current company, location, comp/notice. ' +
    '(2) Fit for the requisition. (3) Interview performance — synthesise feedback across interviewers: strengths, concerns, ' +
    'and any disagreement between them. (4) A clear recommendation. Be specific and evidence-based; ignore gender and other ' +
    'non-job factors. If no feedback yet, say interviews are still pending.\n\n' + ctx, false);
}

function scheduleFromChat(o) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return _g.error; // C-1: server-side auth
  var sheet = trackerSheet_(), row = findRow_(sheet, o.name, o.email);
  if (row < 0) return "I couldn't find " + (o.name || o.email) + " in the tracker.";
  if (!o.datetime) return "When should I schedule it? e.g. \"Schedule " + (o.name || 'them') + " tomorrow 3pm\".";
  var start = new Date(o.datetime);
  if (isNaN(start.getTime())) return "I couldn't read that time — try \"June 10 3pm\".";
  var end = new Date(start.getTime() + 45 * 60000);
  var name = sheet.getRange(row, 2).getValue(), email = (sheet.getRange(row, 3).getValue() || '').toString().trim(), role = sheet.getRange(row, 4).getValue();
  var ev = Calendar.Events.insert({
    summary: 'Interview: ' + name + (role ? ' — ' + role : ''), description: 'AgentATS interview.',
    start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() },
    attendees: email ? [{ email: email }] : [],
    conferenceData: { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
  }, 'primary', { conferenceDataVersion: 1, sendUpdates: 'all' });
  var meet = ev.hangoutLink || '';
  sheet.getRange(row, 7).setValue('Interview Scheduled');
  sheet.getRange(row, 10).setValue(Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'));
  if (meet) sheet.getRange(row, 9).setValue(((sheet.getRange(row, 9).getValue() || '') + ' Meet: ' + meet).trim());
  return '✅ Interview with ' + name + ' booked for ' + start.toLocaleString() + (meet ? '. Google Meet: ' + meet : '') + '. Invite sent to ' + (email || '(no email)') + '.';
}
function helpText() {
  return "Here's what I can do — just say it naturally:\n" +
  "• Create a requisition — or use the + Requisition button\n" +
  "• Add a candidate — \"Add Asha Rao, name@example.com, backend engineer\"\n" +
  "• Upload a CV or JD — tap 📎\n" +
  "• Tag / update details — \"Tag Rohan to PAY-AR-001, CTC 24L, notice 60 days\"\n" +
  "• Update status — \"Shortlist Asha\", \"Reject Asha\", \"Select Meera\"\n" +
  "• Schedule an interview — \"Schedule Meera tomorrow 3pm\" (adds a Meet link)\n" +
  "• Log feedback — \"Note for Asha: strong communication\"\n" +
  "• Ask questions — \"How many are shortlisted?\"";
}

// ---------- DECISION EMAILS ----------
function draftDecisionEmail_(name, role, stage) {
  var prompt = (stage === 'selected')
    ? 'Write a short, warm, professional email to ' + name + ' letting them know they are moving forward for the ' + (role || 'role') + ' after strong interviews, next steps to follow. Return ONLY JSON {"subject":"","body":""}.'
    : 'Write a short, kind, respectful rejection email to ' + name + ' for the ' + (role || 'role') + '. Warm, brief, leaves the door open. Return ONLY JSON {"subject":"","body":""}.';
  return JSON.parse(callGemini(prompt, true));
}
function isInterviewStage_(stage) { var s = (stage || '').toString().toLowerCase(); return s.indexOf('interview') > -1 || s === 'debrief'; }

// ---------- AI / GEMINI ----------
function geminiRequest_(payloadObj) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) throw new Error('GEMINI_KEY not set in Script Properties.');
  var models = [GEMINI_MODEL, 'gemini-2.5-flash-lite'], lastErr = '';
  for (var m = 0; m < models.length; m++) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + models[m] + ':generateContent';
    var opts = { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
                 payload: JSON.stringify(payloadObj), muteHttpExceptions: true };
    for (var i = 0; i < 3; i++) {
      var res = UrlFetchApp.fetch(url, opts), code = res.getResponseCode(), data;
      try { data = JSON.parse(res.getContentText()); } catch (e) { data = {}; }
      if (data.candidates && data.candidates[0]) return data.candidates[0].content.parts[0].text;
      lastErr = (data.error && data.error.message) || ('HTTP ' + code);
      if ((code === 429 || code === 500 || code === 503) && i < 2) { Utilities.sleep(1200 * (i + 1)); continue; }
      break;
    }
  }
  if (/quota|429|503|overload|busy|unavailable|resource/i.test(lastErr))
    throw new Error('The AI is briefly busy — please try again in a few seconds.');
  throw new Error('AI error: ' + lastErr.toString().slice(0, 180));
}
function callGemini(prompt, jsonMode) {
  var cfg = { temperature: 0.1 }; if (jsonMode) cfg.responseMimeType = 'application/json';
  return geminiRequest_({ contents: [{ parts: [{ text: prompt }] }], generationConfig: cfg });
}
function parseDocument_(base64Data, mimeType) {
  var prompt = 'Classify this document and extract fields. Return ONLY JSON. ' +
    'If a candidate resume/CV: {"doc_type":"resume","name":"","first_name":"","middle_name":"","last_name":"","email":"","phone":"","current_location":"","current_company":"","current_title":"","total_experience":"","skills":"","highest_qualification":"","linkedin":"","github":"","highlights":""}. github = the candidate\'s GitHub profile URL or username if present (look for github.com/...). ' +
    'Split the candidate\'s full name: first_name = given name, last_name = family/surname, middle_name = anything in between (often empty). ' +
    'Also add "linkedin":"" = the candidate\'s LinkedIn profile URL. Look carefully in the header, footer, contact line and anywhere a URL appears; accept forms like "linkedin.com/in/xxx", "in/xxx", or a full https URL, and normalize to a full https://www.linkedin.com/in/... URL. If only the word "LinkedIn" appears with no visible address, leave it empty. ' +
    'If a job description: {"doc_type":"jd","title":"","department":"","line_of_business":"","location":"","employment_type":"","level":"","openings":"","hiring_manager":"","role_description":""}. ' +
    'skills = up to 8 comma-separated; total_experience = years. ' +
    'highlights = concise semicolon-separated standout signals: notable open-source repos (with stars if shown), hackathon wins, coding-competition placements (ICPC/Kaggle/Codeforces/GSoC), patents, publications, awards, CERTIFICATIONS (e.g. AWS/GCP/Azure/PMP/CFA/CISSP), TENURE/STABILITY (avg years per job, any job-hopping or career gaps), the FUNDING STAGE of companies when they joined (e.g. "joined at seed", "Series A"), growth/impact metrics they drove (MAU, ARR, revenue, scale), notably complex projects/systems, college tier + CGPA/GPA, and any portfolio / personal website / Behance / Dribbble / Kaggle / Stack Overflow links or handles. Empty string if none.';
  var m = (mimeType || '').toLowerCase();
  var isPdf = m.indexOf('pdf') > -1, isImg = m.indexOf('image/') > -1 || /png|jpe?g|gif|webp/.test(m);
  if (isPdf || isImg) {
    return geminiRequest_({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64Data } }] }],
                            generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
  }
  // Any other format (Word, PowerPoint, ODT, RTF, TXT, etc.): convert via Drive → export PDF → read.
  var pdfB64 = convertToPdfB64_(base64Data, mimeType);
  return geminiRequest_({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'application/pdf', data: pdfB64 } }] }],
                          generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
}
function convertToPdfB64_(base64Data, mimeType) {
  if (typeof Drive === 'undefined' || !Drive.Files) throw new Error('Drive API service not enabled (Services → + → Drive API).');
  var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType || 'application/octet-stream', 'tmp');
  var m = (mimeType || '').toLowerCase();
  var target = (m.indexOf('presentation') > -1 || m.indexOf('powerpoint') > -1) ?
    'application/vnd.google-apps.presentation' : 'application/vnd.google-apps.document';
  var id;
  if (Drive.Files.create) id = Drive.Files.create({ name: 'tmp_parse_' + Date.now(), mimeType: target }, blob).id;       // v3
  else if (Drive.Files.insert) id = Drive.Files.insert({ title: 'tmp_parse_' + Date.now(), mimeType: target }, blob).id;  // v2
  else throw new Error('Drive convert method unavailable.');
  var pdf = DriveApp.getFileById(id).getAs('application/pdf').getBytes();
  DriveApp.getFileById(id).setTrashed(true);
  return Utilities.base64Encode(pdf);
}

// ---------- CV / JD UPLOAD ----------
function uploadCV(base64Data, fileName, mimeType, reqId, talentPool) {
  var u = currentUser_(arguments);
  if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Sorry ' + u.name + ', your role can\'t upload.';
  try {
    var p = {}; try { p = JSON.parse(parseDocument_(base64Data, mimeType)); } catch (e) { p = { doc_type: 'resume' }; }
    var url = DriveApp.getFolderById(FOLDER_ID).createFile(Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName)).getUrl();
    if (p.doc_type === 'jd' && !reqId) return createReqFromJd_(p, url);
    var sheet = trackerSheet_();
    var stage = talentPool ? 'Talent Pool' : 'New', src = talentPool ? 'Passive Pool' : 'CV Upload';
    var r = withScriptLock_(function () { // H-1: atomic append + ID mint
      sheet.appendRow(sanitizeRow_([new Date(), p.name || fileName, p.email || '', '', src, url, stage, '', '', '', ''])); // C-2: parsed CV text
      var rr = sheet.getLastRow();
      sheet.getRange(rr, 31).setValue(nextCandidateId_());
      return rr;
    });
    if (reqId) sheet.getRange(r, 12).setValue(reqId);
    if (p.phone) sheet.getRange(r, 13).setValue(sanitizeCell_(p.phone));
    if (p.current_location) sheet.getRange(r, 14).setValue(sanitizeCell_(p.current_location));
    if (p.current_company) sheet.getRange(r, 18).setValue(sanitizeCell_(p.current_company));
    if (p.current_title) sheet.getRange(r, 19).setValue(sanitizeCell_(p.current_title));
    if (p.total_experience) sheet.getRange(r, 20).setValue(sanitizeCell_(p.total_experience));
    if (p.skills) sheet.getRange(r, 21).setValue(sanitizeCell_(p.skills));
    if (p.highest_qualification) sheet.getRange(r, 22).setValue(sanitizeCell_(p.highest_qualification));
    if (p.first_name) sheet.getRange(r, 32).setValue(sanitizeCell_(p.first_name));
    if (p.middle_name) sheet.getRange(r, 33).setValue(sanitizeCell_(p.middle_name));
    if (p.last_name) sheet.getRange(r, 34).setValue(sanitizeCell_(p.last_name));
    if (p.linkedin) sheet.getRange(r, 35).setValue(sanitizeCell_(p.linkedin));
    if (p.highlights) sheet.getRange(r, 37).setValue(sanitizeCell_(p.highlights)); // L-2: parser already extracts these —
    if (p.github) sheet.getRange(r, 38).setValue(sanitizeCell_(p.github));         // quick-uploads no longer lose the signals
    var cid = sheet.getRange(r, 31).getValue();
    recordStage_((cid || '').toString(), p.name || fileName, stage);
    return '✅ ' + (talentPool ? 'Added to Talent Pool' : 'Candidate added') + ': ' + (p.name || fileName) + ' (' + cid + ') — Drive saved, fields auto-filled.';
  } catch (e) { return '⚠️ Upload failed: ' + e.message; }
}
function parseResumeOnly(base64Data, fileName, mimeType) {
  var u = currentUser_(arguments);
  if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Your role can\'t add candidates.' };
  var url = '';
  try { url = DriveApp.getFolderById(FOLDER_ID).createFile(Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName)).getUrl(); } catch (e) {}
  var p;
  try { p = JSON.parse(parseDocument_(base64Data, mimeType)); }
  catch (e) { return { docType: 'resume', resume: url, lowConfidence: true, parseError: e.message }; }
  if (p.doc_type === 'jd') return { docType: 'jd', jd_link: url };
  var low = !(p.name || p.email) || (!p.skills && !p.current_company);
  return { docType: 'resume', name: p.name || '', firstName: p.first_name || '', middleName: p.middle_name || '', lastName: p.last_name || '',
    email: p.email || '', phone: p.phone || '',
    location: p.current_location || '', company: p.current_company || '', title: p.current_title || '',
    experience: p.total_experience || '', skills: p.skills || '', qualification: p.highest_qualification || '', linkedin: p.linkedin || '', highlights: p.highlights || '', github: p.github || '',
    resume: url, lowConfidence: low };
}
function extractFileId_(url) { var m = (url || '').toString().match(/[-\w]{25,}/); return m ? m[0] : ''; }
// ---------- LIVE GITHUB VERIFICATION (free public API; turns claimed OSS into verified signal) ----------
function ghHandle_(s) { s = (s || '').toString().trim(); var m = s.match(/github\.com\/([A-Za-z0-9-]+)/i); if (m) return m[1]; if (/^[A-Za-z0-9-]{1,39}$/.test(s) && s.toLowerCase() !== 'github') return s; return ''; }
function verifyGitHub(candId) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return { error: 'Candidate not found.' };
  var handle = ghHandle_((sh.getRange(row, 38).getValue() || '').toString()) || ghHandle_((sh.getRange(row, 37).getValue() || '').toString()) || ghHandle_((sh.getRange(row, 35).getValue() || '').toString());
  if (!handle) return { error: 'No GitHub username found. Add their GitHub URL via ✏️ Edit or 🔄 Re-parse CV.' };
  var opt = { muteHttpExceptions: true, headers: { 'User-Agent': 'AgentATS', 'Accept': 'application/vnd.github+json' } };
  try {
    var ur = UrlFetchApp.fetch('https://api.github.com/users/' + encodeURIComponent(handle), opt);
    if (ur.getResponseCode() === 404) return { error: 'GitHub user "' + handle + '" not found.' };
    if (ur.getResponseCode() === 403) return { error: 'GitHub rate limit reached (60/hr). Try again shortly.' };
    var u = JSON.parse(ur.getContentText());
    var repos = []; try { var rr = UrlFetchApp.fetch('https://api.github.com/users/' + encodeURIComponent(handle) + '/repos?per_page=100&sort=pushed', opt); if (rr.getResponseCode() === 200) repos = JSON.parse(rr.getContentText()); } catch (e) {}
    if (!Array.isArray(repos)) repos = [];
    var own = repos.filter(function (r) { return !r.fork; }), stars = 0, langs = {};
    own.forEach(function (r) { stars += (r.stargazers_count || 0); if (r.language) langs[r.language] = (langs[r.language] || 0) + 1; });
    var top = own.slice().sort(function (a, b) { return (b.stargazers_count || 0) - (a.stargazers_count || 0); }).slice(0, 5).map(function (r) { return { name: r.name, stars: r.stargazers_count || 0, forks: r.forks_count || 0, lang: r.language || '', desc: (r.description || '').slice(0, 90) }; });
    var topLangs = Object.keys(langs).sort(function (a, b) { return langs[b] - langs[a]; }).slice(0, 5);
    var summary = 'GitHub @' + u.login + ': ' + (u.public_repos || 0) + ' repos, ' + stars + ' total stars, ' + (u.followers || 0) + ' followers' + (top[0] && top[0].stars ? '; top ' + top.filter(function (t) { return t.stars; }).map(function (t) { return t.name + '(' + t.stars + '★)'; }).join(', ') : '');
    var hl = (sh.getRange(row, 37).getValue() || '').toString(); if (hl.indexOf('GitHub @') < 0) sh.getRange(row, 37).setValue(sanitizeCell_((hl ? hl + '; ' : '') + summary)); // C-2
    try { logAudit_(candId, 'GitHub verified — ' + summary); } catch (e) {}
    return { handle: u.login, name: u.name || '', bio: u.bio || '', followers: u.followers || 0, public_repos: u.public_repos || 0, total_stars: stars, langs: topLangs, top: top, url: u.html_url, created: (u.created_at || '').slice(0, 4), summary: summary };
  } catch (e) { return { error: e.message }; }
}
function reparseRow_(sh, row) {
  var url = (sh.getRange(row, 6).getValue() || '').toString(); if (!url) return { error: 'No CV on file to re-parse.' };
  var id = extractFileId_(url); if (!id) return { error: 'Could not locate the CV file.' };
  var p;
  try { var blob = DriveApp.getFileById(id).getBlob(); p = JSON.parse(parseDocument_(Utilities.base64Encode(blob.getBytes()), blob.getContentType())); }
  catch (e) { return { error: 'Re-parse failed: ' + e.message }; }
  if (p.doc_type === 'jd') return { error: 'That file looks like a JD, not a resume.' };
  var filled = [];
  function fill(col, val, label) { if (val && !(sh.getRange(row, col).getValue())) { sh.getRange(row, col).setValue(sanitizeCell_(val)); filled.push(label); } } // C-2
  fill(2, p.name, 'Name'); fill(3, p.email, 'Email'); fill(13, p.phone, 'Phone'); fill(14, p.current_location, 'Location');
  fill(18, p.current_company, 'Company'); fill(19, p.current_title, 'Title'); fill(20, p.total_experience, 'Experience');
  fill(21, p.skills, 'Skills'); fill(22, p.highest_qualification, 'Qualification'); fill(35, p.linkedin, 'LinkedIn'); fill(37, p.highlights, 'Highlights'); fill(38, p.github, 'GitHub');
  fill(32, p.first_name, 'First name'); fill(33, p.middle_name, 'Middle name'); fill(34, p.last_name, 'Last name');
  if (!(sh.getRange(row, 32).getValue())) {
    var nm = ((sh.getRange(row, 2).getValue() || '') + '').trim().split(/\s+/).filter(Boolean);
    if (nm.length) { sh.getRange(row, 32).setValue(nm[0]); if (nm.length > 1) sh.getRange(row, 34).setValue(nm[nm.length - 1]); if (nm.length > 2) sh.getRange(row, 33).setValue(nm.slice(1, -1).join(' ')); filled.push('Name split'); }
  }
  return { filled: filled };
}
function reparseCandidate(candId) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins.';
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return 'Candidate not found.';
  var r = reparseRow_(sh, row); if (r.error) return '⚠️ ' + r.error;
  logAudit_(candId, 'CV re-parsed → filled: ' + (r.filled.join(', ') || 'nothing new'));
  return r.filled.length ? ('✅ Re-parsed CV — filled: ' + r.filled.join(', ') + '.') : 'Re-parsed — all fields were already filled.';
}
function reparseAllCandidates() {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins.';
  var sh = trackerSheet_(), d = sh.getDataRange().getValues(), tried = 0, updated = 0;
  for (var i = 1; i < d.length && tried < 40; i++) {
    if (!d[i][1] || !d[i][5]) continue; tried++;
    try { var r = reparseRow_(sh, i + 1); if (r.filled && r.filled.length) updated++; } catch (e) {}
  }
  return '✅ Re-parsed ' + tried + ' CV(s); filled missing fields on ' + updated + ' candidate(s). Run again if you have more than 40.';
}
// ---------- FIT SCORECARD (configurable, industry-weighted) ----------
var FIT_KEYS = ['skills', 'domain', 'problem_solving', 'pedigree', 'impact', 'certs', 'stability', 'logistics'];
var FIT_LABELS = { skills: 'Skills / tech match', domain: 'Relevant domain exp', problem_solving: 'Problem-solving / design', pedigree: 'Company / education pedigree', impact: 'Impact / progression', certs: 'Certifications / regulatory', stability: 'Stability / tenure', logistics: 'Logistics (notice/CTC/relocate)' };
var FIT_PRESETS = {
  'Services (IT/Consulting)': { skills: 30, domain: 20, problem_solving: 5, pedigree: 10, impact: 5, certs: 10, stability: 5, logistics: 15 },
  'Product company': { skills: 25, domain: 10, problem_solving: 20, pedigree: 20, impact: 15, certs: 0, stability: 5, logistics: 5 },
  'Ecommerce': { skills: 20, domain: 15, problem_solving: 15, pedigree: 10, impact: 20, certs: 5, stability: 5, logistics: 10 },
  'AI / ML': { skills: 25, domain: 15, problem_solving: 15, pedigree: 15, impact: 10, certs: 5, stability: 5, logistics: 10 },
  'Fintech': { skills: 20, domain: 25, problem_solving: 15, pedigree: 15, impact: 5, certs: 10, stability: 5, logistics: 5 },
  'Media / Creative': { skills: 20, domain: 15, problem_solving: 10, pedigree: 10, impact: 20, certs: 5, stability: 5, logistics: 15 },
  'Industrial / Manufacturing': { skills: 20, domain: 25, problem_solving: 10, pedigree: 10, impact: 5, certs: 15, stability: 5, logistics: 10 },
  'Pharma / Healthcare': { skills: 15, domain: 25, problem_solving: 5, pedigree: 15, impact: 5, certs: 20, stability: 5, logistics: 10 }
};
function getFitPresets() { return { presets: FIT_PRESETS, labels: FIT_LABELS, keys: FIT_KEYS }; }
function getFitConfig(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var def = 'Services (IT/Consulting)';
  try {
    var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), d = sh.getDataRange().getValues();
    for (var i = 1; i < d.length; i++) if ((d[i][0] || '').toString() === reqId.toString()) { var raw = d[i][23]; if (raw) { var c = JSON.parse(raw); if (c.archetype && c.weights) return c; } break; }
  } catch (e) {}
  return { archetype: def, weights: FIT_PRESETS[def] };
}
function saveFitConfig(reqId, archetype, weights) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins.';
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), row = findReqRow_(sh, reqId); if (row < 0) return 'Requisition not found.';
  var w = {}; FIT_KEYS.forEach(function (k) { w[k] = Number((weights && weights[k]) || 0); });
  sh.getRange(row, 24).setValue(JSON.stringify({ archetype: archetype || 'Custom', weights: w })); bustCache_();
  return '✅ Fit weights saved (' + (archetype || 'Custom') + ').';
}
// ---------- ORG CONTEXT + ROLE HIRING BENCHMARK ----------
var STAGE_SLA_DEFAULTS = { screening: 5, interview: 4, debrief: 3, offer: 3, other: 10 };
function stageSlaMap_() {
  var raw = PropertiesService.getScriptProperties().getProperty('ORG_STAGE_SLA'), m = {};
  try { m = raw ? JSON.parse(raw) : {}; } catch (e) { m = {}; }
  var out = {}; for (var k in STAGE_SLA_DEFAULTS) { var v = parseInt(m[k], 10); out[k] = (v > 0 ? v : STAGE_SLA_DEFAULTS[k]); }
  return out;
}
function slaForStage_(stage) {
  var sl = (stage || '').toString().toLowerCase(), m = stageSlaMap_();
  if (sl.indexOf('screen') > -1) return m.screening;
  if (sl.indexOf('debrief') > -1) return m.debrief;
  if (sl.indexOf('offer') > -1) return m.offer;
  if (sl.indexOf('interview') > -1) return m.interview;
  return m.other;
}
function orgContext_() {
  var p = PropertiesService.getScriptProperties();
  return { company: p.getProperty('ORG_COMPANY') || '', type: p.getProperty('ORG_TYPE') || '', hires: p.getProperty('ORG_HIRES') || '', bar: p.getProperty('ORG_BAR') || '',
    workStart: parseInt(p.getProperty('ORG_WS') || '9', 10), workEnd: parseInt(p.getProperty('ORG_WE') || '18', 10), slotMin: parseInt(p.getProperty('ORG_SLOT') || '60', 10),
    ack: p.getProperty('ORG_ACK') !== '0', chatWebhook: p.getProperty('CHAT_WEBHOOK') || '', alertEmail: p.getProperty('ORG_ALERT_EMAIL') || '', reportLink: p.getProperty('REPORT_LINK') || '',
    stageSla: stageSlaMap_(),
    recruiterName: p.getProperty('RECRUITER_NAME') || '', recruiterTitle: p.getProperty('RECRUITER_TITLE') || '', logoUrl: p.getProperty('LOGO_URL') || '',
    rerankUrl: p.getProperty('RERANK_URL') || '', rerankToken: p.getProperty('RERANK_TOKEN') || '', patentKey: p.getProperty('PATENTSVIEW_KEY') || '',
    defaultCompany: p.getProperty('ORG_DEFAULT_COMPANY') || '' };
}

// C-1: public wrapper for the org context. The raw context contains secrets (re-rank token,
// Chat webhook URL, PatentsView key), so it now requires a verified team member; secrets are
// only returned to Recruiters/Admins. Internal code keeps using orgContext_() directly.
function getOrgContext() {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error };
  var o = orgContext_();
  if (roleRank_(_g.role) < roleRank_('Recruiter')) { o.rerankToken = ''; o.patentKey = ''; o.chatWebhook = ''; }
  return o;
}
function getSpreadsheetUrl() {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return _g.error; // C-1: server-side auth
  try { return SpreadsheetApp.openById(SHEET_ID).getUrl(); } catch (e) { return ''; } }
function saveLogo(b64, name, mime) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  try {
    var blob = Utilities.newBlob(Utilities.base64Decode(b64), mime || 'image/png', name || 'company-logo');
    // L-8 FIX: create the logo inside the app's Drive folder (was: loose in My Drive).
    // Link-sharing stays on because the <img> in the web app loads it without sign-in —
    // it's a logo, not PII.
    var file = DriveApp.getFolderById(FOLDER_ID).createFile(blob);
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
    var url = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w240';
    PropertiesService.getScriptProperties().setProperty('LOGO_URL', url);
    return { ok: true, url: url };
  } catch (e) { return { error: e.message }; }
}
function setOrgContext(o) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var p = PropertiesService.getScriptProperties();
  p.setProperty('ORG_COMPANY', o.company || ''); p.setProperty('ORG_TYPE', o.type || ''); p.setProperty('ORG_HIRES', o.hires || ''); p.setProperty('ORG_BAR', o.bar || '');
  if (o.workStart) p.setProperty('ORG_WS', String(o.workStart)); if (o.workEnd) p.setProperty('ORG_WE', String(o.workEnd)); if (o.slotMin) p.setProperty('ORG_SLOT', String(o.slotMin));
  p.setProperty('ORG_ACK', o.ack === false ? '0' : '1');
  if (o.chatWebhook != null) p.setProperty('CHAT_WEBHOOK', o.chatWebhook || '');
  if (o.alertEmail != null) p.setProperty('ORG_ALERT_EMAIL', o.alertEmail || '');
  if (o.reportLink != null) p.setProperty('REPORT_LINK', o.reportLink || '');
  if (o.stageSla && typeof o.stageSla === 'object') { var clean = {}; for (var k in STAGE_SLA_DEFAULTS) { var v = parseInt(o.stageSla[k], 10); clean[k] = (v > 0 ? v : STAGE_SLA_DEFAULTS[k]); } p.setProperty('ORG_STAGE_SLA', JSON.stringify(clean)); }
  if (o.recruiterName != null) p.setProperty('RECRUITER_NAME', o.recruiterName || '');
  if (o.recruiterTitle != null) p.setProperty('RECRUITER_TITLE', o.recruiterTitle || '');
  if (o.logoUrl != null) p.setProperty('LOGO_URL', o.logoUrl || '');
  if (o.rerankUrl != null) p.setProperty('RERANK_URL', (o.rerankUrl || '').toString().replace(/\/+$/, ''));
  if (o.rerankToken != null) p.setProperty('RERANK_TOKEN', o.rerankToken || '');
  if (o.patentKey != null) p.setProperty('PATENTSVIEW_KEY', o.patentKey || '');
  if (o.defaultCompany != null) { p.setProperty('ORG_DEFAULT_COMPANY', o.defaultCompany || ''); bustCache_(); }
  return { ok: true };
}
// Call the external cross-encoder microservice (Step 3+4). Returns {id: crossScore0to1} or null if unavailable.
function deepRerank_(jd, items) {
  var p = PropertiesService.getScriptProperties(), url = p.getProperty('RERANK_URL'), tok = p.getProperty('RERANK_TOKEN');
  if (!url || !items || !items.length) return null;
  try {
    var res = UrlFetchApp.fetch(url + '/rerank', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: tok ? { Authorization: 'Bearer ' + tok } : {},
      payload: JSON.stringify({ jd: (jd || '').slice(0, 6000), candidates: items, top_k: 100 })
    });
    if (res.getResponseCode() !== 200) return null;
    var d = JSON.parse(res.getContentText()), map = {};
    (d.results || []).forEach(function (r) { map[r.id] = Number(r.cross); });
    return map;
  } catch (e) { return null; }
}
function rerankerStatus() {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var url = PropertiesService.getScriptProperties().getProperty('RERANK_URL'); if (!url) return { configured: false };
  try { var res = UrlFetchApp.fetch(url + '/', { muteHttpExceptions: true }); var ok = res.getResponseCode() === 200; return { configured: true, online: ok, info: ok ? res.getContentText().slice(0, 200) : ('HTTP ' + res.getResponseCode()) }; }
  catch (e) { return { configured: true, online: false, info: e.message }; }
}
function getBenchmark(reqId, regenerate) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), row = findReqRow_(sh, reqId);
  if (row < 0) return { error: 'Requisition not found.' };
  if (!regenerate) { var raw = sh.getRange(row, 25).getValue(); if (raw) { try { return JSON.parse(raw); } catch (e) {} } }
  var s = {}; try { s = getReqSummary(reqId) || {}; } catch (e) {}
  var org = orgContext_(), cfg = getFitConfig(reqId);
  var prompt = 'You are an expert technical recruiter. Define the HIRING BENCHMARK (the bar) for this role, drawing on how ' + cfg.archetype + ' companies' + (org.company ? ' like ' + org.company : '') + ' typically hire, and widely-known industry hiring bars and interview practices for this role and seniority.\n' +
    'Company context: type=' + (org.type || cfg.archetype) + '; typically hires=' + (org.hires || 'n/a') + '; hiring-bar notes=' + (org.bar || 'n/a') + '.\n' +
    'Role: ' + (s.title || reqId) + ' · Level: ' + (s.level || 'n/a') + ' · ' + (s.lob || '') + '.\n' +
    'Return ONLY JSON: {"ideal_profile":"","by_level":"","must_have_signals":[],"red_flags":[],"sample_questions":[]}. ' +
    'ideal_profile=2-3 sentences on a strong candidate; by_level=how the bar shifts with seniority; must_have_signals=8-12 concrete resume signals of a strong hire; red_flags=resume signals of a weak fit; sample_questions=6-8 representative interview questions for this role.';
  var j; try { j = JSON.parse(callGemini(prompt, true)); } catch (e) { return { error: e.message }; }
  sh.getRange(row, 25).setValue(JSON.stringify(j));
  return j;
}
function benchmarkSignals_(reqId) {
  try { var b = getBenchmark(reqId, false); if (b && !b.error && b.must_have_signals) return b.must_have_signals; } catch (e) {}
  return [];
}
// ---------- TALENT-INTELLIGENCE CONTEXT (job architecture by company type + signals rubric) ----------
var JOB_ARCHITECTURE = 'COMPANY-TYPE JOB ARCHITECTURE — calibrate what "strong" means by the kind of company and the role family:\n' +
  '• FAANG / Big Tech (Google, Amazon, Meta, Microsoft, Apple, Netflix): deep level ladders (L3–L8 / SDE-I–Distinguished), very high engineering bar, scale & systems depth — strong pedigree signal.\n' +
  '• Product / SaaS scale-ups & unicorns (Stripe, Uber, Atlassian, Razorpay…): ownership, 0→1 plus scaling, product sense.\n' +
  '• E-commerce / marketplaces (Amazon, Flipkart, Shopify): high-throughput, peak-traffic scale, logistics/marketplace domain.\n' +
  '• AI / ML labs & startups: research or applied-ML depth, publications, notable open-source.\n' +
  '• IT Services / Consulting (TCS, Infosys, Accenture, Cognizant, Capgemini): breadth & client delivery; titles often inflated — weigh ACTUAL scope/impact over title.\n' +
  '• Early-stage startups (seed–Series A/B): generalist range, 0→1 building, ambiguity tolerance; joining EARLY and helping scale is a strong signal.\n' +
  '• Non-tech families (sales, marketing, ops, finance, HR, product): map to the equivalent family & seniority and weigh domain outcomes (quota, pipeline, P&L, programs, campaigns) — not tech signals.';
var RANK_SIGNALS = 'SIGNALS TO WEIGH (reward when present AND relevant; infer from company, title, education, skills and resume highlights — do NOT require exact JD keywords):\n' +
  '1) Domain & role relevance (primary gate).\n' +
  '2) Seniority & leadership scope — team/org size built, cross-functional or P&L ownership.\n' +
  '3) Pedigree — strong employers AND tier-1 institutions (IIT/NIT/BITS/IIIT/IIM/Ivy/top global); engineering degree and high CGPA/GPA when stated.\n' +
  '4) Company stage when they JOINED (seed/Series-A vs late) and the growth they drove — MAU/ARR/revenue growth, new product/feature launches, market/geo expansion, 0→1 vs scaling.\n' +
  '5) Project & system complexity — scale, distributed/high-throughput systems, regulated domains, genuine ambiguity.\n' +
  '6) Open-source & community — notable repositories (stars/maintainership), hackathon wins, competitive-programming/coding-competition placements (ICPC, Kaggle, Codeforces, GSoC), patents, publications, conference talks.\n' +
  '7) Career trajectory — promotion velocity, increasing scope, healthy tenure (churn is a mild red flag).\n' +
  '8) Recency & depth of the most relevant skills.\n' +
  'For NON-TECH roles substitute domain-appropriate signals (quota attainment, pipeline built, campaign ROI, programs shipped, certifications).';
var SERVICES_SIGNALS = 'SERVICES / CONSULTING EMPHASIS (this is a services company — weigh these heavily): relevant CERTIFICATIONS (cloud/PM/domain), TENURE & STABILITY (low job-hopping, reliable delivery), BREADTH across clients/domains & delivery track record, NOTICE PERIOD / availability to deploy, COMPENSATION within the role band, and readiness for client LOCATION & WORK AUTHORIZATION. Treat visa/location/min-years/mandatory-cert mismatches as KNOCKOUTS (score low). Discount inflated titles — judge actual delivery scope. Generalist breadth and fast ramp matter more than deep single-stack specialization.';
function servicesMode_() { try { var t = ((getJobArch().companyType || '') + ' ' + (orgContext_().type || '')).toLowerCase(); return t.indexOf('service') > -1 || t.indexOf('consult') > -1; } catch (e) { return false; } }
function reqBand_(reqId) { try { var rq = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions').getDataRange().getValues(); for (var i = 1; i < rq.length; i++) if ((rq[i][0] || '').toString() === reqId.toString()) { var mn = parseFloat(('' + (rq[i][11] || '')).replace(/[^\d.]/g, '')) || 0, mx = parseFloat(('' + (rq[i][12] || '')).replace(/[^\d.]/g, '')) || 0; return { min: mn, max: mx }; } } catch (e) {} return { min: 0, max: 0 }; }
function compFit_(ctc, band) { var n = parseFloat(('' + (ctc || '')).replace(/[^\d.]/g, '')) || 0; if (!n || (!band.min && !band.max)) return ''; if (band.max && n > band.max * 1.05) return 'above budget'; if (band.min && n < band.min * 0.9) return 'below band'; return 'within band'; }
// ---------- COMPANY JOB ARCHITECTURE (configurable; recommended-from-market or bring-your-own) ----------
var COMPANY_TYPES = ['Product / SaaS', 'E-commerce / Marketplace', 'Internet / Consumer', 'IT Services / Consulting', 'Mid-cap / Enterprise', 'AI / ML', 'Fintech', 'Fintech AI', 'BFSI / Banking', 'Industrial / Manufacturing AI', 'Healthcare / Pharma', 'Deep Tech / R&D', 'Early-stage Startup', 'Other'];
function getJobArch() {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var raw = PropertiesService.getScriptProperties().getProperty('ORG_JOB_ARCH'), o = {};
  try { o = raw ? JSON.parse(raw) : {}; } catch (e) { o = {}; }
  return { companyTypes: COMPANY_TYPES, companyType: o.companyType || '', tech: o.tech || { families: [] }, nontech: o.nontech || { families: [] } };
}
function setJobArch(obj) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var clean = { companyType: (obj && obj.companyType) || '', tech: (obj && obj.tech) || { families: [] }, nontech: (obj && obj.nontech) || { families: [] } };
  PropertiesService.getScriptProperties().setProperty('ORG_JOB_ARCH', JSON.stringify(clean)); bustCache_();
  return { ok: true };
}
function recommendJobArch(companyType, track) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var org = orgContext_();
  var prompt = 'You are a compensation & leveling expert. Propose a MARKET-STANDARD job architecture for a "' + (companyType || 'technology') + '" company' + (org.company ? ' like ' + org.company : '') + ', for ' + (track === 'nontech' ? 'NON-TECH (sales, marketing, ops, finance, HR, product, etc.)' : 'TECH (engineering, data, ML, product, design, etc.)') + ' roles, grounded in how leading companies of this type structure their ladders.\n' +
    'Return ONLY JSON: {"families":[{"family":"","levels":[{"level":"","minYears":0,"maxYears":0,"scope":""}]}]}. 3-6 job families typical for this company type & track; each with 4-7 levels from entry to senior/leadership; minYears/maxYears = typical RELEVANT-experience band per level; scope = one short line on expected scope/impact at that level.';
  var j; try { j = JSON.parse(callGemini(prompt, true)); } catch (e) { return { error: e.message }; }
  return { families: j.families || [] };
}
function jobArchText_() {
  try {
    var a = getJobArch();
    if (!a.companyType && !(a.tech.families || []).length && !(a.nontech.families || []).length) return '';
    function fam(list, label) { if (!list || !list.length) return ''; return '\n' + label + ': ' + list.map(function (f) { return f.family + ' [' + (f.levels || []).map(function (l) { return l.level + '(' + l.minYears + '-' + l.maxYears + 'y)'; }).join(', ') + ']'; }).join('; '); }
    return 'COMPANY JOB ARCHITECTURE' + (a.companyType ? ' (' + a.companyType + ')' : '') + ' — calibrate levels & experience bands to THIS ladder:' + fam(a.tech.families, 'Tech') + fam(a.nontech.families, 'Non-tech');
  } catch (e) { return ''; }
}
// ---------- RESEARCH & PATENTS (OpenAlex publications + PatentsView patents; human-confirmed) ----------
function lookupResearch(candId) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return { error: 'Candidate not found.' };
  var name = (sh.getRange(row, 2).getValue() || '').toString().trim(); if (!name) return { error: 'No candidate name.' };
  var out = { name: name, scholars: [], patents: [], patentNote: '' }, opt = { muteHttpExceptions: true, headers: { 'User-Agent': 'AgentATS' } };
  try {
    var r = UrlFetchApp.fetch('https://api.openalex.org/authors?search=' + encodeURIComponent(name) + '&per-page=5', opt);
    if (r.getResponseCode() === 200) { var d = JSON.parse(r.getContentText()); out.scholars = (d.results || []).map(function (a) { var inst = ''; try { inst = (a.last_known_institutions && a.last_known_institutions[0] && a.last_known_institutions[0].display_name) || (a.last_known_institution && a.last_known_institution.display_name) || ''; } catch (e) {} return { name: a.display_name, works: a.works_count || 0, citations: a.cited_by_count || 0, inst: inst, url: a.id }; }); }
  } catch (e) {}
  var pk = PropertiesService.getScriptProperties().getProperty('PATENTSVIEW_KEY');
  if (pk) {
    try {
      var last = name.split(/\s+/).pop();
      var q = 'q=' + encodeURIComponent(JSON.stringify({ '_text_phrase': { 'inventors.inventor_name_last': last } })) + '&f=' + encodeURIComponent(JSON.stringify(['patent_id', 'patent_title'])) + '&o=' + encodeURIComponent(JSON.stringify({ size: 5 }));
      var pr = UrlFetchApp.fetch('https://search.patentsview.org/api/v1/patent/?' + q, { muteHttpExceptions: true, headers: { 'User-Agent': 'AgentATS', 'X-Api-Key': pk } });
      if (pr.getResponseCode() === 200) { var pd = JSON.parse(pr.getContentText()); out.patents = (pd.patents || []).map(function (p) { return { id: p.patent_id, title: (p.patent_title || '').slice(0, 100) }; }); out.patentCount = pd.total_hits || out.patents.length; }
      else out.patentNote = 'PatentsView returned HTTP ' + pr.getResponseCode() + '.';
    } catch (e) { out.patentNote = e.message; }
  } else { out.patentNote = 'Add a free PatentsView API key in 🏢 Company to enable patent lookup.'; }
  return out;
}
function saveResearch(candId, text) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return { error: 'Candidate not found.' };
  var hl = (sh.getRange(row, 37).getValue() || '').toString();
  sh.getRange(row, 37).setValue(sanitizeCell_((hl ? hl + '; ' : '') + text)); // C-2
  try { logAudit_(candId, 'Research/patents confirmed — ' + text); } catch (e) {}
  return { ok: true };
}
// ---------- SUCCESS PROFILE (market-calibrated portrait of a top hire; cached on Requisitions col 27) ----------
// M-2 FIX: cols 27-28 were written with NO header, so sbRowsFromSheet_ (which keys on headers)
// silently excluded success profiles/context from Supabase sync and every backup. This makes
// sure the headers exist before any write (self-healing for sheets set up before the fix).
function ensureReqExtraHeaders_(sh) {
  try {
    if (!(sh.getRange(1, 27).getValue() || '').toString()) sh.getRange(1, 27).setValue('Success Profile').setFontWeight('bold');
    if (!(sh.getRange(1, 28).getValue() || '').toString()) sh.getRange(1, 28).setValue('Success Context').setFontWeight('bold');
  } catch (e) {}
}
function getSuccessProfile(reqId, regen) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), row = findReqRow_(sh, reqId);
  if (row < 0) return { error: 'Requisition not found.' };
  if (!regen) { var raw = sh.getRange(row, 27).getValue(); if (raw) { try { return JSON.parse(raw); } catch (e) {} } }
  var s = {}; try { s = getReqSummary(reqId) || {}; } catch (e) {}
  var org = orgContext_(), cfg = getFitConfig(reqId), brief = {};
  try { var cal = getCalibration(reqId); brief = (cal && cal.brief) || {}; } catch (e) {}
  var jd = String(reqJDText_(reqId) || '');
  var spctx = ''; try { spctx = (sh.getRange(row, 28).getValue() || '').toString(); } catch (e) {}
  var prompt = 'You are a talent-intelligence expert. Using the job description, company context, the recruiter/HM domain context (if any), and your knowledge of how strong people in this field are described on public platforms (LinkedIn, Glassdoor, levels.fyi, Blind, tech Twitter) for this ROLE, INDUSTRY and SENIORITY, define the SUCCESS PROFILE of a top hire. If the role is NEW or evolving and lacks a standard template, infer the profile from the JD + domain context rather than forcing a generic one.\n' +
    (spctx ? 'RECRUITER/HM DOMAIN CONTEXT (weigh heavily — may describe a new/evolving role or specific domain experience required): ' + spctx.slice(0, 1400) + '\n' : '') +
    'Company: type=' + (org.type || cfg.archetype) + (org.company ? ' (' + org.company + ')' : '') + '; hiring bar=' + (org.bar || 'n/a') + '.\n' +
    'Role: ' + (s.title || reqId) + ' · Level: ' + (s.level || 'n/a') + ' · ' + (s.lob || '') + '.\nJD: ' + jd.slice(0, 1400) + '\nCalibrated must-haves: ' + ((brief.must_haves || []).join('; ') || '(none)') + '\n\n' + JOB_ARCHITECTURE + (jobArchText_() ? '\n\n' + jobArchText_() : '') + '\n\n' + RANK_SIGNALS + (servicesMode_() ? '\n\n' + SERVICES_SIGNALS : '') + '\n\n' +
    'Return ONLY JSON: {"exp_min":0,"exp_ideal":0,"exp_max":0,"core_skills":[],"nice_skills":[],"typical_titles":[],"typical_companies":[],"competitor_companies":[],"domains":[],"signals_to_weight":[],"red_flags":[],"market_note":"","summary":""}. signals_to_weight=the 4-6 signals above that matter MOST for THIS role/company type. competitor_companies=8-15 named companies that are direct competitors OR of very similar nature/domain to this employer (candidates from these are high-value). domains=the specific domains relevant here (e.g. for AI roles: NLP/CV/LLMs/RecSys/fintech-AI/etc.). ' +
    'exp_* = years of RELEVANT experience (min acceptable, ideal, max before over-qualified) calibrated to this seniority and market norms. core_skills=8-12 differentiating skills/competencies of a strong hire. typical_titles & typical_companies = titles/orgs strong candidates usually come from in this industry. domains=relevant domains. red_flags=resume signals of a weak fit. market_note=1-2 sentences on what the market (levels.fyi/Glassdoor/Blind) signals separate strong vs weak here. summary=2-3 sentence portrait of a top hire.';
  var j; try { j = JSON.parse(callGemini(prompt, true)); } catch (e) { return { error: e.message }; }
  try { ensureReqExtraHeaders_(sh); sh.getRange(row, 27).setValue(JSON.stringify(j)); } catch (e) {} // M-2
  bustCache_();
  return j;
}
// ---------- SUCCESS-PROFILE CONTEXT (voice/text — domain specifics, new/evolving roles) ----------
function getSuccessContext(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return _g.error; // C-1: server-side auth
  try { var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), row = findReqRow_(sh, reqId); return row < 0 ? '' : (sh.getRange(row, 28).getValue() || '').toString(); } catch (e) { return ''; } }
function setSuccessContext(reqId, text) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), row = findReqRow_(sh, reqId); if (row < 0) return { error: 'Requisition not found.' };
  ensureReqExtraHeaders_(sh); // M-2
  sh.getRange(row, 28).setValue(sanitizeCell_(text || '')); // C-2
  sh.getRange(row, 27).setValue(''); /* clear cached success profile → regenerate with new context */ bustCache_();
  try { logAudit_(reqId, 'Success-profile context updated'); } catch (e) {}
  return { ok: true };
}
function addSuccessVoice(reqId, base64, fileName, mimeType) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), row = findReqRow_(sh, reqId); if (row < 0) return { error: 'Requisition not found.' };
  var prompt = 'Transcribe this audio of a recruiter/hiring manager describing the ideal-candidate SUCCESS PROFILE (domain specifics, must-have experience, what "great" looks like — especially for AI/niche or newly-evolving roles). Return ONLY JSON: {"transcript":""}.';
  var raw; try { raw = geminiRequest_({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64 } }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }); }
  catch (e) { return { error: 'Transcription failed (try mp3/m4a/wav): ' + e.message }; }
  var t = ''; try { t = (JSON.parse(raw).transcript || '').toString(); } catch (e) { t = raw; }
  var prev = (sh.getRange(row, 28).getValue() || '').toString();
  ensureReqExtraHeaders_(sh); // M-2
  sh.getRange(row, 28).setValue(sanitizeCell_((prev ? prev + '\n' : '') + t)); // C-2
  sh.getRange(row, 27).setValue(''); bustCache_();
  try { logAudit_(reqId, 'Success-profile voice note added'); } catch (e) {}
  return { ok: true, transcript: t };
}
// ---------- SHARED RANKING ENGINE (used by stack rank, rediscovery) ----------
// Listwise market-calibrated re-rank grounded in the success profile + experience-band fit + must-have coverage. Bias-blind.
function rankProfiles_(reqId, cands, deep) {
  if (!cands || !cands.length) return { ranked: [], count: 0 };
  var sp = {}; try { sp = getSuccessProfile(reqId, false) || {}; } catch (e) {} if (sp.error) sp = {};
  var cal = {}; try { cal = getCalibration(reqId) || {}; } catch (e) {} var brief = cal.brief || {};
  var must = (brief.must_haves || []).slice(0);
  var cfg = {}; try { cfg = getFitConfig(reqId) || {}; } catch (e) {}
  var FLAB = { skills: 'Skills', domain: 'Domain', problem_solving: 'Problem-solving', pedigree: 'Pedigree', impact: 'Impact', certs: 'Certifications', stability: 'Stability', logistics: 'Logistics' };
  var prio = ''; try { var W = cfg.weights || {}; prio = Object.keys(W).map(function (k) { return { k: k, w: Number(W[k] || 0) }; }).sort(function (a, b) { return b.w - a.w; }).slice(0, 4).map(function (x) { return (FLAB[x.k] || x.k) + ' (' + x.w + ')'; }).join(', '); } catch (e) {}
  (sp.core_skills || []).forEach(function (x) { if (must.indexOf(x) < 0) must.push(x); });
  try { benchmarkSignals_(reqId).forEach(function (x) { if (must.indexOf(x) < 0) must.push(x); }); } catch (e) {}
  var mustL = must.map(function (s) { return (s || '').toString().toLowerCase(); });
  var emin = Number(sp.exp_min) || 0, emax = Number(sp.exp_max) || 0, eideal = Number(sp.exp_ideal) || 0;
  function expFit(y) { y = parseFloat(('' + y).replace(/[^\d.]/g, '')); if (isNaN(y)) return 70; if (!emin && !emax) return 80; if (emax && y > emax) return Math.max(78, 100 - (y - emax) * 3); /* over-qualified = only mildly lower */ if (emin && y < emin) return Math.max(30, 100 - (emin - y) * 12); return 100; }
  var svc = servicesMode_(), band = svc ? reqBand_(reqId) : { min: 0, max: 0 };
  var pool = cands.slice(0, 40);
  pool.forEach(function (c) { var text = ((c.title || '') + ' ' + (c.company || '') + ' ' + (c.skills || '') + ' ' + (c.qual || '')).toLowerCase(); c._cov = mustL.length ? Math.round(mustL.filter(function (m) { return m && text.indexOf(m) > -1; }).length / mustL.length * 100) : null; c._exp = Math.round(expFit(c.exp)); c._comp = svc ? compFit_(c.ctc, band) : ''; });
  var profiles = pool.map(function (c, idx) { return 'C' + idx + ': ' + (c.title || 'role?') + ' @ ' + (c.company || '?') + ', ' + (c.exp || '?') + ' yrs. Skills: ' + (c.skills || '—') + '. Education: ' + (c.qual || '—') + (c.highlights ? '. Highlights: ' + c.highlights : '') + (c.patents ? '. Patents: ' + c.patents : ''); });
  var prompt = 'You are an expert recruiter doing a ZERO-BIAS, market-calibrated stack rank. Rank candidates RELATIVE to each other against the SUCCESS PROFILE of a top hire for this role/industry. Judge on relevance, seniority, pedigree and impact — candidates are anonymised; ignore name/gender/age.\n\n' +
    JOB_ARCHITECTURE + (jobArchText_() ? '\n\n' + jobArchText_() : '') + '\n\n' + RANK_SIGNALS + (servicesMode_() ? '\n\n' + SERVICES_SIGNALS : '') + '\n\n' +
    'SUCCESS PROFILE: ' + JSON.stringify({ exp_min: emin, exp_ideal: eideal, exp_max: emax, core_skills: (sp.core_skills || []), typical_titles: (sp.typical_titles || []), competitor_companies: (sp.competitor_companies || []), domains: (sp.domains || []), red_flags: (sp.red_flags || []), signals_to_weight: (sp.signals_to_weight || []), market_note: sp.market_note || '' }).slice(0, 1800) + '\n' +
    'DOMAIN & COMPETITOR WEIGHTING: strongly reward candidates who have worked at the COMPETITOR/SIMILAR companies listed, or in the same DOMAIN — domain understanding and direct-competitor experience are major positive signals. For AI/ML roles especially, weigh genuine domain understanding (the specific AI sub-domain and having shipped in a comparable domain/company) heavily.\n' +
    'MUST-HAVES: ' + (must.join('; ') || '(none)') +
    '\nNICE-TO-HAVES: ' + ((brief.nice_to_haves || []).join('; ') || '(none)') +
    '\nRED FLAGS (penalise): ' + ((brief.red_flags || []).join('; ') || '(none)') +
    (cal.notes ? '\nRECRUITER NOTES: ' + String(cal.notes).slice(0, 500) : '') +
    ((cal.transcript || brief.summary) ? '\nHIRING-MANAGER CALIBRATION: ' + String(cal.transcript || brief.summary).slice(0, 700) : '') +
    (prio ? '\nSCORING PRIORITIES (weigh these factors most, per the recruiter): ' + prio : '') +
    '\nCANDIDATES:\n' + profiles.join('\n') + '\n' +
    'Return ONLY JSON: {"ranking":[{"id":"C0","score":0-100,"reason":""}]} best-first. score=overall fit considering the success profile, must/nice-to-haves, hiring-manager calibration and the recruiter\'s scoring priorities; reason=one concise evidence-based line. ' +
    'REWARD strong directly-relevant experience, leadership scope, domain depth and pedigree (e.g. building/scaling teams or systems at strong companies) — infer transferable seniority even when the resume uses different words than the JD. A clearly senior, highly-relevant candidate should score HIGH (80-95). Only give LOW scores to candidates who are genuinely under-qualified, off-domain, or match red flags. Do NOT heavily penalise over-qualification (target band ' + (emin || '?') + '-' + (emax || '?') + ' yrs) — at most a small reduction.';
  // Step 4 — DEEP: real cross-encoder microservice if available & requested; else listwise Gemini (RankGPT-style).
  var cross = null, engine = 'listwise';
  if (deep) {
    var jdText = String(reqJDText_(reqId) || '') + '\nMust-haves: ' + must.join(', ') + '\nNice-to-haves: ' + (brief.nice_to_haves || []).join(', ') + (cal.notes ? '\nRecruiter notes: ' + cal.notes : '') + ((cal.transcript || brief.summary) ? '\nHiring manager: ' + (cal.transcript || brief.summary) : '') + '\nCore skills: ' + (sp.core_skills || []).join(', ');
    var items = pool.map(function (c, idx) { return { id: 'C' + idx, text: profiles[idx] }; });
    cross = deepRerank_(jdText, items);
    if (cross) engine = 'cross-encoder';
  }
  var rankMap = {}, aiErr = '';
  if (!cross) {
    try { var j = JSON.parse(callGemini(prompt, true)); (j.ranking || []).forEach(function (r) { var idx = parseInt((r.id || '').toString().replace(/[^0-9]/g, ''), 10); if (!isNaN(idx)) rankMap[idx] = { score: Math.max(0, Math.min(100, Number(r.score) || 0)), reason: (r.reason || '').toString() }; }); } catch (e) { aiErr = e.message || 'AI call failed'; }
    // H-7 FIX: if the listwise AI call failed or returned unusable JSON, every candidate would
    // get an LLM score of 0 and the UI would confidently present bogus ~10–25% "rankings".
    // Surface an explicit error instead — no fake scores are ever produced.
    if (!Object.keys(rankMap).length) {
      return { ranked: [], count: 0, aiFailed: true,
        error: '⚠️ AI ranking failed (' + (aiErr || 'no usable ranking returned') + ') — no scores were produced. Nothing was saved; hit "Re-rank now" to try again.' };
    }
  }
  var out = pool.map(function (c, idx) {
    var llm, reason, fin, cov = (c._cov == null ? 0 : c._cov);
    if (cross) {
      llm = Math.round((cross['C' + idx] != null ? cross['C' + idx] : 0) * 100);   // cross-encoder 0..1 -> 0..100
      var onto = Math.round(cov * 0.6 + c._exp * 0.4);                              // ontological match
      fin = Math.round(llm * 0.7 + onto * 0.3);                                     // Step 5 composite (0.70/0.30)
      reason = 'Cross-encoder relevance ' + llm + '% · ontological ' + onto + '%';
    } else {
      var rm = rankMap[idx] || { score: 0, reason: '' };
      llm = rm.score; var c2 = (c._cov == null ? rm.score : c._cov);
      fin = Math.round(rm.score * 0.7 + c2 * 0.15 + c._exp * 0.15); // trust the LLM judgment most; keyword coverage is a minor signal
      reason = rm.reason;
    }
    var yexp = parseFloat(('' + c.exp).replace(/[^\d.]/g, '')) || 0;
    var over = !!(emax && yexp > emax + 3);
    return { candId: c.candId, name: c.name, title: c.title, company: c.company, exp: c.exp, stage: c.stage || '', reqId: c.reqId || reqId, score: fin, llm: llm, coverage: c._cov, expFit: c._exp, over: over, comp: c._comp || '', reason: reason, matched: c.matched || null, pool: c.pool || false };
  });
  out.sort(function (a, b) { return b.score - a.score; });
  return { ranked: out, count: out.length, hasMust: !!must.length, engine: engine, sp: { exp_min: emin, exp_ideal: eideal, exp_max: emax, summary: sp.summary || '', market_note: sp.market_note || '', core_skills: (sp.core_skills || []), typical_titles: (sp.typical_titles || []) } };
}
function embed_(text) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY'); if (!key) return null;
  text = (text || '').toString().slice(0, 8000); if (!text.trim()) return null;
  try {
    var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent',
      { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, muteHttpExceptions: true,
        payload: JSON.stringify({ model: 'models/text-embedding-004', content: { parts: [{ text: text }] } }) });
    var d = JSON.parse(res.getContentText()); return (d.embedding && d.embedding.values) || null;
  } catch (e) { return null; }
}
function cosine_(a, b) { if (!a || !b || a.length !== b.length) return null; var dot = 0, na = 0, nb = 0; for (var i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } if (!na || !nb) return null; return dot / (Math.sqrt(na) * Math.sqrt(nb)); }
function semanticRelevance_(reqId, candText) {
  try {
    var jd = String(reqJDText_(reqId) || ''), brief = {};
    try { var cal = getCalibration(reqId); brief = (cal && cal.brief) || {}; } catch (e) {}
    var sig = []; try { sig = benchmarkSignals_(reqId); } catch (e) {}
    var sim = cosine_(embed_(jd + ' ' + ((brief.must_haves || []).join(', ')) + ' ' + sig.join(', ')), embed_(candText));
    if (sim == null) return null;
    return Math.max(0, Math.min(100, Math.round((sim - 0.30) / 0.40 * 100)));
  } catch (e) { return null; }
}
function fitScore(candId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return { error: 'Candidate not found.' };
  var r = sh.getRange(row, 1, 1, 35).getValues()[0], reqId = (r[11] || '').toString();
  var jd = String(reqJDText_(reqId) || ''), brief = {};
  try { var cal = getCalibration(reqId); brief = (cal && cal.brief) || {}; } catch (e) {}
  var cfg = getFitConfig(reqId);
  var sp = {}; try { sp = getSuccessProfile(reqId, false) || {}; } catch (e) {} if (sp.error) sp = {};
  var mask = false; try { mask = getSettings().biasMask; } catch (e) {}
  var cand = 'Name: ' + (mask ? '(hidden for unbiased screening)' : (r[1] || '')) + '\nTitle: ' + (r[18] || '') + '\nCompany: ' + (r[17] || '') + '\nExperience: ' + (r[19] || '') + ' yrs\nSkills: ' + (r[20] || '') + '\nQualification: ' + (r[21] || '') + '\nNotice: ' + (r[22] || '') + '\nCurrent CTC: ' + (r[23] || '') + '\nExpected CTC: ' + (r[24] || '') + '\nWilling to relocate: ' + (r[15] || '');
  var must = (brief.must_haves || []).join('; '), nice = (brief.nice_to_haves || []).join('; '), red = (brief.red_flags || []).join('; ');
  var prompt = 'You are an evidence-based technical recruiter scoring a candidate for a "' + cfg.archetype + '" type company. Score each component 0-100 using ONLY evidence in the profile; do not invent.\n' +
    'ROLE: ' + jd.slice(0, 1500) + '\nSUCCESS PROFILE (market-calibrated): experience ' + (sp.exp_min || '?') + '-' + (sp.exp_max || '?') + ' yrs (ideal ' + (sp.exp_ideal || '?') + ')' + (sp.market_note ? '; ' + sp.market_note : '') + '\nMUST-HAVES: ' + (must || '(none)') + '\nNICE-TO-HAVES: ' + (nice || '(none)') + '\nRED FLAGS: ' + (red || '(none)') + '\nCANDIDATE:\n' + cand + '\n' +
    'Return ONLY JSON: {"components":{"skills":0,"domain":0,"problem_solving":0,"pedigree":0,"impact":0,"certs":0,"stability":0,"logistics":0},"must_have_coverage":[{"item":"","met":true}],"strengths":[],"gaps":[],"interview_focus":[],"summary":""}. ' +
    'Each component 0-100: skills=tech/skill match to the role; domain=relevant domain experience; problem_solving=problem-solving & system-design depth; pedigree=company & education quality; impact=ownership & role progression; certs=certifications/regulatory fit; stability=tenure/job stability; logistics=notice period, CTC reasonableness and relocation fit. ' +
    'CRITICAL: role relevance is the primary gate. If the candidate\'s background is clearly NOT relevant to THIS role (e.g., a non-engineering / unrelated-domain profile applying to an engineering role), you MUST score skills and domain near 0. Never reward an irrelevant candidate on pedigree, stability, or logistics.';
  var j; try { j = JSON.parse(callGemini(prompt, true)); } catch (e) { return { error: e.message }; }
  var comp = j.components || {}, W = cfg.weights || {}, totW = 0, acc = 0, rows = [];
  FIT_KEYS.forEach(function (k) { var w = Number(W[k] || 0), s = Math.max(0, Math.min(100, Number(comp[k] || 0))); totW += w; acc += s * w; rows.push({ key: k, label: FIT_LABELS[k], score: Math.round(s), weight: w, contribution: 0 }); });
  var weighted = totW ? Math.round(acc / totW) : 0;
  rows.forEach(function (x) { x.contribution = totW ? Math.round(x.score * x.weight / totW) : 0; });
  // Role-relevance gate — prefer OBJECTIVE semantic (embedding) match; fall back to the model's skills+domain.
  var sem = semanticRelevance_(reqId, (r[18] || '') + ' ' + (r[17] || '') + ' ' + (r[20] || '') + ' ' + (r[21] || '') + ' ' + (r[19] || '') + ' yrs');
  var rel = (sem != null) ? sem : (Number(comp.skills || 0) * 0.6 + Number(comp.domain || 0) * 0.4);
  // Relevant candidates keep their full weighted score; only clearly-irrelevant ones (rel < 25) are crushed.
  var gated = rel < 25;
  var total = gated ? Math.round(weighted * (rel / 25)) : weighted;
  var rec = total >= 70 ? 'Strong fit' : (total >= 45 ? 'Possible fit' : 'Weak fit');
  return { total: total, weighted: weighted, relevance: Math.round(rel), semantic: sem, gated: gated, recommendation: rec, archetype: cfg.archetype, reqId: reqId, components: rows, coverage: j.must_have_coverage || [], strengths: j.strengths || [], gaps: j.gaps || [], focus: j.interview_focus || [], summary: j.summary || '', hasCalibration: !!(brief.must_haves && brief.must_haves.length) };
}
// ---------- SETTINGS (bias-masked screening) + SKILLS INFERENCE ----------
function getSettings() { return { biasMask: PropertiesService.getScriptProperties().getProperty('BIAS_MASK') === '1' }; }
function setBiasMask(on) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  PropertiesService.getScriptProperties().setProperty('BIAS_MASK', on ? '1' : '0');
  return { biasMask: !!on };
}
function inferSkills(candId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return { error: 'Candidate not found.' };
  var r = sh.getRange(row, 1, 1, 35).getValues()[0];
  var prompt = 'You are a skills-taxonomy assistant grounded in ESCO and O*NET occupational skill relationships. Infer this candidate\'s skill profile.\n' +
    'Title: ' + (r[18] || '') + '\nExperience: ' + (r[19] || '') + ' yrs\nListed skills: ' + (r[20] || '') + '\n' +
    'Return ONLY JSON: {"explicit":[],"implied":[],"adjacent":[],"seniority":""}. explicit=skills clearly stated; implied=skills strongly implied by their role/stack but not explicitly listed; adjacent=closely related skills they could ramp into quickly (ESCO/O*NET adjacency); seniority=one of Junior/Mid/Senior/Lead/Principal with a one-line rationale. Max 10 items per list.';
  var j; try { j = JSON.parse(callGemini(prompt, true)); } catch (e) { return { error: e.message }; }
  return { explicit: j.explicit || [], implied: j.implied || [], adjacent: j.adjacent || [], seniority: j.seniority || '' };
}
// ---------- SKILLS-GRAPH MATCH (entity graph + adjacency + explainable coverage) ----------
function buildSkillGraph(candId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return { explicit: [], implied: [], adjacent: [] };
  var raw = sh.getRange(row, 36).getValue();
  if (raw) { try { var g = JSON.parse(raw); if (g && g.explicit) return g; } catch (e) {} }
  var s = inferSkills(candId);
  if (!s || s.error) return { explicit: [], implied: [], adjacent: [] };
  var out = { explicit: s.explicit || [], implied: s.implied || [], adjacent: s.adjacent || [], seniority: s.seniority || '' };
  try { sh.getRange(row, 36).setValue(JSON.stringify(out)); } catch (e) {}
  return out;
}
function graphMatch(candId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return { error: 'Candidate not found.' };
  var reqId = (sh.getRange(row, 12).getValue() || '').toString();
  var brief = {}; try { var cal = getCalibration(reqId); brief = (cal && cal.brief) || {}; } catch (e) {}
  var reqs = (brief.must_haves || []).slice(0);
  try { benchmarkSignals_(reqId).forEach(function (x) { if (reqs.indexOf(x) < 0) reqs.push(x); }); } catch (e) {}
  function low(s) { return (s || '').toString().trim().toLowerCase(); }
  var g = buildSkillGraph(candId);
  var listed = ((sh.getRange(row, 21).getValue() || '') + '').split(/[,;]+/);
  var setE = (g.explicit || []).concat(listed).map(low).filter(Boolean);
  var setI = (g.implied || []).map(low).filter(Boolean);
  var setA = (g.adjacent || []).map(low).filter(Boolean);
  function covers(set, rt) { for (var i = 0; i < set.length; i++) { var s = set[i]; if (s && (s.indexOf(rt) > -1 || rt.indexOf(s) > -1)) return true; } return false; }
  var rows = reqs.map(function (req) { var rt = low(req); var via = 'none'; if (covers(setE, rt)) via = 'explicit'; else if (covers(setI, rt)) via = 'implied'; else if (covers(setA, rt)) via = 'adjacent'; return { req: req, via: via }; });
  var covered = rows.filter(function (x) { return x.via !== 'none'; }).length;
  return { coverage: rows, count: rows.length, covered: covered, pct: rows.length ? Math.round(covered / rows.length * 100) : null, seniority: g.seniority || '', graph: { explicit: g.explicit || [], implied: g.implied || [], adjacent: g.adjacent || [] } };
}
// ---------- TALENT REDISCOVERY (surface past candidates / Talent Pool for a new req) ----------
function rediscoverTalent(reqId) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var STOP = { and: 1, the: 1, for: 1, with: 1, you: 1, our: 1, are: 1, will: 1, have: 1, this: 1, that: 1, role: 1, team: 1, work: 1, years: 1, year: 1, experience: 1, engineer: 1, engineering: 1, senior: 1, junior: 1, lead: 1, manager: 1, developer: 1, development: 1, strong: 1, good: 1, must: 1, should: 1, ability: 1, skills: 1, knowledge: 1, including: 1, etc: 1, plus: 1, new: 1, using: 1, from: 1, into: 1, who: 1, has: 1 };
  var s = getReqSummary(reqId) || {}, brief = {};
  try { var cal = getCalibration(reqId); brief = (cal && cal.brief) || {}; } catch (e) {}
  function toks(t) { return (t || '').toString().toLowerCase().split(/[^a-z0-9+#.]+/).filter(function (w) { return w.length > 2 && !STOP[w]; }); }
  var terms = [].concat(toks(s.title), toks(s.notes));
  (brief.must_haves || []).concat(brief.nice_to_haves || []).forEach(function (m) { terms = terms.concat(toks(m)); });
  var seen = {}, uterms = []; terms.forEach(function (t) { if (!seen[t]) { seen[t] = 1; uterms.push(t); } });
  var sh = trackerSheet_(), d = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < d.length; i++) {
    if (!d[i][1]) continue;
    if ((d[i][11] || '').toString() === reqId.toString()) continue; // already on this req
    var ctext = ((d[i][1] || '') + ' ' + (d[i][18] || '') + ' ' + (d[i][17] || '') + ' ' + (d[i][20] || '') + ' ' + (d[i][21] || '')).toLowerCase();
    var matched = []; uterms.forEach(function (t) { if (ctext.indexOf(t) > -1) matched.push(t); });
    if (!matched.length) continue;
    var pool = (d[i][6] || '').toString().toLowerCase().indexOf('talent pool') > -1;
    out.push({ candId: (d[i][30] || '').toString(), name: String(d[i][1] || ''), title: String(d[i][18] || ''), company: String(d[i][17] || ''), exp: String(d[i][19] || ''), skills: String(d[i][20] || ''), qual: String(d[i][21] || ''), ctc: String(d[i][24] || ''), highlights: String(d[i][36] || ''), stage: String(d[i][6] || ''), reqId: (d[i][11] || '').toString(), matched: matched, score: matched.length, pool: pool });
  }
  out.sort(function (a, b) { return (b.score + (b.pool ? 2 : 0)) - (a.score + (a.pool ? 2 : 0)); });
  var shortlist = out.slice(0, 25); // prefilter, then market-calibrated re-rank
  if (!shortlist.length) return { terms: uterms.slice(0, 20), candidates: [], ranked: [], reqTitle: s.title || '' };
  var r = rankProfiles_(reqId, shortlist);
  if (r.error) return { error: r.error, terms: uterms.slice(0, 20), candidates: out.slice(0, 20), ranked: [], reqTitle: s.title || '' }; // H-7: surface AI failure
  return { terms: uterms.slice(0, 20), candidates: out.slice(0, 20), ranked: r.ranked, sp: r.sp, reqTitle: s.title || '' };
}
function tagCandidateToReq(candId, reqId) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins.';
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return 'Candidate not found.';
  sh.getRange(row, 12).setValue(reqId);
  if ((sh.getRange(row, 7).getValue() || '').toString().toLowerCase().indexOf('talent pool') > -1) sh.getRange(row, 7).setValue('New');
  recordStage_(candId, sh.getRange(row, 2).getValue(), (sh.getRange(row, 7).getValue() || '').toString());
  logAudit_(candId, 'Rediscovered & tagged to ' + reqId);
  return '✅ Added to ' + reqId + '.';
}
// ---------- STAGE HISTORY (precise time-in-stage / time-to-hire) ----------
function stageHistSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID), sh = ss.getSheetByName('Stage History');
  if (!sh) { sh = ss.insertSheet('Stage History'); sh.getRange(1, 1, 1, 6).setValues([['Timestamp', 'Candidate ID', 'Candidate Name', 'From Stage', 'To Stage', 'By']]).setFontWeight('bold'); }
  return sh;
}
function recordStage_(candId, name, toStage) {
  try {
    if (!candId || !toStage) return;
    var sh = stageHistSheet_(), d = sh.getDataRange().getValues(), from = '';
    for (var i = d.length - 1; i >= 1; i--) { if ((d[i][1] || '').toString() === candId.toString()) { from = (d[i][4] || '').toString(); break; } }
    if (from === toStage) return;
    var u = currentUser_(arguments);
    sh.appendRow(sanitizeRow_([new Date(), candId, name || '', from, toStage, u.name || u.email || 'Recruiter'])); // C-2
    bustCache_();
    try { sbSyncCandidate_(candId); } catch (e) {}
  } catch (e) {}
}
function getStageMetrics() {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  try {
    var d = stageHistSheet_().getDataRange().getValues(), byCand = {};
    for (var i = 1; i < d.length; i++) { var c = (d[i][1] || '').toString(); if (!c) continue; (byCand[c] = byCand[c] || []).push({ ts: d[i][0], to: (d[i][4] || '').toString() }); }
    var hireDays = [], dur = {}, cnt = {};
    Object.keys(byCand).forEach(function (c) {
      var ev = byCand[c]; ev.sort(function (a, b) { return a.ts - b.ts; });
      for (var k = 0; k < ev.length; k++) {
        if (k > 0) { var st = ev[k - 1].to, dd = (ev[k].ts - ev[k - 1].ts) / 86400000; if (dd >= 0 && st) { dur[st] = (dur[st] || 0) + dd; cnt[st] = (cnt[st] || 0) + 1; } }
        var tl = ev[k].to.toLowerCase();
        if (tl.indexOf('hire') > -1 || tl.indexOf('onboard') > -1 || tl.indexOf('offer') > -1) hireDays.push((ev[k].ts - ev[0].ts) / 86400000);
      }
    });
    var avg = hireDays.length ? Math.round(hireDays.reduce(function (a, b) { return a + b; }, 0) / hireDays.length) : null;
    var per = Object.keys(dur).map(function (s) { return { stage: s, avgDays: Math.round(dur[s] / cnt[s]) }; }).sort(function (a, b) { return b.avgDays - a.avgDays; });
    return { avgTimeToHire: avg, hiredCount: hireDays.length, perStage: per };
  } catch (e) { return { avgTimeToHire: null, hiredCount: 0, perStage: [] }; }
}
// ---------- PERFORMANCE: lightweight cache + version-based cache busting ----------
function cacheVer_() { try { return PropertiesService.getScriptProperties().getProperty('CACHE_VER') || '0'; } catch (e) { return '0'; } }
function bustCache_() { try { PropertiesService.getScriptProperties().setProperty('CACHE_VER', String(Date.now())); } catch (e) {} }
function cacheGet_(key) { try { var c = CacheService.getScriptCache().get(key); return c ? JSON.parse(c) : null; } catch (e) { return null; } }
function cachePut_(key, val, ttl) { try { var s = JSON.stringify(val); if (s.length < 95000) CacheService.getScriptCache().put(key, s, ttl || 120); } catch (e) {} }
// ---------- ARCHIVE: move terminal, old candidates out of the live Tracker to keep it fast ----------
function archiveOldCandidates(days) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  days = Number(days) || 365;
  var ss = SpreadsheetApp.openById(SHEET_ID), tr = ss.getSheetByName('Tracker'), d = tr.getDataRange().getValues();
  if (d.length < 2) return { moved: 0, message: 'Nothing to archive.' };
  var arch = ss.getSheetByName('Archive'); if (!arch) { arch = ss.insertSheet('Archive'); arch.getRange(1, 1, 1, d[0].length).setValues([d[0]]); }
  var now = new Date(), cutoff = days * 86400000, moved = 0;
  var TERM = ['cv screen reject', 'interview reject', 'debrief reject', 'rejected', 'offer declined', 'onboarded', 'hired'];
  for (var i = d.length - 1; i >= 1; i--) {
    var stage = canonStage_(d[i][6]), dt = d[i][0]; // H-2: normalize so legacy 'Rejected (Debrief)' rows finally archive
    if (TERM.indexOf(stage) > -1 && dt instanceof Date && (now - dt) > cutoff) { arch.appendRow(sanitizeRow_(d[i])); tr.deleteRow(i + 1); moved++; } // C-2: re-neutralize on move
  }
  if (moved) bustCache_();
  return { moved: moved, message: '✅ Archived ' + moved + ' terminal candidate(s) older than ' + days + ' days. Live database is leaner.' };
}
function getArchive(q) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var arch = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Archive'); if (!arch) return { rows: [], count: 0 };
  var d = arch.getDataRange().getValues(), tz = Session.getScriptTimeZone(); q = (q || '').toString().trim().toLowerCase();
  var out = [];
  for (var i = 1; i < d.length; i++) {
    if (!d[i][1]) continue;
    var blob = ((d[i][1] || '') + ' ' + (d[i][2] || '') + ' ' + (d[i][12] || '') + ' ' + (d[i][17] || '') + ' ' + (d[i][18] || '') + ' ' + (d[i][20] || '') + ' ' + (d[i][13] || '') + ' ' + (d[i][11] || '')).toLowerCase();
    if (q && blob.indexOf(q) < 0) continue;
    out.push({ candId: (d[i][30] || '').toString(), name: d[i][1], email: d[i][2] || '', phone: (d[i][12] || ''), company: (d[i][17] || ''), title: (d[i][18] || ''), exp: (d[i][19] || ''), stage: (d[i][6] || ''), reqId: (d[i][11] || ''), location: (d[i][13] || ''), received: (d[i][0] instanceof Date ? Utilities.formatDate(d[i][0], tz, 'dd MMM yyyy') : '') });
  }
  return { rows: out.slice(0, 100), count: out.length };
}
function restoreCandidate(candId) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var ss = SpreadsheetApp.openById(SHEET_ID), arch = ss.getSheetByName('Archive'), tr = ss.getSheetByName('Tracker'); if (!arch) return { error: 'No archive.' };
  var d = arch.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) {
    if ((d[i][30] || '').toString() === candId.toString()) { tr.appendRow(sanitizeRow_(d[i])); arch.deleteRow(i + 1); bustCache_(); try { logAudit_(candId, 'Restored from archive'); } catch (e) {} return { ok: true, name: d[i][1] }; }
  }
  return { error: 'Not found in archive.' };
}
function getToday(scopeEmail) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  if (_g.role === 'HiringManager') scopeEmail = _g.email || scopeEmail; // M-10: scope derived from verified identity, not the client
  var _ck = 'today_' + cacheVer_() + '_' + (scopeEmail || ''); var _hit = cacheGet_(_ck); if (_hit) return _hit;
  var ss = SpreadsheetApp.openById(SHEET_ID), tr = ss.getSheetByName('Tracker').getDataRange().getValues(), now = new Date();
  var newApps = [], awaitingFb = [], debriefs = [], stuck = [], offers = [];
  var ivByCand = {}, fbByCand = {}, lastChange = {};
  var scope = (scopeEmail || '').toString().toLowerCase(), hmByReq = {};
  if (scope) { try { var rqh = ss.getSheetByName('Requisitions').getDataRange().getValues(); for (var z = 1; z < rqh.length; z++) if (rqh[z][0]) hmByReq[rqh[z][0].toString()] = (rqh[z][25] || '').toString().toLowerCase(); } catch (e) {} }
  function inScope(rid) { return !scope || hmByReq[(rid || '').toString()] === scope; }
  try { var iv = ss.getSheetByName('Interviews'); if (iv) { var ivd = iv.getDataRange().getValues(); for (var a = 1; a < ivd.length; a++) { var c = (ivd[a][1] || '').toString(); if (c) ivByCand[c] = true; } } } catch (e) {}
  try { var fbs = ss.getSheetByName('Interview Feedback'); if (fbs) { var fbd = fbs.getDataRange().getValues(); for (var b = 1; b < fbd.length; b++) { var c2 = (fbd[b][1] || '').toString(); if (c2) fbByCand[c2] = true; } } } catch (e) {}
  try { var hd = ss.getSheetByName('Stage History').getDataRange().getValues(); for (var h = 1; h < hd.length; h++) { var ch = (hd[h][1] || '').toString(); if (ch && hd[h][0] instanceof Date) lastChange[ch] = hd[h][0]; } } catch (e) {}
  for (var i = 1; i < tr.length; i++) {
    if (!tr[i][1]) continue;
    var cid = (tr[i][30] || '').toString(), name = tr[i][1], stage = (tr[i][6] || 'New').toString(), sl = stage.toLowerCase(), rid = (tr[i][11] || '').toString();
    if (!inScope(rid)) continue;
    var item = { candId: cid, name: name, stage: stage, reqId: rid };
    if (sl === 'new') { var dr = tr[i][0]; if (dr instanceof Date && (now - dr) < 7 * 86400000) newApps.push(item); }
    if (ivByCand[cid] && !fbByCand[cid] && sl.indexOf('reject') < 0 && sl.indexOf('hire') < 0 && sl.indexOf('onboard') < 0) awaitingFb.push(item);
    if (sl.indexOf('debrief') > -1 && sl.indexOf('reject') < 0) debriefs.push(item);
    if (sl.indexOf('offer') > -1 && sl.indexOf('declin') < 0 && sl.indexOf('onboard') < 0) offers.push(item);
    var since = lastChange[cid] || tr[i][0], terminal = sl.indexOf('reject') > -1 || sl.indexOf('hire') > -1 || sl.indexOf('onboard') > -1 || sl.indexOf('talent pool') > -1 || sl.indexOf('declin') > -1;
    if (!terminal && since instanceof Date) { var days = Math.floor((now - since) / 86400000), sla = slaForStage_(stage); if (days >= sla) stuck.push({ candId: cid, name: name, stage: stage, reqId: rid, days: days, sla: sla }); }
  }
  var reqsNeed = [];
  try {
    var rq = ss.getSheetByName('Requisitions').getDataRange().getValues(), counts = {};
    for (var k = 1; k < tr.length; k++) { var rk = (tr[k][11] || '').toString(); if (rk) counts[rk] = (counts[rk] || 0) + 1; }
    for (var j = 1; j < rq.length; j++) { if (!rq[j][0] || (rq[j][13] || '').toString().toLowerCase() !== 'open') continue; var id = rq[j][0].toString(); if (!inScope(id)) continue; var needs = []; if (!rq[j][21]) needs.push('calibration'); if (!(counts[id] || 0)) needs.push('candidates'); if (needs.length) reqsNeed.push({ reqId: id, title: rq[j][1] || '', needs: needs }); }
  } catch (e) {}
  stuck.sort(function (x, y) { return y.days - x.days; });
  var _res = { newApps: newApps.slice(0, 15), awaitingFb: awaitingFb.slice(0, 15), debriefs: debriefs.slice(0, 15), stuck: stuck.slice(0, 15), offers: offers.slice(0, 15), reqsNeed: reqsNeed.slice(0, 15) };
  cachePut_(_ck, _res, 120); return _res;
}
function pipelineInsights() {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), d = sh.getDataRange().getValues(), now = new Date(), active = 0, aging = [], byStage = {};
  var lastChange = {};
  try { var hd = stageHistSheet_().getDataRange().getValues(); for (var h = 1; h < hd.length; h++) { var c = (hd[h][1] || '').toString(); if (c && hd[h][0] instanceof Date) lastChange[c] = hd[h][0]; } } catch (e) {}
  for (var i = 1; i < d.length; i++) {
    if (!d[i][1]) continue;
    var stage = (d[i][6] || 'New').toString(), sl = stage.toLowerCase();
    byStage[stage] = (byStage[stage] || 0) + 1;
    var terminal = sl.indexOf('reject') > -1 || sl.indexOf('hire') > -1 || sl.indexOf('onboard') > -1 || sl.indexOf('declin') > -1 || sl.indexOf('talent pool') > -1;
    if (!terminal) {
      active++;
      var candId = (d[i][30] || '').toString();
      var since = lastChange[candId] || d[i][0];
      var days = (since instanceof Date) ? Math.floor((now - since) / 86400000) : null;
      if (days != null && days >= 10) aging.push({ candId: candId, name: String(d[i][1] || ''), stage: stage, days: days, reqId: (d[i][11] || '').toString() });
    }
  }
  aging.sort(function (a, b) { return b.days - a.days; });
  return { active: active, byStage: byStage, aging: aging.slice(0, 25), metrics: getStageMetrics() };
}
function notebookPack(reqId) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var s = null, cal = null;
  try { s = getReqSummary(reqId); } catch (e) {}
  try { cal = getCalibration(reqId); } catch (e) {}
  var doc = DocumentApp.create('NotebookLM Pack — ' + reqId), b = doc.getBody();
  b.appendParagraph(((s && s.title) ? s.title : reqId) + ' — Source Pack').setHeading(DocumentApp.ParagraphHeading.TITLE);
  if (s) { b.appendParagraph('Requisition').setHeading(DocumentApp.ParagraphHeading.HEADING1); b.appendParagraph('ID: ' + reqId + '\nTitle: ' + (s.title || '') + '\nLevel: ' + (s.level || '') + '\nLocation: ' + (s.location || '') + '\nHiring Manager: ' + (s.hm || '') + '\nStatus: ' + (s.status || '')); if (s.notes) b.appendParagraph('JD / Notes:\n' + s.notes); }
  if (cal && cal.brief) { b.appendParagraph('Calibration').setHeading(DocumentApp.ParagraphHeading.HEADING1); b.appendParagraph('Must-haves: ' + ((cal.brief.must_haves || []).join('; ')) + '\nNice-to-haves: ' + ((cal.brief.nice_to_haves || []).join('; ')) + '\nRed flags: ' + ((cal.brief.red_flags || []).join('; '))); if (cal.transcript) b.appendParagraph('HM notes: ' + cal.transcript); }
  b.appendParagraph('Candidates (shortlist)').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  var n = 0;
  try {
    getReqPipeline(reqId).forEach(function (c) {
      n++;
      b.appendParagraph(c.name + ' (' + c.candId + ') — ' + (c.stage || '')).setHeading(DocumentApp.ParagraphHeading.HEADING2);
      b.appendParagraph('Current: ' + (c.title || '') + ' @ ' + (c.company || '') + ' · ' + (c.location || '') + ' · ' + (c.exp || '') + ' yrs\nSkills: ' + (c.skills || '') + '\nCurrent CTC: ' + (c.ctc || '') + ' · Notice: ' + (c.notice || '') + ' · Email: ' + (c.email || ''));
      try {
        var fb = getInterviewFeedback_(c.candId);
        if (fb.length) { b.appendParagraph('Interview feedback:'); fb.forEach(function (f) { b.appendParagraph('• ' + (f.stage || '') + ' — ' + (f.recommendation || '') + (f.rating ? ' (' + f.rating + '/5)' : '') + ': ' + (f.feedback || '')); }); }
      } catch (e) {}
    });
  } catch (e) {}
  b.appendParagraph('How to use this in NotebookLM').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  b.appendParagraph('1) In NotebookLM, create a notebook and add this Google Doc as a source.\n2) Click "Audio Overview" to generate a podcast-style briefing the hiring manager can listen to.\n3) Or ask questions, e.g.:');
  b.appendParagraph('• Who are the top 3 candidates for this role and why?\n• Which candidates best match the must-haves, and who has gaps?\n• Summarize the interview feedback and flag any disagreement between interviewers.\n• Draft a shortlist summary email to the hiring manager.\n• What questions should we focus on in the next round for each finalist?');
  doc.saveAndClose();
  return { docUrl: DriveApp.getFileById(doc.getId()).getUrl(), count: n };
}
function reqBrief(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return _g.error; // C-1: server-side auth
  var s = {}; try { s = getReqSummary(reqId) || {}; } catch (e) {}
  var brief = {}; try { var cal = getCalibration(reqId); brief = (cal && cal.brief) || {}; } catch (e) {}
  var pl = []; try { pl = getReqPipeline(reqId); } catch (e) {}
  var lines = pl.map(function (c) { return '- ' + c.name + ': ' + (c.title || '') + ' @ ' + (c.company || '') + ', ' + (c.exp || '') + 'y, skills: ' + (c.skills || '') + ', stage: ' + c.stage + ', keyword-match ' + (c.match != null ? c.match + '%' : 'n/a'); }).join('\n');
  return callGemini('You are a recruiting lead giving a spoken briefing to a hiring manager about requisition "' + (s.title || reqId) + '". Use ONLY the data. Keep it tight and natural to read aloud (~150 words): (1) the role in one line, (2) the must-haves, (3) the strongest candidates and why — rank the top 3, (4) who to drop and why, (5) recommended next steps.\n' +
    'MUST-HAVES: ' + ((brief.must_haves || []).join('; ') || '(none set)') + '\nCANDIDATES:\n' + (lines || '(none added yet)'), false);
}
function getReqWorkflow(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var cal = {}; try { var c = getCalibration(reqId); cal = (c && c.brief) || {}; } catch (e) {}
  var plan = ''; try { plan = getReqPlan(reqId); } catch (e) {}
  var pl = []; try { pl = getReqPipeline(reqId); } catch (e) {}
  var hasInterview = false, hasFeedback = false, hasOffer = false, ids = {};
  pl.forEach(function (c) { ids[c.candId] = 1; var sl = (c.stage || '').toLowerCase(); if (sl.indexOf('offer') > -1 || sl.indexOf('hire') > -1 || sl.indexOf('onboard') > -1) hasOffer = true; });
  try { var ish = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Interviews'); if (ish) { var d = ish.getDataRange().getValues(); for (var i = 1; i < d.length; i++) if ((d[i][3] || '').toString() === reqId.toString()) { hasInterview = true; break; } } } catch (e) {}
  try { var fb = feedbackSheet_().getDataRange().getValues(); for (var k = 1; k < fb.length; k++) if (ids[(fb[k][1] || '').toString()]) { hasFeedback = true; break; } } catch (e) {}
  var shortlisted = false; pl.forEach(function (c) { var sl = (c.stage || '').toLowerCase(); if (sl.indexOf('shortlist') > -1 || sl.indexOf('interview') > -1 || sl.indexOf('debrief') > -1) shortlisted = true; });
  return [
    { n: 1, label: 'Calibrate the role (must-haves)', done: !!(cal.must_haves && cal.must_haves.length), action: 'cal' },
    { n: 2, label: 'Set interview plan', done: !!(plan && plan.length > 2), action: 'plan' },
    { n: 3, label: 'Add / source candidates', done: pl.length > 0, action: 'add' },
    { n: 4, label: 'Screen & shortlist (fit score)', done: shortlisted, action: '' },
    { n: 5, label: 'Schedule interviews', done: hasInterview, action: '' },
    { n: 6, label: 'Collect feedback & debrief', done: hasFeedback, action: '' },
    { n: 7, label: 'Decision / offer', done: hasOffer, action: '' }
  ];
}
function checkDuplicate(o) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  try {
    var sheet = trackerSheet_(), d = sheet.getDataRange().getValues();
    var email = (o.email || '').toString().trim().toLowerCase();
    var phone = (o.phone || '').toString().replace(/\D/g, '');
    var name = (o.name || '').toString().trim().toLowerCase();
    var company = (o.company || '').toString().trim().toLowerCase();
    for (var i = 1; i < d.length; i++) {
      if (o.excludeCandId && (d[i][30] || '').toString() === o.excludeCandId) continue;
      var em = (d[i][2] || '').toString().trim().toLowerCase();
      var ph = (d[i][12] || '').toString().replace(/\D/g, '');
      var nm = (d[i][1] || '').toString().trim().toLowerCase();
      var co = (d[i][17] || '').toString().trim().toLowerCase();
      var via = '';
      if (email && em && em === email) via = 'email';
      else if (phone && ph && ph === phone) via = 'phone';
      else if (name && nm && nm === name && company && co && co === company) via = 'name + company';
      if (via) return { dup: true, via: via, name: String(d[i][1] || ''), candId: (d[i][30] || '').toString(),
        reqId: (d[i][11] || '').toString(), stage: (d[i][6] || '').toString() };
    }
  } catch (e) {}
  return { dup: false };
}
function globalSearch(q) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  q = (q || '').toString().trim().toLowerCase();
  var toks = q.split(/\s+/).filter(Boolean);
  function stem(t) { return t.replace(/(ed|es|s)$/, ''); }
  function hit(text, tok) { text = (text || '').toLowerCase(); return text.indexOf(tok) > -1 || text.indexOf(stem(tok)) > -1; }
  function allHit(text) { if (!toks.length) return true; for (var i = 0; i < toks.length; i++) if (!hit(text, toks[i])) return false; return true; }
  var ss = SpreadsheetApp.openById(SHEET_ID), reqs = [], cands = [];
  var rs = ss.getSheetByName('Requisitions');
  if (rs) {
    var rd = rs.getDataRange().getValues();
    for (var i = 1; i < rd.length; i++) {
      if (!rd[i][0]) continue;
      var rtxt = [rd[i][0], rd[i][1], rd[i][2], rd[i][3], rd[i][4], rd[i][6], rd[i][7], rd[i][8], rd[i][13], rd[i][17]].join(' ');
      if (allHit(rtxt)) reqs.push({ id: String(rd[i][0]), title: String(rd[i][1] || ''), dept: String(rd[i][2] || ''),
        lob: String(rd[i][3] || ''), location: String(rd[i][4] || ''), hm: String(rd[i][7] || ''), status: String(rd[i][13] || '') });
    }
  }
  var tr = ss.getSheetByName('Tracker');
  if (tr) {
    var td = tr.getDataRange().getValues();
    for (var j = 1; j < td.length; j++) {
      if (!td[j][1]) continue;
      var ctxt = [td[j][1], td[j][2], td[j][12], td[j][13], td[j][17], td[j][18], td[j][20], td[j][6], td[j][11], td[j][30]].join(' ');
      if (allHit(ctxt)) cands.push({ candId: String(td[j][30] || ''), name: String(td[j][1] || ''), email: String(td[j][2] || ''),
        phone: String(td[j][12] || ''), location: String(td[j][13] || ''), company: String(td[j][17] || ''),
        stage: String(td[j][6] || ''), reqId: String(td[j][11] || ''), score: String(td[j][7] || ''), hasCv: !!td[j][5] });
    }
  }
  return { reqs: reqs.slice(0, 100), candidates: cands.slice(0, 300), count: reqs.length + cands.length };
}
function saveReviewedCandidate(o) {
  var u = currentUser_(arguments);
  if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins can add candidates.';
  if (!o.name) return 'Name is required.';
  if (!o.talentPool) {
    var miss = [];
    if (!o.currentCTC) miss.push('Current CTC');
    if (!o.expectedCTC) miss.push('Expected CTC');
    if (!o.notice) miss.push('Notice Period');
    // M-7: Gender is no longer mandatory (compliance/bias exposure — at odds with BIAS_MASK). Optional if provided.
    if (miss.length) return '⚠️ Please fill the mandatory fields: ' + miss.join(', ') + '.';
  }
  var sheet = trackerSheet_();
  var stage = o.talentPool ? 'Talent Pool' : 'New';
  var src = o.talentPool ? 'Passive Pool' : 'CV Upload';
  var _lk = withScriptLock_(function () { // H-1: atomic append + ID mint
    sheet.appendRow(sanitizeRow_([new Date(), o.name, o.email || '', '', src, o.resume || '', stage, '', '', '', ''])); // C-2
    var rr = sheet.getLastRow(); var id = nextCandidateId_(); sheet.getRange(rr, 31).setValue(id);
    return { r: rr, cid: id };
  });
  var r = _lk.r, cid = _lk.cid;
  function setC(col, val) { if (val) sheet.getRange(r, col).setValue(sanitizeCell_(val)); } // C-2
  setC(12, o.reqId); setC(13, o.phone); setC(14, o.location); setC(15, o.outstation); setC(16, o.relocate);
  setC(17, o.workmode); setC(18, o.company); setC(19, o.title); setC(20, o.experience); setC(21, o.skills);
  setC(22, o.qualification); setC(23, o.notice); setC(24, o.currentCTC); setC(25, o.expectedCTC);
  setC(26, o.offerInHand); setC(27, o.workAuth); setC(28, o.reasonForChange); setC(30, o.gender);
  setC(32, o.firstName); setC(33, o.middleName); setC(34, o.lastName); setC(35, o.linkedin); setC(37, o.highlights); setC(38, o.github);
  var rem = [(o.relevantExp ? 'Relevant exp: ' + o.relevantExp : ''), (o.comments || '')].filter(Boolean).join(' | ');
  setC(29, rem);
  logAudit_(cid, 'Candidate created (' + src + ')' + (o.reqId ? ' · tagged ' + o.reqId : ''));
  recordStage_(cid, o.name, stage);
  return '✅ Saved ' + o.name + ' to the ' + (o.talentPool ? 'Talent Pool' : 'pipeline') + ' (' + cid + ').';
}
function editCandidate(o) {
  var u = currentUser_(arguments);
  if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins can edit candidate details.';
  var sheet = trackerSheet_(), row = findRowById_(sheet, o.candId);
  if (row < 0) return 'Candidate not found.';
  var miss = [];
  if (o.currentCTC === '') miss.push('Current CTC');
  if (o.expectedCTC === '') miss.push('Expected CTC');
  if (o.notice === '') miss.push('Notice Period');
  // M-7: Gender is optional now (may be blanked deliberately).
  if (miss.length) return '⚠️ These fields are mandatory and can\'t be blank: ' + miss.join(', ') + '.';
  var COLS = [
    [2, 'Name', 'name'], [3, 'Email', 'email'], [12, 'Req ID', 'reqId'], [13, 'Phone', 'phone'], [14, 'Current Location', 'location'],
    [15, 'Outstation', 'outstation'], [16, 'Willing to Relocate', 'relocate'], [17, 'Work Mode', 'workmode'], [18, 'Current Company', 'company'],
    [19, 'Current Title', 'title'], [20, 'Total Experience', 'experience'], [21, 'Skills', 'skills'], [22, 'Highest Qualification', 'qualification'],
    [23, 'Notice Period', 'notice'], [24, 'Current CTC', 'currentCTC'], [25, 'Expected CTC', 'expectedCTC'], [26, 'Offer in Hand', 'offerInHand'],
    [27, 'Work Authorization', 'workAuth'], [28, 'Reason for Change', 'reasonForChange'], [29, 'HR Remarks', 'remarks'], [30, 'Gender', 'gender'],
    [32, 'First Name', 'firstName'], [33, 'Middle Name', 'middleName'], [34, 'Last Name', 'lastName'], [35, 'LinkedIn URL', 'linkedin'],
    [37, 'Highlights', 'highlights'], [38, 'GitHub', 'github'], [39, 'Patents', 'patents']
  ];
  var changes = [];
  COLS.forEach(function (c) {
    var key = c[2]; if (!(key in o)) return;
    var nv = (o[key] == null) ? '' : String(o[key]);
    var cell = sheet.getRange(row, c[0]); var ov = cell.getValue(); ov = (ov == null) ? '' : String(ov);
    if (nv !== ov) { cell.setValue(sanitizeCell_(nv)); changes.push(c[1] + ': ' + (ov || '—') + ' → ' + (nv || '—')); }
  });
  if (!changes.length) return 'No changes to save.';
  logAudit_(o.candId, changes.join('; ')); bustCache_();
  try { sbSyncCandidate_(o.candId); } catch (e) {}
  return '✅ Updated ' + sheet.getRange(row, 2).getValue() + ' — ' + changes.length + ' field(s) changed.';
}
function auditSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID), sh = ss.getSheetByName('Audit');
  if (!sh) { sh = ss.insertSheet('Audit'); sh.getRange(1, 1, 1, 4).setValues([['Timestamp', 'Candidate ID', 'User', 'Changes']]).setFontWeight('bold'); }
  return sh;
}
function logAudit_(candId, summary) {
  try {
    var u = currentUser_(arguments), who = u.name || u.email || 'Recruiter';
    auditSheet_().appendRow(sanitizeRow_([new Date(), candId, who, summary])); // C-2
  } catch (e) {}
}
function getAudit_(candId) {
  try {
    var d = auditSheet_().getDataRange().getValues(), out = [], tz = Session.getScriptTimeZone();
    for (var i = 1; i < d.length; i++) if ((d[i][1] || '').toString() === candId) {
      out.push({
        when: (d[i][0] instanceof Date) ? Utilities.formatDate(d[i][0], tz, 'yyyy-MM-dd HH:mm') : String(d[i][0] || ''),
        who: String(d[i][2] || ''), summary: String(d[i][3] || '')
      });
    }
    return out.reverse();
  } catch (e) { return []; }
}
function authorizeServices() {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return _g.error; // C-1: server-side auth
  var f = DriveApp.createFile('agentats_auth.txt', 'hello', 'text/plain');
  var id;
  if (Drive.Files.create) id = Drive.Files.create({ name: 'tmp_auth', mimeType: 'application/vnd.google-apps.document' }, f.getBlob()).id;
  else id = Drive.Files.insert({ title: 'tmp_auth', mimeType: 'application/vnd.google-apps.document' }, f.getBlob()).id;
  DriveApp.getFileById(id).setTrashed(true); f.setTrashed(true);
  return 'Drive conversion authorized & working.';
}

// ---------- REQUISITIONS ----------
function nextReqId_(sheet, lob, hm) {
  var lob3 = ((lob || 'GEN').replace(/[^A-Za-z]/g, '').substring(0, 3).toUpperCase()) || 'GEN';
  var initials = ((hm || '').split(/\s+/).filter(String).map(function (w) { return w[0]; }).join('').substring(0, 3).toUpperCase()) || 'XX';
  // H-1: sequence comes from a persistent counter, NOT from getLastRow() — deleting a
  // requisition row used to make the next ID collide with an existing one. Seeded once
  // from the current row count so existing sheets keep counting from where they are.
  var p = PropertiesService.getScriptProperties();
  var n = parseInt(p.getProperty('REQ_SEQ') || '0', 10);
  if (!n) n = Math.max(0, sheet.getLastRow() - 1);
  n++; p.setProperty('REQ_SEQ', String(n));
  var seq = ('000' + n).slice(-3);
  return lob3 + '-' + initials + '-' + seq;
}
function createRequisition(o) {
  var _g = guard_(arguments, 'HiringManager'); if (_g.error) return _g.error; // C-1: server-side auth
  if (!o.title || !o.line_of_business || !o.hiring_manager)
    return "To create a requisition I need at least: title, line of business, and hiring manager.";
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions');
  if (!sheet) return "No Requisitions tab — run setupAtsTabs first.";
  var id = withScriptLock_(function () { // H-1: atomic ID mint + append
    var rid = nextReqId_(sheet, o.line_of_business, o.hiring_manager);
    sheet.appendRow(sanitizeRow_([rid, o.title, o.department || '', o.line_of_business, o.location || '', o.employment_type || '',
      o.level || '', o.hiring_manager, o.recruiter || '', o.openings || 1, o.priority || '', o.salary_min || '', o.salary_max || '',
      'Open', new Date(), '', o.jd_link || '', o.notes || o.role_description || ''])); // C-2
    if (o.hm_email) { try { sheet.getRange(sheet.getLastRow(), 26).setValue(sanitizeCell_(o.hm_email)); } catch (e) {} }
    return rid;
  });
  upsertHiringManager_(o.hiring_manager, o.hm_email); bustCache_();
  try { sbSyncReq_(id); } catch (e) {}
  return "✅ Requisition " + id + " created — " + o.title + " (" + o.line_of_business + ", HM " + o.hiring_manager + ").";
}
function listHiringManagers() {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var out = [];
  try {
    var d = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Users').getDataRange().getValues();
    for (var i = 1; i < d.length; i++) {
      var role = (d[i][2] || '').toString().toLowerCase();
      if ((role.indexOf('hiring') > -1 || role.indexOf('manager') > -1) && d[i][1]) out.push({ name: (d[i][1] || '').toString(), email: (d[i][0] || '').toString() });
    }
  } catch (e) {}
  return out;
}
function saveHiringManager(name, email) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  if (!name || !email || email.indexOf('@') < 0) return { error: 'Enter a name and a valid email.' };
  var ss = SpreadsheetApp.openById(SHEET_ID), sh = ss.getSheetByName('Users') || ss.insertSheet('Users');
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, 4).setValues([['Email', 'Name', 'Role', 'Active']]).setFontWeight('bold');
  var d = sh.getDataRange().getValues(), found = false;
  for (var i = 1; i < d.length; i++) { if ((d[i][1] || '').toString().trim().toLowerCase() === name.trim().toLowerCase()) { sh.getRange(i + 1, 1).setValue(email); if (!d[i][2]) sh.getRange(i + 1, 3).setValue('HiringManager'); found = true; break; } }
  if (!found) sh.appendRow(sanitizeRow_([email, name, 'HiringManager', 'Yes'])); // C-2
  return { ok: true, list: listHiringManagers() };
}
function removeHiringManager(name) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  try {
    var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Users'), d = sh.getDataRange().getValues();
    for (var i = d.length - 1; i >= 1; i--) { var role = (d[i][2] || '').toString().toLowerCase(); if ((role.indexOf('hiring') > -1 || role.indexOf('manager') > -1) && (d[i][1] || '').toString().trim().toLowerCase() === name.trim().toLowerCase()) sh.deleteRow(i + 1); }
  } catch (e) { return { error: e.message }; }
  return { ok: true, list: listHiringManagers() };
}
function upsertHiringManager_(name, email) {
  if (!name || !email) return;
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID), sh = ss.getSheetByName('Users') || ss.insertSheet('Users');
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, 4).setValues([['Email', 'Name', 'Role', 'Active']]).setFontWeight('bold');
    var d = sh.getDataRange().getValues();
    for (var i = 1; i < d.length; i++) {
      if ((d[i][1] || '').toString().trim().toLowerCase() === name.trim().toLowerCase()) { if (!d[i][0] && email) sh.getRange(i + 1, 1).setValue(email); return; }
    }
    sh.appendRow(sanitizeRow_([email, name, 'HiringManager', 'Yes'])); // C-2
  } catch (e) {}
}
function parseJD(base64Data, mimeType) {
  var u = currentUser_(arguments);
  if (!allowed_(u.role, 'create_requisition')) return { error: 'No permission.' };
  try {
    var url = DriveApp.getFolderById(FOLDER_ID).createFile(Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, 'JD')).getUrl();
    var p = {}; try { p = JSON.parse(parseDocument_(base64Data, mimeType)); } catch (e) {}
    return { title: p.title || '', department: p.department || '', line_of_business: p.line_of_business || '',
      location: p.location || '', employment_type: p.employment_type || '', level: p.level || '',
      openings: p.openings || '', hiring_manager: p.hiring_manager || '', role_description: p.role_description || '', jd_link: url };
  } catch (e) { return { error: e.message }; }
}
function getReqSummary(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var d = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions').getDataRange().getValues();
  for (var i = 1; i < d.length; i++) if ((d[i][0] || '').toString() === reqId.toString())
    return { id: d[i][0], title: d[i][1], department: d[i][2], lob: d[i][3], location: d[i][4],
      employment: d[i][5], level: d[i][6], hm: d[i][7], recruiter: d[i][8], openings: d[i][9],
      priority: d[i][10], status: d[i][13], jdLink: d[i][16], notes: d[i][17], hmEmail: d[i][25] || '' };
  return null;
}
function getReqAudit(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  return getAudit_((reqId || '').toString()); }
function editRequisition(o) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins can edit requisitions.' };
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), d = sh.getDataRange().getValues(), row = -1;
  for (var i = 1; i < d.length; i++) if ((d[i][0] || '').toString() === (o.reqId || '').toString()) { row = i; break; }
  if (row < 0) return { error: 'Requisition not found.' };
  var map = [[1, 'title', 'Title'], [2, 'department', 'Department'], [3, 'lob', 'Line of business'], [4, 'location', 'Location'], [5, 'employment', 'Employment type'], [6, 'level', 'Level'], [7, 'hm', 'Hiring manager'], [8, 'recruiter', 'Recruiter'], [9, 'openings', 'Openings'], [13, 'status', 'Status'], [17, 'notes', 'Notes'], [25, 'hm_email', 'HM email']];
  var changes = [];
  map.forEach(function (m) {
    if (o[m[1]] === undefined) return;
    var nv = (o[m[1]] == null ? '' : o[m[1]]).toString(), ov = (d[row][m[0]] == null ? '' : d[row][m[0]]).toString();
    if (nv !== ov) { sh.getRange(row + 1, m[0] + 1).setValue(sanitizeCell_(nv)); changes.push(m[2] + ': "' + ov + '" → "' + nv + '"'); }
  });
  if (o.hm && o.hm_email) { try { upsertHiringManager_(o.hm, o.hm_email); } catch (e) {} }
  if (changes.length) { logAudit_((o.reqId || '').toString(), changes.join(' · ')); bustCache_(); }
  try { sbSyncReq_((o.reqId || '').toString()); } catch (e) {}
  return { ok: true, changed: changes.length };
}
// ---------- CALIBRATION KIT (case-study files + HM voice note → AI must-haves) ----------
function findReqRow_(sh, reqId) {
  var d = sh.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) if ((d[i][0] || '').toString() === reqId.toString()) return i + 1;
  return -1;
}
function getCalibration(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), d = sh.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) if ((d[i][0] || '').toString() === reqId.toString()) {
    var files = []; try { files = JSON.parse(d[i][18] || '[]'); } catch (e) { files = []; }
    var brief = null; try { brief = JSON.parse(d[i][21] || 'null'); } catch (e) { brief = null; }
    return { reqId: reqId, files: files, voiceUrl: String(d[i][19] || ''), transcript: String(d[i][20] || ''), brief: brief, notes: String(d[i][22] || '') };
  }
  return { reqId: reqId, files: [], voiceUrl: '', transcript: '', brief: null, notes: '' };
}
function saveCalibrationNotes(reqId, notes) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), row = findReqRow_(sh, reqId);
  if (row < 0) return { error: 'Requisition not found.' };
  sh.getRange(row, 23).setValue(sanitizeCell_(notes || '')); // C-2
  return { ok: true };
}
function addCalibrationFile(reqId, base64, fileName, mimeType, kind) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var url = '';
  try { url = DriveApp.getFolderById(FOLDER_ID).createFile(Utilities.newBlob(Utilities.base64Decode(base64), mimeType, fileName)).getUrl(); }
  catch (e) { return { error: 'Upload failed: ' + e.message }; }
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), row = findReqRow_(sh, reqId);
  if (row < 0) return { error: 'Requisition not found.' };
  var files = []; try { files = JSON.parse(sh.getRange(row, 19).getValue() || '[]'); } catch (e) { files = []; }
  files.push({ name: fileName, url: url, kind: kind || 'case-study' });
  sh.getRange(row, 19).setValue(JSON.stringify(files));
  logAudit_(reqId, 'Calibration file added: ' + fileName + ' (' + (kind || 'case-study') + ')');
  return { ok: true, files: files };
}
function addCalibrationVoice(reqId, base64, fileName, mimeType) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), row = findReqRow_(sh, reqId);
  if (row < 0) return { error: 'Requisition not found.' };
  var url = '';
  try { url = DriveApp.getFolderById(FOLDER_ID).createFile(Utilities.newBlob(Utilities.base64Decode(base64), mimeType, fileName)).getUrl(); } catch (e) {}
  if (url) sh.getRange(row, 20).setValue(url);
  var ctx = String(reqJDText_(reqId) || '');
  var prompt = 'You are a recruiting calibration assistant. The attached audio is a hiring manager describing the ideal candidate for this role.\n' +
    'Role context: ' + ctx.slice(0, 1500) + '\nFirst transcribe the audio, then extract a structured calibration. ' +
    'Return ONLY JSON: {"transcript":"","must_haves":[],"nice_to_haves":[],"red_flags":[],"summary":""}. Keep each list item a short, concrete phrase.';
  var raw;
  try { raw = geminiRequest_({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType, data: base64 } }] }],
        generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }); }
  catch (e) { return { error: 'Transcription failed (try mp3/m4a/wav): ' + e.message, voiceUrl: url }; }
  var b = {}; try { b = JSON.parse(raw); } catch (e) { b = { transcript: raw, must_haves: [], nice_to_haves: [], red_flags: [], summary: '' }; }
  var brief = { must_haves: b.must_haves || [], nice_to_haves: b.nice_to_haves || [], red_flags: b.red_flags || [], summary: b.summary || '' };
  sh.getRange(row, 21).setValue(sanitizeCell_(b.transcript || '')); // C-2
  sh.getRange(row, 22).setValue(JSON.stringify(brief));
  logAudit_(reqId, 'Calibration voice note processed → ' + (brief.must_haves.length) + ' must-haves extracted');
  return { ok: true, voiceUrl: url, transcript: b.transcript || '', brief: brief };
}
function setCalibrationFromText(reqId, text) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions'), row = findReqRow_(sh, reqId);
  if (row < 0) return { error: 'Requisition not found.' };
  var ctx = String(reqJDText_(reqId) || '');
  var prompt = 'Hiring manager calibration notes for a role.\nRole context: ' + ctx.slice(0, 1500) +
    '\nNotes: ' + (text || '').slice(0, 4000) +
    '\nReturn ONLY JSON: {"must_haves":[],"nice_to_haves":[],"red_flags":[],"summary":""}. Short concrete phrases.';
  var raw; try { raw = callGemini(prompt, true); } catch (e) { return { error: e.message }; }
  var brief = {}; try { brief = JSON.parse(raw); } catch (e) { brief = { must_haves: [], nice_to_haves: [], red_flags: [], summary: (text || '').slice(0, 300) }; }
  brief = { must_haves: brief.must_haves || [], nice_to_haves: brief.nice_to_haves || [], red_flags: brief.red_flags || [], summary: brief.summary || '' };
  sh.getRange(row, 21).setValue(sanitizeCell_(text || '')); // C-2
  sh.getRange(row, 22).setValue(JSON.stringify(brief));
  logAudit_(reqId, 'Calibration notes saved → ' + brief.must_haves.length + ' must-haves');
  return { ok: true, transcript: text || '', brief: brief };
}
function addCandidateManual(o) {
  var u = currentUser_(arguments);
  if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins can add candidates.';
  if (!o.name) return 'Name is required.';
  var sheet = trackerSheet_();
  var r = withScriptLock_(function () { // H-1: atomic append + ID mint
    sheet.appendRow(sanitizeRow_([new Date(), o.name, o.email || '', '', 'Manual', '', 'New', '', '', '', ''])); // C-2
    var rr = sheet.getLastRow(); sheet.getRange(rr, 31).setValue(nextCandidateId_()); return rr;
  });
  if (o.phone) sheet.getRange(r, 13).setValue(sanitizeCell_(o.phone));
  if (o.location) sheet.getRange(r, 14).setValue(sanitizeCell_(o.location));
  if (o.skills) sheet.getRange(r, 21).setValue(sanitizeCell_(o.skills));
  if (o.reqId) sheet.getRange(r, 12).setValue(sanitizeCell_(o.reqId));
  bustCache_(); // M-3: manually-added candidates must show in the board/pipeline immediately
  return '✅ Added ' + o.name + ' to the pipeline.';
}
function createReqFromJd_(p, jdUrl) {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions');
  var lob = p.line_of_business || p.department || 'GEN', hm = p.hiring_manager || '';
  var id = withScriptLock_(function () { // H-1: atomic ID mint + append
    var rid = nextReqId_(sheet, lob, hm || 'TBD');
    sheet.appendRow(sanitizeRow_([rid, p.title || 'Untitled', p.department || '', p.line_of_business || '', p.location || '',
      p.employment_type || '', p.level || '', hm, '', p.openings || 1, '', '', '', hm ? 'Open' : 'Draft', new Date(), '', jdUrl, ''])); // C-2: parsed JD
    return rid;
  });
  return '✅ Requisition ' + id + ' created from JD' + (p.title ? ' — ' + p.title : '') + '.' +
    (hm ? '' : ' ⚠️ No hiring manager in the JD — add one in the Requisitions tab.');
}
function updateDetails(o) {
  var u = currentUser_(arguments);
  if (u.role !== 'Admin' && u.role !== 'Recruiter') return "🔒 Only recruiters/admins can edit candidate details.";
  var sheet = trackerSheet_(), row = findRow_(sheet, o.name, o.email);
  if (row < 0) return "I couldn't find " + (o.name || o.email) + ".";
  if (!o.fields || typeof o.fields !== 'object') return "What should I update? e.g. \"Rohan: CTC 24L, notice 60 days, tag to PAY-AR-001\".";
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0], map = {};
  // M-1/L-1: normalize " (optional)" so both header variants ('Gender' vs the legacy
  // 'Gender (optional)') and both field-key spellings match — the drift silently broke chat edits.
  function normKey_(s) { return s.toString().trim().toLowerCase().replace(/\s*\(optional\)\s*$/, ''); }
  headers.forEach(function (h, i) { map[normKey_(h)] = i + 1; });
  var done = [];
  for (var k in o.fields) { var col = map[normKey_(k)]; if (col) { sheet.getRange(row, col).setValue(sanitizeCell_(o.fields[k])); done.push(k); } // C-2
  }
  return done.length ? "✅ Updated " + sheet.getRange(row, 2).getValue() + ": " + done.join(', ') + "." : "I couldn't match those fields.";
}

// ---------- USERS / ROLES ----------
function currentUser_(callerArgs) {
  // C-3 FIX: one identity source for the whole server. Order of trust:
  //   1. the verified ?u= token (works even for anonymous visitors on an "Anyone" deployment)
  //   2. an identity already verified earlier in this same execution
  //   3. Google sign-in (Session) — only works for the owner / same-Workspace users.
  // The role ALWAYS comes from the Users sheet; nothing the browser sends is trusted.
  if (callerArgs) { var t = currentUserFromToken_(extractToken_(callerArgs)); if (t) { AUTH_USER_ = t; return t; } }
  if (AUTH_USER_) return AUTH_USER_;
  var email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  var d = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Users').getDataRange().getValues();
  for (var i = 1; i < d.length; i++)
    if (email && (d[i][0] || '').toString().toLowerCase() === email && (d[i][3] || '').toString().toLowerCase() !== 'no') {
      AUTH_USER_ = { email: email, name: d[i][1] || email, role: (d[i][2] || '').toString() };
      return AUTH_USER_;
    }
  return { email: email, name: email, role: '' };
}
function allowed_(role, intent) {
  var P = {
    Admin:        ['create_requisition','add_candidate','update_details','update_status','schedule_interview','log_feedback','query_status','upload','help'],
    Recruiter:    ['create_requisition','add_candidate','update_details','update_status','schedule_interview','log_feedback','query_status','upload','help'],
    HiringManager:['create_requisition','update_status','log_feedback','query_status','help']
  };
  return (P[role] || []).indexOf(intent) > -1;
}
// ---------- MULTI-USER IDENTITY (token-based personal links) ----------
function ensureUserTokens_() {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Users'); if (!sh) return;
  var d = sh.getDataRange().getValues();
  if (!d.length) return;
  if (d[0].length < 5 || !d[0][4]) sh.getRange(1, 5).setValue('Token');
  if (d[0].length < 6 || !d[0][5]) sh.getRange(1, 6).setValue('Title');
  for (var i = 1; i < d.length; i++) {
    if (d[i][0] && !d[i][4]) sh.getRange(i + 1, 5).setValue(Utilities.getUuid().replace(/-/g, '').slice(0, 12));
  }
}
function whoAmI(token) {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Users');
  if (token && sh) {
    var d = sh.getDataRange().getValues();
    for (var i = 1; i < d.length; i++)
      if ((d[i][4] || '').toString() === token.toString() && (d[i][3] || '').toString().toLowerCase() !== 'no')
        return { email: d[i][0] || '', name: d[i][1] || d[i][0], role: (d[i][2] || '').toString(), title: (d[i][5] || '').toString() };
  }
  try { var u = currentUser_(arguments); if (u && u.role) return { email: u.email, name: u.name, role: u.role, title: '' }; } catch (e) {}
  // C-3 FIX: never hand an unknown visitor a fake 'Recruiter' identity.
  return { email: '', name: 'Guest', role: '', title: '' };
}
function teamAccess() {
  // C-1 FIX: the ?u= tokens ARE login credentials. Only an Admin may list the team with
  // access links; everyone else gets just their own row, with no token/link at all.
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error };
  var isAdmin = (_g.role === 'Admin');
  if (isAdmin) ensureUserTokens_();
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Users'), d = sh ? sh.getDataRange().getValues() : [];
  var base = ''; try { base = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  var list = [];
  for (var i = 1; i < d.length; i++) {
    if (!d[i][0] || (d[i][3] || '').toString().toLowerCase() === 'no') continue;
    if (!isAdmin && (d[i][0] || '').toString().toLowerCase() !== (_g.email || '').toLowerCase()) continue;
    list.push({ email: d[i][0], name: d[i][1] || d[i][0], role: (d[i][2] || ''), title: (d[i][5] || ''),
      link: (isAdmin && base) ? (base + '?u=' + (d[i][4] || '')) : '' });
  }
  return { users: list, base: isAdmin ? base : '' };
}
function addTeamMember(name, email, role, title) {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return { error: _g.error }; // C-1: Admin-only (was open — self-service privilege escalation)
  if (!email) return { error: 'Email is required.' };
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Users'); if (!sh) return { error: 'No Users sheet.' };
  ensureUserTokens_();
  var d = sh.getDataRange().getValues(), el = email.toString().toLowerCase();
  for (var i = 1; i < d.length; i++) {
    if ((d[i][0] || '').toString().toLowerCase() === el) {
      sh.getRange(i + 1, 2).setValue(name || d[i][1]); sh.getRange(i + 1, 3).setValue(role || d[i][2] || 'HiringManager');
      sh.getRange(i + 1, 4).setValue('Yes'); if (title != null) sh.getRange(i + 1, 6).setValue(title);
      if (!d[i][4]) sh.getRange(i + 1, 5).setValue(Utilities.getUuid().replace(/-/g, '').slice(0, 12));
      return teamAccess();
    }
  }
  sh.appendRow(sanitizeRow_([email, name || email, role || 'HiringManager', 'Yes', Utilities.getUuid().replace(/-/g, '').slice(0, 12), title || ''])); // C-2
  return teamAccess();
}
function removeTeamMember(email) {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return { error: _g.error }; // C-1: Admin-only
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Users'), d = sh.getDataRange().getValues(), el = (email || '').toLowerCase();
  for (var i = 1; i < d.length; i++) if ((d[i][0] || '').toString().toLowerCase() === el) { sh.getRange(i + 1, 4).setValue('No'); break; }
  return teamAccess();
}

// ---------- CANDIDATE IDS ----------
function nextCandidateId_() {
  var p = PropertiesService.getScriptProperties();
  var n = (parseInt(p.getProperty('CAND_SEQ') || '0', 10)) + 1;
  p.setProperty('CAND_SEQ', String(n));
  return 'CAND-' + ('0000' + n).slice(-4);
}

// ---------- FORM HELPERS (UI) ----------
function listRequisitions() {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions');
  if (!sh) return [];
  var d = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < d.length; i++) if (d[i][0]) out.push({ id: d[i][0], label: d[i][0] + ' — ' + (d[i][1] || '') });
  return out;
}
function listCandidates() {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), d = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < d.length; i++) if (d[i][1]) out.push({ id: (d[i][30] || ('row' + (i + 1))).toString(), label: d[i][1] + (d[i][30] ? ' (' + d[i][30] + ')' : '') });
  return out;
}
function saveRequisition(o) {
  var u = currentUser_(arguments);
  if (!allowed_(u.role, 'create_requisition')) return '🔒 You can\'t create requisitions.';
  return createRequisition(o);
}
function findRowById_(sheet, candId) {
  if (!candId) return -1;
  if (candId.indexOf('row') === 0) return parseInt(candId.slice(3), 10);
  var d = sheet.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) if ((d[i][30] || '').toString() === candId) return i + 1;
  return -1;
}
function saveCandidateDetails(obj) {
  var u = currentUser_(arguments);
  if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins can edit candidate details.';
  var sheet = trackerSheet_(), row = findRowById_(sheet, obj.candId);
  if (row < 0) return 'Candidate not found.';
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0], map = {};
  function normKey_(s) { return s.toString().trim().toLowerCase().replace(/\s*\(optional\)\s*$/, ''); } // M-1/L-1: tolerate 'Gender (optional)' header/key drift
  headers.forEach(function (h, i) { map[normKey_(h)] = i + 1; });
  var f = obj.fields || {}, done = [];
  for (var k in f) { if (f[k] === '' || f[k] == null) continue; var col = map[normKey_(k)]; if (col) { sheet.getRange(row, col).setValue(sanitizeCell_(f[k])); done.push(k); } // C-2
  }
  return done.length ? '✅ Updated ' + sheet.getRange(row, 2).getValue() + ': ' + done.join(', ') + '.' : 'Nothing to update.';
}

// ---------- DASHBOARD ----------
function getPipeline() {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var ss = SpreadsheetApp.openById(SHEET_ID), t = ss.getSheetByName('Tracker').getDataRange().getValues();
  var stages = {}, total = 0;
  for (var i = 1; i < t.length; i++) { if (!t[i][1]) continue; total++; var st = (t[i][6] || 'New').toString(); stages[st] = (stages[st] || 0) + 1; }
  var openReqs = 0, rq = ss.getSheetByName('Requisitions');
  if (rq) { var r = rq.getDataRange().getValues(); for (var j = 1; j < r.length; j++) if ((r[j][13] || '').toString().toLowerCase() === 'open') openReqs++; }
  return { total: total, stages: stages, openReqs: openReqs };
}

// ---------- RECRUITING ANALYTICS ----------
function buildDashboardData() {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins.';
  return buildDashboardDataCore_();
}
// M-12 FIX: the daily/15-min trigger used to call the guarded function directly — if the
// trigger owner's email wasn't an Admin/Recruiter row in Users (or Session was empty in the
// trigger context) the refresh silently returned 🔒 forever and Looker went stale. Triggers
// now run through this thin entry point, which skips the interactive guard (a time trigger
// can only be installed by the project owner) and returns nothing to web callers.
function buildDashboardDataTrigger() {
  try { Logger.log(buildDashboardDataCore_()); } catch (e) { Logger.log('Dashboard refresh failed: ' + e.message); }
}
function buildDashboardDataCore_() {
  var ss = SpreadsheetApp.openById(SHEET_ID), tr = ss.getSheetByName('Tracker').getDataRange().getValues();
  var reqs = ss.getSheetByName('Requisitions').getDataRange().getValues(), reqMap = {};
  var usersMap = {}; try { var us = ss.getSheetByName('Users').getDataRange().getValues(); for (var w = 1; w < us.length; w++) { var un = (us[w][1] || '').toString().trim().toLowerCase(); if (un) usersMap[un] = (us[w][0] || '').toString(); } } catch (e) {}
  for (var i = 1; i < reqs.length; i++) if (reqs[i][0]) { var hn = (reqs[i][7] || '').toString(); reqMap[reqs[i][0].toString()] = { title: reqs[i][1] || '', dept: reqs[i][3] || '', hm: hn, hmEmail: (reqs[i][25] || '').toString() || usersMap[hn.trim().toLowerCase()] || '' }; }
  var ivMap = {}, fbSet = {};
  try { var ivsh = ss.getSheetByName('Interviews'); if (ivsh) { var iv = ivsh.getDataRange().getValues(); for (var a = 1; a < iv.length; a++) { var ic = (iv[a][1] || '').toString(); if (ic) (ivMap[ic] = ivMap[ic] || []).push((iv[a][6] || '').toString()); } } } catch (e) {}
  try { var fbsh = ss.getSheetByName('Interview Feedback'); if (fbsh) { var fb = fbsh.getDataRange().getValues(); for (var b = 1; b < fb.length; b++) { var fc = (fb[b][1] || '').toString(); if (fc) fbSet[fc] = 1; } } } catch (e) {}
  var sh = null; ss.getSheets().forEach(function (x) { if (x.getName().trim().toLowerCase() === 'dashboard data') sh = x; });
  if (!sh) { try { sh = ss.insertSheet('Dashboard Data'); } catch (e) { sh = ss.getSheetByName('Dashboard Data'); } }
  if (!sh) return '⚠️ Could not create the Dashboard Data tab.';
  sh.clearContents();
  var headers = ['Candidate ID', 'Candidate', 'Req ID', 'Req Title', 'Line of Business', 'Hiring Manager', 'Stage', 'Stage Category', 'Source', 'Current Company', 'Current Title', 'Experience (yrs)', 'Top Skills', 'Current CTC', 'Expected CTC', 'Notice Period', 'Location', 'Gender', 'Has CV', 'Date Received', 'Days in Pipeline', 'Awaiting Action', 'Next Interview', 'HM Email'];
  var now = new Date(), tz = Session.getScriptTimeZone(), out = [headers];
  function cat(s) { s = (s || '').toLowerCase(); if (s.indexOf('reject') > -1) return 'Rejected'; if (s.indexOf('hire') > -1 || s.indexOf('offer') > -1 || s.indexOf('onboard') > -1) return 'Offer/Hired'; if (s.indexOf('hold') > -1) return 'On Hold'; if (s.indexOf('talent pool') > -1) return 'Talent Pool'; return 'Active'; }
  function num(v) { var n = (v == null ? '' : String(v)).replace(/[^\d.]/g, ''); return (n !== '' && !isNaN(n)) ? parseFloat(n) : (v || ''); }
  for (var r = 1; r < tr.length; r++) {
    if (!tr[r][1]) continue;
    var rid = (tr[r][11] || '').toString(), rm = reqMap[rid] || {}, dr = tr[r][0];
    var days = (dr instanceof Date) ? Math.floor((now - dr) / 86400000) : '';
    var cid2 = (tr[r][30] || '').toString(), slc = (tr[r][6] || '').toString().toLowerCase();
    var awaiting = ''; if (slc.indexOf('debrief') > -1 && slc.indexOf('reject') < 0) awaiting = 'Debrief due'; else if (ivMap[cid2] && ivMap[cid2].length && !fbSet[cid2]) awaiting = 'Feedback pending';
    // L-6 FIX: "Next Interview" = the earliest UPCOMING one (was sort().pop() = the latest
    // PAST interview). Dates are 'yyyy-MM-dd HH:mm' strings, so string compare is chronological.
    var nowStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm');
    var nextIv = (ivMap[cid2] && ivMap[cid2].length) ? (ivMap[cid2].filter(function (x) { return x >= nowStr; }).sort()[0] || '') : '';
    out.push([cid2, tr[r][1], rid, rm.title || '', rm.dept || '', rm.hm || '', (tr[r][6] || 'New').toString(), cat(tr[r][6]),
      tr[r][4] || '', tr[r][17] || '', tr[r][18] || '', num(tr[r][19]), tr[r][20] || '', num(tr[r][23]), num(tr[r][24]), tr[r][22] || '', tr[r][13] || '',
      '', // M-7: Gender is no longer exported to the Looker-facing tab (header kept so existing Looker field mappings don't break)
      tr[r][5] ? 'Yes' : 'No', (dr instanceof Date) ? Utilities.formatDate(dr, tz, 'yyyy-MM-dd') : '', days, awaiting, nextIv, rm.hmEmail || '']);
  }
  sh.getRange(1, 1, out.length, headers.length).setValues(out.map(sanitizeRow_)); // C-2
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  return '✅ "Dashboard Data" tab refreshed — ' + (out.length - 1) + ' candidates. Now connect Looker Studio to this tab (see steps).';
}
// Run once from the editor to auto-refresh the Dashboard Data tab every morning (keeps Looker current).
function scheduleDashboardRefresh() {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return _g.error; // C-1: server-side auth
  // M-12: schedule the trigger-safe entry point (guard-free) so the refresh can't silently 🔒 forever
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'buildDashboardData' || t.getHandlerFunction() === 'buildDashboardDataTrigger') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('buildDashboardDataTrigger').timeBased().everyDays(1).atHour(6).create();
  return '✅ Dashboard Data will auto-refresh daily around 6am.';
}
function scheduleDashboardRefreshLive() {
  var _g = guard_(arguments, 'Admin'); if (_g.error) return _g.error; // C-1: server-side auth
  // M-12: schedule the trigger-safe entry point (guard-free) so the refresh can't silently 🔒 forever
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'buildDashboardData' || t.getHandlerFunction() === 'buildDashboardDataTrigger') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('buildDashboardDataTrigger').timeBased().everyMinutes(15).create();
  return '✅ Near real-time: Dashboard Data now rebuilds every 15 minutes. Looker will be at most ~15 min behind (viewers can also hit Looker\'s ⟳ refresh for instant).';
}
function getAnalytics(hm) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var ss = SpreadsheetApp.openById(SHEET_ID), d = trackerSheet_().getDataRange().getValues(), total = 0, bySource = {}, srcHire = {};
  var reqMap = {}; try { var rq = ss.getSheetByName('Requisitions').getDataRange().getValues(); for (var z = 1; z < rq.length; z++) if (rq[z][0]) reqMap[rq[z][0].toString()] = { title: rq[z][1] || '', hm: rq[z][7] || '' }; } catch (e) {}
  var allHMs = {}; for (var hk in reqMap) if (reqMap[hk].hm) allHMs[reqMap[hk].hm] = 1;
  var byReq = {}, byHM = {};
  var reached = { applied: 0, screened: 0, interviewed: 0, offered: 0, hired: 0 };
  var rejects = { cv: 0, interview: 0, debrief: 0, other: 0 }, offered = 0, declined = 0, onboarded = 0;
  var SCR = ['screened','shortlist','interview','interview scheduled','interview reject','debrief','debrief reject','selected','offered','offer declined','onboarded'];
  var IVW = ['interview reject','debrief','debrief reject','selected','offered','offer declined','onboarded']; // interview actually happened (NOT merely 'interview scheduled')
  var OFR = ['offered','offer declined','onboarded'];
  var fbByCand = {}; try { var fbs = ss.getSheetByName('Interview Feedback'); if (fbs) { var fbd = fbs.getDataRange().getValues(); for (var fb = 1; fb < fbd.length; fb++) { var fc = (fbd[fb][1] || '').toString(); if (fc) fbByCand[fc] = 1; } } } catch (e) {}
  for (var i = 1; i < d.length; i++) {
    if (!d[i][1]) continue;
    var crid = (d[i][11] || '').toString(), chm = (reqMap[crid] && reqMap[crid].hm) || '';
    if (hm && chm !== hm) continue;
    total++;
    var src = (d[i][4] || 'Unknown').toString(); bySource[src] = (bySource[src] || 0) + 1;
    var sl = canonStage_(d[i][6] || 'New'); // H-2: normalize legacy debrief stage strings before matching
    reached.applied++;
    if (SCR.indexOf(sl) > -1) reached.screened++;
    if (IVW.indexOf(sl) > -1 || fbByCand[(d[i][30] || '').toString()]) reached.interviewed++; // counts only if interview happened or feedback exists
    if (OFR.indexOf(sl) > -1) reached.offered++;
    if (sl === 'onboarded') reached.hired++;
    if (sl === 'cv screen reject') rejects.cv++; else if (sl === 'interview reject') rejects.interview++;
    else if (sl === 'debrief reject') rejects.debrief++; else if (sl === 'rejected') rejects.other++;
    if (sl === 'offered') offered++; if (sl === 'offer declined') declined++; if (sl === 'onboarded') onboarded++;
    if (['selected','offered','onboarded'].indexOf(sl) > -1) srcHire[src] = (srcHire[src] || 0) + 1;
    if (crid) { var rt = (reqMap[crid] && reqMap[crid].title) ? (crid + ' — ' + reqMap[crid].title) : crid; byReq[rt] = (byReq[rt] || 0) + 1; var hmv = chm || '—'; byHM[hmv] = (byHM[hmv] || 0) + 1; }
  }
  var decided = onboarded + declined;
  var metrics = {}; try { metrics = getStageMetrics(); } catch (e) { metrics = { avgTimeToHire: null, perStage: [] }; }
  return { total: total, reached: reached, bySource: bySource, srcHire: srcHire, rejects: rejects,
    offered: offered, declined: declined, onboarded: onboarded, byReq: byReq, byHM: byHM, metrics: metrics,
    allHMs: Object.keys(allHMs).sort(), scopedHM: hm || '',
    offerAcceptRate: decided ? Math.round(onboarded / decided * 100) : null };
}
// Per-round interview metrics — round names come from each requisition's own interview plan.
// reqIds: array of requisition IDs to include (empty = all). Counts aggregate by round NAME across the selected reqs.
function getRoundMetrics(reqIds) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var ss = SpreadsheetApp.openById(SHEET_ID), set = {}, all = !(reqIds && reqIds.length);
  (reqIds || []).forEach(function (r) { if (r) set[r.toString()] = 1; });
  function inSet(rid) { return all || !!set[(rid || '').toString()]; }
  var order = [], seen = {}, reqs = [];
  var rq = ss.getSheetByName('Requisitions').getDataRange().getValues();
  for (var i = 1; i < rq.length; i++) {
    var id = (rq[i][0] || '').toString(); if (!id || !inSet(id)) continue;
    reqs.push({ id: id, title: rq[i][1] || '' });
    var plan = (rq[i][15] || '').toString();
    if (plan) { try { (JSON.parse(plan).rounds || []).forEach(function (rd) { var nm = (rd.name || '').toString().trim(); if (nm && !seen[nm.toLowerCase()]) { seen[nm.toLowerCase()] = 1; order.push(nm); } }); } catch (e) {} }
  }
  var tr = ss.getSheetByName('Tracker').getDataRange().getValues(), candReq = {};
  for (var t = 1; t < tr.length; t++) { var cid = (tr[t][30] || '').toString(); if (cid) candReq[cid] = (tr[t][11] || '').toString(); }
  var sch = {}, schSeen = {};
  try { var iv = ss.getSheetByName('Interviews').getDataRange().getValues(); for (var a = 1; a < iv.length; a++) { if (!inSet((iv[a][3] || '').toString())) continue; var rn = (iv[a][4] || '').toString().trim(); if (!rn) continue; var lk = rn.toLowerCase(); if (!seen[lk]) { seen[lk] = 1; order.push(rn); } var k = lk + '|' + (iv[a][1] || ''); if (!schSeen[k]) { schSeen[k] = 1; sch[lk] = (sch[lk] || 0) + 1; } } } catch (e) {}
  var fbc = {}, fbSeen = {};
  try { var fb = ss.getSheetByName('Interview Feedback').getDataRange().getValues(); for (var b = 1; b < fb.length; b++) { var cd = (fb[b][1] || '').toString(); if (!inSet(candReq[cd])) continue; var rn2 = (fb[b][5] || '').toString().trim(); if (!rn2) continue; var lk2 = rn2.toLowerCase(); if (!seen[lk2]) { seen[lk2] = 1; order.push(rn2); } var k2 = lk2 + '|' + cd; if (!fbSeen[k2]) { fbSeen[k2] = 1; fbc[lk2] = (fbc[lk2] || 0) + 1; } } } catch (e) {}
  var rounds = order.map(function (nm) { var k = nm.toLowerCase(); return { name: nm, scheduled: sch[k] || 0, interviewed: fbc[k] || 0 }; });
  return { reqs: reqs, rounds: rounds };
}
function emailAnalyticsReport(hm, to) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins.';
  if (!to || to.indexOf('@') < 0) return '⚠️ Enter a valid email address.';
  var a = getAnalytics(hm), r = a.reached;
  var body = 'Hiring report' + (hm ? ' — ' + hm : ' (all requisitions)') + '\n\n' +
    'Total candidates: ' + a.total + '\n' +
    'Funnel — Applied ' + r.applied + ' · Screened ' + r.screened + ' · Interviewed ' + r.interviewed + ' · Offered ' + r.offered + ' · Hired ' + r.hired + '\n' +
    'Offers — Offered ' + a.offered + ' · Onboarded ' + a.onboarded + ' · Declined ' + a.declined + (a.offerAcceptRate != null ? ' · Accept ' + a.offerAcceptRate + '%' : '') + '\n' +
    (a.metrics && a.metrics.avgTimeToHire != null ? 'Avg time-to-hire: ' + a.metrics.avgTimeToHire + ' days\n' : '') +
    '\nBy requisition:\n' + (Object.keys(a.byReq).length ? Object.keys(a.byReq).map(function (k) { return '  • ' + k + ': ' + a.byReq[k]; }).join('\n') : '  (none)');
  var link = ''; try { link = orgContext_().reportLink; } catch (e) {}
  if (link) body += '\n\n📊 Live dashboard (open and pick your name in the filter):\n' + link;
  body += '\n\nGenerated by AgentATS.';
  try { GmailApp.sendEmail(to, 'Hiring report' + (hm ? ' — ' + hm : ''), body); } catch (e) { return '⚠️ ' + e.message; }
  return '✅ Report emailed to ' + to + '.';
}

// ---------- REQUISITION BOARD / PIPELINE / CANDIDATE VIEW ----------
function getReqBoard(scopeEmail) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  // M-10 FIX: HM scoping is enforced SERVER-side from the verified identity. Previously the
  // client decided whether to send an email — any HM could call getReqBoard('') and see all reqs.
  if (_g.role === 'HiringManager') scopeEmail = _g.email || scopeEmail;
  var _ck = 'board_' + cacheVer_() + '_' + (scopeEmail || ''); var _hit = cacheGet_(_ck); if (_hit) return _hit;
  if (SB_ON_()) { try { var _sb = sbGetReqBoard_(scopeEmail); if (_sb) { cachePut_(_ck, _sb, 120); return _sb; } } catch (e) {} }
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var rq = ss.getSheetByName('Requisitions'), reqs = rq ? rq.getDataRange().getValues() : [];
  var tr = ss.getSheetByName('Tracker').getDataRange().getValues(), counts = {};
  for (var i = 1; i < tr.length; i++) { var rid = (tr[i][11] || '').toString(); if (rid) counts[rid] = (counts[rid] || 0) + 1; }
  var scope = (scopeEmail || '').toString().toLowerCase(), out = [];
  for (var j = 1; j < reqs.length; j++) {
    if (!reqs[j][0]) continue; var id = reqs[j][0].toString();
    if (scope && (reqs[j][25] || '').toString().toLowerCase() !== scope) continue;
    out.push({ id: id, title: reqs[j][1] || '', lob: reqs[j][3] || '', hm: reqs[j][7] || '',
      openings: reqs[j][9] || '', status: reqs[j][13] || '', count: counts[id] || 0 });
  }
  cachePut_(_ck, out, 120); return out;
}
// Stack rank — market-calibrated listwise re-rank via the shared rankProfiles_ engine (success profile + experience band + must-have coverage).
function stackRankReq(reqId, deep) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), d = sh.getDataRange().getValues(), cands = [];
  for (var i = 1; i < d.length; i++) {
    if (!d[i][1] || (d[i][11] || '').toString() !== reqId.toString()) continue;
    cands.push({ candId: (d[i][30] || '').toString(), name: d[i][1], title: (d[i][18] || ''), company: (d[i][17] || ''), exp: (d[i][19] || ''), skills: (d[i][20] || '').toString(), qual: (d[i][21] || ''), ctc: (d[i][24] || ''), highlights: (d[i][36] || '').toString(), patents: (d[i][38] || '').toString(), stage: (d[i][6] || '').toString(), reqId: reqId });
  }
  if (!cands.length) return { error: 'No candidates on this requisition.' };
  var r = rankProfiles_(reqId, cands, deep); r.total = cands.length;
  if (r.error) return r; // H-7: AI failed — surface it; do NOT persist empty scores or a rank timestamp
  r.hasCalibration = r.hasMust;
  // Persist so the pipeline view shows these scores instantly (no re-ranking on open).
  try { var map = {}; (r && r.ranked || []).forEach(function (x) { map[x.candId] = { m: x.score, o: !!x.over, c: x.comp || '' }; }); cachePut_('rankres_' + reqId, map, 21600); } catch (e) {}
  setRankTs_(reqId); r.rankedAt = getRankTs(reqId);
  try { cachePut_('sr_' + (deep ? 'd' : 'a') + '_' + reqId, r, 3600); } catch (e) {}
  return r;
}
// Instant read of the LAST stack-rank result (no AI). Returns {needsRank:true} if none saved yet,
// so the Stack rank screen opens immediately instead of blocking on a 30–60s AI pass.
function stackRankCached(reqId, deep) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  try { var hit = cacheGet_('sr_' + (deep ? 'd' : 'a') + '_' + reqId); if (hit) return hit; } catch (e) {}
  return { needsRank: true };
}
// ---------- UNIFIED RUBRIC ENGINE (TalentRubric 37-cat × role × company, scored by our signals; blended) ----------
function getRubricConfig(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  try { var raw = PropertiesService.getScriptProperties().getProperty('RUBRIC_' + reqId); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
function setRubricConfig(reqId, role, company, threshold) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var cfg = { role: role || 'General', company: company || 'Mid-cap SaaS', threshold: threshold || 'Balanced' };
  PropertiesService.getScriptProperties().setProperty('RUBRIC_' + reqId, JSON.stringify(cfg)); bustCache_();
  return { ok: true, cfg: cfg };
}
function classifyRubric(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var existing = getRubricConfig(reqId); if (existing) return existing;
  var s = {}; try { s = getReqSummary(reqId) || {}; } catch (e) {}
  var jd = String(reqJDText_(reqId) || ''), arch = {}; try { arch = getJobArch(); } catch (e) {}
  var opt = TalentRubric.options(), roles = opt.archetypes || [], comps = opt.companies || [];
  var defC = PropertiesService.getScriptProperties().getProperty('ORG_DEFAULT_COMPANY') || '';
  var role = 'General', company = (defC && comps.indexOf(defC) > -1) ? defC : 'Mid-cap SaaS';
  try {
    var j = JSON.parse(callGemini('Classify this requisition into exactly one ROLE archetype and one COMPANY archetype from the lists (return the exact strings).\nRole: ' + (s.title || reqId) + ' · Level: ' + (s.level || '') + ' · ' + (s.lob || '') + '\nJD: ' + jd.slice(0, 1000) + '\nConfigured company type: ' + ((arch && arch.companyType) || (orgContext_().type) || '') + '\nROLE archetypes: ' + roles.join(' | ') + '\nCOMPANY archetypes: ' + comps.join(' | ') + '\nMap the SPECIFIC title to the closest archetype, e.g.: Chief of Staff/BizOps→"Chief of Staff / BizOps"; Customer Success Manager/Support→"Customer Success & Support"; Category Manager/Ops→"Operations/PMO/People"; Content Writer/Brand/Growth/SEO→"Marketing & Content"; Recruiter/HRBP/TA→"HR/Talent/Recruiting"; Data/ML/MLOps Engineer→"Data/ML Engineering"; SRE/DevOps/Datacenter→"Senior Technical IC"; SOC/Security Analyst→"Senior Technical IC"; Integration/Solutions Specialist→"Solutions / Sales Engineering"; DevOps/SRE/Platform→"DevOps / SRE / Platform"; Security/InfoSec Engineer→"Security Engineering / InfoSec"; Data Scientist/Analyst→"Data Science & Analytics"; UX/UI/Product Designer→"UX / Product Design"; Supply-chain/Logistics/Category→"Supply Chain / Logistics / Category"; QA/Test/SDET→"QA / Test Engineering"; Hardware/Embedded/Firmware→"Hardware / Embedded Engineering"; TPM/Program Manager→"Technical Program Management"; Clinical/Regulatory/Medical Affairs→"Clinical / Regulatory Affairs". And company: quick-commerce→"E-commerce — Quick Commerce"; fashion/lifestyle retail→"E-commerce — Fashion/Lifestyle"; OpenAI/Anthropic-type→"Frontier AI"; security firm→"Cybersecurity"; datacenter/colo/cloud→"Datacenter/Cloud Infrastructure"; factory/industrial→"Manufacturing/Industrial"; hospital/pharma/biotech→"Healthcare/Pharma/Biotech"; captive/GCC→"GCC — Global Capability Center".\nReturn ONLY JSON {"role":"","company":""}.', true));
    if (roles.indexOf(j.role) > -1) role = j.role;
    if (comps.indexOf(j.company) > -1) company = j.company;
  } catch (e) {}
  var cfg = { role: role, company: company, threshold: 'Balanced' };
  PropertiesService.getScriptProperties().setProperty('RUBRIC_' + reqId, JSON.stringify(cfg));
  return cfg;
}
function useCustomWeights_() { try { return PropertiesService.getScriptProperties().getProperty('USE_CUSTOM_WEIGHTS') === '1'; } catch (e) { return false; } }
function getWeightMode() {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  return { custom: useCustomWeights_() }; }
function setWeightMode(on) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  if (on) { var ss = SpreadsheetApp.openById(SHEET_ID); if (!ss.getSheetByName('03_Role_Weights') || !ss.getSheetByName('06_Company_Modifiers')) return { error: 'Publish the weight tabs first, then switch to Custom.' }; }
  PropertiesService.getScriptProperties().setProperty('USE_CUSTOM_WEIGHTS', on ? '1' : '0'); bustCache_(); return { ok: true, custom: !!on };
}
// Governance: changing scoring weights affects the whole platform. Choose scope + log who/when/what.
function changeWeights(custom, scope, note) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var p = PropertiesService.getScriptProperties();
  if (custom) { var ss0 = SpreadsheetApp.openById(SHEET_ID); if (!ss0.getSheetByName('03_Role_Weights') || !ss0.getSheetByName('06_Company_Modifiers')) return { error: 'Publish the weight tabs first, then apply Custom.' }; }
  var who = u.name || u.email || 'Recruiter', sh = trackerSheet_(), d = sh.getDataRange().getValues();
  if (scope === 'new') {
    // C-4 FIX: the old code ran up to 300 sequential Gemini calls BEFORE flipping the weight
    // properties — with >~20 uncached candidates it hit the 6-minute execution limit and died
    // with partial snapshots and the switch NEVER applied. Now:
    //   1) the switch is applied FIRST, atomically (one setProperties call) — weights can
    //      never end up half-applied;
    //   2) the snapshot pass makes ZERO AI calls: it persists whatever rubric results are
    //      already in the cache (those were computed under the OLD weights) — seconds, not minutes;
    //   3) any pre-change candidate without a snapshot is frozen lazily: the next time
    //      scoreCandidateRubric runs for them, that result is written to col 40 and kept stable.
    p.setProperties({ 'USE_CUSTOM_WEIGHTS': custom ? '1' : '0', 'WEIGHTS_EFFECTIVE_FROM': new Date().toISOString() });
    var n = 0, ver = cacheVer_(); // read cached (old-weight) scores BEFORE bustCache_ rotates the keys
    for (var i = 1; i < d.length; i++) {
      var cid = (d[i][30] || '').toString(); if (!d[i][1] || !cid || d[i][39]) continue;
      var hit = cacheGet_('rub_' + ver + '_' + cid);
      if (hit && !hit.error) { try { sh.getRange(i + 1, 40).setValue(JSON.stringify(hit)); n++; } catch (e) {} }
    }
    bustCache_(); try { logAudit_('WEIGHTS-CONFIG', (note || 'weights changed') + ' · scope: NEW candidates only · switch applied immediately · ' + n + ' existing candidate(s) frozen from cache, the rest freeze on their next scoring'); } catch (e) {}
    return { ok: true, scope: 'new', frozen: n };
  } else {
    // Apply to ALL — clear frozen snapshots, rescore everyone (incl. interview stage) with new weights.
    for (var j = 1; j < d.length; j++) { if (d[j][39]) { try { sh.getRange(j + 1, 40).setValue(''); } catch (e) {} } }
    p.setProperty('USE_CUSTOM_WEIGHTS', custom ? '1' : '0'); p.deleteProperty('WEIGHTS_EFFECTIVE_FROM');
    bustCache_(); try { logAudit_('WEIGHTS-CONFIG', (note || 'weights changed') + ' · scope: ALL pipeline + new (everyone re-ranked)'); } catch (e) {}
    return { ok: true, scope: 'all' };
  }
}
function getWeightAudit() {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  try { return getAudit_('WEIGHTS-CONFIG'); } catch (e) { return []; } }
// In-app company-emphasis overrides (no spreadsheet) — boost/neutral/dampen per category, or set by plain-English.
function getCoOverrides_() { try { var r = PropertiesService.getScriptProperties().getProperty('RUBRIC_CO_OVERRIDE'); return r ? JSON.parse(r) : {}; } catch (e) { return {}; } }
function applyCoOverride_(company) { try { var ov = getCoOverrides_()[company]; if (!ov) return; var cm = TalentRubric.companyModifiers()[company]; if (!cm) return; Object.keys(ov).forEach(function (c) { if (cm[c] != null) cm[c] = Number(ov[c]); }); } catch (e) {} }
function getCompanyTuning(company) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var cats = TalentRubric.categories(), cm = (TalentRubric.companyModifiers()[company]) || {}, ov = getCoOverrides_()[company] || {};
  function lvl(v) { v = Number(v); if (v >= 1.3) return 'boost'; if (v <= 0.8) return 'dampen'; return 'neutral'; }
  var state = {}; cats.forEach(function (c) { var v = (ov[c] != null ? ov[c] : (cm[c] != null ? cm[c] : 1)); state[c] = lvl(v); });
  return { company: company, categories: cats, state: state, hasOverride: !!getCoOverrides_()[company] };
}
function setCompanyTuning(company, state) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  if (!company) return { error: 'Pick a company type.' };
  var cats = TalentRubric.categories(), map = {}; cats.forEach(function (c) { var s = (state && state[c]) || 'neutral'; map[c] = s === 'boost' ? 1.5 : (s === 'dampen' ? 0.65 : 1); });
  var all = getCoOverrides_(); all[company] = map; PropertiesService.getScriptProperties().setProperty('RUBRIC_CO_OVERRIDE', JSON.stringify(all)); bustCache_();
  try { logAudit_('WEIGHTS-CONFIG', (u.name || u.email || 'Recruiter') + ' tuned category emphasis for "' + company + '"'); } catch (e) {}
  return { ok: true };
}
function resetCompanyTuning(company) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var all = getCoOverrides_(); delete all[company]; PropertiesService.getScriptProperties().setProperty('RUBRIC_CO_OVERRIDE', JSON.stringify(all)); bustCache_();
  try { logAudit_('WEIGHTS-CONFIG', (u.name || u.email || 'Recruiter') + ' reset "' + company + '" to recommended emphasis'); } catch (e) {}
  return { ok: true };
}
function tuneCompanyByText(company, text) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var cats = TalentRubric.categories();
  var prompt = 'A recruiter describes what matters most when hiring at a "' + company + '"-type company. Map it to category emphasis.\nDescription: ' + (text || '').slice(0, 900) + '\nCATEGORIES (index: name):\n' + cats.map(function (c, i) { return i + ': ' + c; }).join('\n') + '\nReturn ONLY JSON {"boost":[indexes],"dampen":[indexes]} — boost = up to 8 categories that matter MOST; dampen = up to 5 that matter least. Use the indexes.';
  var j; try { j = JSON.parse(callGemini(prompt, true)); } catch (e) { return { error: e.message }; }
  var state = {}; cats.forEach(function (c) { state[c] = 'neutral'; });
  (j.boost || []).forEach(function (i) { var c = cats[Number(i)]; if (c) state[c] = 'boost'; });
  (j.dampen || []).forEach(function (i) { var c = cats[Number(i)]; if (c) state[c] = 'dampen'; });
  return { state: state, categories: cats };
}
// One click: publish tabs if missing, switch to custom, return the sheet URL so the UI can open it for editing.
function enableCustomWeights(scope) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var ss = SpreadsheetApp.openById(SHEET_ID);
  if (!ss.getSheetByName('03_Role_Weights') || !ss.getSheetByName('06_Company_Modifiers')) { var pr = publishRubricWeightTabs(); if (pr && pr.error) return pr; }
  var r = changeWeights(true, scope || 'all', 'switched to custom weights'); if (r && r.error) return r;
  r.url = getSpreadsheetUrl(); return r;
}
function publishRubricWeightTabs() {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return { error: '🔒 Only recruiters/admins.' };
  var ss = SpreadsheetApp.openById(SHEET_ID), cats = TalentRubric.categories(), opt = TalentRubric.options(), rw = TalentRubric.roleWeights(), cm = TalentRubric.companyModifiers();
  function writeMatrix(name, cols, src) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name); sh.clear();
    var header = ['Category'].concat(cols), rows = [header];
    cats.forEach(function (cat) { var row = [cat]; cols.forEach(function (c) { row.push((src[c] && src[c][cat] != null) ? src[c][cat] : ''); }); rows.push(row); });
    sh.getRange(1, 1, rows.length, header.length).setValues(rows); sh.getRange(1, 1, 1, header.length).setFontWeight('bold'); sh.setFrozenRows(1); sh.setFrozenColumns(1);
  }
  writeMatrix('03_Role_Weights', opt.archetypes, rw);
  writeMatrix('06_Company_Modifiers', opt.companies, cm);
  return { ok: true, message: '✅ Published 03_Role_Weights (' + cats.length + '×' + opt.archetypes.length + ') and 06_Company_Modifiers (' + cats.length + '×' + opt.companies.length + ') pre-filled with the standard numbers. Edit the cells, then tick "Use custom weights".' };
}
function scoreCandidateRubric(candId, regen) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return { error: 'Candidate not found.' };
  var r = sh.getRange(row, 1, 1, 40).getValues()[0], reqId = (r[11] || '').toString();
  // Frozen snapshot: if weights changed with "new candidates only", pre-change candidates keep their snapshotted score.
  if (!regen) { var eff = PropertiesService.getScriptProperties().getProperty('WEIGHTS_EFFECTIVE_FROM'); if (eff && r[39] && r[0] instanceof Date && r[0] < new Date(eff)) { try { return JSON.parse(r[39]); } catch (e) {} } }
  var cfg = getRubricConfig(reqId) || classifyRubric(reqId);
  if (useCustomWeights_()) { try { TalentRubric.loadFromSheets(SpreadsheetApp.openById(SHEET_ID)); } catch (e) {} }
  try { applyCoOverride_(cfg.company); } catch (e) {}
  var ck = 'rub_' + cacheVer_() + '_' + candId;
  if (!regen) { var hit = cacheGet_(ck); if (hit) return hit; }
  var sp = {}; try { sp = getSuccessProfile(reqId, false) || {}; } catch (e) {} if (sp.error) sp = {};
  var brief = {}; try { var cal = getCalibration(reqId); brief = (cal && cal.brief) || {}; } catch (e) {}
  var cats = TalentRubric.categories(), catList = cats.map(function (c, i) { return i + ': ' + c; }).join('\n');
  var cand = 'Title: ' + (r[18] || '') + '\nCompany: ' + (r[17] || '') + '\nExperience: ' + (r[19] || '') + ' yrs\nSkills: ' + (r[20] || '') + '\nQualification: ' + (r[21] || '') + '\nNotice: ' + (r[22] || '') + '\nCurrent CTC: ' + (r[23] || '') + '\nExpected CTC: ' + (r[24] || '') + '\nHighlights: ' + (r[36] || '') + '\nGitHub: ' + (r[37] || '') + '\nPatents: ' + (r[38] || '');
  var jd = String(reqJDText_(reqId) || '');
  var prompt = 'Score this candidate on a 37-category rubric for a "' + cfg.role + '" role at a "' + cfg.company + '"-type company. Score EACH category 0-5 (0=absent/poor, 3=meets bar, 5=exceptional) using ONLY evidence in the profile; if a category is unknowable from the profile, score 2 (neutral). ZERO-BIAS: ignore name/gender/age — score "Fairness & Bias Controls" = 5 unless the resume itself shows a bias/exclusion risk.\n' +
    'ROLE SUCCESS PROFILE: ' + JSON.stringify({ exp: [sp.exp_min, sp.exp_ideal, sp.exp_max], core: (sp.core_skills || []), competitors: (sp.competitor_companies || []), domains: (sp.domains || []), market: sp.market_note || '' }).slice(0, 900) + '\n' +
    'MUST-HAVES: ' + ((brief.must_haves || []).join('; ') || '(none)') + ' · RED FLAGS: ' + ((brief.red_flags || []).join('; ') || '(none)') + '\n' +
    'DOMAIN PRECISION: reward the EXACT sub-domain match (e.g., within Fintech-AI: credit/lending vs public-fund vs payments/fraud; within Industrial/Real-Estate/Healthcare AI the specific niche) and the required MARKET SCOPE (global vs regional, and prior experience at comparable global companies) described in the success profile / domain context — generic AI or generic domain experience without the specific sub-domain should score notably lower under Domain & Industry Expertise and JD/Role-Fit.\n' +
    'ROLE JD: ' + jd.slice(0, 900) + '\nCANDIDATE:\n' + cand + '\n' +
    'CATEGORIES (index: name):\n' + catList + '\n' +
    'SENIORITY & LEADERSHIP: for candidates with 10+ years, senior ICs, and any people-management / leadership / executive role, weigh heavily — under the relevant categories — leadership & people management, organizational/role IMPACT, cross-functional COLLABORATION & stakeholder influence, mentorship, ownership, and leadership principles (vision, judgement, scaling teams). For a people-management role, score Leadership & People Management as a primary category, not a nice-to-have. For GCC (Global Capability Center) leadership roles (site leader/Director/HR/Finance/Recruiting leader), reward prior GCC / global-captive-center and multinational stakeholder experience.\n' +
    'Set "gate": false ONLY if a disqualifying red flag is present (fabrication, hard-requirement fail, or a "Risk / Red Flags" deal-breaker); else true.\n' +
    'Return ONLY JSON: {"scores":{"0":n, ... ,"36":n},"gate":true,"summary":"one concise evidence-based line"}.';
  var j; try { j = JSON.parse(callGemini(prompt, true)); } catch (e) { return { error: e.message }; }
  var scores = {}; cats.forEach(function (c, i) { var v = Number((j.scores && (j.scores[i] != null ? j.scores[i] : j.scores[String(i)]))); scores[c] = Math.max(0, Math.min(5, isNaN(v) ? 0 : v)); });
  var gate = (j.gate !== false && j.gate !== 'No');
  var res; try { res = TalentRubric.scoreCandidate(cfg.role, cfg.company, cfg.threshold, gate, scores); } catch (e) { return { error: e.message }; }
  var out = { composite: res.composite, verdict: res.verdict, minRequired: res.minRequired, effectiveWeights: res.effectiveWeights, topCategories: res.topCategories, scores: scores, gate: gate, role: cfg.role, company: cfg.company, threshold: cfg.threshold, summary: (j.summary || '') };
  cachePut_(ck, out, 1800);
  // C-4: lazy freeze — if weights were switched with "new candidates only" and this pre-change
  // candidate has no snapshot yet, persist this result as their frozen score (stable from now on).
  try {
    var eff2 = PropertiesService.getScriptProperties().getProperty('WEIGHTS_EFFECTIVE_FROM');
    if (eff2 && !r[39] && r[0] instanceof Date && r[0] < new Date(eff2)) sh.getRange(row, 40).setValue(JSON.stringify(out));
  } catch (e) {}
  return out;
}
function rubricRankReq(reqId) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), d = sh.getDataRange().getValues(), ids = [];
  for (var i = 1; i < d.length; i++) { if (d[i][1] && (d[i][11] || '').toString() === reqId.toString()) ids.push({ candId: (d[i][30] || '').toString(), name: d[i][1] }); }
  if (!ids.length) return { error: 'No candidates on this requisition.' };
  var cfg = getRubricConfig(reqId) || classifyRubric(reqId);
  var ours = {}; try { getReqPipeline(reqId).forEach(function (p) { ours[p.candId] = p.match; }); } catch (e) {}
  var pool = ids.slice(0, 25), ranked = [];
  pool.forEach(function (x) {
    var rb = scoreCandidateRubric(x.candId, false);
    if (rb && !rb.error) { var our = (ours[x.candId] != null ? ours[x.candId] : rb.composite); var fin = Math.round(rb.composite * 0.6 + our * 0.4);
      ranked.push({ candId: x.candId, name: x.name, composite: rb.composite, our: our, final: fin, verdict: rb.verdict, gate: rb.gate, top: (rb.topCategories || []).slice(0, 3), summary: rb.summary }); }
  });
  ranked.sort(function (a, b) { if (a.gate !== b.gate) return a.gate ? -1 : 1; return b.final - a.final; });
  setRankTs_(reqId);
  return { ranked: ranked, count: ranked.length, total: ids.length, role: cfg.role, company: cfg.company, threshold: cfg.threshold, rankedAt: getRankTs(reqId) };
}
function reqMatchTerms_(reqId) {
  var STOP = { and: 1, the: 1, for: 1, with: 1, you: 1, our: 1, are: 1, will: 1, have: 1, this: 1, that: 1, role: 1, team: 1, work: 1, years: 1, year: 1, experience: 1, engineer: 1, engineering: 1, senior: 1, junior: 1, lead: 1, manager: 1, developer: 1, development: 1, strong: 1, good: 1, must: 1, should: 1, ability: 1, skills: 1, knowledge: 1, including: 1, etc: 1, plus: 1, new: 1, using: 1, from: 1, into: 1, who: 1, has: 1 };
  function toks(t) { return (t || '').toString().toLowerCase().split(/[^a-z0-9+#.]+/).filter(function (w) { return w.length > 2 && !STOP[w]; }); }
  var s = {}, brief = {};
  try { s = getReqSummary(reqId) || {}; } catch (e) {}
  try { var cal = getCalibration(reqId); brief = (cal && cal.brief) || {}; } catch (e) {}
  var terms = [];
  // calibration must-haves carry the most weight; fall back to title + JD
  (brief.must_haves || []).concat(brief.nice_to_haves || []).forEach(function (m) { terms = terms.concat(toks(m)); });
  try { benchmarkSignals_(reqId).forEach(function (m) { terms = terms.concat(toks(m)); }); } catch (e) {}
  terms = terms.concat(toks(s.title), toks(s.notes));
  var seen = {}, u = []; terms.forEach(function (t) { if (!seen[t]) { seen[t] = 1; u.push(t); } });
  return u;
}
function setRankTs_(reqId) { try { var w = currentUser_(arguments); PropertiesService.getScriptProperties().setProperty('RANK_TS_' + reqId, JSON.stringify({ when: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy, HH:mm'), who: (w.name || w.email || 'Recruiter') })); } catch (e) {} }
function getRankTs(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  try { var raw = PropertiesService.getScriptProperties().getProperty('RANK_TS_' + reqId); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
// PERF: one round-trip for the whole pipeline screen (was 6 separate google.script.run calls).
// Pure composition of existing functions — no logic changes; each sub-call keeps its own caching.
function getPipelineView(reqId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var out = {};
  try { out.summary = getReqSummary(reqId); } catch (e) { out.summary = null; }
  try { out.plan = getReqPlan(reqId); } catch (e) { out.plan = null; }
  try { out.calibration = getCalibration(reqId); } catch (e) { out.calibration = null; }
  try { out.workflow = getReqWorkflow(reqId); } catch (e) { out.workflow = null; }
  try { out.pipeline = getReqPipeline(reqId); } catch (e) { out.pipeline = []; }
  try { out.rankTs = getRankTs(reqId); } catch (e) { out.rankTs = null; }
  return out;
}
function getReqPipeline(reqId, doRank) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var _ck = 'pipe_' + cacheVer_() + '_' + reqId;
  if (!doRank) { var _hit = cacheGet_(_ck); if (_hit) return _hit; }
  if (SB_ON_() && !doRank) {
    try {
      var _sc = sbGetReqPipeline_(reqId);
      if (_sc) {
        try { var _rr = cacheGet_('rankres_' + reqId); if (_rr) _sc.forEach(function (x) { var e = _rr[x.candId]; if (e) { x.match = e.m; x.over = !!e.o; x.comp = e.c || ''; } }); } catch (e) {}
        cachePut_(_ck, _sc, 600); return _sc;
      }
    } catch (e) {}
  }
  var tr = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Tracker').getDataRange().getValues(), c = [], cands = [];
  for (var i = 1; i < tr.length; i++) {
    if (!tr[i][1] || (tr[i][11] || '').toString() !== reqId.toString()) continue;
    var cid = (tr[i][30] || '').toString();
    var miss = []; if (!tr[i][2]) miss.push('email'); if (!tr[i][23]) miss.push('CTC'); if (!tr[i][22]) miss.push('notice'); if (!tr[i][29]) miss.push('gender');
    c.push({ candId: cid, name: tr[i][1], email: tr[i][2], stage: (tr[i][6] || 'New').toString(), score: tr[i][7] || '',
      company: tr[i][17] || '', exp: tr[i][19] || '', skills: tr[i][20] || '', ctc: tr[i][23] || '', notice: tr[i][22] || '', location: tr[i][13] || '', hasCv: !!tr[i][5], match: null, missing: miss });
    cands.push({ candId: cid, name: tr[i][1], title: (tr[i][18] || ''), company: (tr[i][17] || ''), exp: (tr[i][19] || ''), skills: (tr[i][20] || '').toString(), qual: (tr[i][21] || ''), ctc: (tr[i][24] || ''), highlights: (tr[i][36] || '').toString(), patents: (tr[i][38] || '').toString(), stage: (tr[i][6] || '').toString(), reqId: reqId });
  }
  // PERF FIX: do NOT run the AI ranking engine on every pipeline view — it took ~40s+ and, because
  // Apps Script serialises a user's calls, it blocked the whole app. Instead, MERGE rankings that were
  // computed earlier by "Refresh rankings" or "Stack rank" (saved below) — instant, no AI.
  try { var rr = cacheGet_('rankres_' + reqId); if (rr) c.forEach(function (x) { var e = rr[x.candId]; if (e) { x.match = e.m; x.over = !!e.o; x.comp = e.c || ''; } }); } catch (e) {}
  // Rank ONLY when explicitly requested (doRank=true), then persist for fast future views.
  if (doRank && cands.length) {
    try {
      var r = rankProfiles_(reqId, cands, false), map = {};
      if (!r.error) { // H-7: on AI failure keep the previous good scores instead of overwriting with nothing
        (r.ranked || []).forEach(function (x) { map[x.candId] = { m: x.score, o: !!x.over, c: x.comp || '' }; });
        c.forEach(function (x) { var e = map[x.candId]; if (e) { x.match = e.m; x.over = e.o; x.comp = e.c; } });
        try { cachePut_('rankres_' + reqId, map, 21600); } catch (e) {}
        setRankTs_(reqId);
      }
    } catch (e) {}
  }
  cachePut_(_ck, c, 600); return c;
}
// Explicit, on-demand ranking (used by "Refresh rankings"). Runs the AI engine once and persists
// results so every later pipeline open is instant.
function rankPipelineNow(reqId) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  try { getSuccessProfile(reqId, true); } catch (e) {}
  try { getReqPipeline(reqId, true); } catch (e) {}
  return true;
}
function getCandidateView(candId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var ss = SpreadsheetApp.openById(SHEET_ID), d = ss.getSheetByName('Tracker').getDataRange().getValues(), H = d[0], row = null;
  for (var i = 1; i < d.length; i++) if ((d[i][30] || '').toString() === candId) { row = d[i]; break; }
  if (!row) return { error: 'Candidate not found.' };
  var tz = Session.getScriptTimeZone();
  function clean(v) { if (v === '' || v == null) return ''; if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm'); return String(v); }
  var fields = {}; H.forEach(function (h, i) { var c = clean(row[i]); if (h && c !== '' && h !== 'Resume Link') fields[String(h)] = c; });
  var email = (row[2] || '').toString().toLowerCase(), fb = [];
  try {
    ss.getSheets().forEach(function (s) {
      if (s.getName().indexOf('Form Responses') !== 0) return;
      var fd = s.getDataRange().getValues(), fh = fd[0], ec = -1;
      for (var c = 0; c < fh.length; c++) if ((fh[c] || '').toString().toLowerCase().indexOf('candidate email') > -1) ec = c;
      for (var k = 1; k < fd.length; k++) if (ec > -1 && (fd[k][ec] || '').toString().toLowerCase() === email) {
        var o = {}; fh.forEach(function (hh, ci) { var cv = clean(fd[k][ci]); if (hh && cv !== '') o[String(hh)] = cv; }); fb.push(o);
      }
    });
  } catch (e) { /* feedback optional — never block the profile */ }
  var reqId = clean(row[11]), reqTitle = '';
  if (reqId) { try { var rq = ss.getSheetByName('Requisitions').getDataRange().getValues(); for (var z = 1; z < rq.length; z++) if ((rq[z][0] || '').toString() === reqId) { reqTitle = String(rq[z][1] || ''); break; } } catch (e) {} }
  return { name: clean(row[1]), email: clean(row[2]), resume: clean(row[5]), candId: clean(row[30]), reqId: reqId, reqTitle: reqTitle, fields: fields, feedback: fb };
}
function searchSuggest(q) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  q = (q || '').toString().trim().toLowerCase(); if (q.length < 2) return [];
  var ss = SpreadsheetApp.openById(SHEET_ID), out = [];
  var rs = ss.getSheetByName('Requisitions');
  if (rs) { var rd = rs.getDataRange().getValues(); for (var i = 1; i < rd.length && out.length < 12; i++) { if (!rd[i][0]) continue; var t = (String(rd[i][0]) + ' ' + String(rd[i][1]) + ' ' + String(rd[i][3]) + ' ' + String(rd[i][7])).toLowerCase(); if (t.indexOf(q) > -1) out.push({ type: 'req', id: String(rd[i][0]), label: String(rd[i][0]) + ' — ' + String(rd[i][1] || ''), sub: 'Requisition · HM ' + String(rd[i][7] || '') }); } }
  var tr = ss.getSheetByName('Tracker');
  if (tr) { var td = tr.getDataRange().getValues(); for (var j = 1; j < td.length && out.length < 22; j++) { if (!td[j][1]) continue; var n = (String(td[j][1]) + ' ' + String(td[j][2]) + ' ' + String(td[j][12]) + ' ' + String(td[j][13])).toLowerCase(); if (n.indexOf(q) > -1) out.push({ type: 'cand', id: String(td[j][30] || ''), reqId: String(td[j][11] || ''), label: String(td[j][1] || ''), sub: 'Candidate · ' + String(td[j][6] || 'New') + (td[j][17] ? ' · ' + String(td[j][17]) : '') }); } }
  return out.slice(0, 10);
}
function getCandidateFull(candId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var v = getCandidateView(candId);
  if (v.error) return v;
  try { v.interviews = getInterviews(candId); } catch (e) { v.interviews = []; }
  try { v.audit = getAudit_(candId); } catch (e) { v.audit = []; }
  try { v.appFeedback = getInterviewFeedback_(candId); } catch (e) { v.appFeedback = []; }
  return v;
}
function aiBrief(candId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return _g.error; // C-1: server-side auth
  var d = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Tracker').getDataRange().getValues();
  for (var i = 1; i < d.length; i++) if ((d[i][30] || '').toString() === candId)
    return candidateStory({ email: (d[i][2] || '').toString(), name: d[i][1] });
  return 'Candidate not found.';
}

// ---------- INTERVIEW SCHEDULING (multi-interviewer + RSVP tracking, Prelude-style) ----------
function scheduleInterview2(o) {
  var u = currentUser_(arguments);
  if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins can schedule.';
  var ss = SpreadsheetApp.openById(SHEET_ID), tr = ss.getSheetByName('Tracker'), d = tr.getDataRange().getValues(), row = -1;
  for (var i = 1; i < d.length; i++) if ((d[i][30] || '').toString() === o.candId) { row = i; break; }
  if (row < 0) return 'Candidate not found.';
  var cand = d[row], email = (cand[2] || '').toString(), reqId = (cand[11] || '').toString();
  var start = new Date(o.datetime); if (isNaN(start.getTime())) return 'I could not read that date/time.';
  var end = new Date(start.getTime() + 45 * 60000);
  var interviewers = (o.interviewers || '').split(/[,;\s]+/).filter(function (x) { return x.indexOf('@') > -1; });
  var guests = [email].concat(interviewers).filter(Boolean).map(function (e) { return { email: e }; });
  var ev = Calendar.Events.insert({
    summary: (o.stage || 'Interview') + ': ' + cand[1], description: 'AgentATS interview.',
    start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, attendees: guests,
    conferenceData: { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
  }, 'primary', { conferenceDataVersion: 1, sendUpdates: 'all' });
  var meet = ev.hangoutLink || '';
  var ish = ss.getSheetByName('Interviews') || ss.insertSheet('Interviews');
  if (ish.getLastRow() === 0) ish.appendRow(['Interview ID','Candidate ID','Candidate Name','Req ID','Stage','Interviewers','Date/Time','Event ID','Meet Link','Status']);
  // L-3 FIX: interview IDs come from a persistent counter under the script lock (was
  // 'INT-' + lastRow, which COLLIDES after any row deletion). Self-seeds from the sheet.
  var iid = withScriptLock_(function () {
    var pp = PropertiesService.getScriptProperties();
    var n = parseInt(pp.getProperty('INT_SEQ') || '0', 10);
    if (!n) n = Math.max(0, ish.getLastRow() - 1); // seed once from existing rows
    n++; pp.setProperty('INT_SEQ', String(n));
    return 'INT-' + ('000' + n).slice(-3);
  });
  ish.appendRow(sanitizeRow_([iid, o.candId, cand[1], reqId, o.stage || 'Interview', interviewers.join(', '),
    Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'), ev.id, meet, 'Scheduled'])); // C-2
  tr.getRange(row + 1, 7).setValue('Interview Scheduled');
  recordStage_(o.candId, cand[1], 'Interview Scheduled');
  notifyChat_('📅 Interview scheduled — ' + cand[1] + ' (' + (o.stage || 'Interview') + ') on ' + start.toLocaleString());
  var prep = '';
  if (o.prepPack && email) { try { sendPrepPack_(email, cand[1], reqId, o.stage || 'interview'); prep = ' · prep pack emailed to candidate'; } catch (e) {} }
  return '✅ ' + (o.stage || 'Interview') + ' scheduled for ' + cand[1] + ' on ' + start.toLocaleString() +
    (meet ? '. Meet: ' + meet : '') + '. Invites sent to ' + guests.length + ' people.' + prep;
}
function sendPrepPack_(email, name, reqId, stage) {
  if (!email) return;
  var jd = String(reqJDText_(reqId) || ''), title = '';
  try { var rq = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions').getDataRange().getValues(); for (var i = 1; i < rq.length; i++) if ((rq[i][0] || '').toString() === (reqId || '').toString()) { title = rq[i][1]; break; } } catch (e) {}
  var body;
  try {
    body = callGemini('Write a warm, professional interview-prep email to a candidate named ' + (name || 'there') + ' for the "' + stage + '" round of the ' + (title || 'role') + ' position. ' +
      'Role context: ' + jd.slice(0, 1200) + '. Include: a friendly greeting, what to expect in this round (format and focus areas), 3-5 concrete preparation tips, logistics reminder to watch for the calendar invite, and an encouraging close. ' +
      'Do NOT include any internal scoring rubric or confidential details. Plain text, ready to send, sign off as "The Recruiting Team".', false);
  } catch (e) {
    body = 'Hi ' + (name || 'there') + ',\n\nLooking forward to your upcoming ' + stage + ' interview for the ' + (title || 'role') + '. Please watch for the calendar invite with the joining link.\n\nBest,\nThe Recruiting Team';
  }
  // Attach candidate-appropriate prep materials from the requisition's Calibration Kit (case studies / take-homes only — never internal scorecards/references).
  var attachments = [], names = [];
  try {
    var cal = getCalibration(reqId);
    (cal && cal.files || []).forEach(function (f) {
      var k = (f.kind || '').toLowerCase();
      if ((k === 'case-study' || k === 'take-home') && attachments.length < 5) {
        try { var id = extractFileId_(f.url); if (id) { attachments.push(DriveApp.getFileById(id).getBlob()); names.push(f.name); } } catch (e) {}
      }
    });
  } catch (e) {}
  if (names.length) body += '\n\nAttached for your preparation: ' + names.join(', ') + '.';
  var opts = attachments.length ? { attachments: attachments } : {};
  GmailApp.sendEmail(email, 'Your upcoming ' + (stage || 'interview') + ' — ' + (title || 'role') + ' prep', body, opts);
}
function draftCandidateEmail(candId, kind) {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return { error: 'Candidate not found.' };
  var name = sh.getRange(row, 2).getValue(), email = (sh.getRange(row, 3).getValue() || '').toString(), reqId = (sh.getRange(row, 12).getValue() || '').toString(), title = '';
  try { var rq = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions').getDataRange().getValues(); for (var i = 1; i < rq.length; i++) if ((rq[i][0] || '').toString() === reqId) { title = rq[i][1]; break; } } catch (e) {}
  var tone = { advance: 'invite them to the next interview round, positive and encouraging', reject: 'politely decline, warm and respectful, leave the door open for future roles, do NOT give detailed reasons', offer: 'congratulate them and let them know an offer is coming, that a formal offer letter will follow, enthusiastic', thanks: 'thank them for interviewing and let them know the team is reviewing and will follow up soon' };
  var ask = tone[kind] || 'a professional update';
  var j = {};
  try { j = JSON.parse(callGemini('Write a concise, warm, professional recruiting email to candidate ' + name + ' regarding the ' + (title || 'role') + ' position. Purpose: ' + ask + '. Return ONLY JSON: {"subject":"","body":""}. body in plain text, use the actual name (no [placeholders]), sign off as "The Recruiting Team".', true)); }
  catch (e) { return { error: e.message }; }
  return { subject: j.subject || ((title || 'Your application') + ' — update'), body: j.body || '', email: email };
}
function sendCandidateEmail(candId, subject, body) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins.';
  var sh = trackerSheet_(), row = findRowById_(sh, candId); if (row < 0) return 'Candidate not found.';
  var email = (sh.getRange(row, 3).getValue() || '').toString(); if (!email) return 'No candidate email on file.';
  try { GmailApp.sendEmail(email, subject || 'Update on your application', body || ''); } catch (e) { return '⚠️ ' + e.message; }
  logAudit_(candId, 'Email sent to candidate: ' + (subject || ''));
  return '✅ Email sent to ' + email + '.';
}
function getInterviews(candId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var ss = SpreadsheetApp.openById(SHEET_ID), ish = ss.getSheetByName('Interviews'); if (!ish) return [];
  var d = ish.getDataRange().getValues(), out = [], tz = Session.getScriptTimeZone();
  function cl(v) { if (v == null) return ''; if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm'); return String(v); }
  for (var i = 1; i < d.length; i++) {
    if ((d[i][1] || '').toString() !== candId) continue;
    out.push({ id: cl(d[i][0]), stage: cl(d[i][4]), interviewers: cl(d[i][5]), when: cl(d[i][6]), eventId: cl(d[i][7]), meet: cl(d[i][8]), status: cl(d[i][9]) });
  }
  return out;
}
function checkRsvp(eventId) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return _g.error; // C-1: server-side auth
  try {
    var ev = Calendar.Events.get('primary', eventId), r = [];
    (ev.attendees || []).forEach(function (a) { if (a.email) r.push(a.email.split('@')[0] + ': ' + (a.responseStatus || 'pending')); });
    return r.join(', ') || 'no attendees';
  } catch (e) { return 'status unavailable'; }
}
function checkAvailability(interviewers, datetime) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var start = new Date(datetime); if (isNaN(start.getTime())) return { error: 'Enter a valid date & time first.' };
  var end = new Date(start.getTime() + 45 * 60000);
  var ids = (interviewers || '').split(/[,;\s]+/).filter(function (x) { return x.indexOf('@') > -1; });
  if (!ids.length) return { results: [] };
  var resp;
  try { resp = Calendar.Freebusy.query({ timeMin: start.toISOString(), timeMax: end.toISOString(), items: ids.map(function (e) { return { id: e }; }) }); }
  catch (e) { return { error: 'Availability needs interviewers in your Google Workspace (shared calendars): ' + e.message }; }
  var cals = resp.calendars || {}, out = [];
  ids.forEach(function (e) { var busy = (cals[e] && cals[e].busy) || []; out.push({ email: e, free: busy.length === 0 }); });
  return { results: out };
}
function freeSlots(interviewers, durationMin, fromDate, toDate) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error }; // C-1: server-side auth
  var ids = (interviewers || '').split(/[,;\s]+/).filter(function (x) { return x.indexOf('@') > -1; });
  if (!ids.length) return { error: 'Add interviewer email(s) first.' };
  var oc = orgContext_(), dur = durationMin || oc.slotMin || 60, tz = Session.getScriptTimeZone(), now = new Date();
  var start = fromDate ? new Date(fromDate + 'T00:00:00') : new Date(now.getTime() + 60 * 60000);
  if (isNaN(start.getTime()) || start.getTime() < now.getTime()) start = new Date(now.getTime() + 60 * 60000);
  var end = toDate ? new Date(toDate + 'T23:59:59') : new Date(start.getTime() + 9 * 86400000);
  if (isNaN(end.getTime()) || end.getTime() <= start.getTime()) end = new Date(start.getTime() + 9 * 86400000);
  if (end.getTime() - start.getTime() > 31 * 86400000) end = new Date(start.getTime() + 31 * 86400000); // cap 31 days
  var busy = [], note = '';
  try {
    var resp = Calendar.Freebusy.query({ timeMin: start.toISOString(), timeMax: end.toISOString(), items: ids.map(function (e) { return { id: e }; }) });
    var cals = resp.calendars || {}, unreadable = 0;
    ids.forEach(function (e) { var c = cals[e]; if (c && c.errors) unreadable++; ((c && c.busy) || []).forEach(function (b) { busy.push([new Date(b.start).getTime(), new Date(b.end).getTime()]); }); });
    if (unreadable) note = unreadable + ' interviewer calendar(s) couldn\'t be read (outside your Workspace) — those are assumed free, please confirm.';
  } catch (e) {
    note = 'Couldn\'t read calendars (interviewers may be outside your Workspace) — showing all work-hour slots; confirm availability manually.';
  }
  function isFree(s, e) { for (var i = 0; i < busy.length; i++) if (s < busy[i][1] && e > busy[i][0]) return false; return true; }
  // H-6 FIX: work hours come from the Company settings (ORG_WS / ORG_WE) instead of a
  // hardcoded 9–18. (Slot length already falls back to ORG_SLOT via `dur` above now that the
  // client passes null instead of a hardcoded 60.) Sanity-clamped so a bad setting can't
  // produce an empty or inverted day.
  var WORK_START = Math.max(0, Math.min(23, oc.workStart || 9));
  var WORK_END = Math.max(1, Math.min(24, oc.workEnd || 18));
  if (WORK_END <= WORK_START) { WORK_START = 9; WORK_END = 18; }
  var slots = [], days = Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1;
  for (var d = 0; d < days && slots.length < 30; d++) {
    var day = new Date(start.getTime() + d * 86400000), dow = day.getDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    for (var h = WORK_START; h < WORK_END && slots.length < 30; h++) {
      for (var m = 0; m < 60; m += 30) {
        var s = new Date(day); s.setHours(h, m, 0, 0);
        if (s.getTime() < start.getTime() || s.getTime() > end.getTime()) continue;
        var e2 = new Date(s.getTime() + dur * 60000);
        if (e2.getHours() > WORK_END || (e2.getHours() === WORK_END && e2.getMinutes() > 0)) continue;
        if (isFree(s.getTime(), e2.getTime())) slots.push({ iso: Utilities.formatDate(s, tz, "yyyy-MM-dd'T'HH:mm"), day: Utilities.formatDate(s, tz, 'EEE d MMM'), time: Utilities.formatDate(s, tz, 'h:mm a') });
        if (slots.length >= 30) break;
      }
    }
  }
  return { slots: slots, note: note, interviewers: ids.length, workStart: WORK_START, workEnd: WORK_END, slotMin: dur }; // H-6: tell the UI which settings were used
}
function rescheduleInterview(interviewId, newDatetime) {
  var u = currentUser_(arguments); if (u.role !== 'Admin' && u.role !== 'Recruiter') return '🔒 Only recruiters/admins can reschedule.';
  var ish = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Interviews'); if (!ish) return 'No interviews.';
  var d = ish.getDataRange().getValues();
  for (var i = 1; i < d.length; i++) {
    if ((d[i][0] || '').toString() !== interviewId) continue;
    var start = new Date(newDatetime); if (isNaN(start.getTime())) return 'Enter a valid date & time.';
    var end = new Date(start.getTime() + 45 * 60000);
    try { Calendar.Events.patch({ start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } }, 'primary', d[i][7], { sendUpdates: 'all' }); }
    catch (e) { return 'Couldn\'t update the calendar event: ' + e.message; }
    ish.getRange(i + 1, 7).setValue(Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'));
    ish.getRange(i + 1, 10).setValue('Rescheduled');
    // M-9 FIX: keep the Tracker's interview-date column (col 10) in sync — it used to go stale on reschedule.
    try { var trs = trackerSheet_(), trow = findRowById_(trs, (d[i][1] || '').toString()); if (trow > 0) trs.getRange(trow, 10).setValue(Utilities.formatDate(start, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')); } catch (e) {}
    return '✅ ' + interviewId + ' rescheduled to ' + start.toLocaleString() + ' — updated invites sent to everyone.';
  }
  return 'Interview not found.';
}

// ---------- RECRUITER DAILY DIGEST (give this a daily trigger) ----------
function dailyDigest() {
  var ss = SpreadsheetApp.openById(SHEET_ID), t = ss.getSheetByName('Tracker').getDataRange().getValues();
  var since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  var newC = [], stages = {}, needAction = [];
  for (var i = 1; i < t.length; i++) {
    if (!t[i][1]) continue;
    var stage = (t[i][6] || 'New').toString(), sl = stage.toLowerCase();
    stages[stage] = (stages[stage] || 0) + 1;
    var dt = t[i][0] instanceof Date ? t[i][0] : new Date(t[i][0]);
    if (dt && dt >= since) newC.push(t[i][1] + (t[i][3] ? ' — ' + t[i][3] : ''));
    if (sl === 'new' || sl === 'shortlist') needAction.push(t[i][1] + ' (' + stage + ')');
  }
  var summary = Object.keys(stages).map(function (k) { return k + ': ' + stages[k]; }).join(', ') || 'none';
  var html = '<h2>AgentATS — Daily Digest</h2>' +
    '<p><b>🆕 New in last 24h:</b> ' + (newC.length ? newC.join(', ') : 'none') + '</p>' +
    '<p><b>📊 Pipeline:</b> ' + summary + '</p>' +
    '<p><b>⏳ Waiting on you (New / Shortlist):</b> ' + (needAction.length ? needAction.slice(0, 25).join(', ') : 'none') + '</p>' +
    '<p style="color:#888;font-size:12px">Sent automatically by AgentATS.</p>';
  var users = ss.getSheetByName('Users').getDataRange().getValues();
  for (var u = 1; u < users.length; u++) {
    var role = (users[u][2] || '').toString(), active = (users[u][3] || '').toString().toLowerCase();
    if ((role === 'Admin' || role === 'Recruiter') && active !== 'no' && users[u][0])
      MailApp.sendEmail({ to: users[u][0], subject: 'Your AgentATS daily digest', htmlBody: html });
  }
  return 'Digest sent.';
}

// ---------- PUBLIC CAREERS FORM ----------
function listOpenReqs() {
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('Requisitions');
  if (!sh) return [];
  var d = sh.getDataRange().getValues(), out = [];
  for (var i = 1; i < d.length; i++) if (d[i][0] && (d[i][13] || '').toString().toLowerCase() === 'open') out.push({ id: d[i][0], label: (d[i][1] || '') + (d[i][4] ? ' — ' + d[i][4] : '') });
  return out;
}
// L-8 FIX (part 2): CVs used to pile up in ONE flat Drive folder. Careers-page resumes now go
// into a per-requisition subfolder ("REQ-0007", or "Unassigned") inside the app folder. The
// full file URL is still stored on the row, so nothing downstream changes.
function cvFolderForReq_(reqId) {
  var root = DriveApp.getFolderById(FOLDER_ID);
  try {
    var name = (reqId || '').toString().trim() || 'Unassigned';
    var it = root.getFoldersByName(name);
    return it.hasNext() ? it.next() : root.createFolder(name);
  } catch (e) { return root; } // never fail an applicant on a Drive hiccup
}
function submitApplication(o) {
  if (o.website) return 'OK';
  if (!o.name || !o.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) return 'ERR:Enter a valid name and email.';
  if (!o.resumeB64) return 'ERR:Resume required.';
  if (o.resumeB64.length * 0.75 > MAX_RESUME_MB * 1024 * 1024) return 'ERR:Resume too large (max ' + MAX_RESUME_MB + 'MB).';
  if (!/pdf|msword|officedocument|wordprocessing/.test((o.resumeType || '').toLowerCase())) return 'ERR:Please upload a PDF or Word file.';
  var props = PropertiesService.getScriptProperties();
  var dayKey = 'APPLY_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  var count = parseInt(props.getProperty(dayKey) || '0', 10);
  if (count >= APPLY_DAILY_CAP) return 'ERR:High volume today — please try again tomorrow.';
  var cache = CacheService.getScriptCache(), ek = 'apl_' + o.email.toLowerCase();
  if (cache.get(ek)) return 'ERR:We already have your application — thank you!';
  var sheet = trackerSheet_(), d = sheet.getDataRange().getValues();
  // H-8 FIX: a repeat application (same email) is no longer silently swallowed. We save the
  // NEW resume, update the existing row's resume link + Req ID, and note the re-application,
  // so a past applicant re-applying to a new opening is actually seen by the recruiter.
  for (var i = 1; i < d.length; i++) {
    if ((d[i][2] || '').toString().toLowerCase() !== o.email.toLowerCase()) continue;
    try {
      var rurl = cvFolderForReq_(o.reqId).createFile(Utilities.newBlob(Utilities.base64Decode(o.resumeB64), o.resumeType || 'application/pdf', o.resumeName || 'resume')).getUrl(); // L-8: per-req subfolder
      var rrow = i + 1, candId = (d[i][30] || '').toString();
      sheet.getRange(rrow, 6).setValue(rurl); // latest resume
      if (o.reqId) sheet.getRange(rrow, 12).setValue(sanitizeCell_(o.reqId)); // latest role applied for
      var noteCell = sheet.getRange(rrow, 9), oldNote = (noteCell.getValue() || '').toString();
      noteCell.setValue(sanitizeCell_((oldNote ? oldNote + ' | ' : '') + 'Re-applied ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd MMM yyyy') + (o.reqId ? ' for ' + o.reqId : '') + ' (new resume attached)'));
      if (candId) { try { logAudit_(candId, 'Re-applied via careers page' + (o.reqId ? ' for ' + o.reqId : '') + ' — resume updated'); } catch (e) {} }
      bustCache_();
      notifyChat_('🔁 Repeat applicant: ' + (d[i][1] || o.name) + (o.reqId ? ' for ' + o.reqId : '') + ' (via careers page — record updated)');
    } catch (e) {} // never fail the applicant-facing page on a bookkeeping error
    cache.put(ek, '1', 21600);
    return 'OK';
  }
  var url = cvFolderForReq_(o.reqId).createFile(Utilities.newBlob(Utilities.base64Decode(o.resumeB64), o.resumeType || 'application/pdf', o.resumeName || 'resume')).getUrl(); // L-8: per-req subfolder
  var r = withScriptLock_(function () { // H-1: atomic append + ID mint (public endpoint races the hourly trigger)
    sheet.appendRow(sanitizeRow_([new Date(), o.name, o.email, '', 'Careers Page', url, 'New', '', '', '', ''])); // C-2: public form
    var rr = sheet.getLastRow();
    sheet.getRange(rr, 31).setValue(nextCandidateId_());
    // L-4 FIX: the daily-cap counter is incremented inside the lock so concurrent submissions
    // can't lose increments. (The read at the top stays lock-free — it's a soft cap by design.)
    props.setProperty(dayKey, String(parseInt(props.getProperty(dayKey) || '0', 10) + 1));
    return rr;
  });
  if (o.phone) sheet.getRange(r, 13).setValue(sanitizeCell_(o.phone));
  if (o.location) sheet.getRange(r, 14).setValue(sanitizeCell_(o.location));
  if (o.reqId) sheet.getRange(r, 12).setValue(sanitizeCell_(o.reqId));
  cache.put(ek, '1', 21600);
  // L-4 FIX: APPLY_yyyymmdd keys used to accumulate forever. On the first application of each
  // day, delete every stale APPLY_* key from previous days.
  if (count === 0) { try { props.getKeys().forEach(function (k) { if (k.indexOf('APPLY_') === 0 && k !== dayKey) props.deleteProperty(k); }); } catch (e) {} }
  bustCache_(); // M-3: applicants must appear on the board/pipeline without waiting out the cache TTL
  try { if (props.getProperty('ORG_ACK') !== '0') sendAck_(o.email, o.name); } catch (e) {}
  notifyChat_('📥 New applicant: ' + o.name + (o.reqId ? ' for ' + o.reqId : '') + ' (via careers page)');
  return 'OK';
}
// L-9: notifications can embed attacker-controlled text (public-form names, email subjects).
// Neutralize it before relaying to Chat/Gmail: strip control chars + newlines, defang URLs
// (no clickable phishing links in recruiter alerts), cap the length.
function safeNotifyText_(s, max) {
  s = (s == null ? '' : String(s)).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/https?:\/\//gi, 'hxxp://');
  return s.slice(0, max || 300);
}
function notifyChat_(text) {
  if (!text) return;
  text = safeNotifyText_(text, 300); // L-9
  var p = PropertiesService.getScriptProperties();
  try { var url = p.getProperty('CHAT_WEBHOOK'); if (url) UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ text: text }), muteHttpExceptions: true }); } catch (e) {}
  try { var em = p.getProperty('ORG_ALERT_EMAIL'); if (em) GmailApp.sendEmail(em, '🔔 AgentATS: ' + text.slice(0, 70), text); } catch (e) {}
}
function testChatNotify() {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return _g.error; // C-1: server-side auth
  var p = PropertiesService.getScriptProperties(), url = p.getProperty('CHAT_WEBHOOK'), em = p.getProperty('ORG_ALERT_EMAIL');
  if (!url && !em) return '⚠️ Add a Google Chat webhook OR an alerts email in 🏢 Company first.';
  notifyChat_('✅ AgentATS test notification — alerts are connected.');
  return '✅ Test sent' + (url ? ' to Google Chat' : '') + (em ? ((url ? ' and to ' : ' to ') + em) : '') + '.';
}
function sendAck_(email, name) {
  if (!email) return;
  name = safeNotifyText_(name, 60); // L-9: applicant-controlled — keep the ack email un-spoofable (no links/newlines)
  var org = orgContext_(), co = org.company ? ' to ' + org.company : '';
  try {
    GmailApp.sendEmail(email, 'We received your application' + (org.company ? ' — ' + org.company : ''),
      'Hi ' + (name || 'there') + ',\n\nThank you for your application' + co + '. We\'ve received it and our team will review your profile and get back to you. ' +
      'If there\'s a fit, a recruiter will reach out with next steps.\n\nWarm regards,\nThe Recruiting Team');
  } catch (e) {}
}
