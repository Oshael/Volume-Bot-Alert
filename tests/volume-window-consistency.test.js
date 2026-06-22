process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  isCumulativeVolumeWindowCoherent,
  normalizeCumulativeVolumeWindows,
} = require('../src/services/volume-window-consistency');

describe('volume window consistency', () => {
  it('treats cumulative volume windows as 24h >= 6h >= 1h', () => {
    assert.equal(isCumulativeVolumeWindowCoherent({
      vol24h: 1000,
      vol6h: 1000,
      vol1h: 64000,
    }), false);

    assert.equal(isCumulativeVolumeWindowCoherent({
      vol24h: 64000,
      vol6h: 64000,
      vol1h: 64000,
    }), true);
  });

  it('normalizes positive but incoherent GMGN-style windows using previous stronger values', () => {
    const normalized = normalizeCumulativeVolumeWindows({
      vol24h: 1254.21,
      vol6h: 1254.21,
      vol1h: 63885.03,
    }, {
      vol24h: 360676.66,
      vol6h: 360676.66,
    });

    assert.equal(normalized.vol1h, 63885.03);
    assert.equal(normalized.vol6h, 360676.66);
    assert.equal(normalized.vol24h, 360676.66);
  });

  it('raises missing previous windows to the smallest coherent value', () => {
    const normalized = normalizeCumulativeVolumeWindows({
      vol24h: 1254.21,
      vol6h: 1254.21,
      vol1h: 63885.03,
    });

    assert.equal(normalized.vol6h, 63885.03);
    assert.equal(normalized.vol24h, 63885.03);
  });
});
