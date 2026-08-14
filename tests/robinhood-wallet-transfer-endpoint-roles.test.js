const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  MAX_ROLE_PROBES,
  createRobinhoodWalletTransferEndpointRoleReader,
  __private: { bytecodePresent, probePlan },
} = require('../src/services/robinhood-wallet-transfer-endpoint-roles');

const ALICE = `0x${'1'.repeat(40)}`;
const BOB = `0x${'2'.repeat(40)}`;
const CONTRACT = `0x${'3'.repeat(40)}`;
const POOL = `0x${'4'.repeat(40)}`;
const ROUTER = `0x${'5'.repeat(40)}`;
const KNOWN = `0x${'6'.repeat(40)}`;
const ZERO = `0x${'0'.repeat(40)}`;
const PRECOMPILE = `0x${'0'.repeat(39)}9`;

function transfer(blockNumber, fromWallet, toWallet) {
  return { blockNumber: String(blockNumber), fromWallet, toWallet };
}

describe('Robinhood wallet transfer endpoint roles', () => {
  it('resolves no-code endpoints as wallets and any-code endpoints as contracts', async () => {
    const calls = [];
    const rpcClient = { requestBatch: async (requests) => {
      calls.push(requests);
      return requests.map(({ params }) => params[0] === CONTRACT ? '0x6000' : '0x');
    } };
    const reader = createRobinhoodWalletTransferEndpointRoleReader({ rpcClient, batchSize: 2 });
    const result = await reader.resolveRoles({
      transfers: [
        transfer(100, ALICE, CONTRACT), transfer(101, ALICE, CONTRACT),
        transfer(101, POOL, BOB), transfer(101, ROUTER, KNOWN), transfer(102, ZERO, BOB),
        transfer(102, PRECOMPILE, BOB),
      ],
      poolAddresses: [POOL], routerAddresses: [ROUTER], walletAddresses: [KNOWN],
    });

    assert.deepEqual(calls.map((batch) => batch.length), [2, 2, 2]);
    assert.ok(calls.flat().every(({ method }) => method === 'eth_getCode'));
    assert.deepEqual(new Set(calls.flat().map(({ params }) => params[1])), new Set([
      '0x64', '0x65', '0x66',
    ]));
    assert.deepEqual(result.contractAddresses, [CONTRACT]);
    assert.deepEqual(result.walletAddresses, [ALICE, BOB]);
    assert.deepEqual(result.telemetry, { probes: 6, batches: 3, endpoints: 3 });
  });

  it('classifies an endpoint conservatively as contract if any observed block has code', async () => {
    let index = 0;
    const reader = createRobinhoodWalletTransferEndpointRoleReader({
      rpcClient: { requestBatch: async (requests) => requests.map(() => (
        index++ === 0 ? '0x' : '0x60'
      )) },
    });
    const result = await reader.resolveRoles({
      transfers: [transfer(100, ALICE, ZERO), transfer(101, ALICE, ZERO)],
    });

    assert.deepEqual(result.contractAddresses, [ALICE]);
    assert.deepEqual(result.walletAddresses, []);
  });

  it('rejects malformed bytecode and incomplete batch responses', async () => {
    assert.throws(() => bytecodePresent('0x0'), /invalid bytecode/);
    const reader = createRobinhoodWalletTransferEndpointRoleReader({
      rpcClient: { requestBatch: async () => [] },
    });
    await assert.rejects(
      reader.resolveRoles({ transfers: [transfer(100, ALICE, BOB)] }),
      /invalid result count/
    );
  });

  it('caps unique address-block probes before issuing RPC', () => {
    const transfers = Array.from({ length: (MAX_ROLE_PROBES / 2) + 1 }, (_, index) => (
      transfer(index + 1, ALICE, BOB)
    ));
    assert.throws(() => probePlan({ transfers }), /probes exceed/);
  });
});
