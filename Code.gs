/* ============================================================
   NPD QA AXO Tracker — Google Apps Script backend
   ------------------------------------------------------------
   Container-bound to its OWN Google Sheet (Extensions > Apps Script).
   Fully separate from the NPD QA Endorsement Tracker.

   Data (tabs are created on first use):
     • AXOs     — one row per AXO, fed from #axo-assignments
     • Updates  — one row per QA update on an AXO (history kept)
     • QAs      — the QA name list for the "Who are you?" picker

   Ingestion (both paths go through Parser.gs → upsertAxos_):
     • syncSlack()    — time trigger, Slack conversations.history
     • apiPasteAxo()  — "Paste AXO" box in the web app

   Script Properties (Project Settings > Script Properties):
     • SLACK_USER_TOKEN   xoxp-… user token (scopes: groups:history,
                          optional users:read to show names not IDs)
     • SLACK_CHANNEL_ID   ID of #axo-assignments (starts with C or G)
     • SLACK_REPLY_WINDOW_DAYS  days to re-scan for late assignee
                          replies (default 3)
     • SLACK_LAST_TS      auto-managed; clear it to re-scan
   ============================================================ */

var BUILD = '2026-11-13.1';
var TZ = 'Asia/Manila';

var AXO_SHEET = 'AXOs';
var AXO_HEADERS = ['AxoNumber', 'Title', 'Priority', 'Link', 'AdditionalInfo', 'RaisedBy',
  'DueDate', 'DueDateRaw', 'Client', 'TicketNumber', 'DevAssignees', 'Source', 'SlackTs',
  'PostedAt', 'State', 'ClosedAt', 'CreatedAt', 'UpdatedAt'];

var UPDATE_SHEET = 'Updates';
var UPDATE_HEADERS = ['Id', 'AxoNumber', 'QA', 'ShiftDate', 'Shift', 'Status', 'Notes',
  'Files', 'CreatedAt', 'UpdatedAt'];

var QA_SHEET = 'QAs';
var QA_HEADERS = ['Name', 'Active'];

var SHIFTS = ['Day', 'Mid', 'Night'];
var STATUSES = ['Not Tested', 'In Progress', 'Passed - Initial', 'Passed - Develop/Deployment',
  'Failed - Initial', 'Failed - Develop/Deployment', 'Needs Monitoring', 'Urgent/High Prio', 'Blocked'];
/* An update with one of these statuses closes the AXO (Reopen undoes it). */
var AUTO_CLOSE_STATUSES = ['Passed - Develop/Deployment'];

/* ============================================================
   WEB APP
   ============================================================ */
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('NPD QA AXO Tracker')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* Adds an "AXO Tracker" menu to the bound Sheet for the one-time setup steps. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('AXO Tracker')
    .addItem('Set up tabs', 'setupSheets')
    .addItem('Test Slack connection', 'testSlackConnection')
    .addItem('Import last 30 days from Slack', 'backfillSlack')
    .addItem('Start auto-sync (every 5 min)', 'setupSlackSync')
    .addItem('Sync now', 'syncSlack')
    .addToUi();
}

/* Creates the AXOs, Updates and QAs tabs. Safe to re-run. */
function setupSheets() {
  sheet_(AXO_SHEET, AXO_HEADERS);
  sheet_(UPDATE_SHEET, UPDATE_HEADERS);
  sheet_(QA_SHEET, QA_HEADERS);
}

/* ============================================================
   SHEETS
   ============================================================ */
function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    // Plain text everywhere so AXO numbers, dates and ticket IDs are never coerced.
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  }
  var first = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  if (first.join('|') !== headers.join('|') && (sh.getLastRow() === 0 || !first[0])) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readRows_(name, headers) {
  var sh = sheet_(name, headers);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, headers.length).getValues().map(function (row, i) {
    var o = { _row: i + 2 };
    headers.forEach(function (h, j) {
      var v = row[j];
      if (Object.prototype.toString.call(v) === '[object Date]') v = Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
      o[h] = v === null || v === undefined ? '' : String(v);
    });
    return o;
  });
}

function rowValues_(obj, headers) {
  return headers.map(function (h) { return obj[h] == null ? '' : obj[h]; });
}

function nowIso_() { return new Date().toISOString(); }

/* ---------- AXO model <-> row ---------- */
function axoFromRow_(r) {
  var devs = [];
  try { devs = JSON.parse(r.DevAssignees || '[]'); } catch (e) { devs = r.DevAssignees ? [r.DevAssignees] : []; }
  return {
    axoNumber: r.AxoNumber, title: r.Title, priority: r.Priority, link: r.Link,
    additionalInfo: r.AdditionalInfo, raisedBy: r.RaisedBy, dueDate: r.DueDate,
    dueDateRaw: r.DueDateRaw, client: r.Client, ticketNumber: r.TicketNumber,
    devAssignees: devs, source: r.Source, slackTs: r.SlackTs, postedAt: r.PostedAt,
    state: r.State || 'Active', closedAt: r.ClosedAt, createdAt: r.CreatedAt, updatedAt: r.UpdatedAt
  };
}

function axoToRow_(a) {
  return {
    AxoNumber: a.axoNumber, Title: a.title, Priority: a.priority, Link: a.link,
    AdditionalInfo: a.additionalInfo, RaisedBy: a.raisedBy, DueDate: a.dueDate,
    DueDateRaw: a.dueDateRaw, Client: a.client, TicketNumber: a.ticketNumber,
    DevAssignees: JSON.stringify(a.devAssignees || []), Source: a.source, SlackTs: a.slackTs,
    PostedAt: a.postedAt, State: a.state || 'Active', ClosedAt: a.closedAt || '',
    CreatedAt: a.createdAt, UpdatedAt: a.updatedAt
  };
}

/* Insert new AXOs and merge into existing ones, de-duped by AXO number.
   QA-owned fields (State, ClosedAt) are never touched by ingestion.
   Returns { added: [...numbers], updated: [...numbers] }. */
function upsertAxos_(incoming, source) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_(AXO_SHEET, AXO_HEADERS);
    var rows = readRows_(AXO_SHEET, AXO_HEADERS);
    var byNum = {};
    rows.forEach(function (r) { byNum[r.AxoNumber] = r; });
    var added = [], updated = [], appends = [];
    var now = nowIso_();

    incoming.forEach(function (inc) {
      if (!inc || !inc.axoNumber) return;
      var existingRow = byNum[inc.axoNumber];
      if (existingRow) {
        var before = axoFromRow_(existingRow);
        var merged = mergeAxo(before, inc);
        merged.state = before.state; merged.closedAt = before.closedAt;
        merged.source = before.source; merged.createdAt = before.createdAt;
        merged.slackTs = before.slackTs || inc.slackTs || '';
        merged.postedAt = before.postedAt || inc.postedAt || '';
        if (JSON.stringify(axoToRow_(merged)) === JSON.stringify(axoToRow_(before))) return;
        merged.updatedAt = now;
        sh.getRange(existingRow._row, 1, 1, AXO_HEADERS.length)
          .setValues([rowValues_(axoToRow_(merged), AXO_HEADERS)]);
        byNum[inc.axoNumber] = Object.assign({ _row: existingRow._row }, axoToRow_(merged));
        updated.push(inc.axoNumber);
      } else {
        var fresh = mergeAxo({}, inc);
        fresh.source = source; fresh.state = 'Active';
        fresh.createdAt = now; fresh.updatedAt = now;
        var row = axoToRow_(fresh);
        byNum[inc.axoNumber] = row; // de-dupe within this batch too
        appends.push(row);
        added.push(inc.axoNumber);
      }
    });

    if (appends.length) {
      var start = sh.getLastRow() + 1;
      sh.getRange(start, 1, appends.length, AXO_HEADERS.length)
        .setNumberFormat('@')
        .setValues(appends.map(function (r) { return rowValues_(r, AXO_HEADERS); }));
      appends.forEach(function (r, i) { r._row = start + i; });
    }
    return { added: added, updated: updated };
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   SLACK SYNC (user token, read-only)
   ============================================================ */
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function setProp_(k, v) { PropertiesService.getScriptProperties().setProperty(k, String(v)); }

function slackApi_(method, params) {
  var token = prop_('SLACK_USER_TOKEN');
  if (!token) throw new Error('SLACK_USER_TOKEN is not set in Script Properties.');
  var qs = Object.keys(params || {}).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  for (var attempt = 0; attempt < 3; attempt++) {
    var res = UrlFetchApp.fetch('https://slack.com/api/' + method + (qs ? '?' + qs : ''), {
      method: 'get', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token }
    });
    if (res.getResponseCode() === 429) {
      var wait = Number(res.getHeaders()['Retry-After'] || 5);
      Utilities.sleep(Math.min(wait, 30) * 1000);
      continue;
    }
    var body = JSON.parse(res.getContentText() || '{}');
    if (!body.ok) throw new Error('Slack ' + method + ' failed: ' + (body.error || res.getResponseCode()));
    return body;
  }
  throw new Error('Slack ' + method + ' kept rate-limiting; will retry next run.');
}

/* Map Slack user IDs to display names. Needs users:read; without it
   IDs stay as-is and nothing breaks. Cached for 6 hours. */
function userNames_(ids) {
  var cache = CacheService.getScriptCache();
  var out = {};
  ids.forEach(function (id) {
    if (!id || out[id]) return;
    var hit = cache.get('u:' + id);
    if (hit) { out[id] = hit; return; }
    try {
      var u = slackApi_('users.info', { user: id }).user || {};
      var name = (u.profile && (u.profile.display_name || u.profile.real_name)) || u.real_name || u.name || id;
      out[id] = name;
      cache.put('u:' + id, name, 21600);
    } catch (e) {
      out[id] = id;
    }
  });
  return out;
}

function mentionIds_(text) {
  var ids = [], m, re = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
  while ((m = re.exec(String(text || '')))) ids.push(m[1]);
  return ids;
}

function messageText_(msg) {
  var t = msg.text || '';
  var b = msg.blocks ? blocksToText(msg.blocks) : '';
  // Prefer whichever version actually parses; workflow posts sometimes put a
  // short fallback in `text` and the real content in blocks.
  if (parseAxoPost(t)) return t;
  if (b && parseAxoPost(b)) return b;
  return t || b;
}

function tsToIso_(ts) { return new Date(Number(ts) * 1000).toISOString(); }

/* Fetch posts since `oldestTs`, parse them, pull assignee replies, upsert. */
function syncSince_(oldestTs) {
  var channel = prop_('SLACK_CHANNEL_ID');
  if (!channel) throw new Error('SLACK_CHANNEL_ID is not set in Script Properties.');

  var messages = [], cursor = '';
  do {
    var page = slackApi_('conversations.history', {
      channel: channel, oldest: String(oldestTs), limit: 200, cursor: cursor
    });
    messages = messages.concat(page.messages || []);
    cursor = (page.response_metadata && page.response_metadata.next_cursor) || '';
  } while (cursor);

  var parsed = [], maxTs = Number(prop_('SLACK_LAST_TS') || 0);
  messages.forEach(function (msg) {
    if (msg.subtype === 'channel_join' || msg.subtype === 'channel_leave') return;
    if (Number(msg.ts) > maxTs) maxTs = Number(msg.ts);
    var text = messageText_(msg);
    var ids = mentionIds_(text);
    var replies = [];
    if (msg.reply_count) {
      try {
        replies = (slackApi_('conversations.replies', { channel: channel, ts: msg.ts, limit: 100 }).messages || [])
          .filter(function (r) { return r.ts !== msg.ts; })
          .map(function (r) { return r.text || (r.blocks ? blocksToText(r.blocks) : ''); });
      } catch (e) { console.warn('replies failed for ' + msg.ts + ': ' + e.message); }
      replies.forEach(function (r) { ids = ids.concat(mentionIds_(r)); });
    }
    var names = ids.length ? userNames_(ids) : {};
    var axo = parseAxoPost(text, names);
    if (!axo) return;
    replies.forEach(function (r) {
      parseAssignments(r, names).forEach(function (a) {
        if (a.axoNumber === axo.axoNumber && axo.devAssignees.indexOf(a.assignee) < 0) axo.devAssignees.push(a.assignee);
      });
    });
    axo.slackTs = msg.ts;
    axo.postedAt = tsToIso_(msg.ts);
    parsed.push(axo);
  });

  // Oldest first so the earliest post for an AXO number is the one recorded.
  parsed.sort(function (a, b) { return Number(a.slackTs) - Number(b.slackTs); });
  var result = upsertAxos_(parsed, 'slack');
  if (maxTs) setProp_('SLACK_LAST_TS', maxTs);
  setProp_('SLACK_LAST_SYNC', JSON.stringify({
    at: nowIso_(), scanned: messages.length, parsed: parsed.length,
    added: result.added.length, updated: result.updated.length
  }));
  return result;
}

/* Time-trigger entry point. Re-scans a short window so dev-assignee thread
   replies that arrive after the post are still picked up. */
function syncSlack() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // a previous run is still going
  lock.releaseLock();
  try {
    var windowDays = Number(prop_('SLACK_REPLY_WINDOW_DAYS') || 3);
    var last = Number(prop_('SLACK_LAST_TS') || 0);
    var oldest = last ? last - windowDays * 86400 : Date.now() / 1000 - windowDays * 86400;
    var r = syncSince_(oldest);
    console.log('syncSlack: added ' + r.added.join(',') + ' updated ' + r.updated.join(','));
  } catch (e) {
    setProp_('SLACK_LAST_ERROR', JSON.stringify({ at: nowIso_(), error: e.message }));
    console.error('syncSlack: ' + e.message);
  }
}

/* Run once from the editor to import history. Default 30 days. */
function backfillSlack(days) {
  var d = Number(days) || 30;
  var r = syncSince_(Date.now() / 1000 - d * 86400);
  console.log('backfill ' + d + 'd: added ' + r.added.length + ', updated ' + r.updated.length);
  return r;
}

/* Run once from the editor: installs a 5-minute syncSlack trigger. */
function setupSlackSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncSlack') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncSlack').timeBased().everyMinutes(5).create();
  console.log('syncSlack trigger installed (every 5 minutes).');
}

/* Run once from the editor to check the token and channel. */
function testSlackConnection() {
  var auth = slackApi_('auth.test', {});
  var hist = slackApi_('conversations.history', { channel: prop_('SLACK_CHANNEL_ID'), limit: 5 });
  var parsed = (hist.messages || []).map(function (m) { return parseAxoPost(messageText_(m)); }).filter(Boolean);
  console.log('Token user: ' + auth.user + ' @ ' + auth.team);
  console.log('Read ' + (hist.messages || []).length + ' messages, ' + parsed.length + ' parsed as AXOs.');
  parsed.forEach(function (a) { console.log(JSON.stringify(a)); });
}

/* ============================================================
   WEB APP API (google.script.run)
   ============================================================ */
function apiBootstrap() {
  var sync = {}, err = {};
  try { sync = JSON.parse(prop_('SLACK_LAST_SYNC') || '{}'); } catch (e) {}
  try { err = JSON.parse(prop_('SLACK_LAST_ERROR') || '{}'); } catch (e) {}
  return {
    build: BUILD,
    axos: readRows_(AXO_SHEET, AXO_HEADERS).map(axoFromRow_),
    updates: readRows_(UPDATE_SHEET, UPDATE_HEADERS).map(updateFromRow_),
    qas: readRows_(QA_SHEET, QA_HEADERS)
      .filter(function (r) { return r.Name && String(r.Active).toLowerCase() !== 'false'; })
      .map(function (r) { return r.Name; }),
    statuses: STATUSES, shifts: SHIFTS,
    slack: { configured: !!(prop_('SLACK_USER_TOKEN') && prop_('SLACK_CHANNEL_ID')), lastSync: sync, lastError: err }
  };
}

/* Preview what a paste will add, without saving. */
function apiParseAxo(text) {
  return parseAxoPost(String(text || '').slice(0, 20000));
}

/* Paste AXO fallback: same parser as the Slack sync. */
function apiPasteAxo(text) {
  var axo = parseAxoPost(String(text || '').slice(0, 20000));
  if (!axo) throw new Error('No AXO number found. Paste the whole Slack post, starting from "Axo Number".');
  var r = upsertAxos_([axo], 'paste');
  return { axo: axo, added: r.added.length > 0, updated: r.updated.length > 0 };
}

/* Let a QA pull the newest posts now instead of waiting for the trigger. */
function apiSyncNow() {
  if (!prop_('SLACK_USER_TOKEN')) throw new Error('Slack sync is not set up yet. Use Paste AXO instead.');
  syncSlack();
  return apiBootstrap();
}

/* ---------- updates ---------- */
function updateFromRow_(r) {
  var files = [];
  try { files = JSON.parse(r.Files || '[]'); } catch (e) { files = []; }
  return {
    id: r.Id, axoNumber: r.AxoNumber, qa: r.QA, shiftDate: r.ShiftDate, shift: r.Shift,
    status: r.Status, notes: r.Notes, files: files, createdAt: r.CreatedAt, updatedAt: r.UpdatedAt
  };
}

function cleanUpdate_(u) {
  u = u || {};
  var out = {
    axoNumber: String(u.axoNumber || '').trim(),
    qa: String(u.qa || '').trim(),
    shiftDate: String(u.shiftDate || '').trim(),
    shift: String(u.shift || '').trim(),
    status: String(u.status || '').trim(),
    notes: String(u.notes || '').slice(0, 20000),
    files: (Array.isArray(u.files) ? u.files : []).slice(0, 20).map(function (f) {
      return { name: String((f && f.name) || '').slice(0, 200), url: String((f && f.url) || '').slice(0, 2000) };
    }).filter(function (f) { return /^https?:\/\//i.test(f.url); })
  };
  if (!out.axoNumber) throw new Error('Pick an AXO.');
  if (!out.qa) throw new Error('Pick your name.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.shiftDate)) throw new Error('Shift date is required.');
  if (SHIFTS.indexOf(out.shift) < 0) throw new Error('Pick a shift.');
  if (STATUSES.indexOf(out.status) < 0) throw new Error('Pick a status.');
  return out;
}

function updateToRow_(id, u, createdAt, updatedAt) {
  return {
    Id: id, AxoNumber: u.axoNumber, QA: u.qa, ShiftDate: u.shiftDate, Shift: u.shift,
    Status: u.status, Notes: u.notes, Files: JSON.stringify(u.files), CreatedAt: createdAt, UpdatedAt: updatedAt
  };
}

function setAxoState_(axoNumber, state) {
  var rows = readRows_(AXO_SHEET, AXO_HEADERS);
  var row = rows.filter(function (r) { return r.AxoNumber === axoNumber; })[0];
  if (!row) throw new Error('AXO ' + axoNumber + ' is not in the tracker.');
  if ((row.State || 'Active') === state) return;
  var sh = sheet_(AXO_SHEET, AXO_HEADERS);
  var now = nowIso_();
  sh.getRange(row._row, AXO_HEADERS.indexOf('State') + 1).setValue(state);
  sh.getRange(row._row, AXO_HEADERS.indexOf('ClosedAt') + 1).setValue(state === 'Closed' ? now : '');
  sh.getRange(row._row, AXO_HEADERS.indexOf('UpdatedAt') + 1).setValue(now);
}

function apiAddUpdate(update) {
  var u = cleanUpdate_(update);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var exists = readRows_(AXO_SHEET, AXO_HEADERS).some(function (r) { return r.AxoNumber === u.axoNumber; });
    if (!exists) throw new Error('AXO ' + u.axoNumber + ' is not in the tracker.');
    var sh = sheet_(UPDATE_SHEET, UPDATE_HEADERS);
    var now = nowIso_();
    var id = Utilities.getUuid();
    sh.getRange(sh.getLastRow() + 1, 1, 1, UPDATE_HEADERS.length)
      .setNumberFormat('@')
      .setValues([rowValues_(updateToRow_(id, u, now, now), UPDATE_HEADERS)]);
    if (AUTO_CLOSE_STATUSES.indexOf(u.status) >= 0) setAxoState_(u.axoNumber, 'Closed');
  } finally {
    lock.releaseLock();
  }
  return apiBootstrap();
}

function apiEditUpdate(id, update) {
  var u = cleanUpdate_(update);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var row = readRows_(UPDATE_SHEET, UPDATE_HEADERS).filter(function (r) { return r.Id === String(id); })[0];
    if (!row) throw new Error('That update no longer exists.');
    sheet_(UPDATE_SHEET, UPDATE_HEADERS).getRange(row._row, 1, 1, UPDATE_HEADERS.length)
      .setValues([rowValues_(updateToRow_(row.Id, u, row.CreatedAt, nowIso_()), UPDATE_HEADERS)]);
    if (AUTO_CLOSE_STATUSES.indexOf(u.status) >= 0) setAxoState_(u.axoNumber, 'Closed');
  } finally {
    lock.releaseLock();
  }
  return apiBootstrap();
}

function apiDeleteUpdate(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var row = readRows_(UPDATE_SHEET, UPDATE_HEADERS).filter(function (r) { return r.Id === String(id); })[0];
    if (row) sheet_(UPDATE_SHEET, UPDATE_HEADERS).deleteRow(row._row);
  } finally {
    lock.releaseLock();
  }
  return apiBootstrap();
}

function apiSetAxoState(axoNumber, state) {
  if (state !== 'Active' && state !== 'Closed') throw new Error('Bad state.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { setAxoState_(String(axoNumber), state); } finally { lock.releaseLock(); }
  return apiBootstrap();
}
