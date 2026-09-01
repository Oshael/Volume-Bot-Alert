process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const { createRobinhoodBundleRedistributionSnapshotRepository } = require(
  '../src/models/robinhood-bundle-redistribution-snapshot'
);
const { evaluateBundleRedistribution } = require(
  '../src/services/robinhood-bundle-redistribution-policy'
);
const stage187 = require('../src/utils/db-init-stage187');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const TOKEN = `0x${'9'.repeat(40)}`;
const SOURCE = `0x${'1'.repeat(40)}`;
const CREATOR = `0x${'2'.repeat(40)}`;
const A = `0x${'3'.repeat(40)}`; const B = `0x${'4'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`; const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;
function recipient(walletAddress, block, delayMs) {
  const receivedAt = Date.parse('2026-09-01T12:01:00Z');
  return { walletAddress, transfer: { blockNumber: String(block), transactionIndex: '0',
    logIndex: '1', transactionHash: HASH_B, blockTime: new Date(receivedAt).toISOString(),
    amountRaw: '100' }, firstSell: { blockNumber: String(block + 1), transactionIndex: '1',
    actionIndex: '2', transactionHash: HASH_C,
    blockTime: new Date(receivedAt + delayMs).toISOString(), delayMs, fdvUsd: null } };
}

function snapshot(runId, throughBlockNumber, throughBlockHash, grouped = true) {
  const result = evaluateBundleRedistribution({ tokenAddress: TOKEN, sourceWallet: SOURCE,
    creatorAddress: CREATOR, barrierAddresses: [], sourceBuy: { blockNumber: '10',
      transactionIndex: '0', actionIndex: '1', transactionHash: HASH_A,
      blockTime: '2026-09-01T12:00:00Z', fdvUsd: 50_000 },
    recipients: [recipient(A, 20, 60_000), recipient(B, 30, 300_000)] });
  return { state: { tokenAddress: TOKEN, ruleVersion: result.ruleVersion,
    evidenceVersion: result.evidenceVersion, status: 'ready',
    statusReason: grouped ? 'groups_found' : 'no_groups', sourceKind: 'seed',
    sourceRunId: runId, throughBlockNumber, throughBlockHash,
    policyJson: result.policy }, groups: grouped ? [result.group] : [] };
}

function failBeforeCommitDatabase() {
  return { async getClient() {
    const client = await db.getClient();
    return { release: () => client.release(), query(sql, params) {
      if (sql === 'COMMIT') throw new Error('forced commit failure');
      return client.query(sql, params);
    } };
  } };
}

async function cleanup() {
  await db.query('DELETE FROM robinhood_bundle_redistribution_states');
}

describe('Robinhood BUNDLED redistribution snapshot writer', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage187.init({ closePool: false });
    await cleanup();
  });
  after(async () => { await cleanup(); await db.pool.end(); });

  it('replaces atomically and protects policy plus canonical frontier', async () => {
    const writer = createRobinhoodBundleRedistributionSnapshotRepository({
      database: db, now: () => '2026-09-01T13:00:00Z',
    });
    assert.deepEqual(await writer.replaceSnapshot(snapshot('1', '100', HASH_A)), {
      status: 'published', groups: 1, members: 3,
    });
    assert.deepEqual((await db.query(`SELECT member_count, connection_count,
      confirmation_fdv_usd FROM robinhood_bundle_redistribution_groups`)).rows[0], {
      member_count: 3, connection_count: 2, confirmation_fdv_usd: null,
    });
    assert.equal((await db.query(`SELECT COUNT(*)::integer count
      FROM robinhood_bundle_redistribution_members
      WHERE transfer_transaction_hash IS NOT NULL AND sell_delay_ms <= 300000`)).rows[0].count, 2);

    const interrupted = createRobinhoodBundleRedistributionSnapshotRepository({
      database: failBeforeCommitDatabase(),
    });
    await assert.rejects(interrupted.replaceSnapshot(snapshot('2', '101', HASH_B, false)),
      /forced commit failure/);
    assert.equal((await db.query(`SELECT through_block_number::text
      FROM robinhood_bundle_redistribution_states`)).rows[0].through_block_number, '100');
    assert.deepEqual(await writer.replaceSnapshot(snapshot('3', '99', HASH_C)), {
      status: 'ignored', reason: 'frontier_behind',
    });
    await assert.rejects(writer.replaceSnapshot(snapshot('4', '100', HASH_C)), /frontier fork/);
    const drift = snapshot('1', '100', HASH_A);
    drift.state.policyJson = { ...drift.state.policyJson, maximumRecipientSellDelayMs: 300001 };
    await assert.rejects(writer.replaceSnapshot(drift), /policy drift/);
    const malformed = snapshot('1', '100', HASH_A);
    malformed.groups[0] = { ...malformed.groups[0], memberCount: 4 };
    await assert.rejects(writer.replaceSnapshot(malformed), /group counts/);
  });
});
