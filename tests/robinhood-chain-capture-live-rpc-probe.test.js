'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { CAPTURE_TOPICS } = require('../src/services/robinhood-chain-capture-worker');
const {
  nonNegativeInteger, resolveEndpoint, runProbe, sampleBlocks,
} = require('../src/utils/probe-robinhood-chain-capture-live-rpc');

const hash = (character) => `0x${character.repeat(64)}`;
const address = (character) => `0x${character.repeat(40)}`;

function jsonResponse(result) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', result }) };
}

function blockFixture(tag) {
  const number = BigInt(tag); const blockHash = hash(number % 2n ? 'a' : 'b');
  const transactionHash = hash(number % 2n ? 'c' : 'd');
  return {
    block: {
      number: tag, hash: blockHash, parentHash: hash('e'), timestamp: '0x64',
      transactions: [{
        hash: transactionHash, transactionIndex: '0x0', from: address('1'), to: address('2'),
        nonce: '0x1', value: '0x0', blockNumber: tag, blockHash,
      }],
    },
    receipts: [{
      transactionHash, transactionIndex: '0x0', blockNumber: tag, blockHash,
      status: '0x1', contractAddress: null, logs: [{
        transactionHash, transactionIndex: '0x0', blockNumber: tag, blockHash,
        logIndex: '0x0', address: address('3'), topics: [CAPTURE_TOPICS[0]], data: '0x',
      }],
    }],
  };
}

describe('Robinhood chain capture live RPC probe', () => {
  it('requires an explicit permanent endpoint and chooses the dedicated override', () => {
    assert.throws(() => resolveEndpoint({}), /is required/);
    assert.deepEqual(resolveEndpoint({
      ROBINHOOD_RPC_URL: 'https://public.test',
      ROBINHOOD_CHAIN_CAPTURE_LIVE_RPC_URL: 'https://live.test/key',
    }), { key: 'ROBINHOOD_CHAIN_CAPTURE_LIVE_RPC_URL', url: 'https://live.test/key' });
    assert.deepEqual(sampleBlocks(100n, 2, 64), [98n, 36n]);
    assert.equal(nonNegativeInteger('0', 2, 1000), 0);
  });

  it('approves consistent full blocks and receipts at recent and rollback depths', async () => {
    const methods = [];
    const report = await runProbe({
      endpoint: { key: 'test', url: 'https://live.test/secret' },
      confirmations: 2, historyDepth: 64,
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init.body); methods.push(request.method);
        if (request.method === 'eth_chainId') return jsonResponse('0x1237');
        if (request.method === 'eth_blockNumber') return jsonResponse('0x64');
        const fixture = blockFixture(request.params[0]);
        return jsonResponse(request.method === 'eth_getBlockByNumber'
          ? fixture.block : fixture.receipts);
      },
    });
    assert.equal(report.approved, true);
    assert.equal(report.endpoint, 'https://live.test/***');
    assert.deepEqual(report.samples.map(({ blockNumber }) => blockNumber), ['98', '36']);
    assert.equal(report.samples.every(({ transactions }) => transactions === 1), true);
    assert.equal(methods.filter((method) => method === 'eth_getBlockReceipts').length, 2);
    assert.equal(report.requests, 6);
  });

  it('fails closed on the wrong chain or incomplete receipts', async () => {
    const wrongChain = await runProbe({
      endpoint: { key: 'test', url: 'https://wrong.test' },
      fetchImpl: async () => jsonResponse('0x1'),
    });
    assert.deepEqual(wrongChain.blockers, [{
      code: 'chain_id_mismatch', actual: '1', expected: '4663',
    }]);

    const incomplete = await runProbe({
      endpoint: { key: 'test', url: 'https://live.test' },
      fetchImpl: async (_url, init) => {
        const request = JSON.parse(init.body);
        if (request.method === 'eth_chainId') return jsonResponse('0x1237');
        if (request.method === 'eth_blockNumber') return jsonResponse('0x64');
        if (request.method === 'eth_getBlockByNumber') {
          return jsonResponse(blockFixture(request.params[0]).block);
        }
        return jsonResponse([]);
      },
    });
    assert.equal(incomplete.approved, false);
    assert.deepEqual(incomplete.blockers.map(({ code }) => code), [
      'receipt_capture_unsupported', 'receipt_capture_unsupported',
    ]);
  });
});
