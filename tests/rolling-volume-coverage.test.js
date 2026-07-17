const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  deriveRollingVolumeCoverage,
} = require('../src/services/rolling-volume-coverage');

const NOW = '2026-07-15T18:00:00.000Z';

describe('rolling volume coverage provenance', () => {
  it('marks unchanged direct upstream windows complete', () => {
    const raw = { vol1m: 10, vol5m: 50, vol1h: 500, vol6h: 2000, vol24h: 9000 };
    assert.deepEqual(deriveRollingVolumeCoverage(raw, raw, { now: NOW }), {
      '1m': 'complete', '5m': 'complete', '1h': 'complete',
      '6h': 'complete', '24h': 'complete',
    });
  });

  it('marks a catalog-preserved value partial even when the snapshot is fresh', () => {
    const coverage = deriveRollingVolumeCoverage({
      vol5m: 0, vol1h: 100, vol6h: 400, vol24h: 1000,
    }, {
      vol5m: 50, vol1h: 500, vol6h: 2000, vol24h: 9000,
    }, { now: NOW });

    assert.equal(coverage['5m'], 'partial');
    assert.equal(coverage['1h'], 'partial');
    assert.equal(coverage['6h'], 'partial');
    assert.equal(coverage['24h'], 'partial');
  });

  it('does not treat a source window shorter than the token lifetime as complete', () => {
    const coverage = deriveRollingVolumeCoverage({
      tokenCreatedAt: '2026-07-15T17:30:00.000Z',
      vol5m: 50,
      vol1h: null,
      vol6h: null,
      vol24h: null,
    }, {
      vol5m: 50,
      vol1h: 50,
      vol6h: 50,
      vol24h: 50,
    }, { now: NOW });

    assert.equal(coverage['5m'], 'complete');
    assert.equal(coverage['1h'], 'partial');
    assert.equal(coverage['6h'], 'partial');
    assert.equal(coverage['24h'], 'partial');
  });

  it('accepts a shorter direct window only when it covers the token lifetime', () => {
    const coverage = deriveRollingVolumeCoverage({
      tokenCreatedAt: '2026-07-15T17:56:00.000Z',
      vol5m: 50,
    }, {
      vol5m: 50,
      vol1h: 50,
      vol6h: 50,
      vol24h: 50,
    }, { now: NOW });

    assert.equal(coverage['1h'], 'complete');
    assert.equal(coverage['6h'], 'complete');
    assert.equal(coverage['24h'], 'complete');
  });

  it('does not use a shorter window once the token is older than the target', () => {
    const coverage = deriveRollingVolumeCoverage({
      tokenCreatedAt: '2026-07-15T12:00:00.000Z',
      vol5m: 50,
    }, {
      vol5m: 50,
      vol1h: 50,
      vol6h: 50,
      vol24h: 50,
    }, { now: NOW });

    assert.equal(coverage['1h'], 'partial');
    assert.equal(coverage['6h'], 'partial');
    assert.equal(coverage['24h'], 'partial');
  });

  it('keeps missing normalized values unavailable', () => {
    const coverage = deriveRollingVolumeCoverage({}, {}, { now: NOW });
    assert.deepEqual(coverage, {
      '1m': 'unavailable', '5m': 'unavailable', '1h': 'unavailable',
      '6h': 'unavailable', '24h': 'unavailable',
    });
    assert.throws(
      () => deriveRollingVolumeCoverage({}, {}, { now: 'invalid' }), /now is invalid/,
    );
  });
});
