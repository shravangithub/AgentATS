/***** AgentATS — Speed.gs (optional, recommended) *****/
// Makes the app open faster. Add it as one more Script file next to Code.gs.
// The app still works without it: Index.html falls back to its older startup.
//
// 1. bootstrap(): ONE server call at startup instead of four or five.
// 2. keepWarm(): an optional timer that keeps Google's copy of the app awake, so the
//    first screen after a quiet spell opens faster. Turn it on once by running
//    installKeepWarm from the editor's Run menu; turn it off with removeKeepWarm.

// Everything the first screen needs, in one round trip. Each part is fetched by the
// normal (permission-checked) function, so a role sees exactly what it saw before.
function bootstrap(scopeEmail) {
  var _g = guard_(arguments, 'Interviewer'); if (_g.error) return { error: _g.error };
  var tok = extractToken_(arguments), mark = TOKEN_MARK_ + tok, out = {};
  try { out.org = getOrgContext(mark); } catch (e) { out.org = { error: String(e && e.message || e) }; }
  try { out.settings = getSettings(); } catch (e) { out.settings = null; }
  try { out.me = tok ? whoAmI(tok) : null; } catch (e) { out.me = null; }
  try { out.today = getToday(scopeEmail || '', mark); } catch (e) { out.today = { error: String(e && e.message || e) }; }
  try { out.board = getReqBoard(scopeEmail || '', mark); } catch (e) { out.board = { error: String(e && e.message || e) }; }
  return out;
}

// Runs on a timer. Only does work when a real trigger of this project fires it, so it
// can't be used from the web page to burn your quota.
function keepWarm(e) {
  try {
    var uid = e && e.triggerUid; if (!uid) return;
    var mine = ScriptApp.getProjectTriggers().some(function (t) { return t.getUniqueId() === String(uid); });
    if (!mine) return;
  } catch (err) { return; }
  try { SpreadsheetApp.openById(SHEET_ID).getSheets()[0].getLastRow(); } catch (err) {}
  try { getToday(''); } catch (err) {}      // also refreshes the server-side cache when allowed
  try { getReqBoard(''); } catch (err) {}
}

// Run once from the editor (Run ▸ installKeepWarm). Uses about 5–10 minutes of the
// 90-minute daily trigger allowance on a free Google account.
function installKeepWarm() {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return _g.error;
  removeKeepWarm_();
  ScriptApp.newTrigger('keepWarm').timeBased().everyMinutes(5).create();
  return '✅ Keep-warm is on: AgentATS wakes every 5 minutes so screens open faster.';
}
function removeKeepWarm() {
  var _g = guard_(arguments, 'Recruiter'); if (_g.error) return _g.error;
  removeKeepWarm_();
  return 'Keep-warm is off.';
}
function removeKeepWarm_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'keepWarm') ScriptApp.deleteTrigger(t);
  });
}
