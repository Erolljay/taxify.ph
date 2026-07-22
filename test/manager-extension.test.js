/* ============================================================
   Tests for server/manager-extension.js — the parse/idempotency
   helpers behind the custom-button provisioning step.

     node --test test/manager-extension.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../server/manager-extension.js');

// The batch shape api4 returns, matching what installer.html reads.
function batch(values) {
  return JSON.stringify({ items: values.map(function (v, i) { return { key: 'k' + i, item: v }; }) });
}

test('the Txform button spec matches what installer.html installs', () => {
  // The two install paths must agree, or provisioning and the manual
  // installer would create two different (or duplicate) buttons.
  assert.deepEqual(E.TXFORM_BUTTON, {
    Name: 'Txform Now!',
    Source: 0,
    Endpoint: 'https://extension.txform.ph/taxify.html',
    Placement: 'summary-view',
  });
});

test('parseExtensions: pulls the value objects out of a batch page', () => {
  const body = batch([{ Name: 'A', Endpoint: 'u1' }, { Name: 'B', Endpoint: 'u2' }]);
  assert.deepEqual(E.parseExtensions(body).map((v) => v.Endpoint), ['u1', 'u2']);
});

test('parseExtensions: an empty or absent list is no buttons, not an error', () => {
  assert.deepEqual(E.parseExtensions('{"items":[]}'), []);
  assert.deepEqual(E.parseExtensions('{}'), []);
  assert.deepEqual(E.parseExtensions(''), []);
});

test('parseExtensions: unparseable output throws rather than reading as empty', () => {
  // Treating a broken page as "nothing installed" would re-create the
  // button on every run — the exact duplicate the idempotency check exists
  // to prevent.
  assert.throws(() => E.parseExtensions('<html>not json</html>'), /could not parse/);
});

test('hasExtension: matches on the endpoint, case of the key aside', () => {
  const list = [{ Endpoint: 'https://extension.txform.ph/taxify.html' }];
  assert.equal(E.hasExtension(list, 'https://extension.txform.ph/taxify.html'), true);
  assert.equal(E.hasExtension(list, 'https://other.example/x.html'), false);
  // The proxy path has been seen to lowercase the key.
  assert.equal(E.hasExtension([{ endpoint: 'u1' }], 'u1'), true);
});

test('hasExtension: an empty list is never a match', () => {
  assert.equal(E.hasExtension([], 'u1'), false);
  assert.equal(E.hasExtension(undefined, 'u1'), false);
});
