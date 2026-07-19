/* ============================================================
   Txform.ph — workflow structure harness (Month-end Prep rewire)

   Locks the Phase 6 rewire: every workflow starts with an upfront
   readiness gate, the VAT Tax-Codes step is conditional (showIf), and
   the old per-step party-TIN checks are gone. These are declarative
   config in workflows.js, so we load it (plus reports.js for
   findReport) in a Node vm sandbox and assert the shape — a broken
   edit to the step list fails HERE instead of silently in the browser.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadWorkflows() {
  const preamble = `
    var window = globalThis;
    var self = globalThis;
    var localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    var document = { getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ style: {} }) };
    var fetch = () => Promise.reject(new Error('no network in tests'));
  `;
  const body = ['app/reports.js', 'app/workflows.js']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n;\n');
  const epilogue = `
    globalThis.__WF__ = {};
    try { globalThis.__WF__.WORKFLOWS = WORKFLOWS; } catch (e) { globalThis.__WF__.err = String(e); }
  `;
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(preamble + '\n' + body + '\n' + epilogue, ctx, { filename: 'reports+workflows' });
  return ctx.__WF__;
}

const { WORKFLOWS, err } = loadWorkflows();
const step = (wf, key) => (WORKFLOWS[wf].steps.find(s => s.key === key));

test('workflows.js loads and builds WORKFLOWS without throwing', () => {
  assert.equal(err, undefined, 'load error: ' + err);
  assert.ok(WORKFLOWS && WORKFLOWS.vat && WORKFLOWS.expanded && WORKFLOWS.compensation);
  assert.ok(WORKFLOWS.individual && WORKFLOWS.nonindividual);
});

test('VAT has an upfront readiness gate on customers + suppliers', () => {
  const s = step('vat', 'vat-readiness');
  assert.ok(s, 'vat-readiness step exists');
  assert.equal(s.type, 'checklist');
  assert.equal(s.gate, true);
  assert.equal(s.fixTab, 'customers');
  assert.equal(typeof s.check, 'function');
  // Readiness gate comes before the SLS/SLP document steps.
  const keys = WORKFLOWS.vat.steps.map(x => x.key);
  assert.ok(keys.indexOf('vat-readiness') < keys.indexOf('sls'));
  assert.ok(keys.indexOf('vat-readiness') < keys.indexOf('slp'));
});

test('VAT Tax-Codes step is conditional (showIf)', () => {
  const s = step('vat', 'vat-2550q-taxcodes');
  assert.ok(s);
  assert.equal(typeof s.showIf, 'function');
});

test('VAT SLS/SLP steps no longer carry a per-step check or fixTabSelector', () => {
  for (const key of ['sls', 'slp']) {
    const s = step('vat', key);
    assert.ok(s, key + ' exists');
    assert.equal(s.check, undefined, key + ' has no check');
    assert.equal(s.fixTabSelector, undefined, key + ' has no fixTabSelector');
  }
});

test('EWT has a readiness gate on payees and QAP has no per-step check', () => {
  const gate = step('expanded', 'ewt-readiness');
  assert.ok(gate);
  assert.equal(gate.gate, true);
  assert.equal(gate.fixTab, 'suppliers');
  const qap = step('expanded', 'qap');
  assert.equal(qap.check, undefined);
  assert.equal(qap.fixTabSelector, undefined);
});

test('Compensation replaces the tax-status review with an employee readiness gate', () => {
  assert.equal(step('compensation', 'taxstatus-check'), undefined, 'old tax-status gate removed');
  const s = step('compensation', 'comp-readiness');
  assert.ok(s);
  assert.equal(s.gate, true);
  assert.equal(s.fixTab, 'employees');
  assert.equal(typeof s.check, 'function');
});

test('Income workflows have a NON-blocking customer readiness heads-up', () => {
  for (const wf of ['individual', 'nonindividual']) {
    const s = step(wf, 'itr-readiness');
    assert.ok(s, wf + ' has itr-readiness');
    assert.notEqual(s.gate, true, wf + ' readiness is non-blocking'); // undefined/false
    assert.equal(s.fixTab, 'customers');
    assert.equal(typeof s.check, 'function');
    // SAWT step keeps its optional/skippable nature but drops the TIN check.
    const sawt = step(wf, 'itr-sawt');
    assert.equal(sawt.check, undefined);
    assert.equal(sawt.fixTabSelector, undefined);
    assert.equal(sawt.skippable, true);
  }
});
