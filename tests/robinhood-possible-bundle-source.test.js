const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodPossibleBundleSource,
  __private: { BARRIERS_SQL, CANDIDATES_SQL, EVIDENCE_SQL, RUN_SQL, TOKENS_SQL },
} = require('../src/models/robinhood-possible-bundle-source');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET_A = `0x${'2'.repeat(40)}`;
const WALLET_B = `0x${'3'.repeat(40)}`;
const FUNDER = `0x${'4'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;

function run(overrides = {}) {
  return { id: '7', status: 'completed', rule_version: 'rh_possible_bundle_v1',
    evidence_version: 'rh_native_funding_v2', source_through_block: '200',
    source_through_hash: HASH, lookback_blocks: '1000', ...overrides };
}

function candidate(walletAddress, buyBlock) {
  return { token_address: TOKEN, wallet_address: walletAddress, launch_block: '100',
    first_buy_block: String(buyBlock), first_buy_transaction_index: '1' };
}

function database(rows = {}) {
  const calls = [];
  return {
    calls,
    async queryWithStatementTimeout(sql, params, timeout) {
      calls.push({ sql, params, timeout });
      return { rows: rows[sql] || [] };
    },
  };
}

describe('Robinhood possible-bundle PostgreSQL source', () => {
  it('paginates only frozen tokens from a completed v2 run', async () => {
    const db = database({ [RUN_SQL]: [run()], [TOKENS_SQL]: [
      { token_address: TOKEN },
    ] });
    const source = createRobinhoodPossibleBundleSource({ database: db });
    assert.deepEqual(await source.listSeedTokens({
      runId: 7, afterToken: WALLET_A, limit: 10,
    }), [TOKEN]);
    assert.deepEqual(db.calls[1].params, ['7', WALLET_A, 10]);
    assert.match(TOKENS_SQL, /GROUP BY token_address HAVING COUNT\(\*\) >= 2/);
    const unavailable = database({ [RUN_SQL]: [run({ status: 'running' })] });
    await assert.rejects(createRobinhoodPossibleBundleSource({ database: unavailable })
      .listSeedTokens({ runId: 7 }), /seed run is not ready/);
  });

  it('loads one bounded token scope in the pure materializer contract', async () => {
    const db = database({
      [RUN_SQL]: [run()],
      [CANDIDATES_SQL]: [candidate(WALLET_A, 101), candidate(WALLET_B, 102)],
      [EVIDENCE_SQL]: [{ token_address: TOKEN, candidate_wallet: WALLET_A, hop: 1,
        block_number: '99', transaction_index: '2', transaction_hash: TX,
        from_wallet: FUNDER, to_wallet: WALLET_A, value_wei: '50' }],
      [BARRIERS_SQL]: [{ address: FUNDER }],
    });
    const result = await createRobinhoodPossibleBundleSource({
      database: db, statementTimeoutMs: 5_000,
    }).loadSeedToken({ runId: 7, tokenAddress: TOKEN.toUpperCase() });

    assert.equal(result.ready, true);
    assert.equal(result.sourceKind, 'seed');
    assert.equal(result.sourceRunId, '7');
    assert.equal(result.evidenceVersion, 'rh_native_funding_v2');
    assert.deepEqual(result.candidates[0], {
      tokenAddress: TOKEN, walletAddress: WALLET_A, launchBlock: '100',
      firstBuyBlock: '101', firstBuyTransactionIndex: '1',
    });
    assert.deepEqual(result.evidence[0], {
      tokenAddress: TOKEN, candidateWallet: WALLET_A, hop: 1,
      blockNumber: '99', transactionIndex: '2', transactionHash: TX,
      fromAddress: FUNDER, toAddress: WALLET_A, valueWei: '50',
    });
    assert.deepEqual(result.barrierAddresses, [FUNDER]);
    assert.equal(db.calls.length, 4);
    assert.equal(db.calls.every(({ timeout }) => timeout === 5_000), true);
    assert.match(BARRIERS_SQL, /robinhood_infrastructure_registry/);
    assert.match(BARRIERS_SQL, /robinhood_pool_registry/);
    assert.match(BARRIERS_SQL, /valid_from_block <= actor\.observed_block/);
  });

  it('fails closed before graph reads when the frozen run is unusable', async () => {
    for (const [row, reason] of [
      [null, 'funding_run_missing'],
      [run({ status: 'running' }), 'funding_run_incomplete'],
      [run({ evidence_version: 'rh_native_funding_v1' }), 'funding_lineage_unsupported'],
      [run({ lookback_blocks: '0' }), 'funding_policy_invalid'],
    ]) {
      const db = database({ [RUN_SQL]: row ? [row] : [] });
      const result = await createRobinhoodPossibleBundleSource({ database: db })
        .loadSeedToken({ runId: 7, tokenAddress: TOKEN });
      assert.equal(result.reason, reason);
      assert.equal(db.calls.length, 1);
    }
  });

  it('bounds candidates and exact evidence independently', async () => {
    const tooManyCandidates = database({
      [RUN_SQL]: [run()],
      [CANDIDATES_SQL]: [candidate(WALLET_A, 101), candidate(WALLET_B, 102)],
    });
    assert.equal((await createRobinhoodPossibleBundleSource({
      database: tooManyCandidates, maxCandidatesPerToken: 1,
    }).loadSeedToken({ runId: 7, tokenAddress: TOKEN })).reason,
    'bundle_token_candidate_cap_exceeded');

    const tooMuchEvidence = database({
      [RUN_SQL]: [run()],
      [CANDIDATES_SQL]: [candidate(WALLET_A, 101), candidate(WALLET_B, 102)],
      [EVIDENCE_SQL]: [{}, {}],
    });
    assert.equal((await createRobinhoodPossibleBundleSource({
      database: tooMuchEvidence, maxEvidenceRowsPerToken: 1,
    }).loadSeedToken({ runId: 7, tokenAddress: TOKEN })).reason,
    'bundle_token_evidence_cap_exceeded');
    assert.equal(tooMuchEvidence.calls.some(({ sql }) => sql === BARRIERS_SQL), false);
  });

  it('requires at least two frozen candidates but permits no qualifying evidence', async () => {
    const small = database({ [RUN_SQL]: [run()], [CANDIDATES_SQL]: [candidate(WALLET_A, 101)] });
    assert.equal((await createRobinhoodPossibleBundleSource({ database: small })
      .loadSeedToken({ runId: 7, tokenAddress: TOKEN })).reason,
    'bundle_token_candidate_scope_too_small');

    const empty = database({ [RUN_SQL]: [run()],
      [CANDIDATES_SQL]: [candidate(WALLET_A, 101), candidate(WALLET_B, 102)] });
    const result = await createRobinhoodPossibleBundleSource({ database: empty })
      .loadSeedToken({ runId: 7, tokenAddress: TOKEN });
    assert.equal(result.ready, true);
    assert.deepEqual(result.evidence, []);
  });
});
