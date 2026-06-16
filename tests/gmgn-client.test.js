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

  it('builds market signal CLI args for Pump claim signals', () => {
    const args = gmgn.__private.buildMarketSignalArgs({
      chain: 'sol',
      signalType: 18,
    });

    assert.deepEqual(args, [
      'market',
      'signal',
      '--chain',
      'sol',
      '--signal-type',
      '18',
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

  it('normalizes PumpFun pre-bonding token info price and volume fields', () => {
    const info = gmgn.__private.normalizeTokenInfoPayload({
      address: 'HXTSHe2N53pKS9e41jbcFDAsxx6qPeRGzpsEUkY3pump',
      symbol: 'Starships',
      name: 'Starships Are Meant To Fly',
      logo: 'https://gmgn.ai/example.webp',
      biggest_pool_address: 'AAYLLw7gW2GYs8kUx5MrCuhntW9otZH8Lnbvp7gka1gV',
      launchpad: 'pump',
      launchpad_platform: 'Pump.fun',
      launchpad_status: 0,
      launchpad_progress: 0.5294436621846021,
      open_timestamp: 0,
      migrated_timestamp: 0,
      migrated_pool: '',
      creation_timestamp: 1779505038,
      circulating_supply: '999999853',
      liquidity: '8643.0348388404',
      price: {
        price: '0.0000066159149',
        price_1h: '0.0000026003261',
        volume_1m: '1015.61377896',
        volume_5m: '4363.13630873',
        volume_1h: '51278.17474696',
        volume_6h: '51278.17474696',
        volume_24h: '51278.17474696',
      },
      link: {
        gmgn: 'https://gmgn.ai/sol/token/HXTSHe2N53pKS9e41jbcFDAsxx6qPeRGzpsEUkY3pump',
      },
      stat: {
        top_10_holder_rate: '0.2694',
      },
    }, { chain: 'sol' });

    assert.equal(info.symbol, 'Starships');
    assert.equal(info.imageUrl, 'https://gmgn.ai/example.webp');
    assert.equal(info.pairAddress, 'AAYLLw7gW2GYs8kUx5MrCuhntW9otZH8Lnbvp7gka1gV');
    assert.equal(info.price, 0.0000066159149);
    assert.equal(Math.round(info.marketCap), 6616);
    assert.equal(info.liquidityUsd, 8643.0348388404);
    assert.equal(info.vol1m, 1015.61377896);
    assert.equal(info.vol5m, 4363.13630873);
    assert.equal(info.vol24h, 51278.17474696);
    assert.equal(info.top10HolderRate, 0.2694);
    assert.equal(info.launchpad, 'pump');
    assert.equal(info.launchpadPlatform, 'Pump.fun');
    assert.equal(info.launchpadStatus, 0);
    assert.equal(info.launchpadProgress, 0.5294436621846021);
    assert.equal(info.openTimestamp, null);
    assert.equal(info.migratedTimestamp, null);
    assert.equal(info.migratedPool, null);
    assert.ok(info.priceChange1h > 154);
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

  it('normalizes Pump and Bags claim signal rows', async () => {
    const calls = [];
    const client = gmgn.createGmgnClient({
      apiKey: 'test-key',
      cliBin: 'gmgn-cli',
      execFileImpl: async (file, args, options) => {
        calls.push({ file, args, apiKey: options.env.GMGN_API_KEY });
        return {
          stdout: JSON.stringify({
            data: {
              items: [
                {
                  id: 'gmgn-signal-1',
                  token_address: TOKEN_A,
                  signal_type: 18,
                  trigger_at: 1777867980,
                  data: {
                    chain: 'sol',
                    quote_address: 'So11111111111111111111111111111111111111112',
                    total_fee: '12.34',
                    claim_fee_sol_amount: '0.123456',
                  },
                },
                {
                  id: 'gmgn-signal-2',
                  token_address: TOKEN_B,
                  signal_type: 18,
                  trigger_at: 1777868040,
                  data: {
                    chain: 'sol',
                    quote_address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                    total_fee: '1030.5',
                  },
                },
              ],
            },
          }),
          stderr: '',
        };
      },
    });

    const rows = await client.fetchMarketSignal({ chain: 'sol', signalType: 18 });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, gmgn.__private.buildMarketSignalArgs({ chain: 'sol', signalType: 18 }));
    assert.equal(calls[0].apiKey, 'test-key');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].tokenAddress, TOKEN_A);
    assert.equal(rows[0].signalType, 18);
    assert.equal(rows[0].claimId, 'gmgn-signal-1');
    assert.equal(rows[0].totalFeeUsd, null);
    assert.equal(rows[0].claimFeeAmount, 0.123456);
    assert.equal(rows[0].claimFeeCurrency, 'SOL');
    assert.equal(rows[0].quoteAddress, 'So11111111111111111111111111111111111111112');
    assert.equal(rows[0].claimedAt, '2026-05-04T04:13:00.000Z');
    assert.equal(rows[1].tokenAddress, TOKEN_B);
    assert.equal(rows[1].totalFeeUsd, 1030.5);
    assert.equal(rows[1].claimFeeAmount, 1030.5);
    assert.equal(rows[1].claimFeeCurrency, 'USDC');
  });

  it('caches risk lookups across client instances', async () => {
    const calls = [];
    const cache = gmgn.__private.createRiskLookupCache({ ttlMs: 60000 });
    const execFileImpl = async (_file, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          address: TOKEN_A,
          holder_count: 1234,
          market_cap: 56789,
        }),
        stderr: '',
      };
    };
    const firstClient = gmgn.createGmgnClient({ execFileImpl, riskLookupCache: cache });
    const secondClient = gmgn.createGmgnClient({ execFileImpl, riskLookupCache: cache });

    const firstInfo = await firstClient.fetchTokenInfo({ chain: 'sol', address: TOKEN_A });
    const secondInfo = await secondClient.fetchTokenInfo({ chain: 'sol', address: TOKEN_A });

    assert.equal(calls.length, 1);
    assert.equal(firstInfo.holderCount, 1234);
    assert.equal(secondInfo.holderCount, 1234);
    assert.equal(cache.getStatus().hits, 1);
    assert.equal(cache.getStatus().misses, 1);
    assert.equal(cache.getStatus().writes, 1);
    assert.equal(cache.getStatus().entries, 1);
  });

  it('expires cached risk lookups after ttl', async () => {
    let nowMs = 1000;
    const calls = [];
    const cache = gmgn.__private.createRiskLookupCache({
      ttlMs: 100,
      now: () => nowMs,
    });
    const client = gmgn.createGmgnClient({
      riskLookupCache: cache,
      execFileImpl: async () => {
        calls.push(nowMs);
        return {
          stdout: JSON.stringify({
            address: TOKEN_A,
            top_10_holder_rate: '0.10',
          }),
          stderr: '',
        };
      },
    });

    await client.fetchTokenSecurity({ chain: 'sol', address: TOKEN_A });
    nowMs += 50;
    await client.fetchTokenSecurity({ chain: 'sol', address: TOKEN_A });
    nowMs += 51;
    await client.fetchTokenSecurity({ chain: 'sol', address: TOKEN_A });

    assert.deepEqual(calls, [1000, 1101]);
  });

  it('does not cache trending lookups', async () => {
    const calls = [];
    const cache = gmgn.__private.createRiskLookupCache({ ttlMs: 60000 });
    const client = gmgn.createGmgnClient({
      riskLookupCache: cache,
      execFileImpl: async () => {
        calls.push(true);
        return {
          stdout: JSON.stringify({
            data: {
              rank: [{ address: TOKEN_A, volume: String(calls.length) }],
            },
          }),
          stderr: '',
        };
      },
    });

    await client.fetchTrending({ chain: 'sol', interval: '5m' });
    await client.fetchTrending({ chain: 'sol', interval: '5m' });

    assert.equal(calls.length, 2);
  });

  it('can bypass token info cache for fresh pre-bonding lookups', async () => {
    const calls = [];
    const cache = gmgn.__private.createRiskLookupCache({ ttlMs: 60000 });
    const client = gmgn.createGmgnClient({
      riskLookupCache: cache,
      execFileImpl: async () => {
        calls.push(true);
        return {
          stdout: JSON.stringify({
            address: TOKEN_A,
            holder_count: 1234,
            market_cap: 56789,
          }),
          stderr: '',
        };
      },
    });

    await client.fetchTokenInfo({ chain: 'sol', address: TOKEN_A, skipCache: true });
    await client.fetchTokenInfo({ chain: 'sol', address: TOKEN_A, skipCache: true });

    assert.equal(calls.length, 2);
    assert.equal(cache.getStatus().writes, 0);
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
