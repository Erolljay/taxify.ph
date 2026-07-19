/* ============================================================
   Txform.ph — custom-fields.js pure-helper harness

   The Excel round-trip in the Month-end Prep party/employee editors
   hinges on two bits of pure logic:
     • partyBlobComplete / employeeBlobComplete — the type-aware
       "complete?" rule that drives both the on-screen badge and the
       upload skip decision (already-complete records are left alone).
     • fieldExportValue / fieldImportValue — select code <-> label
       conversion so a filled spreadsheet round-trips cleanly.

   These live inside custom-fields.js's browser IIFE, so we load it the
   same way report-calcs.test.js loads the report files: concatenate the
   sources into a Node `vm` sandbox with minimal browser stubs, then read
   the helpers back off window.CF.
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadCF() {
  const preamble = `
    var window = globalThis;
    var self = globalThis;
    var localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    var document = { getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ style: {} }), addEventListener: () => {} };
    var fetch = () => Promise.reject(new Error('no network in tests'));
  `;
  const body = ['shared/shared.js', 'shared/custom-fields.js']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n;\n');
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(preamble + '\n' + body, ctx);
  return ctx.window.CF;
}

const CF = loadCF();
const P = CF.PARTY_FIELDS;
const E = CF.EMPLOYEE_FIELDS;

// Build a party blob (keyed by field id) from a plain spec.
function partyBlob(spec) {
  const b = {};
  if (spec.type)    b[P[0].id] = spec.type;
  if (spec.tin)     b[P[1].id] = spec.tin;
  if (spec.company) b[P[3].id] = spec.company;
  if (spec.last)    b[P[4].id] = spec.last;
  if (spec.first)   b[P[5].id] = spec.first;
  if (spec.addr1)   b[P[7].id] = spec.addr1;
  return b;
}

test('CF exposes the helpers under test', () => {
  assert.equal(typeof CF.partyBlobComplete, 'function');
  assert.equal(typeof CF.employeeBlobComplete, 'function');
  assert.equal(typeof CF.fieldExportValue, 'function');
  assert.equal(typeof CF.fieldImportValue, 'function');
});

test('non-individual party is complete with TIN + company + address1', () => {
  assert.equal(CF.partyBlobComplete(partyBlob({
    type: 'Non-Individual', tin: '123-456-789', company: 'ABC Corp', addr1: '1 Main St',
  })), true);
});

test('non-individual is incomplete without a company name (last/first do not count)', () => {
  assert.equal(CF.partyBlobComplete(partyBlob({
    type: 'Non-Individual', tin: '123-456-789', last: 'Dela Cruz', first: 'Juan', addr1: '1 Main St',
  })), false);
});

test('individual is complete with TIN + last + first + address1 (no company needed)', () => {
  assert.equal(CF.partyBlobComplete(partyBlob({
    type: 'Individual', tin: '123-456-789', last: 'Dela Cruz', first: 'Juan', addr1: '1 Main St',
  })), true);
});

test('individual is incomplete without a first name', () => {
  assert.equal(CF.partyBlobComplete(partyBlob({
    type: 'Individual', tin: '123-456-789', last: 'Dela Cruz', addr1: '1 Main St',
  })), false);
});

test('party is incomplete when the TIN is missing', () => {
  assert.equal(CF.partyBlobComplete(partyBlob({
    type: 'Non-Individual', company: 'ABC Corp', addr1: '1 Main St',
  })), false);
});

test('party is incomplete when address1 is missing', () => {
  assert.equal(CF.partyBlobComplete(partyBlob({
    type: 'Non-Individual', tin: '123', company: 'ABC Corp',
  })), false);
});

test('blank taxpayer type defaults to Non-Individual (needs company)', () => {
  // No type set → treated as Non-Individual, so last/first alone is NOT complete.
  assert.equal(CF.partyBlobComplete(partyBlob({
    tin: '123', last: 'Dela Cruz', first: 'Juan', addr1: '1 Main St',
  })), false);
  assert.equal(CF.partyBlobComplete(partyBlob({
    tin: '123', company: 'ABC Corp', addr1: '1 Main St',
  })), true);
});

test('employee is complete with TIN + Tax Status + last + first', () => {
  const b = {};
  b[E[0].id]  = '123-456-789'; // TIN
  b[E[5].id]  = 'NMWE';        // Tax Status
  b[E[10].id] = 'Dela Cruz';   // Last Name
  b[E[11].id] = 'Juan';        // First Name
  assert.equal(CF.employeeBlobComplete(b), true);
});

test('employee is incomplete without a Tax Status', () => {
  const b = {};
  b[E[0].id]  = '123-456-789';
  b[E[10].id] = 'Dela Cruz';
  b[E[11].id] = 'Juan';
  assert.equal(CF.employeeBlobComplete(b), false);
});

test('fieldExportValue turns a select code into its human label', () => {
  const taxStatus = E[5]; // options ['','MWE','NMWE']
  assert.equal(CF.fieldExportValue(taxStatus, 'NMWE'), 'NMWE - Non-Minimum Wage Earner');
  assert.equal(CF.fieldExportValue(taxStatus, ''), '');
});

test('fieldExportValue leaves plain text untouched', () => {
  assert.equal(CF.fieldExportValue(E[0], '123-456-789'), '123-456-789');
});

test('fieldImportValue accepts a select label and returns the code', () => {
  const taxStatus = E[5];
  assert.equal(CF.fieldImportValue(taxStatus, 'NMWE - Non-Minimum Wage Earner'), 'NMWE');
});

test('fieldImportValue accepts a select code directly', () => {
  assert.equal(CF.fieldImportValue(E[5], 'MWE'), 'MWE');
});

test('fieldImportValue ignores an unrecognized select value', () => {
  assert.equal(CF.fieldImportValue(E[5], 'gibberish'), '');
});

test('fieldImportValue trims plain text and passes it through', () => {
  assert.equal(CF.fieldImportValue(E[0], '  123-456-789  '), '123-456-789');
});

test('zip4 keeps exactly 4 digits', () => {
  assert.equal(CF.zip4('5000'), '5000');
});

test('zip4 strips non-numeric characters', () => {
  assert.equal(CF.zip4('5000 Iloilo'), '5000');
  assert.equal(CF.zip4('ABC'), '');
});

test('zip4 caps at 4 digits', () => {
  assert.equal(CF.zip4('50001234'), '5000');
});

test('zip4 handles empty / null', () => {
  assert.equal(CF.zip4(''), '');
  assert.equal(CF.zip4(null), '');
  assert.equal(CF.zip4(undefined), '');
});
