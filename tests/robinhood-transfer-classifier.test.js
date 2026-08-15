const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CLASSIFICATION_VERSION,
  createRobinhoodTransferClassifier,
} = require('../src/services/robinhood-transfer-classifier');

const ZERO = `0x${'0'.repeat(40)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
const POOL = `0x${'4'.repeat(40)}`;
const ROUTER = `0x${'5'.repeat(40)}`;
const CONTRACT = `0x${'6'.repeat(40)}`;
const TX = `0x${'a'.repeat(64)}`;

function transfer(overrides = {}) {
  return {
    transactionHash: TX, logIndex: '7', tokenAddress: TOKEN,
    fromWallet: ALICE, toWallet: BOB, amountRaw: '100', ...overrides,
  };
}

function swap(overrides = {}) {
  return {
    transactionHash: TX, actionIndex: '9', tokenAddress: TOKEN,
    walletAddress: ALICE, tokenAmountRaw: '100', side: 'sell', ...overrides,
  };
}

function classifier(overrides = {}) {
  return createRobinhoodTransferClassifier({
    poolAddresses: [POOL], routerAddresses: [ROUTER],
    contractAddresses: [CONTRACT], walletAddresses: [ALICE, BOB], ...overrides,
  });
}

describe('Robinhood transfer classifier', () => {
  it('classifies deterministic mint and burn evidence before technical flows', () => {
    const classify = classifier({ poolAddresses: [POOL, ZERO] }).classify;
    assert.equal(classify(transfer({ fromWallet: ZERO, toWallet: POOL })).kind, 'mint');
    assert.equal(classify(transfer({ toWallet: ZERO })).kind, 'burn');
    assert.equal(classify(transfer({ toWallet: '0x000000000000000000000000000000000000dead' })).kind, 'burn');
  });

  it('correlates exact buy and sell transfers to one wallet swap', () => {
    const classify = classifier().classify;
    const sell = classify(transfer({ toWallet: POOL }), {
      swaps: [swap()], swapCoverageComplete: true,
    });
    const buy = classify(transfer({ fromWallet: POOL, toWallet: BOB }), {
      swaps: [swap({ side: 'buy', walletAddress: ALICE, recipientAddress: BOB })],
      swapCoverageComplete: true,
    });

    for (const result of [sell, buy]) {
      assert.equal(result.kind, 'dex_flow');
      assert.equal(result.duplicateOfSwap, true);
      assert.equal(result.affectsPosition, false);
      assert.equal(result.matchedSwap.transactionHash, TX);
      assert.equal(result.matchedSwap.logOrder, 'before_swap');
    }
  });

  it('fails closed when same-asset swap correlation is incompatible or ambiguous', () => {
    const classify = classifier().classify;
    const incompatible = classify(transfer({ toWallet: POOL, amountRaw: '99' }), {
      swaps: [swap()], swapCoverageComplete: true,
    });
    const ambiguous = classify(transfer({ toWallet: POOL }), {
      swaps: [swap(), swap({ actionIndex: '10' })], swapCoverageComplete: true,
    });

    assert.equal(incompatible.kind, 'unknown');
    assert.equal(ambiguous.kind, 'unknown');
    assert.equal(ambiguous.reasonCode, 'swap_correlation_ambiguous');
  });

  it('uses proven endpoint roles in pool, router and contract priority order', () => {
    const classify = classifier().classify;
    const cases = [
      [transfer({ toWallet: POOL }), 'liquidity_flow'],
      [transfer({ toWallet: ROUTER }), 'router_flow'],
      [transfer({ toWallet: CONTRACT }), 'contract_flow'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(classify(input, { swapCoverageComplete: true }).kind, expected);
    }
  });

  it('makes only proven non-self wallet transfers financially and graph eligible', () => {
    const classify = classifier().classify;
    const complete = { swapCoverageComplete: true };
    const connected = classify(transfer(), complete);
    const self = classify(transfer({ toWallet: ALICE }), complete);
    const coverageGap = classify(transfer());
    const unproven = createRobinhoodTransferClassifier().classify(transfer(), complete);

    assert.equal(connected.kind, 'wallet_transfer');
    assert.equal(connected.affectsPosition, true);
    assert.equal(connected.connectionEligible, true);
    assert.equal(self.kind, 'wallet_self');
    assert.equal(self.reasonCode, 'wallet_self_transfer');
    assert.equal(self.affectsPosition, false);
    assert.equal(self.connectionEligible, false);
    assert.equal(coverageGap.reasonCode, 'swap_coverage_unproven');
    assert.equal(unproven.kind, 'unknown');
    assert.equal(unproven.reasonCode, 'endpoint_types_unproven');
  });

  it('returns stable versioned explanations and rejects malformed evidence', () => {
    const classify = classifier().classify;
    const result = classify(transfer(), { swapCoverageComplete: true });

    assert.equal(result.classificationVersion, CLASSIFICATION_VERSION);
    assert.equal(result.reasonCode, 'known_wallet_pair');
    assert.equal(Object.isFrozen(result), true);
    assert.throws(() => classify(transfer({ tokenAddress: 'bad' })), /tokenAddress/);
    assert.throws(() => classify(transfer(), {
      swaps: 'bad', swapCoverageComplete: true,
    }), /swaps must be a list/);
    assert.throws(() => createRobinhoodTransferClassifier({ walletAddresses: 'bad' }), /must be a list/);
  });
});
