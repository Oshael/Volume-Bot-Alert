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
const DEPLOYMENT = { tokenAddress: TOKEN, source: 'blockscout_internal' };
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
      blockscout: { getContractCreation: async () => ({ creatorAddress: TOKEN, transactionHash: `0x${'b'.repeat(64)}` }) },
      verifier: { verifyDirectDeployment: async () => DEPLOYMENT },
      attributions: { recordVerifiedDirectDeployments: async () => { calls.push('attributed'); } },
      ...overrides,
    },
  };
}

it('materializes exact deployment evidence before completing the outbox task', async () => {
  const fixture = runtime();
  const worker = createRobinhoodTokenDeploymentWorker({ runtime: fixture.value, owner: 'test' });
  const result = await worker.runOnce();
  assert.equal(result.status, 'resolved');
  assert.deepEqual(fixture.calls, ['attributed', 'complete']);
});

it('uses a canonical local code transition before calling Blockscout', async () => {
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
    localResolver: { verify: async () => ({ tokenAddress: TOKEN, blockNumber: '100' }) },
    blockscout: { getContractCreation: async () => { throw new Error('must not call Blockscout'); } },
    attributions: {
      recordCodeTransitions: async () => { fixture.calls.push('local-attributed'); },
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
  }), { tokenAddress: TOKEN, blockNumber: '100' });
  assert.equal(calls.filter(([method]) => method === 'eth_getCode').length, 2);
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
    blockscout: { getContractCreation: async () => { throw new Error('must not call'); } },
  });
  const worker = createRobinhoodTokenDeploymentWorker({
    runtime: fixture.value, owner: 'test', now: () => Date.parse('2026-08-30T20:00:05.000Z'),
  });
  assert.deepEqual(await worker.runOnce(), {
    status: 'deferred', reason: 'local_mint_pending', tokenAddress: TOKEN,
  });
  assert.equal(retries[0].retryMs, 1000);
});

it('prioritizes recent outbox tasks and loads their earliest captured mint', async () => {
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
  assert.match(calls[1].sql, /from_wallet = '0x0{40}'/);
  assert.match(calls[1].sql, /applied = false/);
  assert.match(calls[1].sql, /UNION ALL/);
  assert.match(calls[1].sql, /applied = true/);
});

it('defers missing Blockscout evidence and skips already attributed tokens', async () => {
  const deferred = runtime({ blockscout: { getContractCreation: async () => null } });
  const deferredWorker = createRobinhoodTokenDeploymentWorker({
    runtime: deferred.value, owner: 'test',
  });
  assert.deepEqual(await deferredWorker.runOnce(), {
    status: 'deferred', reason: 'blockscout_creation_pending', tokenAddress: TOKEN,
  });
  assert.equal(deferred.calls[0][0], 'retry');
  assert.equal(deferredWorker.getStatus().lastError, null);
  const exact = runtime();
  exact.value.outbox.isExact = async () => true;
  const result = await createRobinhoodTokenDeploymentWorker({ runtime: exact.value, owner: 'test' }).runOnce();
  assert.equal(result.status, 'already-attributed');
  assert.deepEqual(exact.calls, ['complete']);
});

it('configures the Blockscout PRO API when the live worker has an API key', () => {
  let blockscoutOptions;
  buildRuntime({
    env: {
      RH_NODE_RPC_URL: 'http://127.0.0.1:8547',
      ROBINHOOD_BLOCKSCOUT_API_KEY: 'proapi_test',
    },
    database: {},
    rpcClientFactory: () => ({ request: async () => '0x1237' }),
    blockscoutFactory: (options) => {
      blockscoutOptions = options;
      return { getContractCreation() {}, getInternalContractCreation() {} };
    },
    outboxFactory: () => ({}),
    attributionFactory: () => ({}),
    verifierFactory: () => ({}),
  }, { timeoutMs: 30_000 });

  assert.equal(blockscoutOptions.apiKey, 'proapi_test');
  assert.equal(blockscoutOptions.apiUrl,
    'https://api.blockscout.com/v2/api?chain_id=4663');
});
