const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const adminBlockedToken = require('../src/models/admin-blocked-token');
const userBlocklist = require('../src/models/user-blocklist');

const EVM_MIXED = '0xAbCdEf0123456789aBCdef0123456789aBCDEf01';
const EVM_LOWER = EVM_MIXED.toLowerCase();
const originalQuery = db.query;
const originalGetClient = db.getClient;

afterEach(() => {
  db.query = originalQuery;
  db.getClient = originalGetClient;
});

describe('chain-aware blocklists', () => {
  it('normalizes Robinhood identity in user blocklist CRUD', async () => {
    const calls = [];
    db.query = async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ chain: params[1], address: params[2] }], rowCount: 1 };
    };

    await userBlocklist.add(4, EVM_MIXED, 'meme', 'robinhood');
    await userBlocklist.isBlocked(4, EVM_MIXED, 'robinhood');
    await userBlocklist.remove(4, EVM_MIXED, 'robinhood');

    assert.deepEqual(calls[0].params, [4, 'robinhood', EVM_LOWER, 'meme']);
    assert.match(calls[0].sql, /ON CONFLICT \(user_id, chain, address\)/);
    assert.deepEqual(calls[1].params, [4, 'robinhood', EVM_LOWER]);
    assert.deepEqual(calls[2].params, [4, 'robinhood', EVM_LOWER]);
  });

  it('joins catalog metadata on chain and address', async () => {
    let captured;
    db.query = async (sql, params) => {
      captured = { sql: String(sql), params };
      return { rows: [] };
    };

    await userBlocklist.getAll(8, 'robinhood');
    assert.match(captured.sql, /ON tc\.chain = ub\.chain/);
    assert.match(captured.sql, /AND tc\.address = ub\.address/);
    assert.match(captured.sql, /ub\.user_id = \$1 AND ub\.chain = \$2/);
    assert.deepEqual(captured.params, [8, 'robinhood']);
  });

  it('loads all requested workspace chains and counts one chain for its limit', async () => {
    const calls = [];
    db.query = async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      return /COUNT\(\*\)/.test(sql)
        ? { rows: [{ count: 5 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    };

    await userBlocklist.getAllForChains(8, ['solana', 'robinhood', 'robinhood']);
    const count = await userBlocklist.count(8, 'robinhood');

    assert.match(calls[0].sql, /ub\.chain = ANY\(\$2::varchar\[\]\)/);
    assert.deepEqual(calls[0].params, [8, ['solana', 'robinhood']]);
    assert.deepEqual(calls[1].params, [8, 'robinhood']);
    assert.equal(count, 5);
  });

  it('replaces only one chain and propagates database failures', async () => {
    const calls = [];
    db.getClient = async () => ({
      async query(sql, params = []) {
        calls.push({ sql: String(sql), params });
        if (/INSERT INTO user_blocklist/.test(sql)) throw new Error('blocklist write failed');
        return { rows: [], rowCount: 0 };
      },
      release() {},
    });

    await assert.rejects(
      userBlocklist.setAll(6, [EVM_MIXED], 'robinhood'),
      /blocklist write failed/
    );
    assert.deepEqual(calls[1].params, [6, 'robinhood']);
    assert.ok(calls.some((call) => call.sql === 'ROLLBACK'));
  });

  it('keeps an admin block scoped to its explicit chain', async () => {
    const calls = [];
    db.query = async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      if (/INSERT INTO admin_blocked_tokens/.test(sql)) {
        return { rows: [{ chain: params[0], address: params[1] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };

    const row = await adminBlockedToken.add({
      chain: 'robinhood',
      address: EVM_MIXED,
      label: 'manual',
      createdBy: 9,
    });

    const insert = calls.find((call) => /INSERT INTO admin_blocked_tokens/.test(call.sql));
    assert.deepEqual(row, { chain: 'robinhood', address: EVM_LOWER });
    assert.deepEqual(insert.params, ['robinhood', EVM_LOWER, 'manual', 9]);
    assert.match(insert.sql, /ON CONFLICT \(chain, address\)/);
  });
});
