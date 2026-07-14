/* ============================================================
   Txform.ph — filing-core tests

   Locks the pure filing-lifecycle logic (app/filing-core.js): period-key
   encoding shared with the SQL/PHP layer, filing-status resolution over
   snapshot history, live-vs-filed variance, and the form↔workflow map.
   These functions decide what gets frozen and when a filed return has
   drifted, so a regression here is a correctness bug in the save/freeze
   feature — fail loudly in CI.

   filing-core.js dual-exports (module.exports), so it loads directly with
   require — no vm sandbox needed (unlike the browser-global report calcs).
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const FC = require('../app/filing-core.js');

test('periodKey encodes quarterly/monthly/annual to match the SQL regex', () => {
  const re = /^[a-z]+:\d{4}(:\d{1,2})?$/; // save-report.php's validator
  const q = FC.periodKey({ ptype: 'quarterly', year: 2026, period: 1 });
  const m = FC.periodKey({ ptype: 'monthly', year: 2026, period: 0 });
  const a = FC.periodKey({ ptype: 'annual', year: 2026 });
  assert.equal(q, 'quarterly:2026:1');
  assert.equal(m, 'monthly:2026:0');
  assert.equal(a, 'annual:2026');
  [q, m, a].forEach(k => assert.ok(re.test(k), `${k} must satisfy the endpoint regex`));
});

test('periodKey returns null for an incomplete period', () => {
  assert.equal(FC.periodKey(null), null);
  assert.equal(FC.periodKey({ ptype: 'quarterly' }), null);
});

test('parsePeriodKey round-trips a periodKey', () => {
  assert.deepEqual(FC.parsePeriodKey('quarterly:2026:3'), { ptype: 'quarterly', year: 2026, period: 3 });
  assert.deepEqual(FC.parsePeriodKey('annual:2025'), { ptype: 'annual', year: 2025 });
});

test('periodLabel is human-friendly (month is 0-based)', () => {
  assert.equal(FC.periodLabel({ ptype: 'quarterly', year: 2026, period: 2 }), 'Q2 2026');
  assert.equal(FC.periodLabel({ ptype: 'monthly', year: 2026, period: 0 }), 'January 2026');
  assert.equal(FC.periodLabel({ ptype: 'annual', year: 2026 }), 'Annual 2026');
});

test('formToWorkflow maps each BIR form to its workflow (income split by form)', () => {
  assert.equal(FC.formToWorkflow('2550Q'), 'vat');
  assert.equal(FC.formToWorkflow('0619E'), 'expanded');
  assert.equal(FC.formToWorkflow('1601EQ'), 'expanded');
  assert.equal(FC.formToWorkflow('1601C'), 'compensation');
  assert.equal(FC.formToWorkflow('1701Q'), 'individual');
  assert.equal(FC.formToWorkflow('1702Q'), 'nonindividual');
  assert.equal(FC.formToWorkflow('NOPE'), null);
});

test('headlineFor returns the window var + field the freeze reads', () => {
  assert.deepEqual(FC.headlineFor('vat'), { winVar: '_v', field: 'i61', label: 'Net VAT payable' });
  assert.equal(FC.headlineFor('individual').winVar, '_itr');
  assert.equal(FC.headlineFor('unknown'), null);
});

test('currentSnapshot picks the highest-version filed row', () => {
  const history = [
    { version: 1, status: 'superseded', headline: { amount: 100 } },
    { version: 2, status: 'filed', headline: { amount: 250 } },
  ];
  assert.equal(FC.currentSnapshot(history).version, 2);
  assert.equal(FC.currentSnapshot([]), null);
});

test('currentSnapshot treats a null status (batch view) as filed', () => {
  const batch = [{ version: 1, headline: { amount: 5 } }];
  assert.equal(FC.currentSnapshot(batch).version, 1);
});

test('resolveFilingStatus: draft / filed / amended', () => {
  assert.equal(FC.resolveFilingStatus([]), 'draft');
  assert.equal(FC.resolveFilingStatus([{ version: 1, status: 'filed' }]), 'filed');
  assert.equal(FC.resolveFilingStatus([
    { version: 1, status: 'superseded' },
    { version: 2, status: 'filed' },
  ]), 'amended');
});

test('computeVariance flags a change beyond a centavo', () => {
  const filed = { label: 'Net VAT payable', amount: 1000 };
  const same = FC.computeVariance(filed, 1000);
  assert.equal(same.changed, false);
  assert.equal(same.delta, 0);

  const drift = FC.computeVariance(filed, 1200.5);
  assert.equal(drift.changed, true);
  assert.equal(drift.filedAmount, 1000);
  assert.equal(drift.liveAmount, 1200.5);
  assert.equal(drift.delta, 200.5);
});

test('computeVariance tolerates sub-centavo float noise', () => {
  const v = FC.computeVariance({ amount: 1000 }, 1000.004);
  assert.equal(v.changed, false);
});

test('computeVariance is inconclusive when either side is missing', () => {
  assert.equal(FC.computeVariance({ amount: 1000 }, null).changed, false);
  assert.equal(FC.computeVariance({}, 500).changed, false);
  assert.equal(FC.computeVariance({ amount: 1000 }, NaN).liveAmount, null);
});
