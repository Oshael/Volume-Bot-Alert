const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const userBootstrapToken = require('../src/models/user-bootstrap-token');
const userStarredToken = require('../src/models/user-starred-token');
const userToken = require('../src/models/user-token');

const SOLANA = 'So11111111111111111111111111111111111111112';
const EVM_MIXED = '0xAbCdEf0123456789aBCdef0123456789aBCDEf01';
const EVM_LOWER = EVM_MIXED.toLowerCase();
const originalQuery = db.query;
const originalGetClient = db.getClient;

afterEach(() => {
  db.query = originalQuery;
  db.getClient = originalGetClient;
});

function installClient() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  db.getClient = async () => client;
  return calls;
}

describe('chain-aware user token preferences', () => {
  it('normalizes explicit Robinhood identity in manual token CRUD', async () => {
    const calls = [];
    db.query = async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ chain: params[1], address: params[2] }], rowCount: 1 };
    };

    await userToken.add(7, EVM_MIXED, null, 'robinhood');
    await userToken.exists(7, EVM_MIXED, 'robinhood');
    await userToken.remove(7, EVM_MIXED, 'robinhood');

    assert.deepEqual(calls[0].params, [7, 'robinhood', EVM_LOWER, null]);
    assert.match(calls[0].sql, /ON CONFLICT \(user_id, chain, address\)/);
    assert.deepEqual(calls[1].params, [7, 'robinhood', EVM_LOWER]);
    assert.deepEqual(calls[2].params, [7, 'robinhood', EVM_LOWER]);
  });

  it('keeps legacy reads and counts explicitly scoped to Solana', async () => {
    const calls = [];
    db.query = async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ count: 0 }] };
    };

    await userToken.getAll(3);
    await userToken.count(3);

    assert.ok(calls.every((call) => /chain = \$2/.test(call.sql)));
    assert.ok(calls.every((call) => call.params[1] === 'solana'));
    await assert.rejects(userToken.add(3, EVM_MIXED), /Invalid solana token address/);
  });

  it('replaces only the requested chain for manual tokens', async () => {
    const calls = installClient();
    await userToken.setAll(9, [{ address: EVM_MIXED, label: 'RH' }, SOLANA], 'robinhood');

    assert.match(calls[1].sql, /DELETE FROM user_tokens WHERE user_id = \$1 AND chain = \$2/);
    assert.deepEqual(calls[1].params, [9, 'robinhood']);
    const inserts = calls.filter((call) => /INSERT INTO user_tokens/.test(call.sql));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].params, [9, 'robinhood', EVM_LOWER, 'RH']);
  });

  it('scopes starred and bootstrap replacements without cross-chain deletion', async () => {
    const calls = installClient();
    await userStarredToken.setAll(12, [EVM_MIXED], 'robinhood');
    await userBootstrapToken.setAll(12, [EVM_MIXED], 'robinhood');

    const deletes = calls.filter((call) => /^DELETE FROM user_(starred|bootstrap)_tokens/.test(call.sql));
    assert.equal(deletes.length, 2);
    assert.ok(deletes.every((call) => call.params[1] === 'robinhood'));
    const inserts = calls.filter((call) => /^INSERT INTO user_(starred|bootstrap)_tokens/.test(call.sql));
    assert.equal(inserts.length, 2);
    assert.ok(inserts.every((call) => call.params[2] === EVM_LOWER));
    assert.ok(inserts.every((call) => /ON CONFLICT \(user_id, chain, address\)/.test(call.sql)));
  });

  it('reads both workspace chains and persists stars incrementally per chain', async () => {
    const calls = [];
    db.query = async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: 4 }], rowCount: 1 };
      if (/INSERT INTO user_starred_tokens/.test(sql)) {
        return { rows: [{ chain: params[1], address: params[2] }], rowCount: 1 };
      }
      if (/DELETE FROM user_starred_tokens/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };

    await userToken.getAllForChains(7, ['solana', 'robinhood', 'robinhood']);
    await userStarredToken.getAllForChains(7, ['solana', 'robinhood']);
    const starred = await userStarredToken.add(7, EVM_MIXED, 'robinhood');
    const count = await userStarredToken.count(7, 'robinhood');
    const removed = await userStarredToken.remove(7, EVM_MIXED, 'robinhood');

    assert.match(calls[0].sql, /LEFT JOIN token_catalog tc/);
    assert.match(calls[0].sql, /LEFT JOIN robinhood_published_holder_summaries holder_summary/);
    assert.deepEqual(calls[0].params, [7, ['solana', 'robinhood']]);
    assert.match(calls[1].sql, /chain = ANY\(\$2::varchar\[\]\)/);
    assert.deepEqual(starred, { chain: 'robinhood', address: EVM_LOWER });
    assert.equal(count, 4);
    assert.equal(removed, true);
    assert.ok(calls.slice(2).every((call) => call.params[1] === 'robinhood'));
  });

  it('rolls back instead of swallowing preference persistence failures', async () => {
    const calls = [];
    db.getClient = async () => ({
      async query(sql) {
        calls.push(String(sql));
        if (/INSERT INTO user_tokens/.test(sql)) throw new Error('database write failed');
        return { rows: [], rowCount: 0 };
      },
      release() {},
    });

    await assert.rejects(userToken.setAll(5, [SOLANA]), /database write failed/);
    assert.ok(calls.includes('ROLLBACK'));
    assert.ok(!calls.includes('COMMIT'));
  });
});
