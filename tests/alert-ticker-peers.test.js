const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const alertTickerPeers = require('../src/services/alert-ticker-peers');

const SOURCE_ADDRESS = 'So11111111111111111111111111111111111111112';
const PEER_ADDRESS = '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb';
const ROBINHOOD_SOURCE_ADDRESS = '0x1111111111111111111111111111111111111111';
const ROBINHOOD_PEER_ADDRESS = '0x2222222222222222222222222222222222222222';

// Both peer queries must share the same invariants, so each assertion below runs
// against the SQL of the by-symbol snapshot path and of the monitored batch path.
async function captureTickerPeerQuerySql() {
  const sqls = [];
  const runner = {
    async query(sql) {
      sqls.push(String(sql));
      return { rows: [] };
    },
  };

  await alertTickerPeers.__private.queryTickerPeerRowsBySymbol('HOBBES', {}, runner);
  await alertTickerPeers.listTickerPeerSummariesForTokens([
    { address: SOURCE_ADDRESS, symbol: 'HOBBES' },
  ], {}, runner);

  return sqls;
}

describe('alert ticker peers', () => {
  it('classifies the source token as OG when it is the oldest exact peer', () => {
    const role = alertTickerPeers.__private.resolveSourcePeerRole(SOURCE_ADDRESS, {
      exactCount: 3,
      subtickerCount: 0,
      oldestExactAddress: SOURCE_ADDRESS,
      highestMcapExactAddress: PEER_ADDRESS,
    });

    assert.equal(role, 'og');
  });

  it('keeps OG when another exact peer is missing created-at but the source is oldest known', () => {
    const role = alertTickerPeers.__private.resolveSourcePeerRole(SOURCE_ADDRESS, {
      exactCount: 4,
      subtickerCount: 0,
      oldestExactAddress: SOURCE_ADDRESS,
      highestMcapExactAddress: PEER_ADDRESS,
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
    assert.equal(calls[0].params[4], 'solana');
    assert.match(calls[0].sql, /WHERE chain = \$5/);
  });

  it('scopes Robinhood OG peers to Robinhood catalog rows', async () => {
    const calls = [];
    const runner = {
      async query(sql, params) {
        calls.push({ sql: String(sql), params });
        return {
          rows: [
            {
              address: ROBINHOOD_SOURCE_ADDRESS,
              symbol: 'HOOD',
              last_mcap: '300000',
              last_token_created_at_ms: '1700000000000',
              age_ms_at_alert: '2000',
              match_type: 'exact',
              exact_count: '2',
              subticker_count: '0',
              oldest_exact_address: ROBINHOOD_SOURCE_ADDRESS,
              highest_mcap_exact_address: ROBINHOOD_SOURCE_ADDRESS,
            },
            {
              address: ROBINHOOD_PEER_ADDRESS,
              symbol: 'HOOD',
              last_mcap: '100000',
              last_token_created_at_ms: '1700000001000',
              age_ms_at_alert: '1000',
              match_type: 'exact',
              exact_count: '2',
              subticker_count: '0',
              oldest_exact_address: ROBINHOOD_SOURCE_ADDRESS,
              highest_mcap_exact_address: ROBINHOOD_SOURCE_ADDRESS,
            },
          ],
        };
      },
    };

    const snapshot = await alertTickerPeers.buildTickerPeerSnapshotForAlert({
      chain: 'robinhood',
      address: ROBINHOOD_SOURCE_ADDRESS.toUpperCase().replace('0X', '0x'),
      symbol: 'HOOD',
    }, {}, runner);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].params[4], 'robinhood');
    assert.match(calls[0].sql, /WHERE chain = \$5/);
    assert.equal(snapshot.chain, 'robinhood');
    assert.equal(snapshot.sourcePeerRole, 'og');
    assert.equal(snapshot.items.length, 2);
  });

  it('keeps the market-cap leader role when other exact peers have no market cap data', () => {
    const role = alertTickerPeers.__private.resolveSourcePeerRole(SOURCE_ADDRESS, {
      exactCount: 40,
      subtickerCount: 0,
      oldestExactAddress: PEER_ADDRESS,
      highestMcapExactAddress: SOURCE_ADDRESS,
    });

    assert.equal(role, 'mcap_leader');
  });

  it('treats nonpositive token-created timestamps as missing for OG peer queries', async () => {
    const sqls = await captureTickerPeerQuerySql();

    assert.equal(sqls.length, 2);
    for (const sql of sqls) {
      assert.match(sql, /last_token_created_at_ms IS NOT NULL\s+AND last_token_created_at_ms > 0/i);
    }
  });

  it('keeps a peer whose market cap stopped being refreshed out of the leader pick', async () => {
    const sqls = await captureTickerPeerQuerySql();

    assert.equal(sqls.length, 2);
    for (const sql of sqls) {
      // The leader aggregate must be restricted to peers with fresh market data,
      // otherwise a rugged token keeps the #1 badge with its frozen peak mcap.
      assert.match(sql, /last_mcap > 0\s+AND has_fresh_mcap/i);
      assert.match(sql, /metadata_updated_at > NOW\(\) - make_interval\(secs => \$\d+\)/i);
    }
  });

  it('flags peers whose market cap is stale', () => {
    const fresh = alertTickerPeers.__private.mapPeerRow({
      address: SOURCE_ADDRESS,
      last_mcap: '13241900',
      has_fresh_mcap: true,
      mcap_age_ms: '0',
    });
    const stale = alertTickerPeers.__private.mapPeerRow({
      address: PEER_ADDRESS,
      last_mcap: '18874618',
      has_fresh_mcap: false,
      mcap_age_ms: '342000000',
    });

    assert.equal(fresh.mcapStale, false);
    assert.equal(stale.mcapStale, true);
    assert.equal(stale.mcap, 18874618);
    assert.equal(stale.mcapAgeMs, 342000000);
  });

  it('keeps the OG and market-cap leader rows even when they fall outside the ranked limit', async () => {
    const sqls = await captureTickerPeerQuerySql();

    assert.equal(sqls.length, 2);
    for (const sql of sqls) {
      assert.match(
        sql,
        /WHERE peer_rank <= \$\d+\s+OR address = oldest_exact_address\s+OR address = highest_mcap_exact_address/i
      );
    }
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

  it('builds ticker peer role summaries for monitored token batches', async () => {
    const calls = [];
    const runner = {
      async query(sql, params) {
        calls.push({ sql: String(sql), params });
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
              normalized_symbol: 'WSOL',
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
              normalized_symbol: 'WSOL',
              exact_count: '2',
              subticker_count: '0',
              oldest_exact_address: PEER_ADDRESS,
              highest_mcap_exact_address: SOURCE_ADDRESS,
            },
          ],
        };
      },
    };

    const summaries = await alertTickerPeers.listTickerPeerSummariesForTokens([
      { address: SOURCE_ADDRESS, symbol: 'WSOL' },
      { address: PEER_ADDRESS, symbol: 'wsol' },
    ], {}, runner);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params[0], ['WSOL']);
    assert.equal(calls[0].params[3], 'solana');
    assert.match(calls[0].sql, /WHERE chain = \$4/);
    assert.equal(summaries.get(SOURCE_ADDRESS).sourcePeerRole, 'mcap_leader');
    assert.equal(summaries.get(PEER_ADDRESS).sourcePeerRole, 'og');
    assert.equal(summaries.get(SOURCE_ADDRESS).count, 2);
    assert.equal(summaries.get(SOURCE_ADDRESS).items.length, 2);
    assert.equal(summaries.get(SOURCE_ADDRESS).items[0].address, SOURCE_ADDRESS);
    assert.equal(summaries.get(SOURCE_ADDRESS).items[0].ageMsAtAlert, 7200000);
  });
});
