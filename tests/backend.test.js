/* Run: node tests/backend.test.js */
const assert = require('assert');
const { loadGas } = require('./fake-gas');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok -', name); }
const plain = (x) => JSON.parse(JSON.stringify(x));

const post = (num, extra = '') => `*Axo Number*\n${num} - [Frontend] - Bug AXO: Thing ${num}\n*Priority*\nHigh\n*Link*\n<https://x.axosoft.com/${num}>\n*Raised By*\n<@U1>\n*Due Date*\n2026-11-20\n*Client*\nAcme\n*Ticket Number*\nT-${num}${extra}`;

function slackFake(messages, replies = {}) {
  return (url) => {
    const u = new URL(url);
    const m = u.pathname.split('/').pop();
    if (m === 'conversations.history') return { body: { ok: true, messages } };
    if (m === 'conversations.replies') return { body: { ok: true, messages: [{ ts: u.searchParams.get('ts') }].concat(replies[u.searchParams.get('ts')] || []) } };
    if (m === 'users.info') return { body: { ok: true, user: { profile: { display_name: { U1: 'Maria', U2: 'Dev Dan' }[u.searchParams.get('user')] || 'Someone' } } } };
    return { body: { ok: false, error: 'unknown_method' } };
  };
}

t('Slack sync adds AXOs, resolves names, reads assignee replies, de-dupes', () => {
  const g = loadGas({ props: { SLACK_USER_TOKEN: 'xoxp-test', SLACK_CHANNEL_ID: 'G1' } });
  g.setFetch(slackFake([
    { ts: '1763000000.000100', text: post(15611), reply_count: 1 },
    { ts: '1763000100.000100', text: 'random chatter' },
    { ts: '1763000200.000100', text: post(15611) } // duplicate post
  ], { '1763000000.000100': [{ ts: '1763000050.1', text: '<@U2> assigned to Axo 15611 - [Frontend] - Bug AXO: Thing' }] }));
  g.ctx.syncSlack();
  const b = plain(g.ctx.apiBootstrap());
  assert.strictEqual(b.axos.length, 1);
  const a = b.axos[0];
  assert.strictEqual(a.axoNumber, '15611');
  assert.strictEqual(a.raisedBy, 'Maria');
  assert.deepStrictEqual(a.devAssignees, ['Dev Dan']);
  assert.strictEqual(a.source, 'slack');
  assert.strictEqual(a.slackTs, '1763000000.000100');
  assert.strictEqual(b.slack.lastSync.added, 1);
  // second run: nothing new
  g.ctx.syncSlack();
  assert.strictEqual(plain(g.ctx.apiBootstrap()).axos.length, 1);
});

t('sync errors are recorded, not thrown', () => {
  const g = loadGas({ props: { SLACK_USER_TOKEN: 'x', SLACK_CHANNEL_ID: 'G1' } });
  g.setFetch(() => ({ body: { ok: false, error: 'not_in_channel' } }));
  g.ctx.syncSlack();
  assert.match(plain(g.ctx.apiBootstrap()).slack.lastError.error, /not_in_channel/);
});

t('paste adds once and merges blanks without duplicating', () => {
  const g = loadGas();
  const r1 = plain(g.ctx.apiPasteAxo('Axo Number: 15700 - Bug AXO: Paste me\nPriority: Low'));
  assert.ok(r1.added);
  const r2 = plain(g.ctx.apiPasteAxo('Axo Number: 15700 - Bug AXO: Paste me\nClient: Globex'));
  assert.ok(r2.updated && !r2.added);
  const axos = plain(g.ctx.apiBootstrap()).axos;
  assert.strictEqual(axos.length, 1);
  assert.strictEqual(axos[0].priority, 'Low');
  assert.strictEqual(axos[0].client, 'Globex');
  assert.throws(() => g.ctx.apiPasteAxo('no number here'), /No AXO number/);
});

t('updates: validate, keep history, auto-close, reopen, edit, delete', () => {
  const g = loadGas();
  g.ctx.apiPasteAxo('Axo Number: 15800 - Bug AXO: Close me');
  const base = { axoNumber: '15800', qa: 'Ley', shiftDate: '2026-11-13', shift: 'Day', status: 'In Progress', notes: 'started', files: [{ name: 'TC', url: 'https://drive.google.com/x' }, { name: 'bad', url: 'javascript:alert(1)' }] };
  assert.throws(() => g.ctx.apiAddUpdate(Object.assign({}, base, { status: 'Nope' })), /status/);
  assert.throws(() => g.ctx.apiAddUpdate(Object.assign({}, base, { axoNumber: '1' })), /not in the tracker/);
  let b = plain(g.ctx.apiAddUpdate(base));
  assert.strictEqual(b.updates.length, 1);
  assert.deepStrictEqual(b.updates[0].files, [{ name: 'TC', url: 'https://drive.google.com/x' }]);
  b = plain(g.ctx.apiAddUpdate(Object.assign({}, base, { qa: 'Carla', status: 'Passed - Develop/Deployment' })));
  assert.strictEqual(b.updates.length, 2);
  assert.strictEqual(b.axos[0].state, 'Closed');
  b = plain(g.ctx.apiSetAxoState('15800', 'Active'));
  assert.strictEqual(b.axos[0].state, 'Active');
  const id = b.updates[0].id;
  b = plain(g.ctx.apiEditUpdate(id, Object.assign({}, base, { notes: 'edited' })));
  assert.strictEqual(b.updates.filter(u => u.id === id)[0].notes, 'edited');
  b = plain(g.ctx.apiDeleteUpdate(id));
  assert.strictEqual(b.updates.length, 1);
});

t('re-sync never reopens a closed AXO', () => {
  const g = loadGas({ props: { SLACK_USER_TOKEN: 'x', SLACK_CHANNEL_ID: 'G1' } });
  g.setFetch(slackFake([{ ts: '1763000000.1', text: post(15900) }]));
  g.ctx.syncSlack();
  g.ctx.apiSetAxoState('15900', 'Closed');
  g.props.SLACK_LAST_TS = '';
  g.ctx.syncSlack();
  assert.strictEqual(plain(g.ctx.apiBootstrap()).axos[0].state, 'Closed');
});

t('closeImportedAxos closes overdue untouched AXOs only', () => {
  const g = loadGas();
  g.ctx.apiPasteAxo('Axo Number: 1001 - Old\nDue Date: 2020-01-01');
  g.ctx.apiPasteAxo('Axo Number: 1002 - Old but worked\nDue Date: 2020-01-01');
  g.ctx.apiPasteAxo('Axo Number: 1003 - Future\nDue Date: 2099-01-01');
  g.ctx.apiAddUpdate({ axoNumber: '1002', qa: 'Ley', shiftDate: '2026-11-13', shift: 'Day', status: 'In Progress', notes: '', files: [] });
  assert.strictEqual(g.ctx.closeImportedAxos('2026-11-14'), 1);
  const st = Object.fromEntries(plain(g.ctx.apiBootstrap()).axos.map(a => [a.axoNumber, a.state]));
  assert.deepStrictEqual(st, { '1001': 'Closed', '1002': 'Active', '1003': 'Active' });
  assert.strictEqual(g.ctx.closeAllImportedAxos(), 1);
});

t('syncSlack waits SYNC_EVERY_MIN between runs', () => {
  const g = loadGas({ props: { SLACK_USER_TOKEN: 'x', SLACK_CHANNEL_ID: 'G1', SYNC_EVERY_MIN: '3' } });
  let calls = 0;
  g.setFetch((url) => { if (/conversations.history/.test(url)) calls++; return slackFake([])(url); });
  g.ctx.syncSlack(); g.ctx.syncSlack();
  assert.strictEqual(calls, 1);
  g.props.SLACK_LAST_SYNC = JSON.stringify({ at: new Date(Date.now() - 181000).toISOString() });
  g.ctx.syncSlack();
  assert.strictEqual(calls, 2);
});

t('importEndorsementHistory copies old AXO lines, re-runs safely, fixes open/closed', () => {
  const OLD = '1WSI1MeqS421MSfTvh2HewJtBi9HVMKcib4EHJOCu8s0';
  const row = (id, day, shift, qa, sections, at) => [id, day, shift, qa, JSON.stringify({ sections, fileRefs: [] }), at, at];
  const g = loadGas({ external: { [OLD]: { Endorsements: [
    ['Id', 'ShiftDate', 'Shift', 'QAResource', 'Payload', 'CreatedAt', 'UpdatedAt'],
    row('e1', '2026-11-10', 'Day', 'Norma', { workedOn: [{ axo: '2001', status: 'Passed', note: 'ok' }, { axo: '9999', status: 'In Progress' }], nonAxo: [{ note: 'x' }] }, '2026-11-10T02:00:00.000Z'),
    row('e2', '2026-11-11', 'Night', 'Ervin', { workedOn: [{ axo: '2002 (formerly 1)', status: 'Passed - Develop/Deployment', note: '' }], blocker: [{ axo: '2003', status: 'Blocked', note: 'env down' }] }, '2026-11-11T15:00:00.000Z')
  ] } } });
  ['2001', '2002', '2003'].forEach(nm => g.ctx.apiPasteAxo('Axo Number: ' + nm + ' - T\nDue Date: 2020-01-01'));
  g.ctx.apiSetAxoState('2003', 'Closed'); // e.g. auto-closed as overdue
  const r = plain(g.ctx.importEndorsementHistory());
  assert.strictEqual(r.updatesAdded, 3);
  assert.deepStrictEqual(r.notInTracker, ['9999']);
  assert.strictEqual(r.closed, 1);   // 2002 passed develop/deployment
  assert.strictEqual(r.reopened, 1); // 2003 is blocked, back to active
  const b = plain(g.ctx.apiBootstrap());
  const st = Object.fromEntries(b.axos.map(a => [a.axoNumber, a.state]));
  assert.deepStrictEqual(st, { '2001': 'Active', '2002': 'Closed', '2003': 'Active' });
  const u = b.updates.filter(x => x.axoNumber === '2001')[0];
  assert.strictEqual(u.status, 'Passed - Initial');
  assert.strictEqual(u.qa, 'Norma');
  assert.strictEqual(u.createdAt, '2026-11-10T02:00:00.000Z');
  assert.strictEqual(plain(g.ctx.importEndorsementHistory()).updatesAdded, 0);
});

t('[Backend] AXOs close at Passed - Initial; closePassedAxos sweeps old ones', () => {
  const g = loadGas();
  g.ctx.apiPasteAxo('Axo Number: 3001 - [Backend] - API thing');
  g.ctx.apiPasteAxo('Axo Number: 3002 - [Frontend] - UI thing');
  g.ctx.apiPasteAxo('Axo Number: 3003 - [Backend] - Older thing');
  const up = (num, status) => ({ axoNumber: num, qa: 'Ley', shiftDate: '2026-11-13', shift: 'Day', status, notes: '', files: [] });
  // simulate an old Passed - Initial on 3003 written before the rule existed
  const sh = g.ss.getSheetByName('Updates') || g.ss.insertSheet('Updates');
  g.ctx.apiAddUpdate(up('3003', 'In Progress'));
  const rows = sh.dump(); rows[rows.length - 1][5] = 'Passed - Initial'; sh.getRange(rows.length, 6).setValue('Passed - Initial');
  let b = plain(g.ctx.apiAddUpdate(up('3001', 'Passed - Initial')));
  b = plain(g.ctx.apiAddUpdate(up('3002', 'Passed - Initial')));
  let st = Object.fromEntries(b.axos.map(a => [a.axoNumber, a.state]));
  assert.deepStrictEqual(st, { '3001': 'Closed', '3002': 'Active', '3003': 'Active' });
  assert.deepStrictEqual(plain(g.ctx.closePassedAxos()), ['3003']);
  st = Object.fromEntries(plain(g.ctx.apiBootstrap()).axos.map(a => [a.axoNumber, a.state]));
  assert.strictEqual(st['3003'], 'Closed');
});

t('bootstrap gives a Slack thread base from auth.test', () => {
  const g = loadGas({ props: { SLACK_USER_TOKEN: 'x', SLACK_CHANNEL_ID: 'G1' } });
  g.setFetch((url) => /auth.test/.test(url) ? { body: { ok: true, url: 'https://acme.slack.com/' } } : slackFake([])(url));
  assert.strictEqual(g.ctx.apiBootstrap().slack.threadBase, 'https://acme.slack.com/archives/G1/p');
});

console.log(n + ' tests passed');
