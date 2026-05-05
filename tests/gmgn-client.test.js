const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const gmgn = require('../src/services/gmgn-client');

const TOKEN_A = 'So11111111111111111111111111111111111111112';
const TOKEN_B = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

describe('gmgn client', () => {
  it('builds the official market trending CLI args sorted by volume', () => {
    const args = gmgn.__private.buildTrendingArgs({
      chain: 'sol',
      interval: '5m',
      limit: 30,
    });

    assert.deepEqual(args, [
      'market',
      'trending',
      '--chain',
      'sol',
      '--interval',
      '5m',
      '--order-by',
      'volume',
      '--direction',
      'desc',
      '--limit',
      '30',
      '--raw',
    ]);
  });

  it('builds token security CLI args', () => {
    const args = gmgn.__private.buildTokenSecurityArgs({
      chain: 'sol',
      address: TOKEN_A,
    });

    assert.deepEqual(args, [
      'token',
      'security',
      '--chain',
      'sol',
      '--address',
      TOKEN_A,
      '--raw',
    ]);
  });

  it('builds token info CLI args', () => {
    const args = gmgn.__private.buildTokenInfoArgs({
      chain: 'sol',
      address: TOKEN_A,
    });

    assert.deepEqual(args, [
      'token',
      'info',
      '--chain',
      'sol',
      '--address',
      TOKEN_A,
      '--raw',
    ]);
  });

  it('builds market kline CLI args', () => {
    const args = gmgn.__private.buildMarketKlineArgs({
      chain: 'sol',
      address: TOKEN_A,
      resolution: '1m',
      from: 1777867920,
      to: 1777869120,
    });

    assert.deepEqual(args, [
      'market',
      'kline',
      '--chain',
      'sol',
      '--address',
      TOKEN_A,
      '--resolution',
      '1m',
      '--from',
      '1777867920',
      '--to',
      '1777869120',
      '--raw',
    ]);
  });

  it('normalizes raw trending rows into internal token snapshots', async () => {
    const calls = [];
    const client = gmgn.createGmgnClient({
      apiKey: 'test-key',
      cliBin: 'gmgn-cli',
      execFileImpl: async (file, args, options) => {
        calls.push({ file, args, apiKey: options.env.GMGN_API_KEY });
        return {
          stdout: JSON.stringify({
            data: {
              rank: [
                {
                  address: TOKEN_A,
                  symbol: 'SOL',
                  name: 'Wrapped SOL',
                  logo: 'https://img.example/sol.png',
                  rank: 1,
                  price: '123.45',
                  market_cap: '456789',
                  liquidity: '50000',
                  volume: '12345.67',
                  price_change_percent5m: '12.5',
                  creation_timestamp: 1700000000,
                },
                {
                  address: TOKEN_B,
                  symbol: 'JUP',
                  name: 'Jupiter',
                  volume: '9876',
                },
              ],
            },
          }),
          stderr: '',
        };
      },
    });

    const tokens = await client.fetchTrending({ chain: 'sol', interval: '5m', limit: 30 });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'gmgn-cli');
    assert.equal(calls[0].apiKey, 'test-key');
    assert.equal(tokens.length, 2);
    assert.equal(tokens[0].address, TOKEN_A);
    assert.equal(tokens[0].symbol, 'SOL');
    assert.equal(tokens[0].mcap, 456789);
    assert.equal(tokens[0].price, 123.45);
    assert.equal(tokens[0].liquidityUsd, 50000);
    assert.equal(tokens[0].vol5m, 12345.67);
    assert.equal(tokens[0].vol1m, null);
    assert.equal(tokens[0].priceChange5m, 12.5);
    assert.equal(tokens[0].gmgnInterval, '5m');
    assert.equal(tokens[0].gmgnRank, 1);
  });

  it('assigns queried 1m volume to vol1m', () => {
    const rows = gmgn.__private.normalizeTrendingPayload({
      data: {
        rank: [{ address: TOKEN_A, volume: '5000' }],
      },
    }, { chain: 'sol', interval: '1m' });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].vol1m, 5000);
    assert.equal(rows[0].vol5m, null);
  });

  it('normalizes token security metrics', async () => {
    const calls = [];
    const client = gmgn.createGmgnClient({
      apiKey: 'test-key',
      cliBin: 'gmgn-cli',
      execFileImpl: async (file, args, options) => {
        calls.push({ file, args, apiKey: options.env.GMGN_API_KEY });
        return {
          stdout: JSON.stringify({
            address: TOKEN_A,
            top_10_holder_rate: '0.9234',
            hide_risk: false,
            renounced_freeze_account: true,
            renounced_mint: true,
            can_sell: 0,
            can_not_sell: 0,
            flags: ['bundled_wallets'],
          }),
          stderr: '',
        };
      },
    });

    const security = await client.fetchTokenSecurity({ chain: 'sol', address: TOKEN_A });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, gmgn.__private.buildTokenSecurityArgs({ chain: 'sol', address: TOKEN_A }));
    assert.equal(calls[0].apiKey, 'test-key');
    assert.equal(security.address, TOKEN_A);
    assert.equal(security.top10HolderRate, 0.9234);
    assert.equal(security.hideRisk, false);
    assert.equal(security.renouncedFreezeAccount, true);
    assert.equal(security.renouncedMint, true);
    assert.equal(security.canSell, 0);
    assert.deepEqual(security.flags, ['bundled_wallets']);
  });

  it('normalizes percentage-style security rates into ratios', () => {
    const security = gmgn.__private.normalizeTokenSecurityPayload({
      address: TOKEN_A,
      top_10_holder_rate: '92.34',
    });

    assert.equal(security.top10HolderRate, 0.9234);
  });

  it('normalizes token info holder and derived market cap metrics', async () => {
    const client = gmgn.createGmgnClient({
      apiKey: 'test-key',
      cliBin: 'gmgn-cli',
      execFileImpl: async () => ({
        stdout: JSON.stringify({
          address: TOKEN_A,
          symbol: 'TEST',
          name: 'Test Token',
          holder_count: 2001,
          price: '0.000084034193',
          circulating_supply: '1000000001',
          liquidity: '118880.80',
          creation_timestamp: 1777859693,
          stat: {
            top_bundler_trader_percentage: '0.0636',
            bot_degen_rate: '0.0586',
          },
          wallet_tags_stat: {
            bundler_wallets: 328,
          },
        }),
        stderr: '',
      }),
    });

    const info = await client.fetchTokenInfo({ chain: 'sol', address: TOKEN_A });

    assert.equal(info.address, TOKEN_A);
    assert.equal(info.symbol, 'TEST');
    assert.equal(info.holderCount, 2001);
    assert.equal(Math.round(info.marketCap), 84034);
    assert.equal(info.liquidityUsd, 118880.8);
    assert.equal(info.topBundlerTraderRate, 0.0636);
    assert.equal(info.botDegenRate, 0.0586);
    assert.equal(info.bundlerWalletCount, 328);
    assert.equal(info.tokenCreatedAt, '2026-05-04T01:54:53.000Z');
  });

  it('normalizes market kline rows', async () => {
    const client = gmgn.createGmgnClient({
      apiKey: 'test-key',
      cliBin: 'gmgn-cli',
      execFileImpl: async () => ({
        stdout: JSON.stringify({
          data: [
            { time: 1777868040000, open: '0.2', high: '0.25', low: '0.19', close: '0.24', volume: '2000' },
            { time: 1777867980000, open: '0.1', high: '0.2', low: '0.1', close: '0.2', volume: '1000' },
          ],
        }),
        stderr: '',
      }),
    });

    const rows = await client.fetchMarketKline({
      chain: 'sol',
      address: TOKEN_A,
      resolution: '1m',
      from: 1777867920,
      to: 1777869120,
    });

    assert.deepEqual(rows, [
      { timestampMs: 1777867980000, open: 0.1, high: 0.2, low: 0.1, close: 0.2, volume: 1000 },
      { timestampMs: 1777868040000, open: 0.2, high: 0.25, low: 0.19, close: 0.24, volume: 2000 },
    ]);
  });

  it('throws a structured rate-limit error from CLI stderr', async () => {
    const client = gmgn.createGmgnClient({
      apiKey: 'test-key',
      execFileImpl: async () => {
        const error = new Error('Command failed');
        error.code = 1;
        error.stderr = '{"code":429,"error":"RATE_LIMIT_EXCEEDED","reset_at":1775184222}';
        throw error;
      },
    });

    await assert.rejects(
      client.fetchTrending({ interval: '1m' }),
      (error) => error instanceof gmgn.GmgnRateLimitError
        && error.code === 'GMGN_RATE_LIMIT'
        && error.resetAt === 1775184222
    );
  });

  it('rejects invalid JSON output with a client error', async () => {
    const client = gmgn.createGmgnClient({
      apiKey: 'test-key',
      execFileImpl: async () => ({ stdout: 'not-json', stderr: '' }),
    });

    await assert.rejects(
      client.fetchTrending({ interval: '1m' }),
      (error) => error instanceof gmgn.GmgnCliError
        && error.code === 'GMGN_INVALID_JSON'
    );
  });
});
