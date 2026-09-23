const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { findExactBuySplitEvidence } = require('../src/services/robinhood-wallet-transfer-split-evidence');
const { classifyTransfers } = require('../src/services/robinhood-wallet-transfer-batch');

const TOKEN = '0xf8c9d7a0905143a525469e7be4c89c6f9bfe7777';
const WALLET = '0xa28284148f9a2b7b1037b81a86e8b19116d43b74';
const SOURCE = '0x95556d498dfdda36380e8701adca762cb880e519';
const TX = '0x0d4ea12817d801c8fda870f6962c1a7adeba7c3451d18758e3790ad48354f3fc';

function transfer(logIndex, toWallet, amountRaw) {
  return {
    transactionHash: TX, tokenAddress: TOKEN, fromWallet: SOURCE, toWallet,
    logIndex: String(logIndex), amountRaw, transferKind: 'unknown', blockNumber: '100',
  };
}
function swap(overrides = {}) {
  return {
    transactionHash: TX, tokenAddress: TOKEN, actionIndex: '60', side: 'buy',
    walletAddress: WALLET, tokenAmountRaw: '590015906838025895703115', ...overrides,
  };
}
function legs() {
  return [
    transfer(53, TOKEN, '5900159068380258957031'),
    transfer(55, WALLET, '584115747769645636746084'),
  ];
}

describe('Robinhood exact buy split evidence', () => {
  it('recognizes the observed gross split without changing either unknown decision', () => {
    const evidence = findExactBuySplitEvidence(legs(), [swap()]);
    assert.deepEqual(evidence, [{
      transactionHash: TX, tokenAddress: TOKEN, swapActionIndex: '60',
      walletLogIndex: '55', contractLogIndex: '53',
      grossAmountRaw: '590015906838025895703115',
      walletReceivedRaw: '584115747769645636746084',
      contractReceivedRaw: '5900159068380258957031',
    }]);

    const result = classifyTransfers(legs(), {
      swaps: [swap()], swapCoverageComplete: true,
      poolAddresses: [], routerAddresses: [], contractAddresses: [TOKEN],
      walletAddresses: [WALLET],
    });
    assert.deepEqual(result.counts, { unknown: 2 });
    assert.equal(result.unknownEvidence.exactBuySplitTransactions, 1);
    assert.ok(result.events.every(({ transferKind }) => transferKind === 'unknown'));
  });

  it('rejects incomplete, non-unique and non-conserving splits', () => {
    const cases = [
      { transfers: legs().slice(1), swaps: [swap()] },
      { transfers: [...legs(), transfer(57, WALLET, '1')], swaps: [swap()] },
      { transfers: legs(), swaps: [swap(), swap({ actionIndex: '61' })] },
      { transfers: legs(), swaps: [swap({ tokenAmountRaw: '590015906838025895703116' })] },
      { transfers: legs(), swaps: [swap({ side: 'sell' })] },
      { transfers: [legs()[0], { ...legs()[1], fromWallet: WALLET }], swaps: [swap()] },
      { transfers: [legs()[0], { ...legs()[1], logIndex: '61' }], swaps: [swap()] },
      { transfers: [legs()[0], { ...legs()[1], transferKind: 'dex_flow' }], swaps: [swap()] },
    ];
    for (const input of cases) assert.deepEqual(findExactBuySplitEvidence(
      input.transfers, input.swaps
    ), []);
  });
});
