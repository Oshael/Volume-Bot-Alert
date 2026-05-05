const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeConfidence,
  normalizeDataset,
  normalizeLabel,
} = require('../src/utils/normalize-token-junk-dataset');

describe('normalize token junk dataset', () => {
  it('normalizes known label variants', () => {
    assert.equal(normalizeLabel('Junk'), 'junk_probable');
    assert.equal(normalizeLabel('junk'), 'junk_probable');
    assert.equal(normalizeLabel('legit'), 'valid');
    assert.equal(normalizeLabel('weak but legit'), 'valid_but_weak');
    assert.equal(normalizeLabel('weak/monitoring'), 'valid_but_weak');
  });

  it('normalizes confidence to lowercase', () => {
    assert.equal(normalizeConfidence('High'), 'high');
    assert.equal(normalizeConfidence('medium'), 'medium');
    assert.equal(normalizeConfidence(''), null);
  });

  it('ignores string notes and merges duplicate addresses', () => {
    const normalized = normalizeDataset([
      '# note',
      {
        address: 'TokenA',
        label: 'Junk',
        reason: 'first reason',
        confidence: 'medium',
      },
      {
        address: 'TokenA',
        label: 'junk',
        reason: 'second reason',
        confidence: 'High',
      },
      {
        address: 'TokenB',
        label: 'legit',
        reason: 'looks fine',
        confidence: 'low',
      },
    ]);

    assert.deepEqual(normalized.meta.datasetNotes, ['# note']);
    assert.equal(normalized.meta.totalEntries, 2);
    assert.deepEqual(normalized.meta.labelCounts, {
      junk_probable: 1,
      valid: 1,
    });
    assert.equal(normalized.entries[0].address, 'TokenA');
    assert.equal(normalized.entries[0].label, 'junk_probable');
    assert.equal(normalized.entries[0].confidence, 'high');
    assert.match(normalized.entries[0].notes || '', /extra_reason: second reason/);
  });

  it('rejects conflicting labels for the same address', () => {
    assert.throws(() => normalizeDataset([
      {
        address: 'TokenA',
        label: 'junk',
        reason: 'bad',
      },
      {
        address: 'TokenA',
        label: 'legit',
        reason: 'good',
      },
    ]), /Conflicting labels/);
  });
});
