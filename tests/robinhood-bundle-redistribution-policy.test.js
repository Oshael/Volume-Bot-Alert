const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  EVIDENCE_VERSION, MAX_SELL_DELAY_MS, RULE_VERSION, evaluateBundleRedistribution,
} = require('../src/services/robinhood-bundle-redistribution-policy');

const TOKEN = `0x${'9'.repeat(40)}`;
const SOURCE = `0x${'1'.repeat(40)}`;
const A = `0x${'2'.repeat(40)}`;
const B = `0x${'3'.repeat(40)}`;
const C = `0x${'4'.repeat(40)}`;
const CREATOR = `0x${'5'.repeat(40)}`;
const INFRA = `0x${'6'.repeat(40)}`;

function hash(value) {
  return `0x${String(value).padStart(64, '0')}`;
}

function recipient(walletAddress, delayMs, overrides = {}) {
  const transferTime = Date.parse('2026-01-01T00:10:00.000Z');
  return {
    walletAddress,
    transfer: {
      blockNumber: '20', transactionIndex: '1', logIndex: '1',
      transactionHash: hash(walletAddress.at(-1)),
      blockTime: new Date(transferTime).toISOString(), amountRaw: '100',
    },
    firstSell: delayMs == null ? null : {
      blockNumber: String(21 + Math.floor(delayMs / 60_000)),
      transactionIndex: '2', actionIndex: '2',
      transactionHash: hash(`${walletAddress.at(-1)}1`),
      blockTime: new Date(transferTime + delayMs).toISOString(), fdvUsd: 42_000,
    },
    ...overrides,
  };
}

function evaluate(recipients, overrides = {}) {
  return evaluateBundleRedistribution({
    tokenAddress: TOKEN, sourceWallet: SOURCE, creatorAddress: CREATOR,
    barrierAddresses: [INFRA],
    sourceBuy: {
      blockNumber: '10', transactionIndex: '1', actionIndex: '1', transactionHash: hash(1),
      blockTime: '2026-01-01T00:00:00.000Z', fdvUsd: 120_000,
    },
    recipients, ...overrides,
  });
}

describe('Robinhood BUNDLED redistribution policy', () => {
  it('forms a token-scoped group from two recipients selling within five minutes', () => {
    const result = evaluate([
      recipient(A, MAX_SELL_DELAY_MS), recipient(B, 60_000), recipient(C, 600_000),
    ]);
    assert.equal(result.ruleVersion, RULE_VERSION);
    assert.equal(result.evidenceVersion, EVIDENCE_VERSION);
    assert.equal(result.statusReason, 'group_found');
    assert.equal(result.rapidSellingRecipientCount, 2);
    assert.equal(result.group.memberCount, 3);
    assert.equal(result.group.connectionCount, 2);
    assert.equal(result.group.confirmationFdvUsd, 42_000);
    assert.deepEqual(result.group.members.map(({ walletAddress }) => walletAddress),
      [SOURCE, A, B]);
    assert.deepEqual(result.group.members.map(({ connectionKind }) => connectionKind),
      ['redistribution_source', 'rapid_sell_recipient', 'rapid_sell_recipient']);
    assert.equal(result.group.evidenceJson.recipients[1].firstSell.delayMs,
      MAX_SELL_DELAY_MS);
  });

  it('keeps FDV out of classification and rejects the slower secondary band', () => {
    const missingFdv = recipient(A, 60_000);
    missingFdv.firstSell.fdvUsd = null;
    const first = evaluate([missingFdv, recipient(B, 300_001)]);
    assert.equal(first.statusReason, 'no_group');
    assert.equal(first.rapidSellingRecipientCount, 1);
    const second = evaluate([missingFdv, recipient(B, 299_999)]);
    assert.equal(second.statusReason, 'group_found');
    assert.equal(second.policy.fdvIsClassificationGate, false);
    assert.equal(second.group.evidenceJson.recipients[0].firstSell.fdvUsd, null);
  });

  it('excludes creator and infrastructure on both sides', () => {
    const recipients = [recipient(CREATOR, 1_000), recipient(INFRA, 1_000),
      recipient(A, 1_000)];
    assert.equal(evaluate(recipients).statusReason, 'no_group');
    assert.equal(evaluate([recipient(A, 1_000), recipient(B, 1_000)], {
      sourceWallet: CREATOR,
    }).statusReason, 'source_excluded');
  });

  it('fails closed on duplicate recipients and invalid causal order', () => {
    assert.throws(() => evaluate([recipient(A, 1_000), recipient(A, 2_000)]),
      /duplicated/);
    const invalid = recipient(A, 1_000);
    invalid.transfer.blockNumber = '10';
    assert.throws(() => evaluate([invalid, recipient(B, 1_000)]),
      /strictly after source buy block/);
    assert.throws(() => evaluate([recipient(A, 1_000), recipient(B, 1_000)], {
      creatorAddress: null,
    }), /creatorAddress is invalid/);
  });

  it('produces the same bundle id regardless of recipient input order', () => {
    const left = evaluate([recipient(A, 1_000), recipient(B, 2_000)]);
    const right = evaluate([recipient(B, 2_000), recipient(A, 1_000)]);
    assert.equal(left.group.bundleId, right.group.bundleId);
  });
});
