const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  AUDIT_SQL,
  createRobinhoodInsiderShadowAuditor,
} = require('../src/services/robinhood-insider-shadow-auditor');
const {
  main,
  parseArgs,
} = require('../src/utils/audit-robinhood-holder-insiders');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const CREATOR = `0x${'3'.repeat(40)}`;
const TX = `0x${'a'.repeat(64)}`;

describe('Robinhood INSIDER shadow auditor', () => {
  it('reports aggregate divergence and bounded evidence samples read-only', async () => {
    const calls = [];
    const auditor = createRobinhoodInsiderShadowAuditor({
      database: { query() {}, queryWithStatementTimeout: async (...args) => {
        calls.push(args);
        return { rows: [{
          eligible_wallets: 4, classified_wallets: 3, matched: 1,
          pending: 1, stale: 0, missing: 1, invalid: 1,
          snapshot_tokens: 3, current_snapshot_tokens: 2,
          outcome: 'missing_classification', token_address: TOKEN,
          wallet_address: WALLET, creator_address: CREATOR,
          transaction_hash: TX, transfer_block: '100',
          transfer_log_index: '2', amount_raw: '500',
        }] };
      } },
    });
    const report = await auditor.audit({
      sampleLimit: 5, seed: 'review-1', statementTimeoutMs: 2000,
    });
    assert.equal(report.mode, 'read-only');
    assert.equal(report.verdict, 'divergence');
    assert.deepEqual(report.summary, {
      eligibleWallets: 4, classifiedWallets: 3, matched: 1,
      pending: 1, stale: 0, missing: 1, invalid: 1,
      snapshotTokens: 3, currentSnapshotTokens: 2,
    });
    assert.deepEqual(report.samples[0], {
      outcome: 'missing_classification', tokenAddress: TOKEN,
      walletAddress: WALLET, creatorAddress: CREATOR,
      transactionHash: TX, blockNumber: '100', logIndex: '2', amountRaw: '500',
    });
    assert.deepEqual(calls[0].slice(1), [['rh_holder_v1', 'review-1', 5], 2000]);
  });

  it('mirrors exclusions, prioritizes findings, and rejects unsafe controls', async () => {
    assert.match(AUDIT_SQL, /robinhood_infrastructure_registry/);
    assert.match(AUDIT_SQL, /robinhood_pool_registry/);
    assert.match(AUDIT_SQL, /classification_without_eligible_evidence/);
    assert.match(AUDIT_SQL, /COALESCE\(eligible\.transaction_hash/);
    assert.match(AUDIT_SQL, /WHEN 'missing_classification' THEN 0/);
    const auditor = createRobinhoodInsiderShadowAuditor({
      database: { query: async () => ({ rows: [] }) },
    });
    assert.equal((await auditor.audit()).verdict, 'no_data');
    await assert.rejects(auditor.audit({ sampleLimit: 101 }), /sampleLimit/);
    await assert.rejects(auditor.audit({ seed: 'Bad Seed' }), /seed/);
  });
});

describe('Robinhood INSIDER shadow audit command', () => {
  it('parses bounded read-only options and prints the report', async () => {
    assert.deepEqual(parseArgs([
      '--limit=7', '--seed=review-2', '--statement-timeout-ms=3000',
    ]), { sampleLimit: 7, seed: 'review-2', statementTimeoutMs: 3000 });
    assert.throws(() => parseArgs(['--apply']), /unknown argument/);
    assert.throws(() => parseArgs(['--limit=0']), /--limit/);
    const calls = [];
    const report = await main(['--limit=7'], {
      database: {}, logger: { log: (value) => calls.push(value) },
      auditorFactory: () => ({ audit: async (options) => ({
        mode: 'read-only', verdict: 'clean', options,
      }) }),
    });
    assert.equal(report.verdict, 'clean');
    assert.equal(JSON.parse(calls[0]).options.sampleLimit, 7);
  });
});
