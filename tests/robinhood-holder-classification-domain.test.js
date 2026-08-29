const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CLASSIFICATION_STATUSES,
  HOLDER_CLASSIFICATION_VERSION,
  HOLDER_DISTRIBUTION_METRICS,
  classificationKey,
  compareClassificationFrontiers,
  deriveClassificationStatus,
  normalizeHolderClassification,
  normalizeHolderTags,
  primaryHolderTag,
  selectClassificationRecord,
} = require('../src/services/robinhood-holder-classification-domain');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;

function record(overrides = {}) {
  return {
    tokenAddress: TOKEN,
    walletAddress: WALLET,
    tag: 'sniper',
    confidence: 'high',
    reasonCode: 'early_launch_buy',
    evidence: { deltaSeconds: 12, deltaBlocks: 1 },
    throughBlockNumber: '100',
    throughBlockHash: HASH_A,
    observedAt: '2026-08-21T12:00:00.000Z',
    ...overrides,
  };
}

describe('Robinhood holder classification domain', () => {
  it('publishes stable v1 tags, metrics and statuses', () => {
    assert.equal(HOLDER_CLASSIFICATION_VERSION, 'rh_holder_v1');
    assert.deepEqual(CLASSIFICATION_STATUSES, [
      'unavailable', 'pending', 'ready', 'stale', 'reorged',
    ]);
    assert.deepEqual(HOLDER_DISTRIBUTION_METRICS, [
      'top10', 'top50', 'snipers', 'fresh_wallets', 'insiders',
      'dev_hold', 'lp_locked', 'bundled',
    ]);
  });

  it('normalizes a versioned evidence record deterministically', () => {
    const normalized = normalizeHolderClassification(record({
      tokenAddress: TOKEN.toUpperCase().replace('0X', '0x'),
      evidence: { z: [2, 1], a: { valid: true } },
    }));

    assert.equal(normalized.chain, 'robinhood');
    assert.equal(normalized.classificationVersion, HOLDER_CLASSIFICATION_VERSION);
    assert.deepEqual(normalized.evidence, { a: { valid: true }, z: [2, 1] });
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(normalized.evidence.a), true);
    assert.match(classificationKey(normalized), /:sniper:rh_holder_v1$/);
  });

  it('accepts only the canonical reason codes for each v1 tag', () => {
    const cases = [
      ['lp', 'registered_token_pool', 'deterministic'],
      ['lp', 'registered_v4_pool_manager', 'deterministic'],
      ['cex', 'known_cex_address', 'deterministic'],
      ['sniper', 'early_launch_buy', 'high'],
      ['bundled', 'connected_funding_launch_cluster', 'heuristic'],
      ['fresh', 'new_wallet_at_first_buy', 'high'],
      ['insider', 'creator_token_distribution', 'high'],
      ['insider', 'creator_direct_funding', 'high'],
    ];

    for (const [tag, reasonCode, confidence] of cases) {
      const normalized = normalizeHolderClassification(record({ tag, reasonCode, confidence }));
      assert.deepEqual([normalized.tag, normalized.reasonCode], [tag, reasonCode]);
    }
  });

  it('keeps all tags while deriving the documented primary glyph', () => {
    const tags = normalizeHolderTags(['insider', 'lp', 'sniper', 'bundled', 'lp', 'fresh']);

    assert.deepEqual(tags, ['lp', 'sniper', 'bundled', 'fresh', 'insider']);
    assert.equal(primaryHolderTag(tags), 'sniper');
    assert.equal(primaryHolderTag(['cex', 'bundled']), 'bundled');
    assert.equal(primaryHolderTag(['insider']), 'unknown');
    assert.equal(primaryHolderTag([]), 'unknown');
  });

  it('compares frontier order and detects a same-height fork', () => {
    const frontier = (blockNumber, blockHash = HASH_A) => ({ blockNumber, blockHash });

    assert.equal(compareClassificationFrontiers(frontier(99), frontier(100)), 'behind');
    assert.equal(compareClassificationFrontiers(frontier(101), frontier(100)), 'ahead');
    assert.equal(compareClassificationFrontiers(frontier(100), frontier(100)), 'same');
    assert.equal(compareClassificationFrontiers(frontier(100), frontier(100, HASH_B)), 'fork');
  });

  it('derives availability fail-closed from source and frontier state', () => {
    const at = (blockNumber, blockHash = HASH_A) => ({ blockNumber, blockHash });
    const cases = [
      [{}, 'unavailable'],
      [{ sourceAvailable: false }, 'unavailable'],
      [{ sourceAvailable: true }, 'pending'],
      [{ sourceAvailable: true, classificationFrontier: at(100) }, 'ready'],
      [{ sourceAvailable: true, classificationFrontier: at(99), requiredFrontier: at(100) }, 'stale'],
      [{ sourceAvailable: true, classificationFrontier: at(101), requiredFrontier: at(100) }, 'ready'],
      [{ sourceAvailable: true, classificationFrontier: at(100), requiredFrontier: at(100, HASH_B) }, 'reorged'],
    ];

    for (const [input, expected] of cases) {
      assert.equal(deriveClassificationStatus(input), expected);
    }
  });

  it('is idempotent, monotonic and explicit about fork replacement', () => {
    const current = normalizeHolderClassification(record());
    const repeated = record({ observedAt: '2026-08-21T12:05:00.000Z' });
    const ahead = record({
      throughBlockNumber: '101', throughBlockHash: HASH_B,
      observedAt: '2026-08-21T12:06:00.000Z',
    });
    const fork = record({
      throughBlockHash: HASH_B, observedAt: '2026-08-21T12:07:00.000Z',
    });

    const idempotent = selectClassificationRecord(current, repeated);
    assert.deepEqual(idempotent, current);
    assert.equal(idempotent.observedAt, current.observedAt);
    assert.equal(selectClassificationRecord(ahead, current).throughBlockNumber, '101');
    assert.equal(selectClassificationRecord(current, ahead).throughBlockNumber, '101');
    assert.throws(() => selectClassificationRecord(current, fork), /explicit replacement/);
    assert.equal(
      selectClassificationRecord(current, fork, { allowForkReplacement: true }).throughBlockHash,
      HASH_B,
    );
  });

  it('rejects unsupported or contradictory evidence', () => {
    const cases = [
      record({ tag: 'unknown' }),
      record({ reasonCode: 'known_cex_address' }),
      record({ tag: 'lp', reasonCode: 'registered_token_pool', confidence: 'high' }),
      record({ evidence: {} }),
      record({ throughBlockHash: 'bad' }),
      record({ classificationVersion: 'latest' }),
      record({ chain: 'ethereum' }),
      record({ expiresAt: '2026-08-21T11:00:00.000Z' }),
    ];

    for (const input of cases) assert.throws(() => normalizeHolderClassification(input));
    assert.throws(() => selectClassificationRecord(record(), record({
      walletAddress: `0x${'3'.repeat(40)}`,
    })), /different holder classifications/);
    assert.throws(() => selectClassificationRecord(record(), record({
      evidence: { deltaSeconds: 13 },
    })), /Conflicting holder classification/);
  });
});
