const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage110 = require('../src/utils/db-init-stage110');
const stage113 = require('../src/utils/db-init-stage113');
const { createRobinhoodTokenAttributionRepository } = require('../src/models/robinhood-token-attribution');
const { runDirectCreatorTick, __private: directPrivate } = require(
  '../src/services/robinhood-direct-creator-worker'
);
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const {
  CONFIRM, parseArgs, run, __private,
} = require('../src/utils/backfill-robinhood-token-creators');

const TOKEN = `0x${'a'.repeat(40)}`;
const CREATOR = `0x${'b'.repeat(40)}`;

describe('Robinhood token creator attribution', () => {
  it('registers direct RPC provenance and its independent LIVE cursor', () => {
    const sql = stage113.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage113-robinhood-direct-creator-live');
    assert.match(sql, /source IN \('blockscout', 'rpc_direct'\)/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_direct_creator_cursors/);
    assert.match(sql, /attribution_tx_hash ~ '\^0x\[0-9a-f\]\{64\}\$'/);
    assert.equal(group.repair, 'node src/utils/db-init-stage113.js');
  });

  it('captures direct deployments at the safe head and skips failed creations', async () => {
    const tx = (digit) => ({
      hash: `0x${digit.repeat(64)}`, from: `0x${digit.repeat(40)}`, to: null,
    });
    const direct = [tx('a'), tx('b')];
    let persisted;
    const client = {
      request: async (method) => method === 'eth_blockNumber' ? '0x66' : ({
        number: '0x64', hash: `0x${'c'.repeat(64)}`, timestamp: '0x1',
        transactions: [...direct, { ...tx('d'), to: TOKEN }],
      }),
      requestBatch: async () => direct.map((item, index) => ({
        transactionHash: item.hash, blockNumber: '0x64',
        blockHash: `0x${'c'.repeat(64)}`,
        contractAddress: index === 0 ? TOKEN : null,
      })),
    };
    const repository = {
      loadDirectCursor: async () => null,
      initializeDirectCursor: async () => ({ next_block: '100', safe_head: '100' }),
      recordDirectBlock: async (input) => { persisted = input; return { attributed: 1 }; },
    };
    const result = await runDirectCreatorTick({ client, repository, confirmations: 2 });
    assert.equal(result.status, 'caught-up');
    assert.equal(result.attributed, 1);
    assert.deepEqual(persisted.deployments, [{
      tokenAddress: TOKEN, creatorAddress: direct[0].from, transactionHash: direct[0].hash,
    }]);
  });

  it('fails closed when a direct-creation receipt belongs to another block', async () => {
    const txHash = `0x${'a'.repeat(64)}`;
    const client = {
      request: async () => ({
        number: '0x64', hash: `0x${'b'.repeat(64)}`, timestamp: '0x1',
        transactions: [{ hash: txHash, from: CREATOR, to: null }],
      }),
      requestBatch: async () => [{
        transactionHash: txHash, blockNumber: '0x63',
        blockHash: `0x${'b'.repeat(64)}`, contractAddress: TOKEN,
      }],
    };
    await assert.rejects(() => directPrivate.scanBlock(client, 100n), /receipt diverged/);
  });

  it('commits direct attribution and cursor advancement atomically', async () => {
    const calls = [];
    const client = {
      query: async (sql) => {
        calls.push(sql);
        return sql.startsWith('UPDATE') ? { rowCount: 1, rows: [{}] } : { rows: [] };
      },
      release: () => {},
    };
    const repository = createRobinhoodTokenAttributionRepository({
      database: { connect: async () => client },
    });
    const result = await repository.recordDirectBlock({
      blockNumber: '100', safeHead: '100', blockHash: `0x${'c'.repeat(64)}`,
      blockTimestamp: '2026-08-10T00:00:00.000Z',
      deployments: [{ tokenAddress: TOKEN, creatorAddress: CREATOR, transactionHash: `0x${'d'.repeat(64)}` }],
    });
    assert.equal(result.attributed, 1);
    assert.deepEqual(calls.map((sql) => sql.split(/\s+/)[0]), ['BEGIN', 'INSERT', 'UPDATE', 'COMMIT']);
  });

  it('registers an additive, retryable attribution table in the runtime guard', () => {
    const sql = stage110.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage110-robinhood-token-attributions'
    ));

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_token_attributions/);
    assert.match(sql, /PRIMARY KEY \(chain, token_address\)/);
    assert.match(sql, /creator_address IS NULL AND last_resolved_at IS NULL/);
    assert.match(sql, /WHERE creator_address IS NULL/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage110.js');
    assert.equal(group.tables[0].indexes[0].name, 'idx_robinhood_token_attributions_retry');
  });

  it('lists every unresolved registry token and exposes the total before the limit', async () => {
    const calls = [];
    const repository = createRobinhoodTokenAttributionRepository({
      database: {
        query: async (sql, params) => {
          calls.push({ sql, params });
          return { rows: [{
            token_address: TOKEN.toUpperCase(), discovery_block: '123', eligible_count: '588037',
          }] };
        },
      },
    });
    const retryBefore = new Date('2026-08-01T00:00:00.000Z');

    assert.deepEqual(await repository.listCreatorCandidates({ retryBefore, limit: 12 }), {
      eligible: 588037, candidates: [{ tokenAddress: TOKEN, discoveryBlock: '123' }],
    });
    assert.match(calls[0].sql, /FROM robinhood_pool_registry registry/);
    assert.doesNotMatch(calls[0].sql, /user_(?:tokens|starred_tokens|pinned_monitored_tokens)/);
    assert.match(calls[0].sql, /LEFT JOIN robinhood_token_attributions/);
    assert.match(calls[0].sql, /attribution\.creator_address IS NULL/);
    assert.match(calls[0].sql, /attribution\.last_attempted_at < \$1/);
    assert.match(calls[0].sql, /ORDER BY MIN\(registry\.discovery_block\), registry\.token_address/);
    assert.deepEqual(calls[0].params, [retryBefore.toISOString(), 12]);
  });

  it('normalizes and records a resolved direct contract creator', async () => {
    const calls = [];
    const repository = createRobinhoodTokenAttributionRepository({
      database: {
        query: async (sql, params) => {
          calls.push({ sql, params });
          return { rows: [{ token_address: params[0][0], creator_address: params[1][0] }] };
        },
      },
    });

    const row = await repository.recordAttempt({
      tokenAddress: TOKEN.toUpperCase(), creatorAddress: CREATOR.toUpperCase(),
    });
    assert.deepEqual(row, { token_address: TOKEN, creator_address: CREATOR });
    assert.deepEqual(calls[0].params, [[TOKEN], [CREATOR], [null]]);
    assert.match(calls[0].sql, /UNNEST\(\$1::varchar\[\], \$2::varchar\[\], \$3::varchar\[\]\)/);
    assert.match(calls[0].sql, /ON CONFLICT \(chain, token_address\) DO UPDATE/);
    assert.match(calls[0].sql, /COALESCE\(EXCLUDED\.creator_address[\s\S]+source = 'blockscout'/);
  });

  it('is dry-run by default and performs no Blockscout lookup or write', async () => {
    let lookups = 0;
    let writes = 0;
    const repository = {
      listCreatorCandidates: async () => ({
        eligible: 1, candidates: [{ tokenAddress: TOKEN }],
      }),
      recordAttempt: async () => { writes += 1; },
    };
    const summary = await run({
      options: { apply: false, limit: 10, sleepMs: 0, retryHours: 24 },
      repository,
      client: { getContractCreators: async () => { lookups += 1; } },
    });

    assert.deepEqual(summary, {
      apply: false, eligible: 1, candidates: 1,
      batches: 1, requests: 0, resolved: 0, unresolved: 0, failed: 0, retried: 0,
    });
    assert.equal(lookups, 0);
    assert.equal(writes, 0);
  });

  it('persists resolved, unresolved, and provider failures without hiding them', async () => {
    const candidates = [TOKEN, `0x${'c'.repeat(40)}`, `0x${'d'.repeat(40)}`]
      .map((tokenAddress) => ({ tokenAddress, discoveryBlock: '1' }));
    const attempts = [];
    let index = 0;
    const summary = await run({
      options: {
        apply: true, limit: 10, sleepMs: 0, retryHours: 24,
        batchSize: 1, concurrency: 1,
      },
      repository: {
        listCreatorCandidates: async () => ({ eligible: candidates.length, candidates }),
        recordAttempt: async (attempt) => { attempts.push(attempt); },
      },
      client: {
        getContractCreators: async ([tokenAddress]) => {
          index += 1;
          if (index === 1) return [{ tokenAddress, creatorAddress: CREATOR }];
          if (index === 2) return [{ tokenAddress, creatorAddress: null }];
          throw new Error('rate limited');
        },
      },
    });

    assert.deepEqual(summary, {
      apply: true, eligible: 3, candidates: 3,
      batches: 3, requests: 3, resolved: 1, unresolved: 1, failed: 1, retried: 0,
    });
    assert.equal(attempts[0].creatorAddress, CREATOR);
    assert.equal(attempts[1].creatorAddress, null);
    assert.equal(attempts[2].error, 'rate limited');
  });

  it('does not misclassify a persistence failure as a provider failure', async () => {
    let writes = 0;
    await assert.rejects(() => run({
      options: { apply: true, limit: 1, sleepMs: 0, retryHours: 24 },
      repository: {
        listCreatorCandidates: async () => ({
          eligible: 1, candidates: [{ tokenAddress: TOKEN }],
        }),
        recordAttempt: async () => { writes += 1; throw new Error('database unavailable'); },
      },
      client: {
        getContractCreators: async ([tokenAddress]) => [{ tokenAddress, creatorAddress: CREATOR }],
      },
    }), /database unavailable/);
    assert.equal(writes, 1);
  });

  it('retries transient provider failures with bounded exponential backoff', async () => {
    let lookups = 0;
    const waits = [];
    const timeout = Object.assign(new Error('timed out'), { code: 'timeout' });
    const result = await __private.resolveCreatorBatchWithRetry({
      getContractCreators: async ([tokenAddress]) => {
        lookups += 1;
        if (lookups < 3) throw timeout;
        return [{ tokenAddress, creatorAddress: CREATOR }];
      },
    }, [TOKEN], { requestRetries: 2, retryDelayMs: 250 }, async (ms) => waits.push(ms));

    assert.deepEqual(result, {
      creators: [{ tokenAddress: TOKEN, creatorAddress: CREATOR }], retries: 2,
    });
    assert.deepEqual(waits, [250, 500]);
    assert.equal(__private.isRetryableProviderError(
      Object.assign(new Error('server error'), { code: 'http_error', httpStatus: 500 })
    ), true);
    assert.equal(__private.isRetryableProviderError(
      Object.assign(new Error('bad request'), { code: 'http_error', httpStatus: 400 })
    ), false);
  });

  it('passes the configured request timeout to the Blockscout client', async () => {
    let clientOptions;
    const attempts = [];
    const summary = await run({
      options: {
        apply: true, limit: 1, sleepMs: 0, retryHours: 0,
        requestRetries: 0, retryDelayMs: 0, timeoutMs: 12000,
      },
      repository: {
        listCreatorCandidates: async () => ({
          eligible: 1, candidates: [{ tokenAddress: TOKEN }],
        }),
        recordAttempt: async (attempt) => { attempts.push(attempt); },
      },
      clientFactory: (options) => {
        clientOptions = options;
        return {
          getContractCreators: async ([tokenAddress]) => [{ tokenAddress, creatorAddress: CREATOR }],
        };
      },
    });

    assert.deepEqual(clientOptions, { timeoutMs: 12000 });
    assert.equal(attempts[0].creatorAddress, CREATOR);
    assert.equal(summary.resolved, 1);
  });

  it('requires explicit confirmation and validates operational bounds', () => {
    assert.equal(parseArgs([]).apply, false);
    assert.equal(parseArgs([]).limit, 1000);
    assert.equal(parseArgs([]).sleepMs, 500);
    assert.equal(parseArgs([CONFIRM, '--limit', '25', '--sleep-ms', '0']).apply, true);
    assert.throws(() => parseArgs(['--limit', '0']), /--limit/);
    assert.throws(() => parseArgs(['--limit', '10001']), /--limit/);
    assert.throws(() => parseArgs(['--sleep-ms', '-1']), /--sleep-ms/);
    assert.throws(() => parseArgs(['--retry-hours', '-1']), /--retry-hours/);
    assert.throws(() => parseArgs(['--request-retries', '6']), /--request-retries/);
    assert.throws(() => parseArgs(['--retry-delay-ms', '-1']), /--retry-delay-ms/);
    assert.throws(() => parseArgs(['--timeout-ms', '999']), /--timeout-ms/);
    assert.throws(() => parseArgs(['--timeout-ms', '15001']), /--timeout-ms/);
    assert.throws(() => parseArgs(['--batch-size', '11']), /--batch-size/);
    assert.throws(() => parseArgs(['--concurrency', '6']), /--concurrency/);
    const retries = parseArgs(['--request-retries', '3', '--retry-delay-ms', '750']);
    assert.equal(retries.requestRetries, 3);
    assert.equal(retries.retryDelayMs, 750);
    assert.equal(retries.timeoutMs, 10000);
    assert.equal(retries.batchSize, 10);
    assert.equal(retries.concurrency, 2);
    assert.equal(parseArgs(['--timeout-ms', '15000']).timeoutMs, 15000);
  });
});
