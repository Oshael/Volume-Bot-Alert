const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  createRobinhoodTokenDeploymentWorker,
  __private: { buildRuntime, createLocalCodeTransitionResolver },
} = require('../src/services/robinhood-token-deployment-worker');
const {
  createRobinhoodTokenDeploymentOutboxRepository,
} = require('../src/models/robinhood-token-deployment-outbox');
const stage215 = require('../src/utils/db-init-stage215');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

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

it('uses a durable mint anchor without searching the moving journal window', async () => {
  const mintHint = {
    tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
  };
  const fixture = runtime({
    outbox: {
      claim: async () => ({
        tokenAddress: TOKEN, attemptCount: 1, createdAt: new Date(), mintHint,
      }),
      isExact: async () => false,
      complete: async () => { fixture.calls.push('complete'); },
      retry: async () => { throw new Error('must not retry'); },
    },
    localResolver: { verify: async (input) => input },
    creatorSource: { readRange: async () => new Map([['100', { deployments: [] }]]) },
    attributions: {
      recordCodeTransitions: async () => { fixture.calls.push('transition'); },
    },
  });
  const result = await createRobinhoodTokenDeploymentWorker({
    runtime: fixture.value, owner: 'test',
  }).runOnce();
  assert.equal(result.source, 'rpc_code_transition');
  assert.deepEqual(fixture.calls, ['transition', 'complete']);
});

it('persists bounded live trace enrichment after the code transition', async () => {
  const traced = [];
  const tasks = [TOKEN, TOKEN_B].map((tokenAddress) => ({
    tokenAddress, attemptCount: 1, createdAt: new Date(),
    mintHint: { tokenAddress, blockNumber: '100', blockHash: BLOCK_HASH,
      transactionHash: TRANSACTION_HASH },
  }));
  const worker = createRobinhoodTokenDeploymentWorker({
    owner: 'test', options: { traceEnabled: true, traceBatchSize: 1 },
    runtime: {
      outbox: {
        claimBatch: async () => tasks,
        isExact: async () => false,
        complete: async () => {},
        retry: async () => { throw new Error('must not retry'); },
      },
      localResolver: { verify: async (input) => input },
      creatorSource: { readRange: async () => new Map([['100', { deployments: [] }]]) },
      traceVerifier: {
        async verifyBlockTraceDeployment(input) {
          traced.push(input.tokenAddress);
          return { ...input, creatorAddress: TOKEN_B, transactionHash: TRANSACTION_HASH,
            source: 'rpc_trace', factoryAddress: TOKEN_B, blockHash: BLOCK_HASH };
        },
      },
      attributions: {
        recordCodeTransitions: async () => {},
        recordVerifiedDirectDeployments: async () => {},
      },
    },
  });
  const result = await worker.runOnce();
  assert.equal(result.resolved, 2);
  assert.equal(traced.length, 1);
  assert.equal(worker.getStatus().totalTraceAttempts, 1);
  assert.equal(worker.getStatus().totalTraceResolved, 1);
  assert.equal(worker.getStatus().totalTraceBudgetSkipped, 1);
});

it('completes basic deployment evidence when optional live trace fails', async () => {
  const fixture = runtime({
    outbox: {
      claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1, createdAt: new Date(),
        mintHint: { tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
          transactionHash: TRANSACTION_HASH } }),
      isExact: async () => false,
      complete: async () => { fixture.calls.push('complete'); },
      retry: async () => { throw new Error('must not retry'); },
    },
    localResolver: { verify: async (input) => input },
    creatorSource: { readRange: async () => new Map([['100', { deployments: [] }]]) },
    traceVerifier: { verifyBlockTraceDeployment: async () => {
      throw Object.assign(new Error('trace timeout'), { code: 'rpc_timeout' });
    } },
    attributions: { recordCodeTransitions: async () => { fixture.calls.push('transition'); } },
  });
  const worker = createRobinhoodTokenDeploymentWorker({
    runtime: fixture.value, owner: 'test', options: { traceEnabled: true },
  });
  assert.deepEqual(await worker.runOnce(), {
    status: 'resolved', tokenAddress: TOKEN, source: 'rpc_code_transition',
  });
  assert.deepEqual(fixture.calls, ['transition', 'complete']);
  assert.equal(worker.getStatus().totalTraceFailed, 1);
  assert.deepEqual(worker.getStatus().lastTraceError, {
    code: 'rpc_timeout', message: 'trace timeout',
  });
});

it('retries a durable mint anchor rapidly without hiding the RPC failure', async () => {
  let retry;
  const mintHint = {
    tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
  };
  const fixture = runtime({
    outbox: {
      claim: async () => ({
        tokenAddress: TOKEN, attemptCount: 1, createdAt: new Date(), mintHint,
      }),
      isExact: async () => false,
      retry: async (input) => { retry = input; },
    },
    localResolver: { verify: async () => {
      throw Object.assign(new Error('state temporarily unavailable'), { code: 'rpc_unavailable' });
    } },
  });
  const result = await createRobinhoodTokenDeploymentWorker({
    runtime: fixture.value, owner: 'test',
  }).runOnce();
  assert.deepEqual(result, { status: 'error', tokenAddress: TOKEN, errors: 1 });
  assert.equal(retry.retryMs, 1000);
  assert.equal(
    retry.error,
    'rpc_code_transition:rpc_unavailable:state temporarily unavailable'
  );
});

it('uses bounded Archive fallback for a pinned live eth_getCode -32000 failure', async () => {
  const completed = [];
  const mintHint = {
    tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
  };
  const transition = { ...mintHint };
  const worker = createRobinhoodTokenDeploymentWorker({
    owner: 'test', options: { archiveFallbackBatchSize: 1 },
    runtime: {
      outbox: {
        claimBatch: async () => [TOKEN, TOKEN_B].map((tokenAddress) => ({
          tokenAddress, attemptCount: 1, mintHint: { ...mintHint, tokenAddress },
        })),
        isExact: async () => false,
        complete: async ({ tokenAddress }) => { completed.push(tokenAddress); return true; },
        retry: async () => true,
      },
      localResolver: { verify: async () => null, inspect: async () => {
        throw Object.assign(new Error('eth_getCode RPC error -32000'), {
          code: 'rpc_error', rpcCode: -32000, method: 'eth_getCode',
        });
      } },
      archiveResolver: { inspect: async () => ({ status: 'transition', transition }) },
      attributions: { recordCodeTransitions: async () => ({ attributed: 1 }) },
    },
  });
  const result = await worker.runOnce();
  assert.equal(result.resolved, 1);
  assert.equal(result.errors, 1);
  assert.deepEqual(completed, [TOKEN]);
  assert.equal(worker.getStatus().totalArchiveFallbackAttempts, 1);
  assert.equal(worker.getStatus().totalArchiveFallbackResolved, 1);
});

it('finds earlier code before completing a pinned mint that is not a deployment', async () => {
  let discovered;
  let recorded;
  const mintHint = {
    tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
  };
  const worker = createRobinhoodTokenDeploymentWorker({
    owner: 'test',
    runtime: {
      outbox: {
        claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1, mintHint }),
        isExact: async () => false,
        complete: async () => true,
        retry: async () => { throw new Error('must not retry'); },
      },
      localResolver: { verify: async () => null, inspect: async () => {
        throw Object.assign(new Error('eth_getCode RPC error -32000'), {
          code: 'rpc_error', rpcCode: -32000, method: 'eth_getCode',
        });
      } },
      archiveResolver: { inspect: async () => ({ status: 'preexisting-code' }) },
      archiveDiscovery: { discover: async (input) => {
        discovered = input;
        return { tokenAddress: TOKEN, blockNumber: '50', source: 'rpc_code_transition' };
      } },
      attributions: { recordCodeTransitions: async (items) => {
        recorded = items;
        return { attributed: 1 };
      } },
    },
  });
  assert.equal((await worker.runOnce()).status, 'resolved');
  assert.equal(discovered.upperBlock, '100');
  assert.equal(discovered.blockEvidenceOnly, true);
  assert.equal(recorded[0].blockNumber, '50');
});

it('leaves the live task retryable when Archive proof is inconclusive', async () => {
  let retry;
  let completed = false;
  const worker = createRobinhoodTokenDeploymentWorker({
    owner: 'test',
    runtime: {
      outbox: {
        claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1, mintHint: {
          tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
          transactionHash: TRANSACTION_HASH,
        } }),
        isExact: async () => false,
        complete: async () => { completed = true; },
        retry: async (input) => { retry = input; },
      },
      localResolver: { verify: async () => null, inspect: async () => {
        throw Object.assign(new Error('eth_getCode RPC error -32000'), {
          code: 'rpc_error', rpcCode: -32000, method: 'eth_getCode',
        });
      } },
      archiveResolver: { inspect: async () => ({ status: 'missing-current-code' }) },
      attributions: { recordCodeTransitions: async () => {
        throw new Error('must not attribute');
      } },
    },
  });
  assert.equal((await worker.runOnce()).status, 'error');
  assert.equal(completed, false);
  assert.match(retry.error, /eth_getCode RPC error -32000/);
  assert.equal(worker.getStatus().totalArchiveFallbackFailed, 1);
});

it('measures first mint attempts against the live head and locates -32000 errors', async () => {
  for (const { head, bucket } of [
    { head: '0x78', bucket: 'WithinLookback' },
    { head: '0xfa', bucket: 'BeyondLookback' },
    { head: '0x5a', bucket: 'NodeBehind' },
  ]) {
    let headCalls = 0;
    const worker = createRobinhoodTokenDeploymentWorker({
      owner: 'test',
      runtime: {
        outbox: {
          claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1, mintHint: {
            tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
            transactionHash: TRANSACTION_HASH,
          } }),
          isExact: async () => false,
          retry: async () => true,
        },
        liveHead: async () => { headCalls += 1; return head; },
        localResolver: { verify: async () => null, inspect: async () => {
          throw Object.assign(new Error('eth_getCode RPC error -32000'), {
            code: 'rpc_error', rpcCode: -32000, method: 'eth_getCode',
          });
        } },
      },
    });
    await worker.runOnce();
    const status = worker.getStatus();
    assert.equal(headCalls, 1);
    assert.equal(status.firstAttemptHeadSamples, 1);
    assert.equal(status[`firstAttemptHead${bucket}`], 1);
    assert.equal(status[`firstAttemptCode32000${bucket}`], 1);
    assert.equal(status.lastFirstAttemptCode32000.bucket, bucket);
  }
});

it('measures first-attempt queue wait, claim wait and batch duration', async () => {
  let clock = 100_000;
  const worker = createRobinhoodTokenDeploymentWorker({
    owner: 'test', now: () => clock,
    runtime: {
      outbox: {
        archiveExpiredBatch: async () => { clock += 2; return 0; },
        claimBatch: async () => {
          clock += 3;
          return [{ tokenAddress: TOKEN, attemptCount: 1, createdAt: new Date(90_000),
            mintHint: { tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
              transactionHash: TRANSACTION_HASH } }];
        },
        isExact: async () => { clock += 5; return false; },
        retry: async () => { clock += 13; return true; },
      },
      liveHead: async () => { clock += 7; return '0xfa'; },
      localResolver: {
        verify: async () => null,
        inspect: async () => {
          clock += 11;
          throw Object.assign(new Error('eth_getCode RPC error -32000'), {
            code: 'rpc_error', rpcCode: -32000, method: 'eth_getCode',
          });
        },
      },
    },
  });
  await worker.runOnce();
  const status = worker.getStatus();
  assert.equal(status.firstAttemptQueueWaitSamples, 1);
  assert.equal(status.firstAttemptQueueWaitTotalMs, 10_010);
  assert.equal(status.firstAttemptQueueWaitMaxMs, 10_010);
  assert.equal(status.firstAttemptClaimWaitMaxMs, 5);
  assert.equal(status.lastFirstAttemptCode32000.queueWaitMs, 10_010);
  assert.equal(status.lastFirstAttemptCode32000.claimWaitMs, 5);
  assert.equal(status.lastRunClaimed, 1);
  assert.equal(status.lastClaimDurationMs, 3);
  assert.equal(status.lastProcessDurationMs, 36);
  assert.equal(status.lastRunDurationMs, 41);
});

it('continues deployment resolution when the first-attempt head probe fails', async () => {
  let headCalls = 0;
  const worker = createRobinhoodTokenDeploymentWorker({
    owner: 'test',
    runtime: {
      outbox: {
        claim: async () => ({ tokenAddress: TOKEN, attemptCount: 1, mintHint: {
          tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
          transactionHash: TRANSACTION_HASH,
        } }),
        isExact: async () => false,
        complete: async () => true,
      },
      liveHead: async () => { headCalls += 1; throw new Error('probe unavailable'); },
      localResolver: { verify: async (input) => input },
      creatorSource: { readRange: async () => new Map() },
      attributions: { recordCodeTransitions: async () => ({ attributed: 1 }) },
    },
  });
  assert.equal((await worker.runOnce()).status, 'resolved');
  assert.equal(headCalls, 1);
  assert.equal(worker.getStatus().firstAttemptHeadErrors, 1);
});

it('does not add a head RPC to retries of old pinned mints', async () => {
  const worker = createRobinhoodTokenDeploymentWorker({
    owner: 'test',
    runtime: {
      outbox: {
        claim: async () => ({ tokenAddress: TOKEN, attemptCount: 2, mintHint: {
          tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
          transactionHash: TRANSACTION_HASH,
        } }),
        isExact: async () => false,
        retry: async () => true,
      },
      liveHead: async () => { throw new Error('must not probe retries'); },
      localResolver: { verify: async () => null, inspect: async () => {
        throw Object.assign(new Error('eth_getCode RPC error -32000'), {
          code: 'rpc_error', rpcCode: -32000, method: 'eth_getCode',
        });
      } },
    },
  });
  await worker.runOnce();
  assert.equal(worker.getStatus().firstAttemptHeadSamples, 0);
  assert.equal(worker.getStatus().firstAttemptHeadErrors, 0);
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
    ignoredMints: 0, archiveRequired: 0, errors: 0,
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

it('claims only the live lane with fresh pinned mints first and loads a canonical mint', async () => {
  const calls = [];
  const repository = createRobinhoodTokenDeploymentOutboxRepository({
    database: { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('WITH candidate')) return { rows: [{
        token_address: TOKEN, attempt_count: 1, created_at: '2026-08-30T20:00:00Z',
        mint_block_number: '100', mint_block_hash: BLOCK_HASH,
        mint_transaction_hash: TRANSACTION_HASH,
      }] };
      return { rows: [{
        block_number: '100', block_hash: BLOCK_HASH, transaction_hash: TRANSACTION_HASH,
      }] };
    } },
  });
  assert.deepEqual((await repository.claim({ owner: 'test', leaseMs: 30_000 })).mintHint, {
    tokenAddress: TOKEN, blockNumber: '100', blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
  });
  assert.match(calls[0].sql, /live_deadline_at > NOW\(\)/);
  assert.match(calls[0].sql, /mint_block_number IS NOT NULL/);
  assert.match(calls[0].sql, /created_at >= NOW\(\) - INTERVAL '30 seconds'/);
  assert.match(calls[0].sql, /live_deadline_at, next_attempt_at, created_at/);
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

it('moves expired pending work to the Archive lane in a bounded batch', async () => {
  let query;
  const repository = createRobinhoodTokenDeploymentOutboxRepository({
    database: { async query(sql, params) { query = { sql, params }; return { rowCount: 7 }; } },
  });
  assert.equal(await repository.archiveExpiredBatch({ limit: 16 }), 7);
  assert.match(query.sql, /status = 'archive_required'/);
  assert.match(query.sql, /live_deadline_at <= NOW\(\)/);
  assert.match(query.sql, /LIMIT \$1 FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(query.params, [16]);
});

it('completes an archived mint only while its pinned identity is unchanged', async () => {
  let query;
  const repository = createRobinhoodTokenDeploymentOutboxRepository({
    database: { async query(sql, params) { query = { sql, params }; return { rowCount: 1 }; } },
  });
  assert.equal(await repository.completePinnedRecovered({
    tokenAddress: TOKEN, blockNumber: '100',
    blockHash: BLOCK_HASH, transactionHash: TRANSACTION_HASH,
  }), true);
  assert.match(query.sql, /status = 'archive_required'/);
  assert.match(query.sql, /mint_block_number = \$2::bigint/);
  assert.match(query.sql, /mint_block_hash = \$3 AND mint_transaction_hash = \$4/);
  assert.deepEqual(query.params, [TOKEN, '100', BLOCK_HASH, TRANSACTION_HASH]);
});

it('registers the durable mint anchor migration in runtime schema', async () => {
  const calls = [];
  await stage215.init({
    closePool: false,
    database: { query: async (sql) => { calls.push(sql); }, pool: { end: async () => {} } },
  });
  assert.deepEqual(calls, [...stage215.STATEMENTS]);
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage215-robinhood-token-deployment-mint-anchor'
  ));
  assert.deepEqual(group.tables[0].columns, [
    'mint_block_number', 'mint_block_hash', 'mint_transaction_hash',
  ]);
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

it('builds the live deployment runtime without an external creation lookup', async () => {
  let blockscoutFactoryCalls = 0;
  const built = buildRuntime({
    env: {
      RH_NODE_RPC_URL: 'http://127.0.0.1:8547',
      ROBINHOOD_BLOCKSCOUT_API_KEY: 'proapi_test',
    },
    database: {},
    rpcClientFactory: () => ({ request: async (method) => (
      method === 'eth_blockNumber' ? '0x64' : '0x1237'
    ) }),
    blockscoutFactory: () => { blockscoutFactoryCalls += 1; return {}; },
    outboxFactory: () => ({}),
    attributionFactory: () => ({}),
    creatorSourceFactory: () => ({}),
  }, { timeoutMs: 30_000 });

  assert.ok(built);
  assert.equal(await built.liveHead(), '0x64');
  assert.equal(blockscoutFactoryCalls, 0);
});

it('builds an isolated no-retry trace client only when trace is enabled', () => {
  const clients = [];
  let verifierOptions;
  const built = buildRuntime({
    env: { RH_NODE_RPC_URL: 'http://127.0.0.1:8547' }, database: {},
    rpcClientFactory: (options) => {
      const client = { request: async () => '0x1237' };
      clients.push({ options, client });
      return client;
    },
    outboxFactory: () => ({}), attributionFactory: () => ({}),
    creatorSourceFactory: () => ({}), localResolverFactory: () => ({}),
    traceVerifierFactory: (options) => { verifierOptions = options; return {}; },
  }, { timeoutMs: 30_000, traceEnabled: true, traceTimeoutMs: 2000 });
  assert.ok(built.traceVerifier);
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1].options, {
    providers: [{ name: 'robinhood-deployment-live-trace', url: 'http://127.0.0.1:8547' }],
    timeoutMs: 2000, maxRetries: 0,
  });
  assert.equal(verifierOptions.rpcClient, clients[1].client);
  assert.equal(typeof verifierOptions.internalCreationLookup, 'function');
});
