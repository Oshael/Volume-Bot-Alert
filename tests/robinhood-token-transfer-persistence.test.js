const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage128 = require('../src/utils/db-init-stage128');
const stage138 = require('../src/utils/db-init-stage138');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const {
  RAW_RETENTION_DAYS,
  createRobinhoodTokenTransferRepository,
  __private: { dayBounds, dayKey, normalizeTransferEvent, partitionName },
} = require('../src/models/robinhood-token-transfer-persistence');

function event(overrides = {}) {
  return {
    blockNumber: '100', blockHash: `0x${'a'.repeat(64)}`,
    blockTime: '2026-08-14T23:59:59.000Z',
    transactionHash: `0x${'b'.repeat(64)}`, transactionIndex: '2', logIndex: '3',
    tokenAddress: `0x${'1'.repeat(40)}`, fromWallet: `0x${'0'.repeat(40)}`,
    toWallet: `0x${'2'.repeat(40)}`, amountRaw: '0', ...overrides,
  };
}

function fakeDb() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: /^INSERT/.test(sql.trim()) ? 2 : 0 };
    },
  };
}

describe('Robinhood token transfer persistence', () => {
  it('defines the narrow partitioned Stage 128 and the inactive retention contract', () => {
    const sql = stage128.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => key === 'stage128-robinhood-token-transfer-events');

    assert.match(sql, /PARTITION BY RANGE \(block_time\)/);
    assert.match(sql, /PRIMARY KEY \(\s*chain, transaction_hash, log_index, block_time/);
    assert.match(sql, /classification_version IS NOT NULL/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)|DELETE\s+FROM/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage128.js');
    assert.equal(group.tables[0].indexes.length, 3);
    assert.equal(RAW_RETENTION_DAYS, 30);
  });

  it('adds wallet_self as a durable non-edge kind in Stage 138', () => {
    const sql = stage138.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage138-robinhood-wallet-self-transfer-kind'
    ));
    assert.match(sql, /wallet_self/);
    assert.match(sql, /NOT VALID/);
    assert.match(sql, /VALIDATE CONSTRAINT rh_token_transfer_events_kind_check/);
    assert.match(sql, /UPDATE robinhood_token_transfer_events/);
    assert.match(sql, /from_wallet = to_wallet/);
    assert.match(sql, /wallet_transfer' OR from_wallet <> to_wallet/);
    assert.doesNotMatch(sql, /DELETE|DROP\s+(?:TABLE|COLUMN)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage138.js');
  });

  it('derives strict UTC daily partition identities', () => {
    const date = new Date('2026-08-14T23:59:59.000Z');
    assert.equal(dayKey(date), '2026-08-14');
    assert.equal(partitionName('2026-08-14'), 'robinhood_token_transfer_events_2026_08_14');
    assert.deepEqual(dayBounds('2026-08-14'), {
      from: '2026-08-14T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z',
    });
    assert.throws(() => dayBounds('2026-02-31'), /valid UTC day/);
  });

  it('preserves zero-value raw evidence and defaults it to unclassified', () => {
    const row = normalizeTransferEvent(event());
    assert.equal(row.amount_raw, '0');
    assert.equal(row.transfer_kind, 'unclassified');
    assert.equal(row.classification_version, null);
    assert.equal(row.__dayKey, '2026-08-14');
    assert.equal(normalizeTransferEvent(event({ transferKind: 'mint', classificationVersion: 'v1' })).transfer_kind, 'mint');
    assert.equal(normalizeTransferEvent(event({
      transferKind: 'wallet_self', classificationVersion: 'rh_transfer_v1',
    })).transfer_kind, 'wallet_self');
  });

  it('rejects malformed evidence and inconsistent classification metadata', () => {
    assert.throws(() => normalizeTransferEvent(event({ tokenAddress: `0x${'0'.repeat(40)}` })), /cannot be zero/);
    assert.throws(() => normalizeTransferEvent(event({ logIndex: '2147483648' })), /exceeds PostgreSQL integer/);
    assert.throws(() => normalizeTransferEvent(event({ classificationVersion: 'v1' })), /cannot have/);
    assert.throws(() => normalizeTransferEvent(event({ transferKind: 'mint' })), /require a valid/);
  });

  it('ensures sorted daily partitions before one idempotent bulk insert', async () => {
    const database = fakeDb();
    const repository = createRobinhoodTokenTransferRepository({ database });
    const result = await repository.insertTransferEvents([
      event({ blockTime: '2026-08-15T00:00:00.000Z', transactionHash: `0x${'c'.repeat(64)}` }),
      event(),
    ]);
    const partitions = database.calls.filter(({ sql }) => /PARTITION OF/.test(sql));
    const insert = database.calls.find(({ sql }) => /^INSERT/.test(sql.trim()));

    assert.deepEqual(result, { inserted: 2, ensuredDays: ['2026-08-14', '2026-08-15'] });
    assert.equal(database.calls.indexOf(insert) > database.calls.indexOf(partitions[1]), true);
    assert.match(insert.sql, /ON CONFLICT \(chain, transaction_hash, log_index, block_time\) DO NOTHING/);
    assert.equal(JSON.parse(insert.params[0]).every((row) => row.chain === 'robinhood'), true);
  });
});
