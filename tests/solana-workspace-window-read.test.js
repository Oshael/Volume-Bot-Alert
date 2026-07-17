const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createSolanaWorkspaceWindowReadRepository,
  __private,
} = require('../src/models/solana-workspace-window-read');

const TOKEN = 'So11111111111111111111111111111111111111112';
const WINDOW_END = '2026-07-15T18:00:00.000Z';

function metricRow(overrides = {}) {
  return {
    token_address: TOKEN,
    volume_observed_at: new Date('2026-07-15T17:59:00.000Z'),
    volume_source: 'gmgn',
    close_vol_5m: '0',
    close_vol_1h: '125000',
    close_vol_6h: '410000',
    close_vol_24h: '980000',
    window_coverage: {
      '5m': { state: 'complete', source: 'gmgn' },
      '1h': { state: 'complete', source: 'gmgn' },
      '6h': { state: 'complete', source: 'gmgn' },
      '24h': { state: 'complete', source: 'gmgn' },
    },
    history_start_at: null,
    current_price: '2',
    current_observed_at: new Date('2026-07-15T17:59:00.000Z'),
    price_1h: '1.6',
    price_1h_observed_at: new Date('2026-07-15T16:58:00.000Z'),
    price_6h: '1',
    price_6h_observed_at: new Date('2026-07-15T11:59:00.000Z'),
    price_24h: null,
    price_24h_observed_at: null,
    ...overrides,
  };
}

describe('Solana workspace window metric reader', () => {
  it('projects stored coverage provenance into the normalization boundary', () => {
    assert.match(__private.WINDOW_METRICS_SQL, /volume\.window_coverage/);
  });

  it('accepts a fresh upstream rolling snapshot without inventing swap counts', async () => {
    const calls = [];
    const database = {
      async queryWithStatementTimeout(sql, params, timeoutMs) {
        calls.push({ sql, params, timeoutMs });
        return { rows: [metricRow()] };
      },
    };
    const repository = createSolanaWorkspaceWindowReadRepository({ database });
    const [row] = await repository.getMetricsByAddresses({
      addresses: [TOKEN], asOf: '2026-07-15T18:00:59.000Z',
    });

    assert.equal(row.key, `solana:${TOKEN}`);
    assert.equal(row.windowEnd, WINDOW_END);
    assert.equal(row.volume5mUsd, 0);
    assert.equal(row.volume1hUsd, 125000);
    assert.deepEqual(row.coverage, {
      '5m': 'complete', '1h': 'complete', '6h': 'complete', '24h': 'complete',
    });
    assert.equal(row.swaps5m, null);
    assert.equal(row.swaps1h, null);
    assert.deepEqual(row.swapCoverage, {
      '5m': 'unavailable', '1h': 'unavailable',
      '6h': 'unavailable', '24h': 'unavailable',
    });
    assert.equal(row.lastActivityAt, null);
    assert.equal(row.priceChange1hPct, 25);
    assert.equal(row.priceChange6hPct, 100);
    assert.equal(row.priceChange24hPct, null);
    assert.deepEqual(row.coverageProvenance, {
      source: 'solana-rolling-volume-snapshot',
      upstreamSource: 'gmgn',
      observedAt: '2026-07-15T17:59:00.000Z',
      historyStartAt: null,
      exactLastActivity: false,
      declaredCoverage: {
        '5m': 'complete', '1h': 'complete', '6h': 'complete', '24h': 'complete',
      },
      declaredSources: {
        '5m': 'gmgn', '1h': 'gmgn', '6h': 'gmgn', '24h': 'gmgn',
      },
    });
    assert.deepEqual(calls[0].params, [[TOKEN], new Date(WINDOW_END)]);
    assert.equal(calls[0].timeoutMs, 15_000);
  });

  it('marks a misaligned upstream snapshot partial even with declared coverage', async () => {
    const database = {
      async query() {
        return { rows: [metricRow({
          volume_observed_at: new Date('2026-07-15T17:50:00.000Z'),
        })] };
      },
    };
    const repository = createSolanaWorkspaceWindowReadRepository({ database });
    const [row] = await repository.getMetricsByAddresses({
      addresses: [TOKEN], asOf: WINDOW_END,
    });

    assert.equal(row.coverage['5m'], 'partial');
    assert.equal(row.volume5mUsd, 0);
    assert.equal(row.coverage['1h'], 'partial');
    assert.equal(row.volume1hUsd, 125000);
  });

  it('does not infer PumpFun continuity or exact activity from bucket history', async () => {
    const database = {
      async query() {
        return { rows: [metricRow({
          volume_source: 'pumpfun-pre-migration',
          history_start_at: new Date('2026-07-15T17:50:00.000Z'),
          window_coverage: {},
        })] };
      },
    };
    const repository = createSolanaWorkspaceWindowReadRepository({ database });
    const [row] = await repository.getMetricsByAddresses({
      addresses: [TOKEN], asOf: WINDOW_END,
    });

    assert.equal(row.coverage['5m'], 'partial');
    assert.equal(row.coverage['1h'], 'partial');
    assert.equal(row.coverage['24h'], 'partial');
    assert.equal(row.lastActivityAt, null);
    assert.equal(row.coverageProvenance.exactLastActivity, false);
    assert.doesNotMatch(__private.WINDOW_METRICS_SQL, /history_start_at/);
  });

  it('keeps unknown snapshot provenance partial and missing data unavailable', () => {
    const unknown = __private.normalizeRow(metricRow({
      volume_source: 'legacy-import', window_coverage: {},
    }),
      new Date(WINDOW_END));
    assert.equal(unknown.coverage['1h'], 'partial');
    assert.equal(unknown.volume1hUsd, 125000);

    const missing = __private.normalizeRow(metricRow({
      volume_source: null,
      volume_observed_at: null,
      close_vol_5m: null,
      close_vol_1h: null,
      close_vol_6h: null,
      close_vol_24h: null,
      window_coverage: {},
    }), new Date(WINDOW_END));
    assert.deepEqual(missing.coverage, {
      '5m': 'unavailable', '1h': 'unavailable',
      '6h': 'unavailable', '24h': 'unavailable',
    });
  });

  it('keeps source provenance attached to each merged window', () => {
    const mixed = __private.normalizeRow(metricRow({
      volume_source: 'dexscreener',
      window_coverage: {
        '5m': { state: 'complete', source: 'gmgn' },
        '1h': { state: 'complete', source: 'dexscreener' },
        '6h': 'complete',
      },
    }), new Date(WINDOW_END));

    assert.equal(mixed.coverageProvenance.upstreamSource, null);
    assert.deepEqual(mixed.coverageProvenance.declaredSources, {
      '5m': 'gmgn', '1h': 'dexscreener', '6h': null,
    });
    assert.deepEqual(mixed.coverageProvenance.declaredCoverage, {
      '5m': 'complete', '1h': 'complete', '6h': 'complete',
    });
  });

  it('uses bounded identity lookups and never reads projected catalog windows', () => {
    const sql = __private.WINDOW_METRICS_SQL;
    assert.match(sql, /SELECT UNNEST\(\$1::varchar\[\]\)/);
    assert.match(sql, /token_market_volume_buckets_1m/);
    assert.match(sql, /window_coverage/);
    assert.match(sql, /token_market_buckets_1m/);
    assert.match(sql, /bucket\.token_address = requested\.token_address/);
    assert.match(sql, /bucket\.chain = 'solana'/);
    assert.doesNotMatch(sql, /FROM token_catalog/);
    assert.doesNotMatch(sql, /eligible_for_monitoring/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('bounds identity input and skips an empty page', async () => {
    let calls = 0;
    const database = { async query() { calls += 1; return { rows: [] }; } };
    const repository = createSolanaWorkspaceWindowReadRepository({ database });
    assert.deepEqual(await repository.getMetricsByAddresses({ addresses: [] }), []);
    assert.equal(calls, 0);
    await assert.rejects(
      repository.getMetricsByAddresses({ addresses: ['invalid'] }), /Invalid solana/,
    );
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    await assert.rejects(repository.getMetricsByAddresses({
      addresses: Array.from({ length: 101 }, (_, index) => (
        `${'1'.repeat(30)}${alphabet[Math.floor(index / alphabet.length)]}`
          + alphabet[index % alphabet.length]
      )),
    }), /at most 100/);
    await assert.rejects(repository.getMetricsByAddresses({
      addresses: [TOKEN], statementTimeoutMs: 999,
    }), /between 1000 and 60000/);
    await assert.rejects(repository.getMetricsByAddresses({
      addresses: [TOKEN], asOf: '',
    }), /asOf is invalid/);
  });
});
