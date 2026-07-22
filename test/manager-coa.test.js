/* ============================================================
   Tests for server/manager-coa.js — the batch parse/transform and
   PUT-result helpers behind the chart-of-accounts copy step.

     node --test test/manager-coa.test.js
   ============================================================ */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../server/manager-coa.js');

test('COA_COLLECTIONS lists the five collections in dependency order', () => {
  // Groups and subtotals before the accounts that reference them, so every
  // reference already exists by the time it is written. Matches Manager's
  // own Replicator order.
  assert.deepEqual(C.COA_COLLECTIONS, [
    '/api4/balance-sheet-group-batch',
    '/api4/profit-and-loss-statement-group-batch',
    '/api4/subtotal-batch',
    '/api4/balance-sheet-account-batch',
    '/api4/profit-and-loss-statement-account-batch',
  ]);
});

test('batchGetPath: capital Business, plus Skip and PageSize', () => {
  assert.equal(
    C.batchGetPath('/api4/subtotal-batch', '0000 Chart of Accounts', 50),
    '/api4/subtotal-batch?Business=0000%20Chart%20of%20Accounts&Skip=50&PageSize=' + C.PAGE_SIZE);
});

test('parseBatchItems: reads the items array, tolerant of empties', () => {
  assert.deepEqual(C.parseBatchItems('{"items":[{"key":"k1","item":{"name":"A"}}]}'),
    [{ key: 'k1', item: { name: 'A' } }]);
  assert.deepEqual(C.parseBatchItems('{"items":[]}'), []);
  assert.deepEqual(C.parseBatchItems('{}'), []);
  assert.deepEqual(C.parseBatchItems(''), []);
});

test('parseBatchItems: unparseable output throws rather than reading as empty', () => {
  assert.throws(() => C.parseBatchItems('<html>nope</html>'), /could not parse/);
});

test('toValues: turns { key, item } into { key, value }, keeping the GUID', () => {
  // Preserving the key is the whole point — it is what keeps an account's
  // group reference valid in the destination.
  assert.deepEqual(
    C.toValues([{ key: 'g1', item: { name: 'Assets' } }, { key: 'a1', item: { name: 'Cash', group: 'g1' } }]),
    [{ key: 'g1', value: { name: 'Assets' } }, { key: 'a1', value: { name: 'Cash', group: 'g1' } }]);
});

test('putSucceeded: Manager answers a good batch PUT with true (or empty)', () => {
  assert.equal(C.putSucceeded({ status: 200, body: 'true' }), true);
  assert.equal(C.putSucceeded({ status: 200, body: '' }), true);
  assert.equal(C.putSucceeded({ status: 200, body: true }), true);
});

test('putSucceeded: an error body or 4xx/5xx is a failure', () => {
  assert.equal(C.putSucceeded({ status: 200, body: '{"message":"bad group"}' }), false);
  assert.equal(C.putSucceeded({ status: 500, body: '' }), false);
  assert.equal(C.putSucceeded({ status: 400, body: 'true' }), false);
  assert.equal(C.putSucceeded(null), false);
});

test('putError: surfaces Manager\'s message, else the status', () => {
  assert.match(C.putError({ status: 200, body: '{"message":"bad group"}' }), /bad group/);
  assert.match(C.putError({ status: 500, body: '' }), /http 500/);
});
