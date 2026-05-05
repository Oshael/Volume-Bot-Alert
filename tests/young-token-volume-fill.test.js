const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { fillYoungTokenVolumeWindows } = require('../src/services/young-token-volume-fill');

describe('young token volume window fill', () => {
  it('fills missing 1h from 5m while the token is younger than 1h', () => {
    const snapshot = fillYoungTokenVolumeWindows({
      tokenCreatedAt: '2026-05-04T10:00:00.000Z',
      vol5m: 59000,
      vol1h: 0,
      vol6h: 0,
      vol24h: 0,
    }, {
      now: new Date('2026-05-04T10:10:00.000Z'),
    });

    assert.equal(snapshot.vol1h, 59000);
    assert.equal(snapshot.vol6h, 59000);
    assert.equal(snapshot.vol24h, 59000);
  });

  it('does not fill 1h from 5m after the token is older than 1h', () => {
    const snapshot = fillYoungTokenVolumeWindows({
      tokenCreatedAt: '2026-05-04T10:00:00.000Z',
      vol5m: 59000,
      vol1h: 0,
      vol6h: 0,
      vol24h: 0,
    }, {
      now: new Date('2026-05-04T11:05:00.000Z'),
    });

    assert.equal(snapshot.vol1h, 0);
    assert.equal(snapshot.vol6h, 59000);
    assert.equal(snapshot.vol24h, 59000);
  });

  it('fills missing 6h and 24h windows from shorter volume while the token is younger than both windows', () => {
    const snapshot = fillYoungTokenVolumeWindows({
      tokenCreatedAt: '2026-05-04T10:00:00.000Z',
      vol5m: 91000,
      vol1h: 663000,
      vol6h: 0,
      vol24h: null,
    }, {
      now: new Date('2026-05-04T10:30:00.000Z'),
    });

    assert.equal(snapshot.vol6h, 663000);
    assert.equal(snapshot.vol24h, 663000);
  });

  it('does not overwrite positive native longer-window volumes', () => {
    const snapshot = fillYoungTokenVolumeWindows({
      tokenCreatedAt: '2026-05-04T10:00:00.000Z',
      vol5m: 91000,
      vol1h: 663000,
      vol6h: 700000,
      vol24h: 800000,
    }, {
      now: new Date('2026-05-04T10:30:00.000Z'),
    });

    assert.equal(snapshot.vol6h, 700000);
    assert.equal(snapshot.vol24h, 800000);
  });

  it('only fills 24h when the token is older than 6h but younger than 24h', () => {
    const snapshot = fillYoungTokenVolumeWindows({
      tokenCreatedAt: '2026-05-04T00:00:00.000Z',
      vol5m: 10000,
      vol1h: 20000,
      vol6h: 30000,
      vol24h: 0,
    }, {
      now: new Date('2026-05-04T10:00:00.000Z'),
    });

    assert.equal(snapshot.vol6h, 30000);
    assert.equal(snapshot.vol24h, 30000);
  });
});
