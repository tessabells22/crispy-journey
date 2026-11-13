/* Minimal in-memory Apps Script stand-in so Code.gs + Parser.gs run under Node
   (tests and the local preview). Only what this project uses is implemented. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeSheet(name) {
  const rows = []; // rows[r-1][c-1]
  const sh = {
    name,
    getName: () => name,
    getMaxRows: () => 1000,
    getLastRow: () => { for (let i = rows.length; i > 0; i--) if ((rows[i - 1] || []).some(v => v !== '' && v != null)) return i; return 0; },
    setFrozenRows: () => {},
    deleteRow: (r) => { rows.splice(r - 1, 1); },
    getRange: (r, c, nr = 1, nc = 1) => {
      const rng = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
          const v = (rows[r - 1 + i] || [])[c - 1 + j]; return v === undefined ? '' : v; })),
        setValues: (vals) => { vals.forEach((row, i) => { rows[r - 1 + i] = rows[r - 1 + i] || []; row.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; }); }); return rng; },
        setValue: (v) => { rows[r - 1] = rows[r - 1] || []; rows[r - 1][c - 1] = v; return rng; },
        setNumberFormat: () => rng, setFontWeight: () => rng
      };
      return rng;
    },
    dump: () => rows.map(r => r.slice())
  };
  return sh;
}

function loadGas(opts = {}) {
  const sheets = {};
  const props = Object.assign({ SYNC_EVERY_MIN: '0' }, opts.props || {});
  const external = opts.external || {};
  const cache = {};
  let fetchHandler = opts.fetch || (() => ({ code: 200, body: { ok: false, error: 'no_fetch_handler' } }));
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n))
  };
  const ctx = {
    console,
    JSON, Math, Date, Number, String, Object, Array, RegExp, Error, encodeURIComponent,
    module: undefined,
    SpreadsheetApp: { getActive: () => ss,
      openById: (id) => ({ getSheetByName: (n) => (external[id] && external[id][n]) ? { getDataRange: () => ({ getValues: () => external[id][n].map(r => r.slice()) }) } : null }), getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addToUi() {} }) }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    Utilities: {
      formatDate: (d, tz, fmt) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10),
      getUuid: () => 'u-' + Math.random().toString(36).slice(2, 10),
      sleep: () => {}
    },
    UrlFetchApp: { fetch: (url, o) => {
      const r = fetchHandler(url, o) || {};
      return { getResponseCode: () => r.code || 200, getHeaders: () => r.headers || {}, getContentText: () => JSON.stringify(r.body || {}) };
    } },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) }
  };
  vm.createContext(ctx);
  const root = path.join(__dirname, '..');
  vm.runInContext(fs.readFileSync(path.join(root, 'Parser.gs'), 'utf8'), ctx, { filename: 'Parser.gs' });
  vm.runInContext(fs.readFileSync(path.join(root, 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  return { ctx, ss, props, setFetch: (f) => { fetchHandler = f; } };
}

module.exports = { loadGas };
