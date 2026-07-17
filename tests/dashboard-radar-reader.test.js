const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createDashboardRadarReader } = require('../src/services/dashboard-radar-reader');

const AS_OF = '2026-07-15T18:00:00.000Z';
const SOL = 'So11111111111111111111111111111111111111112';
const RH = `0x${'1'.repeat(40)}`;

function row(chain, address, volume, overrides = {}) {
  return {
    identity: { chain, address, key: `${chain}:${address}` },
    tokenAge: { state: 'known', timestampMs: Date.parse('2026-07-14T00:00:00.000Z') },
    valuation: { type: chain === 'solana' ? 'mcap' : 'fdv', usd: 50_000 },
    volume1hUsd: volume,
    volume6hUsd: volume,
    volume24hUsd: volume,
    coverage: { '1h': 'complete', '6h': 'complete', '24h': 'complete' },
    priceChangeCoverage: { '1h': 'unavailable', '6h': 'unavailable', '24h': 'unavailable' },
    ...overrides,
  };
}

function reader(chain, rows, total = rows.length, calls = []) {
  return {
    async listRadarPrefix(input) {
      calls.push(input);
      return { chain, asOf: input.asOf, total, rows: rows.slice(0, input.perPage * (input.page + 1)) };
    },
  };
}

describe('dashboard radar reader', () => {
  it('builds an exact combined page from bounded chain prefixes under one snapshot', async () => {
    const solanaCalls = [];
    const robinhoodCalls = [];
    const solanaRows = [row('solana', SOL, 90), row('solana', `${SOL.slice(0, -1)}3`, 70),
      row('solana', `${SOL.slice(0, -1)}4`, 30)];
    const robinhoodRows = [row('robinhood', RH, 100),
      row('robinhood', `0x${'2'.repeat(40)}`, 70), row('robinhood', `0x${'3'.repeat(40)}`, 40)];
    const dashboard = createDashboardRadarReader({
      solanaReader: reader('solana', solanaRows, 3, solanaCalls),
      robinhoodReader: reader('robinhood', robinhoodRows, 3, robinhoodCalls),
      now: () => new Date('2026-07-15T18:00:45.000Z'),
    });
    const result = await dashboard.listExactRadar({
      chains: ['solana', 'robinhood'], page: 1, perPage: 2,
      minMcap: 10_000, minFdv: 30_000,
      sorts: [{ mode: 'vol', window: '1h' }],
    });

    assert.equal(result.asOf, AS_OF);
    assert.equal(result.total, 6);
    assert.equal(result.requiredPrefix, 4);
    assert.equal(result.hasMore, true);
    assert.deepEqual(result.rows.map((item) => item.identity.chain), ['robinhood', 'solana']);
    assert.deepEqual(result.rows.map((item) => item.volume1hUsd), [70, 70]);
    assert.equal(solanaCalls[0].minMcap, 10_000);
    assert.equal(Object.hasOwn(solanaCalls[0], 'minFdv'), false);
    assert.equal(robinhoodCalls[0].minFdv, 30_000);
    assert.equal(Object.hasOwn(robinhoodCalls[0], 'minMcap'), false);
    assert.equal(solanaCalls[0].asOf, robinhoodCalls[0].asOf);
  });

  it('scopes canonical dismissed and starred identities to each adapter', async () => {
    const solanaCalls = [];
    const robinhoodCalls = [];
    const dashboard = createDashboardRadarReader({
      solanaReader: reader('solana', [], 0, solanaCalls),
      robinhoodReader: reader('robinhood', [], 0, robinhoodCalls),
    });
    await dashboard.listExactRadar({
      asOf: AS_OF, chains: ['solana', 'robinhood'],
      dismissedIdentities: [`solana:${SOL}`, `robinhood:${RH}`],
      starredIdentities: [`solana:${SOL}`, `robinhood:${RH}`],
    });

    assert.deepEqual(solanaCalls[0].dismissedIdentities.map((item) => item.key), [`solana:${SOL}`]);
    assert.deepEqual(robinhoodCalls[0].starredIdentities.map((item) => item.key), [`robinhood:${RH}`]);
  });

  it('does not call another chain and avoids every reader for an empty starred query', async () => {
    let solanaCalls = 0;
    let robinhoodCalls = 0;
    const dashboard = createDashboardRadarReader({
      solanaReader: { async listRadarPrefix(input) {
        solanaCalls += 1;
        return { chain: 'solana', asOf: input.asOf, total: 0, rows: [] };
      } },
      robinhoodReader: { async listRadarPrefix() { robinhoodCalls += 1; } },
    });
    await dashboard.listExactRadar({ asOf: AS_OF, chains: ['solana'] });
    const empty = await dashboard.listExactRadar({
      asOf: AS_OF, chains: ['solana', 'robinhood'], starredOnly: true,
    });

    assert.equal(solanaCalls, 1);
    assert.equal(robinhoodCalls, 0);
    assert.equal(empty.total, 0);
  });

  it('fails closed on stale, incomplete, cross-chain or unsorted prefixes', async () => {
    async function rejects(prefix, pattern) {
      const dashboard = createDashboardRadarReader({
        solanaReader: { async listRadarPrefix() { return prefix; } },
        robinhoodReader: reader('robinhood', []),
      });
      await assert.rejects(dashboard.listExactRadar({
        asOf: AS_OF, chains: ['solana'], perPage: 2,
        sorts: [{ mode: 'vol', window: '1h' }],
      }), pattern);
    }

    await rejects({ chain: 'solana', asOf: '2026-07-15T17:00:00.000Z', total: 0, rows: [] }, /snapshot/);
    await rejects({ chain: 'solana', asOf: AS_OF, total: 2, rows: [row('solana', SOL, 10)] }, /required/);
    await rejects({ chain: 'solana', asOf: AS_OF, total: 1, rows: [row('robinhood', RH, 10)] }, /identity/);
    await rejects({ chain: 'solana', asOf: AS_OF, total: 2, rows: [
      row('solana', SOL, 10), row('solana', `${SOL.slice(0, -1)}3`, 20),
    ] }, /not sorted/);
  });

  it('preserves pin order outside the page while respecting explicit exclusions', async () => {
    const solanaTwo = `${SOL.slice(0, -1)}3`;
    const calls = [];
    const dashboard = createDashboardRadarReader({
      solanaReader: { async listRadarPrefix() {}, async getRadarTokensByAddresses(input) {
        calls.push(['solana', input]);
        return input.addresses.map((address) => row('solana', address, 0));
      } },
      robinhoodReader: { async listRadarPrefix() {}, async getRadarTokensByAddresses(input) {
        calls.push(['robinhood', input]);
        return input.addresses.map((address) => row('robinhood', address, 0));
      } },
    });
    const rows = await dashboard.listRadarPins({
      asOf: AS_OF, chains: ['solana', 'robinhood'],
      pinnedIdentities: [`solana:${SOL}`, `robinhood:${RH}`, `solana:${solanaTwo}`],
      excludedIdentities: [`solana:${solanaTwo}`],
      pageRows: [row('robinhood', RH, 0)],
    });

    assert.deepEqual(rows.map((item) => item.identity.key), [`solana:${SOL}`]);
    assert.deepEqual(calls.map(([chain, input]) => [chain, input.addresses]), [
      ['solana', [SOL]], ['robinhood', [RH]],
    ]);
  });
});
