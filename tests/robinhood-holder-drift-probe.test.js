const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runDriftProbe,
  __private: { balanceOfData, findFirstDeficit },
} = require('../src/utils/robinhood-holder-drift-probe');
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');

const ZERO = `0x${'0'.repeat(40)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

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
});
