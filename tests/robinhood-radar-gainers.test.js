const assert = require('node:assert/strict');
const { it } = require('node:test');
const { createRobinhoodRadarGainersService } = require('../src/services/robinhood-radar-gainers');
const { createTokenIdentity } = require('../src/utils/token-identity');
const AS_OF = '2026-10-06T12:00:00.000Z';
const addresses = [1, 2].map((id) => `0x${String(id).repeat(40)}`);
const page = { chain: 'robinhood', asOf: AS_OF, candidateCount: 5000, total: 100,
  items: addresses.map((address) => ({ identity: createTokenIdentity('robinhood', address),
    priceChangePct: '100.00000000000001', priceBasis: { type: 'first-observed-price' } })) };
const metric = (address, overrides = {}) => ({ chain: 'robinhood', address, windowEnd: AS_OF,
  volume24hUsd: 500, coverage: { '24h': 'partial' }, liquidityUsd: 1000,
  liquidityCoverage: 'partial', liquidityProjectionCommittedAt: '2026-10-06T11:59:00.000Z',
  liquidityMarketCount: 2, valuedLiquidityMarketCount: 1, ...overrides });

it('hydrates only winners in bounded batches without changing order, price basis or coverage', async () => {
  let volumeCalls = 0; let holderCalls = 0;
  const service = createRobinhoodRadarGainersService({ ranking: { async getGainers(input) {
    assert.deepEqual(input.excludedAddresses, [addresses[0]]); return page;
  } }, windows: { async getMetricsByAddresses(input) {
    volumeCalls += 1;
    assert.deepEqual(input, { addresses, asOf: AS_OF, statementTimeoutMs: 5000 });
    return addresses.toReversed().map((address) => metric(address));
  } }, holders: { async getPublishedSummaries(tokens) {
    holderCalls += 1; assert.deepEqual(tokens, addresses);
    return [{ tokenAddress: addresses[0], holderCount: 0, source: 'ledger_live',
      observedAt: '2026-10-06T11:40:00.000Z', checkedAt: '2026-10-06T11:59:00.000Z' }];
  } } });
  const result = await service.getGainers({ excludedAddresses: [addresses[0]] });
  assert.equal(volumeCalls, 1); assert.equal(holderCalls, 1);
  assert.deepEqual(result.items.map((item) => item.identity.address), addresses);
  assert.equal(result.items[0].priceChangePct, page.items[0].priceChangePct);
  assert.equal(result.items[0].priceBasis, page.items[0].priceBasis);
  assert.equal(result.items[0].volume24hCoverage, 'partial');
  assert.equal(result.items[0].volume24hChangePct, null);
  assert.equal(result.items[0].liquidityCoverage, 'partial');
  assert.equal(result.items[0].holderCount, 0);
  assert.equal(result.items[0].holderFreshness, 'fresh');
  assert.equal(result.items[1].holderCount, null);
  assert.equal(result.items[1].holderUnavailableReason, 'snapshot_missing');
});

it('rejects a mismatched metric cutoff and hides projections committed after asOf', async () => {
  let metrics = [metric(addresses[0], { windowEnd: '2026-10-06T12:01:00.000Z' })];
  const service = createRobinhoodRadarGainersService({
    ranking: { async getGainers() { return { ...page, items: page.items.slice(0, 1) }; } },
    windows: { async getMetricsByAddresses() { return metrics; } },
    holders: { async getPublishedSummaries() { return [{ tokenAddress: addresses[0],
      holderCount: 100, source: 'ledger_live', observedAt: AS_OF,
      checkedAt: '2026-10-06T12:01:00.000Z' }]; } },
  });
  await assert.rejects(service.getGainers(), /cutoff/);
  metrics = [metric(addresses[0], { liquidityProjectionCommittedAt: '2026-10-06T12:01:00.000Z' })];
  const item = (await service.getGainers()).items[0];
  assert.equal(item.holderCount, null); assert.equal(item.holderFreshness, 'unavailable');
  assert.equal(item.holderUnavailableReason, 'snapshot_after_as_of');
  assert.equal(item.liquidityUsd, null); assert.equal(item.liquidityCoverage, 'unavailable');
});

it('skips empty hydration, rejects an oversized top and propagates source failure', async () => {
  let selected = { ...page, items: [] };
  const service = createRobinhoodRadarGainersService({
    ranking: { async getGainers() { return selected; } },
    windows: { async getMetricsByAddresses() { throw Object.assign(new Error('timeout'), { code: '57014' }); } },
    holders: { async getPublishedSummaries() { assert.fail('unexpected holder read'); } },
  });
  assert.equal(await service.getGainers(), selected);
  selected = { ...page, items: Array(21).fill(page.items[0]) };
  await assert.rejects(service.getGainers(), /bounded top/);
  selected = page;
  await assert.rejects(service.getGainers(), { code: '57014' });
});
