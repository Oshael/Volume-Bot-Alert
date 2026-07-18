const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createDashboardChainReader,
} = require('../src/services/dashboard-chain-reader');

it('routes independent valuation floors and paginates the combined active set', async () => {
  const calls = [];
  const reader = createDashboardChainReader({
    tokenCatalog: {
      async listDashboardMonitoredForMerge(minMcap) {
        calls.push({ source: 'solana', minMcap });
        return [{
          chain: 'solana',
          address: 'So11111111111111111111111111111111111111112',
          last_mcap: '30000',
          last_vol_5m: '100',
        }];
      },
    },
    robinhoodDashboardRead: {
      async listActiveCatalogRows(options) {
        calls.push({ source: 'robinhood', ...options });
        return [{
          chain: 'robinhood',
          address: `0x${'a'.repeat(40)}`,
          last_fdv: '30000',
          last_vol_5m: '200',
        }];
      },
    },
  });

  const slice = await reader.listMonitored({
    chains: ['solana', 'robinhood'],
    minMcap: 30_000,
    minFdv: 30_000,
    pagination: { page: 0, perPage: 1 },
    sorts: [{ mode: 'vol', window: '5m' }],
  });

  assert.deepEqual(calls, [
    { source: 'solana', minMcap: 30_000 },
    { source: 'robinhood', minFdv: 30_000 },
  ]);
  assert.equal(slice.total, 2);
  assert.equal(slice.rows[0].chain, 'robinhood');
});

const SOL = 'So11111111111111111111111111111111111111112';
const EXCLUDED_SOL = '11111111111111111111111111111111';
const EXCLUDED_EVM = `0x${'a'.repeat(40)}`;

function normalizedRow(chain, address, volume5mUsd) {
  return {
    identity: { chain, address, key: `${chain}:${address}` },
    valuation: { type: chain === 'solana' ? 'mcap' : 'fdv', usd: 50_000 },
    tokenCreatedAt: 1_000,
    volume5mUsd,
    volume1hUsd: volume5mUsd,
    volume6hUsd: volume5mUsd,
    volume24hUsd: volume5mUsd,
    coverage: {
      '5m': 'complete', '1h': 'complete', '6h': 'complete', '24h': 'complete',
    },
  };
}

describe('exact monitored coordinator', () => {
  it('shares one minute-aligned asOf and merges selected chain prefixes exactly', async () => {
    const calls = [];
    const solanaRows = [100, 80, 60, 40].map((volume, index) => normalizedRow(
      'solana', index === 0 ? SOL : `${'1'.repeat(31)}${index + 1}`, volume,
    ));
    const robinhoodRows = [90, 70, 50].map((volume, index) => normalizedRow(
      'robinhood', `0x${String(index + 5).repeat(40)}`, volume,
    ));
    const reader = createDashboardChainReader({
      now: () => new Date('2026-07-15T18:00:45.000Z'),
      solanaWorkspaceTokenReader: {
        async listMonitoredPrefix(input) {
          calls.push({ chain: 'solana', input });
          return {
            chain: 'solana', asOf: input.asOf, total: 5, rows: solanaRows,
          };
        },
      },
      robinhoodWorkspaceTokenReader: {
        async listMonitoredPrefix(input) {
          calls.push({ chain: 'robinhood', input });
          return {
            chain: 'robinhood', asOf: input.asOf, total: 3, rows: robinhoodRows,
          };
        },
      },
    });

    const page = await reader.listExactMonitored({
      chains: ['solana', 'robinhood'], page: 1, perPage: 2,
      minMcap: 30_000, maxMcap: 90_000,
      minFdv: 40_000, maxFdv: 100_000,
      sorts: [{ mode: 'vol', window: '5m' }],
      statementTimeoutMs: 12_000,
      preferCatalogValuation: true,
      excludedIdentities: [
        { chain: 'solana', address: EXCLUDED_SOL },
        `robinhood:${EXCLUDED_EVM.toUpperCase()}`,
      ],
    });

    assert.equal(page.asOf, '2026-07-15T18:00:00.000Z');
    assert.equal(page.total, 8);
    assert.deepEqual(page.rows.map((row) => row.volume5mUsd), [80, 70]);
    assert.deepEqual(calls, [
      { chain: 'solana', input: {
        asOf: page.asOf, page: 1, perPage: 2,
        sorts: [{ mode: 'vol', window: '5m' }],
        statementTimeoutMs: 12_000, minMcap: 30_000, maxMcap: 90_000,
        excludedAddresses: [EXCLUDED_SOL],
      } },
      { chain: 'robinhood', input: {
        asOf: page.asOf, page: 1, perPage: 2,
        sorts: [{ mode: 'vol', window: '5m' }],
        statementTimeoutMs: 12_000, preferCatalogValuation: true,
        minFdv: 40_000, maxFdv: 100_000,
        excludedAddresses: [EXCLUDED_EVM],
      } },
    ]);
  });

  it('calls only selected adapters and preserves an explicit snapshot', async () => {
    let robinhoodCalls = 0;
    const reader = createDashboardChainReader({
      solanaWorkspaceTokenReader: {
        async listMonitoredPrefix() { throw new Error('Solana must not be called'); },
      },
      robinhoodWorkspaceTokenReader: {
        async listMonitoredPrefix(input) {
          robinhoodCalls += 1;
          return { chain: 'robinhood', asOf: input.asOf, total: 0, rows: [] };
        },
      },
    });

    const page = await reader.listExactMonitored({
      chains: ['robinhood'], asOf: '2026-07-15T18:04:59.000Z', perPage: 10,
    });

    assert.equal(robinhoodCalls, 1);
    assert.equal(page.asOf, '2026-07-15T18:04:00.000Z');
    assert.equal(page.total, 0);
  });

  it('hydrates canonical pins outside valuation filters and omits excluded identities', async () => {
    const calls = [];
    const robinhoodAddress = `0x${'b'.repeat(40)}`;
    const missingAddress = `0x${'c'.repeat(40)}`;
    const reader = createDashboardChainReader({
      now: () => new Date('2026-07-15T18:00:45.000Z'),
      solanaWorkspaceTokenReader: {
        async getTokensByAddresses(input) {
          calls.push({ chain: 'solana', input });
          return input.addresses.map((address) => normalizedRow('solana', address, 0));
        },
      },
      robinhoodWorkspaceTokenReader: {
        async getTokensByAddresses(input) {
          calls.push({ chain: 'robinhood', input });
          return input.addresses.filter((address) => address !== missingAddress)
            .map((address) => normalizedRow('robinhood', address, 0));
        },
      },
    });

    const pins = await reader.listExactPinned({
      chains: ['solana', 'robinhood'],
      pinnedItems: [
        { chain: 'robinhood', address: robinhoodAddress.toUpperCase(), sortOrder: 2 },
        { chain: 'solana', address: SOL, sortOrder: 0 },
        { chain: 'solana', address: EXCLUDED_SOL, sortOrder: 1 },
        { chain: 'robinhood', address: missingAddress, sortOrder: 3 },
        { chain: 'solana', address: SOL, sortOrder: 9 },
      ],
      excludedIdentities: [{ chain: 'solana', address: EXCLUDED_SOL }],
      minMcap: 30_000,
      minFdv: 60_000,
    });

    assert.deepEqual(pins.map(({ row, sortOrder }) => [row.identity.key, sortOrder]), [
      [`solana:${SOL}`, 0], [`robinhood:${robinhoodAddress}`, 2],
    ]);
    assert.deepEqual(pins.map((pin) => pin.filterMismatch), [
      [], ['valuation_below_min'],
    ]);
    assert.deepEqual(calls.map(({ chain, input }) => ({ chain, ...input })), [
      { chain: 'solana', addresses: [SOL], asOf: '2026-07-15T18:00:00.000Z',
        statementTimeoutMs: undefined },
      { chain: 'robinhood', addresses: [robinhoodAddress, missingAddress],
        asOf: '2026-07-15T18:00:00.000Z', statementTimeoutMs: undefined },
    ]);
  });

  it('rejects unavailable or empty chain selections before reading', async () => {
    let calls = 0;
    const adapter = { async listMonitoredPrefix() { calls += 1; return null; } };
    const reader = createDashboardChainReader({
      solanaWorkspaceTokenReader: adapter,
      robinhoodWorkspaceTokenReader: adapter,
    });

    await assert.rejects(reader.listExactMonitored({ chains: [] }), /at least one chain/);
    await assert.rejects(
      reader.listExactMonitored({ chains: ['base'] }), /adapter is unavailable/,
    );
    await assert.rejects(
      reader.listExactMonitored({ chains: ['solana'], excludedIdentities: ['invalid'] }),
      /Invalid token identity key/,
    );
    await assert.rejects(reader.listExactPinned({
      chains: ['solana'], pinnedItems: [{ chain: 'robinhood', address: EXCLUDED_EVM,
        sortOrder: 0 }],
    }), /chain is not selected/);
    assert.equal(calls, 0);
  });
});
