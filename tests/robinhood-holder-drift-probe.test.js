const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runDriftProbe,
  __private: { balanceOfData, classifyOverflow, findFirstDeficit },
} = require('../src/utils/robinhood-holder-drift-probe');
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');

const ZERO = `0x${'0'.repeat(40)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const MAX_UINT256 = (1n << 256n) - 1n;

function transfer(overrides = {}) {
  return {
    blockNumber: '110', blockHash: HASH, transactionHash: HASH,
    transactionIndex: 0, logIndex: 0, tokenAddress: TOKEN,
    fromWallet: ALICE, toWallet: BOB, amountRaw: '8',
    ...overrides,
  };
}

function receiptLog(logIndex, overrides = {}) {
  return {
    address: TOKEN, topics: [TRANSFER_TOPIC], blockNumber: '0x6e',
    transactionHash: HASH, logIndex: `0x${logIndex.toString(16)}`, removed: false,
    ...overrides,
  };
}

describe('Robinhood holder drift probe', () => {
  it('locates the first negative transition without mutating the input balances', () => {
    const balances = { [ALICE]: '10' };
    const deficit = findFirstDeficit([
      transfer({ amountRaw: '7' }),
      transfer({ amountRaw: '4', logIndex: 1 }),
    ], balances);

    assert.equal(deficit.localBalanceBefore, '3');
    assert.equal(deficit.localBalanceAtBlockStart, '10');
    assert.equal(deficit.transfer.logIndex, 1);
    assert.deepEqual(balances, { [ALICE]: '10' });
  });

  it('distinguishes an invalid persisted balance from an overflow produced by logs', () => {
    const overflow = findFirstDeficit([
      transfer({ fromWallet: ALICE, toWallet: BOB, amountRaw: '1' }),
    ], { [ALICE]: '1', [BOB]: MAX_UINT256.toString() });

    assert.equal(overflow.reason, 'holder_balance_overflow');
    assert.equal(overflow.walletAddress, BOB);
    assert.equal(overflow.localBalanceBefore, MAX_UINT256.toString());
    assert.equal(overflow.projectedBalanceRaw, (MAX_UINT256 + 1n).toString());
    assert.deepEqual(classifyOverflow(overflow, MAX_UINT256.toString()), {
      classification: 'same-block-or-nonstandard-transfer-semantics',
      recommendedAction: 'fallback-required',
    });
    assert.deepEqual(classifyOverflow({
      ...overflow, localBalanceBefore: (MAX_UINT256 + 1n).toString(),
    }, '5'), {
      classification: 'invalid-persisted-balance',
      recommendedAction: 'full-replay-candidate',
    });
  });

  it('reads one drifted range and compares block-start state through historical eth_call', async () => {
    const queries = [];
    const database = { async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM robinhood_holder_token_states')) return { rows: [{
        token_address: TOKEN, deployment_block: '100', backfill_next_block: '110',
        holder_count: '1', version: '7',
      }] };
      if (sql.includes('FROM robinhood_holder_balances')) {
        return { rows: [{ wallet_address: ALICE, balance_raw: '5' }] };
      }
      throw new Error('unexpected query');
    } };
    const calls = [];
    const rpcClient = {
      async request(method, params) {
        calls.push([method, params]);
        assert.equal(method, 'eth_call');
        return '0x09';
      },
      async requestBatch(requests) {
        calls.push(['receipt-batch', requests]);
        return [[{ logs: [
          receiptLog(0), receiptLog(1),
          receiptLog(2, { transactionHash: `0x${'b'.repeat(64)}` }),
        ] }]];
      },
    };
    const reader = {
      getSafeHead: async () => ({ safeHead: '200' }),
      readRange: async (range) => ({ ...range, transfers: [
        transfer({ fromWallet: ZERO, toWallet: ALICE, amountRaw: '2', logIndex: 0 }),
        transfer({ amountRaw: '8', logIndex: 1 }),
      ] }),
    };

    const result = await runDriftProbe({
      database, rpcClient, reader, provider: { name: 'own-node', url: 'http://node' },
      limit: 1, now: () => 1000,
    });

    assert.equal(result.results[0].status, 'deficit-found');
    assert.equal(result.results[0].classification, 'missing-or-implicit-credit-before-block');
    assert.equal(result.results[0].localBalanceAtBlockStart, '5');
    assert.equal(result.results[0].historicalBalanceAtPrecedingBlock, '9');
    assert.equal(result.results[0].version, '7');
    assert.deepEqual(result.results[0].receiptEvidence, {
      status: 'mismatch', fromBlock: '110', toBlock: '110', blockCount: 1,
      rpcBatches: 1, receiptCount: 1, getLogsTransfers: 2, receiptTransfers: 3,
      missingFromGetLogsCount: 1, missingFromReceiptsCount: 0,
      missingFromGetLogs: [`0x${'b'.repeat(64)}:2`], missingFromReceipts: [],
      elapsedMs: 0,
    });
    assert.deepEqual(calls[0], ['eth_call', [{
      to: TOKEN, data: balanceOfData(ALICE),
    }, '0x6d']]);
    assert.deepEqual(calls[1], ['receipt-batch', [
      { method: 'eth_getBlockReceipts', params: ['0x6e'] },
    ]]);
    assert.equal(queries.every((sql) => /^\s*SELECT/.test(sql)), true);
  });

  it('reports uint256 overflow evidence and a fail-closed recovery recommendation', async () => {
    const database = { async query(sql) {
      if (sql.includes('FROM robinhood_holder_token_states')) return { rows: [{
        token_address: TOKEN, deployment_block: '100', backfill_next_block: '110',
        holder_count: '1', version: '8',
      }] };
      if (sql.includes('FROM robinhood_holder_balances')) return { rows: [{
        wallet_address: BOB, balance_raw: (MAX_UINT256 + 1n).toString(),
      }] };
      throw new Error('unexpected query');
    } };
    const calls = [];
    const rpcClient = {
      async request(method, params) {
        calls.push([method, params]);
        return params[1] === '0x6d' ? '0x05' : '0x04';
      },
      async requestBatch(requests) {
        calls.push(['receipt-batch', requests]);
        return [[{ logs: [receiptLog(0)] }]];
      },
    };
    const reader = {
      getSafeHead: async () => ({ safeHead: '200' }),
      readRange: async (range) => ({ ...range, transfers: [
        transfer({ fromWallet: BOB, toWallet: ALICE, amountRaw: '1' }),
      ] }),
    };

    const result = await runDriftProbe({
      database, rpcClient, reader, provider: { name: 'archive', url: 'http://node' },
      limit: 1, now: () => 1000,
    });
    const inspected = result.results[0];

    assert.equal(inspected.status, 'overflow-found');
    assert.equal(inspected.classification, 'invalid-persisted-balance');
    assert.equal(inspected.recommendedAction, 'full-replay-candidate');
    assert.equal(inspected.walletAddress, BOB);
    assert.equal(inspected.projectedBalanceRaw, (MAX_UINT256 + 1n).toString());
    assert.equal(inspected.historicalBalanceAtPrecedingBlock, '5');
    assert.equal(inspected.historicalBalanceAtFailedBlock, '4');
    assert.equal(inspected.receiptEvidence.status, 'match');
    assert.deepEqual(inspected.archiveErrors, { precedingBlock: null, failedBlock: null });
    assert.equal(calls.filter(([method]) => method === 'eth_call').length, 2);
  });
});
