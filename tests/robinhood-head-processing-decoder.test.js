const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  decodeCapture,
  assessLiquidity,
  attachLiquidity,
} = require('../src/services/robinhood-head-processing-decoder');
const { ROBINHOOD_WETH } = require('../src/services/evm-market-metrics');
const v2 = require('../src/services/uniswap-v2-decoder');
const v3 = require('../src/services/uniswap-v3-decoder');
const v4 = require('../src/services/uniswap-v4-decoder');

const TOKEN = `0x${'11'.repeat(20)}`;
const POOL = `0x${'22'.repeat(20)}`;
const POOL_ID = `0x${'33'.repeat(32)}`;
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const TX_HASH = `0x${'cd'.repeat(32)}`;
const ONE = 10n ** 18n;

function word(value) {
  const big = BigInt(value);
  const masked = big < 0n ? (1n << 256n) + big : big;
  return masked.toString(16).padStart(64, '0');
}

function addressWord(address) {
  return `0x${word(BigInt(address))}`;
}

function data(values) {
  return `0x${values.map(word).join('')}`;
}

// Buy: 1 WETH in, 10 TOKEN out => priceQuote 0.1, priceUsd 0.1 * 2000 = 200.
function marketEvidence(protocol, extra = {}) {
  return {
    evidenceVersion: 1,
    timestampMs: '1750000000000',
    tokenAddress: TOKEN,
    quoteAddress: ROBINHOOD_WETH,
    quoteIndex: 1,
    eligibility: { eligible: true, reason: null },
    tokenMetadata: {
      name: 'Token', symbol: 'TKN', decimals: 18,
      totalSupplyRaw: (1000n * ONE).toString(),
      tokenSupplyStatus: 'latest_call', tokenSupplyBlockTag: '0x64',
    },
    quoteMetadata: { decimals: 18 },
    quoteUsd: { priceUsd: '2000', source: 'canonical-weth-usdg-3000', status: 'observed', blockTag: '0x10' },
    ...extra,
  };
}

function baseRow(overrides = {}) {
  return {
    stream: 'market',
    evidence_version: 1,
    block_number: '100',
    block_hash: BLOCK_HASH,
    transaction_hash: TX_HASH,
    log_index: '2',
    transaction_index: '0',
    market_key: `robinhood:uniswap-v3:${POOL}`,
    ...overrides,
  };
}

function v3Row(evidenceExtra = {}) {
  return baseRow({
    protocol: 'uniswap-v3',
    address: POOL,
    topics: [v3.TOPICS.swap, addressWord(TOKEN), addressWord(POOL)],
    // amount0 (token) = -10, amount1 (quote/WETH) = +1, sqrtPriceX96, liquidity, tick
    data: data([-10n * ONE, ONE, 1n << 96n, 5n * ONE, 0n]),
    evidence: marketEvidence('uniswap-v3', {
      v3: {
        poolAddress: POOL, blockTag: '0x64',
        tokenBalanceRaw: (10n * ONE).toString(),
        quoteBalanceRaw: (30000n * ONE).toString(),
        sqrtPriceX96: (1n << 96n).toString(),
      },
      ...evidenceExtra,
    }),
  });
}

describe('head processing decoder — market observation from evidence (no RPC)', () => {
  it('rebuilds a V3 observation and freezes the quote provenance', () => {
    const result = decodeCapture(v3Row());
    assert.equal(result.kind, 'observation');
    assert.equal(result.observation.accepted, true);
    assert.equal(result.observation.side, 'buy');
    assert.equal(result.observation.tokenAmountRaw, (10n * ONE).toString());
    assert.equal(result.observation.quoteAmountRaw, ONE.toString());
    assert.equal(result.observation.priceUsd, '200');
    assert.equal(result.observation.fdvUsd, '200000');
    assert.equal(result.observation.volumeUsd, '2000');
    assert.equal(result.observation.quoteUsdStatus, 'observed');
    assert.equal(result.observation.quoteUsdSource, 'canonical-weth-usdg-3000');
    assert.equal(result.observation.tokenSupplyStatus, 'latest_call');
  });

  it('values V3 liquidity from the frozen pool balances', () => {
    const result = decodeCapture(v3Row());
    const assessment = assessLiquidity(result.liquidityInputs);
    assert.equal(assessment.status, 'spot_tvl_from_pool_balances');
    const withLiquidity = attachLiquidity(result.observation, assessment);
    assert.equal(withLiquidity.liquidityUsd, assessment.liquidityUsd);
    assert.equal(withLiquidity.liquidityStatus, 'spot_tvl_from_pool_balances');
  });

  it('rebuilds a V2 observation and values liquidity from the frozen reserve', () => {
    const row = baseRow({
      protocol: 'uniswap-v2',
      market_key: `robinhood:uniswap-v2:${POOL}`,
      address: POOL,
      topics: [v2.TOPICS.swap, addressWord(TOKEN), addressWord(POOL)],
      // amount0In, amount1In (quote in), amount0Out (token out), amount1Out
      data: data([0n, ONE, 10n * ONE, 0n]),
      evidence: marketEvidence('uniswap-v2', { v2: { quoteReserveRaw: (3n * ONE).toString() } }),
    });
    const result = decodeCapture(row);
    assert.equal(result.observation.priceUsd, '200');
    assert.equal(result.observation.side, 'buy');
    const assessment = assessLiquidity(result.liquidityInputs);
    assert.equal(assessment.status, 'spot_estimate_from_double_quote_reserve');
  });

  it('rebuilds a V4 observation and defers liquidity to the caller-supplied ranges', () => {
    const row = baseRow({
      protocol: 'uniswap-v4',
      market_key: `robinhood:uniswap-v4:${POOL_ID}`,
      address: v4.ROBINHOOD_V4_POOL_MANAGER,
      topics: [v4.TOPICS.swap, POOL_ID, addressWord(POOL)],
      // int128 amount0 (token) = -10, amount1 (quote) = +1, sqrt, liquidity, tick, fee
      data: data([-10n * ONE, ONE, 1n << 96n, 5n * ONE, 0n, 0n]),
      evidence: marketEvidence('uniswap-v4', {
        v4: {
          poolId: POOL_ID, sqrtPriceX96: (1n << 96n).toString(),
          liquidityRaw: (5n * ONE).toString(), modifyLiquidity: [],
        },
      }),
    });
    const result = decodeCapture(row);
    assert.equal(result.observation.priceUsd, '200');
    assert.equal(result.liquidityInputs.requiresRanges, true);
    const assessment = assessLiquidity(result.liquidityInputs, {
      v4Ranges: [{ tickLower: -60, tickUpper: 60, liquidityGross: ONE }],
    });
    assert.equal(assessment.status, 'spot_tvl_from_v4_tick_ranges');
  });
});

describe('head processing decoder — non-valuation and guard paths', () => {
  it('passes a head rejection capture through without decoding a swap', () => {
    const row = v3Row();
    row.evidence = { evidenceVersion: 1, rejected: 'v3_pool_balance_unavailable', tokenAddress: TOKEN };
    const result = decodeCapture(row);
    assert.equal(result.kind, 'rejected');
    assert.equal(result.reason, 'v3_pool_balance_unavailable');
  });

  it('surfaces a frozen V4 ModifyLiquidity event as a ledger delta', () => {
    const row = baseRow({
      protocol: 'uniswap-v4',
      address: v4.ROBINHOOD_V4_POOL_MANAGER,
      topics: [v4.TOPICS.swap, POOL_ID, addressWord(POOL)],
      data: '0x00',
      evidence: { evidenceVersion: 1, event: { kind: 'modify-liquidity', poolId: POOL_ID, liquidityDelta: '-123' } },
    });
    const result = decodeCapture(row);
    assert.equal(result.kind, 'liquidity-delta');
    assert.equal(result.event.liquidityDelta, '-123');
  });

  it('surfaces a discovery capture with its frozen NOXA validation', () => {
    const row = baseRow({
      stream: 'discovery',
      protocol: 'uniswap-v3',
      address: POOL,
      topics: [addressWord(POOL)],
      data: '0x00',
      evidence: {
        evidenceVersion: 1,
        event: { kind: 'noxa-launch', marketKey: `robinhood:uniswap-v3:${POOL}` },
        noxa: { accepted: true, canonicalPoolAddress: POOL },
      },
    });
    const result = decodeCapture(row);
    assert.equal(result.kind, 'discovery');
    assert.equal(result.noxa.accepted, true);
  });

  it('refuses an unknown evidence version instead of guessing', () => {
    const row = v3Row();
    row.evidence_version = 2;
    assert.throws(() => decodeCapture(row), (error) => error.terminal === true && /version/.test(error.message));
  });
});
