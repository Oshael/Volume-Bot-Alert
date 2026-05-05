const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const alertTickerPeers = require('../src/services/alert-ticker-peers');

const SOURCE_ADDRESS = 'So11111111111111111111111111111111111111112';
const PEER_ADDRESS = '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb';

describe('alert ticker peers', () => {
  it('classifies the source token as OG when it is oldest and highest market cap exact peer', () => {
    const role = alertTickerPeers.__private.resolveSourcePeerRole(SOURCE_ADDRESS, {
      exactCount: 3,
      subtickerCount: 0,
      oldestExactAddress: SOURCE_ADDRESS,
      highestMcapExactAddress: SOURCE_ADDRESS,
    });

    assert.equal(role, 'og');
  });

  it('keeps OG when another exact peer is missing created-at but the source is oldest known and highest market cap', () => {
    const role = alertTickerPeers.__private.resolveSourcePeerRole(SOURCE_ADDRESS, {
      exactCount: 4,
      subtickerCount: 0,
      exactMissingCreatedAtCount: 1,
      exactMissingMcapCount: 0,
      oldestExactAddress: SOURCE_ADDRESS,
      highestMcapExactAddress: SOURCE_ADDRESS,
    });

    assert.equal(role, 'og');
  });

  it('classifies the source token as market-cap leader when it is not the oldest exact peer', () => {
    const role = alertTickerPeers.__private.resolveSourcePeerRole(SOURCE_ADDRESS, {
      exactCount: 2,
      subtickerCount: 0,
      oldestExactAddress: PEER_ADDRESS,
      highestMcapExactAddress: SOURCE_ADDRESS,
    });

    assert.equal(role, 'mcap_leader');
  });

  it('keeps warning semantics when only subticker peers exist', () => {
    const role = alertTickerPeers.__private.resolveSourcePeerRole(SOURCE_ADDRESS, {
      exactCount: 1,
      subtickerCount: 2,
      oldestExactAddress: SOURCE_ADDRESS,
      highestMcapExactAddress: SOURCE_ADDRESS,
    });

    assert.equal(role, 'peer_warning');
  });

  it('keeps contextual subticker peers when the extension matches the source name', () => {
    assert.equal(alertTickerPeers.__private.isContextualSubtickerPeer(
      { symbol: 'CRYO', name: 'Cry Out Loud' },
      { symbol: 'CRYOOUTLOUD', name: 'Cry Out Loud' }
    ), true);
  });

  it('filters unrelated subticker peers when the extension conflicts with source context', () => {
    assert.equal(alertTickerPeers.__private.isContextualSubtickerPeer(
      { symbol: 'CRYO', name: 'Cry Out Loud' },
      { symbol: 'CRYOTRUMP', name: 'Cry Trump' }
    ), false);
  });

  it('allows contextual subticker checks for 3-character source tickers', async () => {
    const calls = [];
    const runner = {
      async query(sql, params) {
        calls.push({ sql: String(sql), params });
        return { rows: [] };
      },
    };

    await alertTickerPeers.listTickerPeersBySymbol('CRY', { limit: 8 }, runner);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].params[1], 3);
  });

  it('does not promote the source token when exact peer market cap data is incomplete', () => {
    const role = alertTickerPeers.__private.resolveSourcePeerRole(SOURCE_ADDRESS, {
      exactCount: 2,
      subtickerCount: 0,
      exactMissingCreatedAtCount: 0,
      exactMissingMcapCount: 1,
      oldestExactAddress: SOURCE_ADDRESS,
      highestMcapExactAddress: SOURCE_ADDRESS,
    });

    assert.equal(role, 'peer_warning');
  });

  it('adds peer role metadata to alert snapshots', async () => {
    const calls = [];
    const runner = {
      async query(sql, params) {
        calls.push({ sql: String(sql), params });
        if (calls.length === 1) {
          return {
            rows: [
              {
                address: SOURCE_ADDRESS,
                symbol: 'WSOL',
                name: 'Wrapped SOL',
                image_url: 'https://example.com/wsol.png',
                last_mcap: '300000',
                last_token_created_at_ms: '1710000000000',
                age_ms_at_alert: '7200000',
                match_type: 'exact',
                exact_count: '2',
                subticker_count: '0',
                oldest_exact_address: PEER_ADDRESS,
                highest_mcap_exact_address: SOURCE_ADDRESS,
              },
              {
                address: PEER_ADDRESS,
                symbol: 'WSOL',
                name: 'Older WSOL',
                last_mcap: '120000',
                last_token_created_at_ms: '1700000000000',
                age_ms_at_alert: '172000000',
                match_type: 'exact',
                exact_count: '2',
                subticker_count: '0',
                oldest_exact_address: PEER_ADDRESS,
                highest_mcap_exact_address: SOURCE_ADDRESS,
              },
            ],
          };
        }
        return {
          rows: [{
            exact_count: '2',
            subticker_count: '0',
            oldest_exact_address: PEER_ADDRESS,
            highest_mcap_exact_address: SOURCE_ADDRESS,
          }],
        };
      },
    };

    const snapshot = await alertTickerPeers.buildTickerPeerSnapshotForAlert({
      address: SOURCE_ADDRESS,
      symbol: 'WSOL',
    }, { snapshotTsMs: 1710007200000 }, runner);

    assert.equal(snapshot.sourcePeerRole, 'mcap_leader');
    assert.equal(snapshot.exactCount, 2);
    assert.equal(snapshot.subtickerCount, 0);
    assert.equal(snapshot.oldestExactAddress, PEER_ADDRESS);
    assert.equal(snapshot.highestMcapExactAddress, SOURCE_ADDRESS);
    assert.equal(snapshot.items[0].ageMsAtAlert, 7200000);
    assert.equal(calls.length, 1);
  });
});
