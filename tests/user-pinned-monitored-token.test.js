const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const userPinnedMonitoredToken = require('../src/models/user-pinned-monitored-token');

const originalQuery = db.query;
const originalGetClient = db.getClient;

afterEach(() => {
  db.query = originalQuery;
  db.getClient = originalGetClient;
});

function installClientStub() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  db.getClient = async () => client;
  return calls;
}

describe('user pinned monitored token model', () => {
  it('normalizes, dedupes, and persists pinned order transactionally', async () => {
    const clientCalls = installClientStub();
    db.query = async () => ({
      rows: [
        {
          address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          sort_order: 0,
          pinned_at: '2026-07-05T18:00:00.000Z',
          updated_at: '2026-07-05T18:00:00.000Z',
        },
        {
          address: 'So11111111111111111111111111111111111111112',
          sort_order: 1,
          pinned_at: '2026-07-05T18:01:00.000Z',
          updated_at: '2026-07-05T18:01:00.000Z',
        },
      ],
    });

    const rows = await userPinnedMonitoredToken.setAll(42, [
      { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      { address: 'not-a-token' },
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      { address: 'So11111111111111111111111111111111111111112', sortOrder: 8 },
    ]);

    assert.deepEqual(
      clientCalls
        .filter((call) => /INSERT INTO user_pinned_monitored_tokens/.test(call.sql))
        .map((call) => call.params),
      [
        [42, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 0],
        [42, 'So11111111111111111111111111111111111111112', 8],
      ]
    );
    assert.equal(clientCalls[0].sql, 'BEGIN');
    assert.ok(/DELETE FROM user_pinned_monitored_tokens/.test(clientCalls[1].sql));
    assert.equal(clientCalls.at(-2).sql, 'COMMIT');
    assert.equal(rows[1].sortOrder, 1);
  });

  it('removes one pin without clearing the whole user order', async () => {
    const calls = [];
    db.query = async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    };

    const removed = await userPinnedMonitoredToken.remove(
      7,
      'So11111111111111111111111111111111111111112'
    );

    assert.equal(removed, true);
    assert.deepEqual(calls[0].params, [7, 'So11111111111111111111111111111111111111112']);
    assert.match(calls[0].sql, /WHERE user_id = \$1 AND address = \$2/);
  });

  it('clears all pins for one user only', async () => {
    const calls = [];
    db.query = async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 3 };
    };

    const removed = await userPinnedMonitoredToken.removeAll(11);

    assert.equal(removed, 3);
    assert.deepEqual(calls[0].params, [11]);
    assert.match(calls[0].sql, /WHERE user_id = \$1/);
  });
});
