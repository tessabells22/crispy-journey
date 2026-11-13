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

console.log(n + ' tests passed');
