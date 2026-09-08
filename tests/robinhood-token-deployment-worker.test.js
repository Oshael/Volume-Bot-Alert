const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  createRobinhoodTokenDeploymentWorker,
  __private: { buildRuntime, createLocalCodeTransitionResolver },
} = require('../src/services/robinhood-token-deployment-worker');
const {
  createRobinhoodTokenDeploymentOutboxRepository,
} = require('../src/models/robinhood-token-deployment-outbox');

const TOKEN = `0x${'a'.repeat(40)}`;
const TOKEN_B = `0x${'d'.repeat(40)}`;
const DEPLOYMENT = { tokenAddress: TOKEN, source: 'rpc_direct' };
const BLOCK_HASH = `0x${'c'.repeat(64)}`;
const TRANSACTION_HASH = `0x${'b'.repeat(64)}`;

function runtime(overrides = {}) {
  const calls = [];
  return {
    calls,
    value: {
      outbox: {
        claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1 }),
        isExact: async () => false,
        complete: async () => { calls.push('complete'); },
        retry: async (input) => { calls.push(['retry', input.error]); },
      },
      attributions: { recordVerifiedDirectDeployments: async () => { calls.push('attributed'); } },
      ...overrides,
    },
  };
}

it('materializes exact deployment evidence before completing the outbox task', async () => {
  const transition = {
    tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
  };
  const fixture = runtime({
    outbox: {
      claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1, createdAt: new Date() }),
      isExact: async () => false,
      findMintHint: async () => transition,
      complete: async () => { fixture.calls.push('complete'); },
      retry: async () => { throw new Error('must not retry'); },
    },
    localResolver: { verify: async () => transition },
    creatorSource: {
      readRange: async () => new Map([['100', { deployments: [DEPLOYMENT] }]]),
    },
    attributions: {
      recordCodeTransitions: async () => { fixture.calls.push('transition'); },
      recordVerifiedDirectDeployments: async () => { fixture.calls.push('attributed'); },
    },
  });
  const worker = createRobinhoodTokenDeploymentWorker({ runtime: fixture.value, owner: 'test' });
  const result = await worker.runOnce();
  assert.equal(result.status, 'resolved');
  assert.deepEqual(fixture.calls, ['transition', 'attributed', 'complete']);
});

it('drains a bounded deployment batch concurrently', async () => {
  const completed = [];
  const worker = createRobinhoodTokenDeploymentWorker({
    owner: 'test',
    runtime: {
      outbox: {
        claimBatch: async (input) => {
          assert.equal(input.limit, 64);
          return [TOKEN, TOKEN_B].map((tokenAddress) => ({
            tokenAddress, attemptCount: 1, createdAt: new Date(),
          }));
        },
        isExact: async () => false,
        findMintHint: async (tokenAddress) => ({
          tokenAddress, blockNumber: '100', blockHash: BLOCK_HASH,
          transactionHash: TRANSACTION_HASH,
        }),
        complete: async ({ tokenAddress }) => { completed.push(tokenAddress); },
        retry: async () => { throw new Error('must not retry'); },
      },
      localResolver: { verify: async (input) => input },
      creatorSource: { readRange: async () => new Map([['100', { deployments: [] }]]) },
      attributions: {
        recordCodeTransitions: async () => {},
        recordVerifiedDirectDeployments: async () => { throw new Error('must not invent creator'); },
      },
    },
  });
  const result = await worker.runOnce();
  assert.deepEqual(result, {
    status: 'completed', claimed: 2, resolved: 2, deferred: 0, skipped: 0,
    ignoredMints: 0, errors: 0,
  });
  assert.deepEqual(completed.sort(), [TOKEN, TOKEN_B].sort());
});

it('completes from an exact code transition without requiring creator provenance', async () => {
  const fixture = runtime({
    outbox: {
      claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1, createdAt: new Date() }),
      isExact: async () => false,
      findMintHint: async () => ({
        tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
        transactionHash: TRANSACTION_HASH,
      }),
      complete: async () => { fixture.calls.push('complete'); },
      retry: async () => { throw new Error('must not retry'); },
    },
    localResolver: { verify: async () => ({
      tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
      transactionHash: TRANSACTION_HASH,
    }) },
    creatorSource: { readRange: async () => new Map([['100', { deployments: [] }]]) },
    attributions: {
      recordCodeTransitions: async () => { fixture.calls.push('local-attributed'); },
      recordVerifiedDirectDeployments: async () => { throw new Error('must not invent creator'); },
    },
  });
  const result = await createRobinhoodTokenDeploymentWorker({
    runtime: fixture.value, owner: 'test',
  }).runOnce();
  assert.deepEqual(result, {
    status: 'resolved', tokenAddress: TOKEN, source: 'rpc_code_transition',
  });
  assert.deepEqual(fixture.calls, ['local-attributed', 'complete']);
});

it('uses the canonical pool discovery transaction when no mint was observed', async () => {
  let verifiedHint;
  const discoveryHint = {
    tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
  };
  const fixture = runtime({
    outbox: {
      claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1, createdAt: new Date() }),
      isExact: async () => false,
      findMintHint: async () => null,
      findDiscoveryHint: async () => discoveryHint,
      complete: async () => { fixture.calls.push('complete'); },
      retry: async () => { throw new Error('must not retry'); },
    },
    localResolver: { verify: async (hint) => { verifiedHint = hint; return hint; } },
    creatorSource: { readRange: async () => new Map([['100', { deployments: [] }]]) },
    attributions: {
      recordCodeTransitions: async () => { fixture.calls.push('local-attributed'); },
      recordVerifiedDirectDeployments: async () => { throw new Error('must not invent creator'); },
    },
  });
  const result = await createRobinhoodTokenDeploymentWorker({
    runtime: fixture.value, owner: 'test',
  }).runOnce();
  assert.deepEqual(verifiedHint, discoveryHint);
  assert.equal(result.source, 'rpc_code_transition');
  assert.deepEqual(fixture.calls, ['local-attributed', 'complete']);
});

it('does not keep exact holder evidence queued when creator evidence is unavailable', async () => {
  const fixture = runtime({
    outbox: {
      claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1, createdAt: new Date() }),
      isExact: async () => false,
      findMintHint: async () => ({ tokenAddress: TOKEN, blockNumber: '100',
        blockHash: BLOCK_HASH, transactionHash: TRANSACTION_HASH }),
      complete: async () => { fixture.calls.push('complete'); },
      retry: async () => { throw new Error('must not retry'); },
    },
    localResolver: { verify: async (input) => input },
    creatorSource: { readRange: async () => new Map([['100', { deployments: [] }]]) },
    attributions: {
      recordCodeTransitions: async () => { fixture.calls.push('local-attributed'); },
      recordVerifiedDirectDeployments: async () => { throw new Error('must not persist'); },
    },
  });
  const worker = createRobinhoodTokenDeploymentWorker({ runtime: fixture.value, owner: 'test' });
  assert.deepEqual(await worker.runOnce(), {
    status: 'resolved', tokenAddress: TOKEN, source: 'rpc_code_transition',
  });
  assert.deepEqual(fixture.calls, ['local-attributed', 'complete']);
  assert.equal(worker.getStatus().lastError, null);
});

it('proves an exact deployment block from recent pruned-RPC state', async () => {
  const calls = [];
  const resolver = createLocalCodeTransitionResolver({
    async request(method, params = []) {
      calls.push([method, params]);
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getCode') return params[1] === '0x63' ? '0x' : '0x6000';
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: BLOCK_HASH };
      if (method === 'eth_getTransactionReceipt') return {
        transactionHash: TRANSACTION_HASH, blockNumber: '0x64',
        blockHash: BLOCK_HASH, status: '0x1',
      };
      throw new Error(`unexpected method ${method}`);
    },
  });
  assert.deepEqual(await resolver.verify({
    tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
  }), {
    tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
  });
  assert.equal(calls.filter(([method]) => method === 'eth_getCode').length, 2);
});

it('discards a later mint when bytecode already existed in the previous block', async () => {
  const calls = [];
  const resolver = createLocalCodeTransitionResolver({
    async request(method) {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: BLOCK_HASH };
      if (method === 'eth_getTransactionReceipt') return {
        transactionHash: TRANSACTION_HASH, blockNumber: '0x64',
        blockHash: BLOCK_HASH, status: '0x1',
      };
      throw new Error(`unexpected method ${method}`);
    },
  });
  const fixture = runtime({
    outbox: {
      claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1, createdAt: new Date() }),
      isExact: async () => false,
      findMintHint: async () => ({
        tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
        transactionHash: TRANSACTION_HASH,
      }),
      complete: async () => { calls.push('complete'); },
      retry: async () => { throw new Error('must not retry'); },
    },
    localResolver: resolver,
    attributions: {
      recordCodeTransitions: async () => { throw new Error('must not attribute'); },
    },
  });
  assert.deepEqual(await createRobinhoodTokenDeploymentWorker({
    runtime: fixture.value, owner: 'test',
  }).runOnce(), { status: 'non-deployment-mint', tokenAddress: TOKEN });
  assert.deepEqual(calls, ['complete']);
});

it('defers a fresh task briefly while its mint reaches the journal', async () => {
  const retries = [];
  const fixture = runtime({
    outbox: {
      claim: async () => ({
        tokenAddress: TOKEN, attemptCount: 1, createdAt: '2026-08-30T20:00:00.000Z',
      }),
      isExact: async () => false,
      findMintHint: async () => null,
      retry: async (input) => { retries.push(input); },
    },
    localResolver: { verify: async () => null },
  });
  const worker = createRobinhoodTokenDeploymentWorker({
    runtime: fixture.value, owner: 'test', now: () => Date.parse('2026-08-30T20:00:05.000Z'),
  });
  assert.deepEqual(await worker.runOnce(), {
    status: 'deferred', reason: 'local_mint_pending', tokenAddress: TOKEN,
  });
  assert.equal(retries[0].retryMs, 1000);
});

it('prioritizes recent outbox tasks and loads a confirmed canonical mint', async () => {
  const calls = [];
  const repository = createRobinhoodTokenDeploymentOutboxRepository({
    database: { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('WITH candidate')) return { rows: [{
        token_address: TOKEN, attempt_count: 1, created_at: '2026-08-30T20:00:00Z',
      }] };
      return { rows: [{
        block_number: '100', block_hash: BLOCK_HASH, transaction_hash: TRANSACTION_HASH,
      }] };
    } },
  });
  assert.equal((await repository.claim({ owner: 'test', leaseMs: 30_000 })).tokenAddress, TOKEN);
  assert.match(calls[0].sql, /created_at >= NOW\(\) - INTERVAL '10 minutes'/);
  assert.deepEqual(await repository.findMintHint(TOKEN), {
    tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
  });
  assert.match(calls[1].sql, /robinhood_chain_events event/);
  assert.match(calls[1].sql, /block\.canonical=TRUE/);
  assert.match(calls[1].sql, /event\.topics->>1=\$4/);
  assert.match(calls[1].sql, /cursor\.node_head - \$2::bigint/);
  assert.match(calls[1].sql, /cursor\.node_head - \$5::bigint/);
  assert.deepEqual(calls[1].params.slice(1), [12,
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    `0x${'0'.repeat(64)}`, 96]);
});

it('loads the earliest active pool transaction as canonical discovery evidence', async () => {
  let query;
  const repository = createRobinhoodTokenDeploymentOutboxRepository({
    database: { query: async (sql, params) => {
      query = { sql, params };
      return { rows: [{
        discovery_block: '101', discovery_block_hash: BLOCK_HASH,
        discovery_tx_hash: TRANSACTION_HASH,
      }] };
    } },
  });
  assert.deepEqual(await repository.findDiscoveryHint(TOKEN), {
    tokenAddress: TOKEN, blockNumber: '101', blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
  });
  assert.match(query.sql, /active = TRUE/);
  assert.match(query.sql, /ORDER BY discovery_block, discovery_log_index LIMIT 1/);
  assert.deepEqual(query.params, [TOKEN]);
});

it('treats a code transition as terminal holder deployment evidence', async () => {
  let exactSources;
  const repository = createRobinhoodTokenDeploymentOutboxRepository({
    database: { async query(_sql, params) { exactSources = params[1]; return { rowCount: 0 }; } },
  });
  assert.equal(await repository.isExact(TOKEN), false);
  assert.equal(exactSources.includes('rpc_code_transition'), true);
  assert.equal(exactSources.includes('rpc_trace'), true);
});

it('defers a token when canonical creator evidence is not materialized yet', async () => {
  const deferred = runtime({
    outbox: {
      claim: async () => ({
        tokenAddress: TOKEN, attemptCount: 1, createdAt: '2026-08-30T19:00:00.000Z',
      }),
      isExact: async () => false,
      findMintHint: async () => ({
        tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
        transactionHash: TRANSACTION_HASH,
      }),
      retry: async (input) => { deferred.calls.push(['retry', input]); },
    },
    localResolver: { verify: async () => null },
  });
  const deferredWorker = createRobinhoodTokenDeploymentWorker({
    runtime: deferred.value, owner: 'test', now: () => Date.parse('2026-08-30T20:00:00.000Z'),
  });
  assert.deepEqual(await deferredWorker.runOnce(), {
    status: 'deferred', reason: 'local_deployment_evidence_pending', tokenAddress: TOKEN,
  });
  assert.equal(deferred.calls[0][0], 'retry');
  assert.match(deferred.calls[0][1].error, /^canonical_creator_evidence:/);
  assert.equal(deferredWorker.getStatus().lastError, null);
});

it('skips tokens whose exact local attribution was already captured', async () => {
  const exact = runtime();
  exact.value.outbox.isExact = async () => true;
  const result = await createRobinhoodTokenDeploymentWorker({ runtime: exact.value, owner: 'test' }).runOnce();
  assert.equal(result.status, 'already-attributed');
  assert.deepEqual(exact.calls, ['complete']);
});

it('builds the live deployment runtime without an external creation lookup', () => {
  let blockscoutFactoryCalls = 0;
  const built = buildRuntime({
    env: {
      RH_NODE_RPC_URL: 'http://127.0.0.1:8547',
      ROBINHOOD_BLOCKSCOUT_API_KEY: 'proapi_test',
    },
    database: {},
    rpcClientFactory: () => ({ request: async () => '0x1237' }),
    blockscoutFactory: () => { blockscoutFactoryCalls += 1; return {}; },
    outboxFactory: () => ({}),
    attributionFactory: () => ({}),
    creatorSourceFactory: () => ({}),
  }, { timeoutMs: 30_000 });

  assert.ok(built);
  assert.equal(blockscoutFactoryCalls, 0);
});
