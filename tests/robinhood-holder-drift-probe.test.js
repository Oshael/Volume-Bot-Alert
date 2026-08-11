const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runDriftProbe,
  __private: { balanceOfData, findFirstDeficit },
} = require('../src/utils/robinhood-holder-drift-probe');

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
        holder_count: '1',
      }] };
      if (sql.includes('FROM robinhood_holder_balances')) {
        return { rows: [{ wallet_address: ALICE, balance_raw: '5' }] };
      }
      throw new Error('unexpected query');
    } };
    const calls = [];
    const rpcClient = { async request(method, params) {
      calls.push([method, params]);
      assert.equal(method, 'eth_call');
      return '0x09';
    } };
    const reader = {
      getSafeHead: async () => ({ safeHead: '200' }),
      readRange: async () => ({ transfers: [
        transfer({ fromWallet: ZERO, toWallet: ALICE, amountRaw: '2', logIndex: 0 }),
        transfer({ amountRaw: '8', logIndex: 1 }),
      ] }),
    };

    const result = await runDriftProbe({
      database, rpcClient, reader, provider: { name: 'own-node', url: 'http://node' },
      limit: 1,
    });

    assert.equal(result.results[0].status, 'deficit-found');
    assert.equal(result.results[0].classification, 'missing-or-implicit-credit-before-block');
    assert.equal(result.results[0].localBalanceAtBlockStart, '5');
    assert.equal(result.results[0].historicalBalanceAtPrecedingBlock, '9');
    assert.deepEqual(calls[0], ['eth_call', [{
      to: TOKEN, data: balanceOfData(ALICE),
    }, '0x6d']]);
    assert.equal(queries.every((sql) => /^\s*SELECT/.test(sql)), true);
  });
});
