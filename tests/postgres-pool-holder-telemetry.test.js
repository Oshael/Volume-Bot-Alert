'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { it } = require('node:test');
const { createPoolHolderTelemetry, sqlLabel } = require(
  '../src/models/postgres-pool-holder-telemetry'
);

it('attributes checked-out connections and removes them on release', () => {
  const pool = new EventEmitter();
  let clock = 1000;
  const telemetry = createPoolHolderTelemetry(pool, () => clock);
  const client = { processID: 42, _getActiveQuery: () => active };
  let active = { text: "SELECT * FROM wallet WHERE secret='private'" };
  pool.emit('acquire', client);
  telemetry.tag(client, 'getClient models/wallet.js:15');
  clock = 3500;
  assert.deepEqual(telemetry.snapshot(), [{
    pid: 42, heldMs: 2500, origin: 'getClient models/wallet.js:15',
    activeSql: "SELECT * FROM wallet WHERE secret='?'",
  }]);
  active = null;
  assert.equal(telemetry.snapshot()[0].activeSql, null);
  pool.emit('release', null, client);
  assert.deepEqual(telemetry.snapshot(), []);
});

it('accounts for pool acquisitions outside database wrappers without SQL parameters', () => {
  const pool = new EventEmitter();
  const telemetry = createPoolHolderTelemetry(pool, () => 100);
  const direct = { processID: 7, _getActiveQuery: () => ({ text: 'SELECT $1' }) };
  pool.emit('acquire', direct);
  assert.equal(telemetry.snapshot()[0].origin, 'pool query or direct use');
  assert.equal(telemetry.snapshot()[0].activeSql, 'SELECT $1');
  assert.equal(sqlLabel({ text: "SELECT 'another-secret'" }), "SELECT '?'");
  assert.equal(sqlLabel("SELECT E'private\\'value'"), "SELECT '?'");
});
