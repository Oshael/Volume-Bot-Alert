const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  RULE_VERSION,
  compareRobinhoodFreshWalletEvidence,
  evaluateRobinhoodFreshWallet,
} = require('../src/services/robinhood-fresh-wallet-rule');
const {
  createRobinhoodFreshWalletRpcSource,
  resolveRobinhoodFreshWalletRpcProvider,
  __private: { requestBatches },
} = require('../src/services/robinhood-fresh-wallet-rpc-source');

const WALLET = `0x${'1'.repeat(40)}`;
const TX_HASH = `0x${'a'.repeat(64)}`;
const TARGET_MS = Date.parse('2026-08-29T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function hash(number) {
  return `0x${BigInt(number).toString(16).padStart(64, '0')}`;
}

function timestampMs(number) {
  const value = Number(number);
  if (value <= 50) return TARGET_MS - ((51 - value) * 1000);
  return TARGET_MS + Math.round(((value - 51) * DAY_MS) / 49);
}

function quantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function block(number, overrides = {}) {
  return {
    number: quantity(number), hash: hash(number),
    timestamp: quantity(Math.floor(timestampMs(number) / 1000)), ...overrides,
  };
}

function rpc(options = {}) {
  const calls = [];
  const batches = [];
  const client = {
    async request(method, params = []) {
      calls.push([method, params]);
      if (method === 'eth_chainId') return options.chainId || '0x1237';
      if (method === 'eth_getBlockByNumber') {
        const number = BigInt(params[0]);
        return block(number, number === 100n ? options.firstBuyBlock : {});
      }
      if (method === 'eth_getTransactionByHash') {
        return options.transaction === null ? null : {
          hash: TX_HASH, from: WALLET, nonce: quantity(options.firstBuyNonce ?? 5),
          blockNumber: '0x64', blockHash: hash(100), ...options.transaction,
        };
      }
      if (method === 'eth_getTransactionCount') return options.cutoffNonce ?? '0x0';
      throw new Error(`unexpected RPC method ${method}`);
    },
  };
  client.requestBatch = async (requests) => {
    batches.push(requests);
    return Promise.all(requests.map(({ method, params }) => client.request(method, params)));
  };
  return { calls, batches, client };
}

function firstBuy(overrides = {}) {
  return {
    walletAddress: WALLET,
    transactionHash: TX_HASH,
    blockNumber: '100',
    blockHash: hash(100),
    blockTime: new Date(TARGET_MS + DAY_MS).toISOString(),
    ...overrides,
  };
}

function ruleEvidence(overrides = {}) {
  return {
    ruleVersion: RULE_VERSION, sourceKind: 'seed',
    firstBuy: { nonce: '5', blockTime: '2026-08-30T12:00:00.000Z' },
    cutoff: {
      number: '50', nonce: '0', targetAt: '2026-08-29T12:00:00.000Z',
      blockTime: '2026-08-29T11:59:59.000Z',
    },
    nextBlock: { number: '51', blockTime: '2026-08-29T12:00:00.000Z' },
    ...overrides,
  };
}

describe('Robinhood FRESH signed-activity rule', () => {
  it('accepts nonce boundaries 0 and 5 and rejects nonce 6', () => {
    for (const nonce of ['0', '5']) {
      assert.deepEqual(evaluateRobinhoodFreshWallet(ruleEvidence({
        firstBuy: { ...ruleEvidence().firstBuy, nonce },
      })), {
        ruleVersion: RULE_VERSION, outcome: 'fresh',
        outcomeReason: 'new_wallet_at_first_buy',
        reasonCode: 'new_wallet_at_first_buy', confidence: 'high',
      });
    }
    const result = evaluateRobinhoodFreshWallet(ruleEvidence({
      firstBuy: { ...ruleEvidence().firstBuy, nonce: '6' },
    }));
    assert.equal(result.outcome, 'not_fresh');
    assert.equal(result.outcomeReason, 'too_many_prior_signed_transactions');
    assert.equal(result.reasonCode, null);
  });

  it('rejects prior signed activity and incomplete cutoff proof', () => {
    const old = evaluateRobinhoodFreshWallet(ruleEvidence({
      cutoff: { ...ruleEvidence().cutoff, nonce: '1' },
    }));
    assert.equal(old.outcome, 'not_fresh');
    assert.equal(old.outcomeReason, 'signed_activity_before_window');
    assert.throws(() => evaluateRobinhoodFreshWallet(ruleEvidence({
      nextBlock: { number: '52', blockTime: '2026-08-29T12:00:00.000Z' },
    })), /strict 24-hour boundary/);
    assert.throws(() => evaluateRobinhoodFreshWallet(ruleEvidence({
      cutoff: { ...ruleEvidence().cutoff, blockTime: '2026-08-29T12:00:00.000Z' },
    })), /strict 24-hour boundary/);
    assert.throws(() => evaluateRobinhoodFreshWallet({
      ...ruleEvidence(), sourceKind: undefined,
    }), /explicitly select seed or live/);
  });

  it('uses signed-origin activity without inventing a historical nonce', () => {
    const seed = ruleEvidence();
    const live = { ...seed, sourceKind: 'live',
      cutoff: Object.fromEntries(Object.entries(seed.cutoff).filter(([key]) => key !== 'nonce')),
      signedActivity: { priorSignedActivity: false,
        reason: 'no_signed_activity_before_cutoff' },
    };
    assert.equal(evaluateRobinhoodFreshWallet(live).outcome, 'fresh');
    assert.deepEqual(compareRobinhoodFreshWalletEvidence(seed, live), {
      equivalent: true, seedPriorSignedActivity: false, livePriorSignedActivity: false,
      sameFirstBuyNonce: true, seedOutcome: 'fresh', liveOutcome: 'fresh',
    });
    assert.equal(compareRobinhoodFreshWalletEvidence(seed, { ...live,
      signedActivity: { priorSignedActivity: true } }).equivalent, false);
  });
});

describe('Robinhood FRESH historical RPC source', () => {
  it('runs bounded RPC sub-batches concurrently and preserves result order', async () => {
    let active = 0; let maxActive = 0; const sizes = [];
    const requests = Array.from({ length: 25 }, (_, index) => index);
    const results = await requestBatches(requests, async (batch) => {
      sizes.push(batch.length); active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve)); active -= 1; return batch;
    });
    assert.deepEqual(sizes, [10, 10, 5]);
    assert.equal(maxActive, 3);
    assert.deepEqual(results, requests);
  });

  it('resolves the strict cutoff, anchors nonce by hash, and reuses block cache', async () => {
    const fake = rpc();
    const source = createRobinhoodFreshWalletRpcSource({
      rpcClient: fake.client, source: 'robinhood-pc-archive',
      sourceKind: 'seed',
      now: () => new Date('2026-08-30T12:05:00.000Z'),
    });
    const evidence = await source.readEvidence(firstBuy());
    assert.equal(evidence.cutoff.number, '50');
    assert.equal(evidence.sourceKind, 'seed');
    assert.equal(evidence.cutoff.nonce, '0');
    assert.equal(evidence.nextBlock.number, '51');
    assert.equal(evaluateRobinhoodFreshWallet(evidence).outcome, 'fresh');
    const nonceCall = fake.calls.find(([method]) => method === 'eth_getTransactionCount');
    assert.deepEqual(nonceCall[1], [WALLET, {
      blockHash: hash(50), requireCanonical: true,
    }]);
    const blocksBefore = fake.calls.filter(([method]) => method === 'eth_getBlockByNumber').length;
    await source.readEvidence(firstBuy());
    const blocksAfter = fake.calls.filter(([method]) => method === 'eth_getBlockByNumber').length;
    assert.equal(blocksAfter - blocksBefore, 1);
    assert.equal(fake.calls.filter(([method]) => method === 'eth_chainId').length, 1);
  });

  it('interpolates a realistic 24-hour cutoff with exact adjacent blocks', async () => {
    const firstBlock = 50_000_000n;
    const firstTime = Date.parse('2026-08-30T12:00:00.000Z');
    const calls = [];
    const client = { async request(method, params = []) {
      calls.push([method, params]);
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getTransactionByHash') return {
        hash: TX_HASH, from: WALLET, nonce: '0x5', blockNumber: quantity(firstBlock),
        blockHash: hash(firstBlock),
      };
      if (method === 'eth_getBlockByNumber') {
        const number = BigInt(params[0]);
        const timestamp = firstTime - (Number(firstBlock - number) * 13_000);
        return { number: quantity(number), hash: hash(number),
          timestamp: quantity(Math.floor(timestamp / 1000)) };
      }
      if (method === 'eth_getTransactionCount') return '0x0';
      throw new Error(`unexpected RPC method ${method}`);
    } };
    client.requestBatch = (requests) => Promise.all(
      requests.map(({ method, params }) => client.request(method, params))
    );
    const evidence = await createRobinhoodFreshWalletRpcSource({ rpcClient: client,
      source: 'robinhood-pc-archive', sourceKind: 'seed' }).readEvidence({
      ...firstBuy(), blockNumber: firstBlock.toString(), blockHash: hash(firstBlock),
      blockTime: new Date(firstTime).toISOString(),
    });
    assert.equal(evidence.cutoff.number, (firstBlock - 6647n).toString());
    assert.equal(evidence.nextBlock.number, (firstBlock - 6646n).toString());
    assert.ok(calls.filter(([method]) => method === 'eth_getBlockByNumber').length <= 6);
  });

  it('batches identical canonical evidence without changing the result', async () => {
    const fake = rpc();
    const source = createRobinhoodFreshWalletRpcSource({
      rpcClient: fake.client, source: 'robinhood-pc-archive', sourceKind: 'seed',
      now: () => new Date('2026-08-30T12:05:00.000Z'),
    });
    const results = await source.readEvidenceBatch([firstBuy(), firstBuy()]);
    const control = rpc();
    const individual = await createRobinhoodFreshWalletRpcSource({
      rpcClient: control.client, source: 'robinhood-pc-archive', sourceKind: 'seed',
      now: () => new Date('2026-08-30T12:05:00.000Z'),
    }).readEvidence(firstBuy());
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], individual);
    assert.equal(evaluateRobinhoodFreshWallet(results[0]).outcome, 'fresh');
    assert.ok(fake.batches.length > 0);
    assert.ok(fake.batches.every((batch) => batch.length <= 10));
    assert.equal(fake.calls.filter(([method]) => method === 'eth_getTransactionByHash').length, 1);
    assert.equal(fake.calls.filter(([method]) => method === 'eth_getTransactionCount').length, 1);
  });

  it('batches canonical live context without requesting historical account nonce', async () => {
    const fake = rpc();
    const source = createRobinhoodFreshWalletRpcSource({
      rpcClient: fake.client, source: 'robinhood-live', sourceKind: 'live',
    });
    const results = await source.readCanonicalEvidenceBatch([firstBuy(), firstBuy()]);
    assert.equal(results.length, 2);
    assert.equal(results[0].cutoff.nonce, undefined);
    assert.equal(fake.calls.filter(([method]) => method === 'eth_getTransactionCount').length, 0);
    assert.ok(fake.batches.length > 0);
  });

  it('fails closed for missing, mismatched, malformed, and wrong-chain evidence', async () => {
    const cases = [
      rpc({ transaction: null }),
      rpc({ transaction: { from: `0x${'2'.repeat(40)}` } }),
      rpc({ firstBuyBlock: { hash: hash(99) } }),
      rpc({ cutoffNonce: '0x00' }),
      rpc({ firstBuyNonce: 5, cutoffNonce: '0x6' }),
    ];
    for (const fake of cases) {
      const source = createRobinhoodFreshWalletRpcSource({
        rpcClient: fake.client, source: 'robinhood-pc-archive', sourceKind: 'seed',
      });
      await assert.rejects(() => source.readEvidence(firstBuy()),
        (error) => error.code === 'fresh_evidence_invalid');
    }
    const wrongChain = rpc({ chainId: '0x1' });
    await assert.rejects(() => createRobinhoodFreshWalletRpcSource({
      rpcClient: wrongChain.client, source: 'robinhood-live', sourceKind: 'live',
    }).readEvidence(firstBuy()), (error) => error.code === 'configuration_error');
  });

  it('selects Archive and live configuration without an external API', () => {
    assert.deepEqual(resolveRobinhoodFreshWalletRpcProvider({
      RH_NODE_RPC_URL: 'http://archive.test',
    }), { name: 'robinhood-pc-archive', url: 'http://archive.test' });
    assert.deepEqual(resolveRobinhoodFreshWalletRpcProvider({
      ROBINHOOD_RPC_URL: 'http://live.test',
    }, 'live'), { name: 'robinhood-live', url: 'http://live.test' });
    assert.throws(() => resolveRobinhoodFreshWalletRpcProvider({}, 'archive'),
      (error) => error.code === 'configuration_error' && error.fatal === true);
  });
});
