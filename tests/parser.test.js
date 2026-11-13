/* Run: node tests/parser.test.js  (no dependencies) */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'Parser.gs'), 'utf8'), ctx);
const P = ctx.module.exports;

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok -', name); }

// 1. Slack API text, bold labels on their own lines (typical workflow output)
const apiText = [
  '*Axo Number*',
  '15611 - [Frontend] - Bug AXO: OTM: Importer Details Change after Ship Confirmation',
  '*Priority*',
  'High',
  '*Link*',
  '<https://shiperp.axosoft.com/viewitem?id=15611&amp;type=defects|https://shiperp.axosoft.com/viewitem?id=15611&amp;type=defects>',
  '*Additional Info*',
  'Repro in QA2 only.',
  'Check importer address too.',
  '*Raised By*',
  '<@U012ABC|Maria>',
  '*Due Date*',
  'Nov 20, 2026',
  '*Client*',
  'Acme Corp',
  '*Ticket Number*',
  'CS-4821'
].join('\n');

t('parses labelled multi-line workflow post', () => {
  const a = P.parseAxoPost(apiText);
  assert.strictEqual(a.axoNumber, '15611');
  assert.strictEqual(a.title, '[Frontend] - Bug AXO: OTM: Importer Details Change after Ship Confirmation');
  assert.strictEqual(a.priority, 'High');
  assert.strictEqual(a.link, 'https://shiperp.axosoft.com/viewitem?id=15611&type=defects');
  assert.strictEqual(a.additionalInfo, 'Repro in QA2 only.\nCheck importer address too.');
  assert.strictEqual(a.raisedBy, 'Maria');
  assert.strictEqual(a.dueDate, '2026-11-20');
  assert.strictEqual(a.client, 'Acme Corp');
  assert.strictEqual(a.ticketNumber, 'CS-4821');
});

// 2. Text copied from the Slack desktop client (inline "Label: value")
const pasted = `NPD Axo Assignment  Workflow  10:32 AM
Axo Number: 15702 - [Backend] - Feature AXO: Carrier rate refresh
Priority: Urgent
Link: https://shiperp.axosoft.com/viewitem?id=15702
Additional Info: N/A
Raised By: @John Cruz
Due Date: 11/18/2026
Client: Globex
Ticket Number: 99812
3 replies
@Dev Person assigned to Axo 15702 - [Backend] - Feature AXO: Carrier rate refresh`;

t('parses pasted inline post with assignee reply', () => {
  const a = P.parseAxoPost(pasted);
  assert.strictEqual(a.axoNumber, '15702');
  assert.strictEqual(a.title, '[Backend] - Feature AXO: Carrier rate refresh');
  assert.strictEqual(a.priority, 'Urgent');
  assert.strictEqual(a.raisedBy, 'John Cruz');
  assert.strictEqual(a.dueDate, '2026-11-18');
  assert.strictEqual(a.ticketNumber, '99812');
  assert.deepStrictEqual([...a.devAssignees], ['Dev Person']);
});

t('returns null when there is no AXO number', () => {
  assert.strictEqual(P.parseAxoPost('hello team, standup in 5'), null);
});

t('parseAssignments handles mentions and variants', () => {
  const r = P.parseAssignments('<@U9|ana.r> assigned to Axo 15611 - x\n@Ben has been assigned to AXO #15612', {});
  assert.deepStrictEqual([...r.map(x => x.assignee + ':' + x.axoNumber)], ['ana.r:15611', 'Ben:15612']);
  const r2 = P.parseAssignments('<@U77> assigned to Axo 15611', { U77: 'Carla' });
  assert.strictEqual(r2[0].assignee, 'Carla');
});

t('blocksToText flattens rich_text blocks', () => {
  const blocks = [{ type: 'rich_text', elements: [
    { type: 'rich_text_section', elements: [{ type: 'text', text: 'Axo Number: ', style: { bold: true } }, { type: 'text', text: '15800 - Bug AXO: X' }] },
    { type: 'rich_text_section', elements: [{ type: 'text', text: 'Link: ' }, { type: 'link', url: 'https://a.axosoft.com/1' }] }
  ]}];
  const a = P.parseAxoPost(P.blocksToText(blocks));
  assert.strictEqual(a.axoNumber, '15800');
  assert.strictEqual(a.link, 'https://a.axosoft.com/1');
});

t('normalizeDueDate formats', () => {
  assert.strictEqual(P.normalizeDueDate('2026-1-5'), '2026-01-05');
  assert.strictEqual(P.normalizeDueDate('5 December 2026'), '2026-12-05');
  assert.strictEqual(P.normalizeDueDate('September 3rd, 2026'), '2026-09-03');
  assert.strictEqual(P.normalizeDueDate('ASAP'), '');
});

t('mergeAxo keeps existing values over blanks and unions assignees', () => {
  const m = P.mergeAxo({ axoNumber: '1', priority: 'High', devAssignees: ['A'] }, { axoNumber: '1', priority: '', client: 'C', devAssignees: ['a', 'B'] });
  assert.strictEqual(m.priority, 'High');
  assert.strictEqual(m.client, 'C');
  assert.deepStrictEqual([...m.devAssignees], ['A', 'B']);
});

t('workflow footer is not read as a field value', () => {
  const a = P.parseAxoPost('*Axo Number:*\n15612 - [Frontend] - Bug AXO: X\n*Client:*\nEntrust\n*Ticket Number:*\n\nPlease assign a resource <!here>');
  assert.strictEqual(a.client, 'Entrust');
  assert.strictEqual(a.ticketNumber, '');
});

console.log(n + ' tests passed');
