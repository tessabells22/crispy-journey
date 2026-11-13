/* Local preview: node tools/preview-server.js  ->  http://localhost:8788
   Runs the real Code.gs + Parser.gs on an in-memory sheet with dummy AXOs.
   Nothing is saved and nothing talks to Slack. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadGas } = require('../tests/fake-gas');

const root = path.join(__dirname, '..');
const port = Number(process.env.PORT || 8788);
const gas = loadGas({ props: { SLACK_USER_TOKEN: 'xoxp-preview', SLACK_CHANNEL_ID: 'G-preview',
  SLACK_LAST_SYNC: JSON.stringify({ at: new Date(Date.now() - 3 * 60e3).toISOString(), scanned: 12, parsed: 12, added: 0, updated: 0 }) } });
const g = gas.ctx;
g.setupSheets();
const qaTab = gas.ss.getSheetByName('QAs');
['Ley', 'Carla', 'Tessa', 'Joanne', 'AJ', 'Liza'].forEach((n, i) => qaTab.getRange(i + 2, 1, 1, 2).setValues([[n, 'TRUE']]));

const day = (n) => new Date(Date.now() + n * 864e5 + 8 * 3600e3).toISOString().slice(0, 10);
const demo = [
  ['15611', '[Frontend] - Bug AXO: OTM: Importer Details Change after Ship Confirmation (dummy)', 'High', 'Acme Freight', 1, 'Marco V'],
  ['15622', '[Backend] - Feature AXO: Carrier rate refresh on re-rate (dummy)', 'Urgent', 'Globex', -1, 'Angela C'],
  ['15630', '[Frontend] - Bug AXO: Label preview cut off on A6 (dummy)', 'Medium', 'Initech', 4, ''],
  ['15641', '[Backend] - Bug AXO: Duplicate tracking numbers on split shipments (dummy)', 'High', 'Acme Freight', 2, 'Rafael D'],
  ['15655', '[Frontend] - Story AXO: Bulk print packing slips (dummy)', 'Low', 'Umbrella', 9, 'Marco V'],
  ['15660', '[Backend] - Bug AXO: Customs value rounding (dummy)', 'Medium', 'Globex', 6, 'Angela C'],
  ['15672', '[Frontend] - Bug AXO: Address validation message overlaps button (dummy)', 'Low', 'Initech', 12, ''],
  ['15688', '[Backend] - Bug AXO: Freight class missing on LTL quote (dummy)', 'High', 'Umbrella', 3, 'Rafael D']
];
demo.forEach(([num, title, prio, client, due, dev]) => {
  g.apiPasteAxo(`Axo Number: ${num} - ${title}\nPriority: ${prio}\nLink: https://example.axosoft.com/viewitem?id=${num}\nAdditional Info: Repro steps in the ticket. Check QA2 and DEV 800.\nRaised By: Hannah G\nDue Date: ${day(due)}\nClient: ${client}\nTicket Number: CS-${num.slice(1)}` +
    (dev ? `\n@${dev} assigned to Axo ${num} - ${title}` : ''));
});
const U = (axoNumber, qa, d, shift, status, notes) => g.apiAddUpdate({ axoNumber, qa, shiftDate: day(d), shift, status, notes,
  files: status.startsWith('Failed') ? [{ name: 'Failed TC screenshot', url: 'https://drive.google.com/preview' }] : [] });
U('15611', 'Ley', -1, 'Day', 'In Progress', 'Reproduced on QA2. Waiting on dev fix for importer address sync.');
U('15611', 'Carla', 0, 'Day', 'Failed - Initial', 'Fix deployed to DEV 800 but importer phone still reverts after ship confirm.');
U('15622', 'Tessa', 0, 'Day', 'Blocked', 'Carrier sandbox credentials expired; raised with BA.');
U('15630', 'Joanne', -2, 'Mid', 'Passed - Initial', 'A6 preview OK in Chrome and Edge.');
U('15641', 'AJ', 0, 'Night', 'Urgent/High Prio', 'Duplicates still happen when splitting into 3+ packages.');
U('15655', 'Liza', -3, 'Day', 'Passed - Develop/Deployment', 'Verified on deployment.');
U('15660', 'Ley', -1, 'Mid', 'Needs Monitoring', 'Rounding fixed for USD; keep an eye on JPY.');

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/rpc/')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const fn = req.url.slice(5);
      let out;
      try {
        if (!/^api[A-Z]\w*$/.test(fn) || fn === 'apiSyncNow') throw new Error(fn === 'apiSyncNow' ? 'Preview does not talk to Slack.' : 'Not exposed: ' + fn);
        out = { result: JSON.parse(JSON.stringify(g[fn](...JSON.parse(body)) ?? null)) };
      } catch (e) { out = { error: e.message }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  let html = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
  html = html.replace(/<\?!= include\('(\w+)'\); \?>/g, (_, n) => fs.readFileSync(path.join(root, n + '.html'), 'utf8'));
  const shim = `<script>window.google={script:{get run(){var ok=function(){},fail=function(){};var p=new Proxy({},{get:function(_,fn){
    if(fn==='withSuccessHandler')return function(f){ok=f;return p};if(fn==='withFailureHandler')return function(f){fail=f;return p};
    return function(){fetch('/rpc/'+fn,{method:'POST',body:JSON.stringify([].slice.call(arguments))}).then(function(r){return r.json()})
    .then(function(j){j.error?fail(new Error(j.error)):ok(j.result)},fail)}}});return p}}};</script>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html.replace('<head>', '<head>' + shim));
}).listen(port, () => console.log('Preview on http://localhost:' + port));
