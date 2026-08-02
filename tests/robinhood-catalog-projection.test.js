const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const catalog = require('../src/models/robinhood-catalog');

const TOKEN = `0x${'1'.repeat(40)}`;
const MARKET_ADDRESS = `0x${'2'.repeat(40)}`;

function snapshot(overrides = {}) {
  return {
    chain: 'robinhood',
    tokenAddress: TOKEN,
    protocol: 'uniswap-v3',
    marketKey: `robinhood:uniswap-v3:${MARKET_ADDRESS}`,
    discoveredAt: '2026-07-14T16:00:00.000Z',
    lastObservedAt: '2026-07-14T17:59:30.000Z',
    lastPriceUsd: '1.25',
    lastFdvUsd: '500000',
    volume5mUsd: '1200.50',
    volume1hUsd: '5000',
    volume6hUsd: '15000',
    volume24hUsd: '45000',
    liquidityUsd: null,
    priceChange1hPct: '-2.5',
    priceChange6hPct: '10',
    priceChange24hPct: null,
    ...overrides,
  };
}

describe('Robinhood dashboard catalog projection', () => {
  it('upserts committed live valuations without waiting for metadata projection', async () => {
    const calls = [];
    const written = await catalog.applyLiveSnapshots([{
      address: TOKEN.toUpperCase(),
      observedAt: '2026-07-18T18:00:00.500Z',
      priceUsd: 1.5,
      fdvUsd: 600000,
    }], {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 1 };
      },
    });

    assert.equal(written, 1);
    assert.match(calls[0].sql, /jsonb_to_recordset/);
    assert.match(calls[0].sql, /'robinhood-dashboard-active'/);
    assert.match(calls[0].sql, /EXCLUDED\.last_seen_at >= token_catalog\.last_seen_at/);
    assert.match(calls[0].sql, /eligibility_state = 'robinhood-staged'/);
    assert.doesNotMatch(calls[0].sql, /last_mcap/);
    assert.deepEqual(JSON.parse(calls[0].params[0]), [{
      address: TOKEN,
      observedAt: '2026-07-18T18:00:00.500Z',
      observedAtMs: 1784397600500,
      priceUsd: 1.5,
      fdvUsd: 600000,
    }]);
  });

  it('rejects FDV-capped snapshots across every automated catalog write path', async () => {
    const runner = {
      async query() {
        throw new Error('FDV-capped snapshots must not reach PostgreSQL');
      },
    };
    const highFdv = '30000000000';

    assert.equal(await catalog.applyLiveSnapshots([{
      address: TOKEN,
      observedAt: '2026-07-18T18:00:00.500Z',
      priceUsd: 1,
      fdvUsd: highFdv,
    }], runner), 0);
    assert.equal(await catalog.projectDashboardSnapshot(
      snapshot({ lastFdvUsd: highFdv }), runner
    ), null);
    assert.equal(await catalog.stageSnapshot({
      ...snapshot({ lastFdvUsd: highFdv }),
      chain: 'robinhood',
      protocol: 'uniswap-v2',
      marketKey: `robinhood:uniswap-v2:${MARKET_ADDRESS}`,
      windowMs: 300000,
      volumeUsd: '1000',
    }, runner), null);
  });

  it('creates a durable manual identity without making it monitoring-eligible', async () => {
    const calls = [];
    const row = await catalog.ensureManualToken(TOKEN.toUpperCase(), {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ chain: 'robinhood', address: params[0], source: 'user-manual' }] };
      },
    });

    assert.equal(row.address, TOKEN);
    assert.match(calls[0].sql, /'user-manual', FALSE/);
    assert.match(calls[0].sql, /FALSE, 'robinhood-manual'/);
    assert.match(calls[0].sql, /token_catalog\.source = 'robinhood-onchain'/);
    assert.deepEqual(calls[0].params, [TOKEN]);
  });

  it('selects manual Robinhood identities for asynchronous metadata enrichment', async () => {
    const calls = [];
    const rows = await catalog.listManualMetadataCandidates({ limit: 75 }, {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ tokenAddress: TOKEN, volumeUsd: '0' }] };
      },
    });

    assert.equal(rows[0].tokenAddress, TOKEN);
    assert.match(calls[0].sql, /EXISTS \(/);
    assert.match(calls[0].sql, /manual\.chain = catalog\.chain/);
    assert.deepEqual(calls[0].params, [75]);
  });

  it('prioritizes durable on-chain identities with due metadata independently of market activity', async () => {
    const calls = [];
    const asOf = new Date('2026-08-02T06:00:00.000Z');
    const rows = await catalog.listAutomaticMetadataCandidates({
      limit: 25,
      asOf,
      ttlMs: 86_400_000,
    }, {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ tokenAddress: TOKEN, volumeUsd: '0' }] };
      },
    });

    assert.equal(rows[0].tokenAddress, TOKEN);
    assert.match(calls[0].sql, /catalog\.source = 'robinhood-onchain'/);
    assert.match(calls[0].sql, /identity_missing AND blockscout_due/);
    assert.match(calls[0].sql, /robinhood_dexscreener_checked_at/);
    assert.deepEqual(calls[0].params, [25, asOf, 86_400_000]);
  });

  it('projects a V3 aggregate snapshot without enabling Solana monitoring', async () => {
    const calls = [];
    const row = await catalog.projectDashboardSnapshot(snapshot(), {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ chain: 'robinhood', address: params[0] }] };
      },
    });

    assert.deepEqual(row, { chain: 'robinhood', address: TOKEN });
    assert.match(calls[0].sql, /ON CONFLICT \(chain, address\) DO UPDATE/);
    assert.match(calls[0].sql, /'robinhood-dashboard-active'/);
    assert.match(calls[0].sql, /eligibility_state = 'robinhood-staged'/);
    assert.match(calls[0].sql, /FALSE,\s*FALSE/);
    assert.doesNotMatch(calls[0].sql, /last_mcap/);
    assert.deepEqual(calls[0].params.slice(3, 12), [
      '1.25', '500000', '1200.50', '5000', '15000', '45000', null,
      MARKET_ADDRESS, 'uniswap-v3',
    ]);
    assert.equal(calls[0].params[12], '-2.5');
  });

  it('keeps a V4 pool id out of the pair-address column', () => {
    const normalized = catalog.__private.normalizeDashboardSnapshot(snapshot({
      protocol: 'uniswap-v4',
      marketKey: `robinhood:uniswap-v4:0x${'3'.repeat(64)}`,
    }));

    assert.equal(normalized.protocol, 'uniswap-v4');
    assert.equal(normalized.pairAddress, null);
  });

  it('lists metadata by canonical chain-aware addresses', async () => {
    const calls = [];
    const rows = await catalog.listMetadata([TOKEN.toUpperCase(), TOKEN], {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ address: TOKEN, symbol: 'TKN' }] };
      },
    });

    assert.equal(rows[0].symbol, 'TKN');
    assert.match(calls[0].sql, /chain = 'robinhood'/);
    assert.deepEqual(calls[0].params, [[TOKEN]]);
  });

  it('sanitizes and applies ERC-20 and social metadata without clearing fields', async () => {
    const calls = [];
    await catalog.applyMetadata({
      address: TOKEN,
      symbol: ' TKN ',
      name: ' Token Name ',
      imageUrl: 'ipfs://bafy-image',
      websiteUrl: 'https://token.example/path#fragment',
      twitterUrl: 'javascript:alert(1)',
      telegramUrl: 'https://t.me/token',
    }, {
      async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; },
    });

    assert.match(calls[0].sql, /COALESCE\(\$2, symbol\)/);
    assert.match(calls[0].sql, /last_website_url/);
    assert.deepEqual(calls[0].params, [
      TOKEN,
      'TKN',
      'Token Name',
      'https://ipfs.io/ipfs/bafy-image',
      'https://token.example/path',
      null,
      'https://t.me/token',
    ]);
  });

  it('persists negative Blockscout checks without clearing cached metadata', async () => {
    const calls = [];
    await catalog.recordBlockscoutMetadata({ address: TOKEN }, {
      async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; },
    });

    assert.match(calls[0].sql, /robinhood_blockscout_checked_at = NOW\(\)/);
    assert.match(calls[0].sql, /last_image_url = COALESCE\(last_image_url, \$4\)/);
    assert.deepEqual(calls[0].params, [TOKEN, null, null, null]);
  });

  it('persists negative DexScreener checks without clearing Blockscout images', async () => {
    const calls = [];
    await catalog.recordDexscreenerMetadata({ address: TOKEN }, {
      async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; },
    });

    assert.match(calls[0].sql, /robinhood_dexscreener_checked_at = NOW\(\)/);
    assert.match(calls[0].sql, /last_image_url = COALESCE\(last_image_url, \$2\)/);
    assert.deepEqual(calls[0].params, [TOKEN, null, null, null, null]);
  });

});
