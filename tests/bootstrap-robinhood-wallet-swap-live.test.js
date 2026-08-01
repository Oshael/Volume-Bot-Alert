const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG,
  assertBootstrapSafe,
  bootstrap,
  inspectNode,
  main,
  planFromRow,
} = require('../src/utils/bootstrap-robinhood-wallet-swap-live');

function safeRow(overrides = {}) {
  return {
    live_worker_active: false,
    seed_next_block: '181',
    seed_safe_head: '200',
    seed_version: '8',
    live_next_block: null,
    live_safe_head: null,
    live_version: null,
    market_next_block: '250',
    accepted_without_wallet: '0',
    missing_min_block: null,
    missing_max_block: null,
    oldest_needed_block: '210',
    ...overrides,
  };
}

function rpcHarness(overrides = {}) {
  const calls = [];
  const rpcClient = {
    request: async (method, params = []) => {
      calls.push({ method, params });
      if (method === 'eth_blockNumber') return overrides.head || '0x12c';
      if (method === 'eth_syncing') return overrides.syncing ?? false;
      if (method === 'eth_getBlockByNumber') {
        return overrides.block || {
          number: params[0],
          transactions: [{ hash: `0x${'a'.repeat(64)}`, from: `0x${'b'.repeat(40)}` }],
        };
      }
      throw new Error(`unexpected RPC method ${method}`);
    },
  };
  return { rpcClient, calls, validateChainIds: async () => ({ local: '4663' }) };
}

describe('Robinhood wallet-swap LIVE bootstrap', () => {
  it('derives the handoff from seed.safe_head and reports the full audit', () => {
    assert.deepEqual(planFromRow(safeRow()), {
      liveWorkerActive: false,
      seed: { nextBlock: '181', safeHead: '200', version: '8' },
      live: { nextBlock: null, safeHead: null, version: null },
      marketNextBlock: '250',
      acceptedWithoutWallet: '0',
      missingMinBlock: null,
      missingMaxBlock: null,
      oldestNeededBlock: '210',
      proposedNextBlock: '201',
    });
  });

  it('refuses an active lease, incomplete cursors, audit gaps and an existing LIVE cursor', () => {
    const base = planFromRow(safeRow());
    assert.throws(
      () => assertBootstrapSafe({ ...base, liveWorkerActive: true }), /lease is active/
    );
    assert.throws(
      () => assertBootstrapSafe({ ...base, seed: { ...base.seed, safeHead: null } }),
      /seed cursor is incomplete/
    );
    assert.throws(
      () => assertBootstrapSafe({ ...base, marketNextBlock: null }), /market cursor is absent/
    );
    assert.throws(
      () => assertBootstrapSafe({
        ...base, acceptedWithoutWallet: '2', missingMinBlock: '190', missingMaxBlock: '199',
      }),
      /2 accepted observations.*190\.\.199/
    );
    assert.throws(
      () => assertBootstrapSafe({ ...base, live: { nextBlock: '201' } }), /inspection only/
    );
  });

  it('validates chain/head/sync and probes the oldest required full block', async () => {
    const rpc = rpcHarness();
    const node = await inspectNode(rpc.rpcClient, '210', rpc);

    assert.deepEqual(node, {
      providerChainIds: { local: '4663' },
      nodeHead: '300',
      syncing: false,
      probedBlock: { number: '210', transactions: 1 },
    });
    assert.deepEqual(rpc.calls, [
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_syncing', params: [] },
      { method: 'eth_getBlockByNumber', params: ['0xd2', true] },
    ]);
    await assert.rejects(
      inspectNode(rpcHarness({ syncing: { currentBlock: '0x1' } }).rpcClient, null, rpc),
      /still syncing/
    );
    const hashesOnly = rpcHarness({ block: { number: '0xd2', transactions: ['0xabc'] } });
    await assert.rejects(
      inspectNode(hashesOnly.rpcClient, '210', hashesOnly), /full transactions/
    );
  });

  it('keeps dry-run read-only even when a LIVE cursor already exists', async () => {
    const rpc = rpcHarness();
    const database = {
      query: async () => ({ rows: [safeRow({
        live_next_block: '220', live_safe_head: '219', live_version: '3',
      })] }),
      getClient: async () => { throw new Error('dry-run must not open a transaction'); },
    };
    const result = await main([], { database, rpcClient: rpc.rpcClient, ...rpc });

    assert.equal(result.live.nextBlock, '220');
    assert.equal(result.proposedNextBlock, '201');
  });

  it('refuses a node behind the seed handoff point', async () => {
    const rpc = rpcHarness({ head: '0x64' });
    const database = { query: async () => ({ rows: [safeRow()] }) };
    await assert.rejects(
      main([], { database, rpcClient: rpc.rpcClient, ...rpc }), /behind seed safe head/
    );
  });

  it('creates the LIVE cursor once with null safe_head after transactional recheck', async () => {
    const statements = [];
    const client = {
      query: async (sql, params) => {
        statements.push({ sql, params });
        if (sql.includes('WITH\n  seed AS')) {
          return { rows: [safeRow()] };
        }
        if (sql.includes('INSERT INTO robinhood_wallet_swap_cursors')) {
          assert.deepEqual(params, ['201']);
          assert.match(sql, /'live'.*\$1::bigint, NULL/s);
          assert.match(sql, /ON CONFLICT.*DO NOTHING/s);
          return { rows: [{ next_block: '201', safe_head: null, version: '0' }] };
        }
        if (sql.includes("stream = 'live'")) {
          return { rows: [{ next_block: '201', safe_head: null, version: '0' }] };
        }
        return { rows: [] };
      },
      release() { statements.push({ sql: 'RELEASE' }); },
    };
    const database = {
      query: async () => ({ rows: [safeRow()] }),
      getClient: async () => client,
    };
    const rpc = rpcHarness();
    const result = await bootstrap(database, rpc.rpcClient, rpc);

    assert.deepEqual(result.created, { nextBlock: '201', safeHead: null, version: '0' });
    assert.equal(statements.some(({ sql }) => sql.includes('FOR UPDATE')), true);
    assert.deepEqual(statements.slice(-2).map(({ sql }) => sql), ['COMMIT', 'RELEASE']);
  });

  it('rolls back if the seed audit changes after the RPC preflight', async () => {
    const statements = [];
    const client = {
      query: async (sql) => {
        statements.push(sql);
        if (sql.includes('WITH\n  seed AS')) return { rows: [safeRow({
          accepted_without_wallet: '1', missing_min_block: '199', missing_max_block: '199',
        })] };
        return { rows: [] };
      },
      release() { statements.push('RELEASE'); },
    };
    const database = {
      query: async () => ({ rows: [safeRow()] }),
      getClient: async () => client,
    };
    const rpc = rpcHarness();
    await assert.rejects(bootstrap(database, rpc.rpcClient, rpc), /seed audit found 1/);
    assert.equal(statements.includes('ROLLBACK'), true);
    assert.equal(statements.includes('COMMIT'), false);
  });

  it('uses a long, specific confirmation flag', () => {
    assert.equal(CONFIRM_FLAG, '--confirm-bootstrap-robinhood-wallet-swap-live');
  });
});
