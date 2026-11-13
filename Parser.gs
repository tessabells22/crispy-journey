/* ============================================================
   NPD QA AXO Tracker — shared AXO parser (pure functions)
   ------------------------------------------------------------
   ONE parser for both ingestion paths:
     • Slack sync  — message text from conversations.history
     • Paste AXO   — text a QA lead copies out of the Slack client
   No Apps Script services are used here, so the file also runs
   under Node for tests (see tests/parser.test.js).
   ============================================================ */

/* Labels the "NPD Axo Assignment" workflow prints, mapped to model keys.
   Matched case-insensitively, ignoring bold or italic marks and a
   trailing colon. Longest labels first so "Axo Number" wins over "Axo". */
var AXO_FIELDS = [
  { key: 'axoLine',        labels: ['axo number', 'axo no', 'axo #', 'axo'] },
  { key: 'priority',       labels: ['priority'] },
  { key: 'link',           labels: ['link', 'axosoft link', 'axo link'] },
  { key: 'additionalInfo', labels: ['additional info', 'additional information', 'additional details'] },
  { key: 'raisedBy',       labels: ['raised by'] },
  { key: 'dueDate',        labels: ['due date', 'due'] },
  { key: 'client',         labels: ['client'] },
  { key: 'ticketNumber',   labels: ['ticket number', 'ticket no', 'ticket #', 'ticket'] }
];

/* Turn Slack mrkdwn into plain text a person would read.
   <https://x|label> -> https://x  (links keep the URL, the useful part)
   <mailto:a@b|a@b>  -> a@b
   <@U123|name>      -> @name ; <@U123> -> @U123 (resolved later if possible)
   <#C123|chan>      -> #chan ; &amp; &lt; &gt; unescaped. */
function cleanSlackText(text, userNames) {
  var names = userNames || {};
  var s = String(text == null ? '' : text);
  s = s.replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, function (_, id, label) {
    return '@' + (label || names[id] || id);
  });
  s = s.replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1');
  s = s.replace(/<!(here|channel|everyone)[^>]*>/g, '@$1');
  s = s.replace(/<mailto:([^|>]+)(?:\|[^>]+)?>/g, '$1');
  s = s.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, '$1');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  s = s.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  return s;
}

/* Flatten Slack Block Kit blocks to text, for workflow posts whose
   top-level `text` is empty or a short fallback. */
function blocksToText(blocks) {
  var out = [];
  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (node.type === 'text' && typeof node.text === 'string') { out.push(node.text); return; }
    if (node.type === 'link') { out.push(node.url || node.text || ''); return; }
    if (node.type === 'user') { out.push('<@' + node.user_id + '>'); return; }
    if (node.text && typeof node.text === 'object' && typeof node.text.text === 'string') {
      out.push(node.text.text); out.push('\n');
    }
    if (node.fields) { node.fields.forEach(function (f) { if (f && f.text) { out.push(f.text); out.push('\n'); } }); }
    if (node.elements) {
      walk(node.elements);
      if (node.type === 'rich_text_section' || node.type === 'rich_text_list' ||
          node.type === 'rich_text_preformatted' || node.type === 'rich_text_quote') out.push('\n');
    }
  }
  walk(blocks);
  return out.join('');
}

function stripMarks_(s) {
  return String(s).replace(/^[\s*_~>•\-]+|[\s*_~]+$/g, '');
}

/* Match a line that starts with a known label. Returns {key, rest} or null. */
function matchLabel_(line) {
  var bare = stripMarks_(line);
  var lower = bare.toLowerCase();
  for (var i = 0; i < AXO_FIELDS.length; i++) {
    var f = AXO_FIELDS[i];
    for (var j = 0; j < f.labels.length; j++) {
      var lab = f.labels[j];
      if (lower.indexOf(lab) !== 0) continue;
      var after = bare.slice(lab.length);
      // Label must end here, or be followed by ':' / whitespace / bold marks.
      var m = after.match(/^[\s*_]*(?::|\s-\s|\s*$|\s+)/);
      if (!m) continue;
      // "Axo" alone is only a label when a colon follows, to avoid eating
      // "Axo 15611 - ..." style lines where the number is the value anyway.
      var rest = after.slice(m[0].length);
      rest = rest.replace(/^[\s*_:]+/, '');
      return { key: f.key, rest: stripMarks_(rest) };
    }
  }
  return null;
}

/* Split "15611 - [Frontend] - Bug AXO: OTM: ..." into number + title. */
function splitAxoLine(line) {
  var s = stripMarks_(String(line || ''));
  var m = s.match(/#?\s*(\d{3,})\s*(?:[-–—:|]\s*)?([\s\S]*)$/);
  if (!m) return { axoNumber: '', title: s };
  return { axoNumber: m[1], title: stripMarks_(m[2] || '') };
}

/* Best-effort ISO date (YYYY-MM-DD) from what the workflow prints.
   Accepts 2026-11-20, 11/20/2026, Nov 20, 2026, 20 Nov 2026, "November 20th, 2026".
   Returns '' when it can't be sure; the raw text is always kept separately. */
function normalizeDueDate(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  var MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };
  function iso(y, mo, d) {
    y = +y; mo = +mo; d = +d;
    if (y < 100) y += 2000;
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return '';
    return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
  }
  var m;
  if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) return iso(m[3], m[1], m[2]); // US m/d/y
  if ((m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/))) {
    var mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return iso(m[3], mo, m[2]);
  }
  if ((m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/))) {
    var mo2 = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo2) return iso(m[3], mo2, m[1]);
  }
  return '';
}

/* Pull every "@X assigned to Axo N" out of some text.
   Returns [{ assignee, axoNumber }]. */
function parseAssignments(text, userNames) {
  var s = cleanSlackText(text, userNames);
  var out = [];
  var re = /@([^\n@]+?)\s+(?:has been\s+|was\s+|is\s+)?assigned\s+to\s+axo\s*(?:number|no\.?|#)?\s*#?\s*(\d{3,})/gi;
  var m;
  while ((m = re.exec(s))) {
    out.push({ assignee: stripMarks_(m[1]), axoNumber: m[2] });
  }
  return out;
}

/* Parse one AXO assignment post. Returns a model or null when the text
   has no AXO number. Unknown lines after a label are folded into that
   label's value, so multi-line "Additional Info" survives. */
function parseAxoPost(text, userNames) {
  var clean = cleanSlackText(text, userNames);
  var lines = clean.split('\n');
  var fields = {};
  var current = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var hit = matchLabel_(line);
    if (hit && !(hit.key in fields)) {
      current = hit.key;
      fields[current] = hit.rest ? [hit.rest] : [];
      continue;
    }
    if (!current) continue;
    var t = stripMarks_(line);
    if (!t) continue;
    // Thread chatter copied along with a paste ends the post.
    if (/assigned\s+to\s+axo/i.test(t) || /^\d+\s+repl(y|ies)\b/i.test(t) || /^view thread$/i.test(t) ||
        /@(here|channel|everyone)\b/i.test(t) || /^please assign\b/i.test(t)) { current = null; continue; }
    // Single-value fields take one value line; only free text keeps folding.
    if (current === 'additionalInfo' || fields[current].length === 0) fields[current].push(t);
  }

  function val(k) { return fields[k] ? fields[k].join('\n').trim() : ''; }

  var axoLine = val('axoLine');
  // No labelled AXO line: fall back to the first "NNNNN - title" line in the post.
  if (!axoLine) {
    for (var k = 0; k < lines.length; k++) {
      var cand = stripMarks_(lines[k]);
      if (/^#?\d{4,}\s*[-–—:]\s*\S/.test(cand)) { axoLine = cand; break; }
    }
  }
  var split = splitAxoLine(axoLine.split('\n')[0]);
  if (!split.axoNumber) return null;
  var title = split.title;
  // Title wrapped onto following lines under the same label.
  var extra = axoLine.split('\n').slice(1).join(' ').trim();
  if (extra && !title) title = extra;

  var link = val('link');
  var urlMatch = link.match(/https?:\/\/\S+/);
  if (urlMatch) link = urlMatch[0];
  if (!link) {
    var axosoft = clean.match(/https?:\/\/[^\s>|]*axosoft[^\s>|]*/i);
    if (axosoft) link = axosoft[0];
  }

  var dueRaw = val('dueDate');
  var assignments = parseAssignments(text, userNames).filter(function (a) { return a.axoNumber === split.axoNumber; });

  return {
    axoNumber: split.axoNumber,
    title: title,
    priority: val('priority'),
    link: link,
    additionalInfo: val('additionalInfo'),
    raisedBy: val('raisedBy').replace(/^@/, ''),
    dueDateRaw: dueRaw,
    dueDate: normalizeDueDate(dueRaw),
    client: val('client'),
    ticketNumber: val('ticketNumber'),
    devAssignees: assignments.map(function (a) { return a.assignee; })
  };
}

/* Merge a freshly parsed AXO onto an existing record. Fields from the
   post overwrite only when the new value is non-empty, so a sparse
   paste never wipes data the Slack sync already filled in. Assignees
   are unioned. */
function mergeAxo(existing, incoming) {
  var out = {};
  var k;
  for (k in existing) out[k] = existing[k];
  for (k in incoming) {
    if (k === 'devAssignees') continue;
    if (incoming[k] !== '' && incoming[k] != null) out[k] = incoming[k];
  }
  var seen = {};
  out.devAssignees = [].concat(existing.devAssignees || [], incoming.devAssignees || []).filter(function (a) {
    var key = String(a).toLowerCase();
    if (!a || seen[key]) return false;
    seen[key] = true;
    return true;
  });
  return out;
}

/* Turn rows of the old NPD QA Endorsement Tracker's "Endorsements" sheet
   (Id, ShiftDate, Shift, QAResource, Payload, CreatedAt, UpdatedAt) into
   updates for this tracker. Each AXO line in an endorsement becomes one
   update; ids are stable ("legacy-…") so a re-run never duplicates.
   Non-AXO notes and shift-level file links have no AXO to attach to, so
   they are left out. */
var LEGACY_STATUS = { 'Passed': 'Passed - Initial', 'Failed': 'Failed - Initial' };
var LEGACY_SECTIONS = ['workedOn', 'needsMonitoring', 'blocker', 'urgent', 'notTested'];
function legacyUpdatesFrom(rows) {
  var out = [];
  (rows || []).forEach(function (r) {
    var endId = String(r[0] || '').trim();
    if (!endId) return;
    var day = String(r[1] || '').match(/^(\d{4}-\d{2}-\d{2})/);
    if (!day) return;
    var payload = {};
    try { payload = JSON.parse(r[4] || '{}'); } catch (e) { return; }
    var sections = payload && typeof payload.sections === 'object' && payload.sections ? payload.sections : payload;
    LEGACY_SECTIONS.forEach(function (key) {
      var list = Array.isArray(sections[key]) ? sections[key] : [];
      list.forEach(function (e, i) {
        var m = String((e && e.axo) || '').match(/^\s*#?(\d{3,})/);
        if (!m) return;
        out.push({
          id: 'legacy-' + endId + '-' + key + '-' + i,
          axoNumber: m[1],
          qa: String(r[3] || '').trim(),
          shiftDate: day[1],
          shift: String(r[2] || 'Day').trim(),
          status: LEGACY_STATUS[e.status] || e.status || 'Not Tested',
          notes: String(e.note || ''),
          files: [],
          createdAt: String(r[5] || ''),
          updatedAt: String(r[6] || r[5] || '')
        });
      });
    });
  });
  return out;
}

/* Newest update first: shift date, then shift (Night after Day), then save time. */
function latestUpdate(updates) {
  var rank = { Day: 0, Mid: 1, Night: 2 };
  return (updates || []).slice().sort(function (x, y) {
    return String(y.shiftDate).localeCompare(String(x.shiftDate)) ||
      (rank[y.shift] == null ? 3 : rank[y.shift]) - (rank[x.shift] == null ? 3 : rank[x.shift]) ||
      String(y.createdAt).localeCompare(String(x.createdAt));
  })[0] || null;
}

/* Node export for tests; ignored by Apps Script. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cleanSlackText: cleanSlackText, blocksToText: blocksToText, splitAxoLine: splitAxoLine,
    normalizeDueDate: normalizeDueDate, parseAssignments: parseAssignments,
    parseAxoPost: parseAxoPost, mergeAxo: mergeAxo,
    legacyUpdatesFrom: legacyUpdatesFrom, latestUpdate: latestUpdate
  };
}
