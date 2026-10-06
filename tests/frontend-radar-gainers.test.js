const assert = require('node:assert/strict');
const { before, it } = require('node:test');
let createRadarGainersLoader;
let gainersPercent;
before(async () => ({ createRadarGainersLoader, gainersPercent } = await import('../frontend/src/utils/radar-gainers.ts')));
const address = `0x${'1'.repeat(40)}`;
const input = { token: 'session-a', available: true, dismissedIdentities: [] };
const page = () => ({ chain: 'robinhood', asOf: '2026-10-06T12:00:00Z',
  generatedAt: '2026-10-06T12:00:45Z', total: 1, candidateCount: 3, unpricedCount: 2,
  items: [{ identity: { chain: 'robinhood', address, key: `robinhood:${address}` },
    priceChangePct: '123.456789123456789', priceBasis: { coverage: 'available-history' } }] });

it('loads an independent top once, preserves order/precision and deduplicates equivalent exclusions', async () => {
  const calls = [];
  const loader = createRadarGainersLoader(async (query) => { calls.push(query); return page(); });
  const excluded = `robinhood:${address}`;
  await loader.update({ ...input, dismissedIdentities: [excluded, excluded, `base:${address}`, 'bad'] });
  await loader.update({ ...input, dismissedIdentities: [excluded] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].dismissedIdentities, [excluded]);
  assert.equal(loader.state.page.items[0].priceChangePct, '123.456789123456789');
  assert.equal(loader.state.page.unpricedCount, 2);
  assert.equal(gainersPercent('123.456789123456789'), '+123.46%');
  for (const missing of [null, '', 'NaN', 'Infinity']) assert.equal(gainersPercent(missing), '-');
});

it('clears previous identities, aborts obsolete requests and ignores their late responses', async () => {
  let time = 10000;
  const pending = [];
  const loader = createRadarGainersLoader((query, signal) => new Promise((resolve) => {
    pending.push({ query, signal, resolve });
  }), () => {}, () => time);
  const first = loader.update(input);
  await loader.update(input); // Renders while loading cannot add a second request.
  time += 5000;
  const second = loader.update({ ...input, token: 'session-b', dismissedIdentities: [`robinhood:${address}`] });
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(page()); await first;
  assert.equal(loader.state.page, null);
  assert.equal(loader.state.loading, true);
  pending[1].resolve({ ...page(), items: [], total: 0 }); await second;
  assert.deepEqual(loader.state.page.items, []);
  await loader.update({ ...input, available: false });
  assert.equal(loader.state.page, null);
  assert.equal(pending.length, 2);
});

it('respects retry delay across renders/identity changes and recovers only on manual refresh', async () => {
  let time = 10000;
  let calls = 0;
  const loader = createRadarGainersLoader(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('busy'), { retryAfterMs: 20000 });
    return { ...page(), items: [], total: 0 };
  }, () => {}, () => time);
  await loader.update(input);
  await loader.update(input);
  await loader.update(input, true);
  await loader.update({ ...input, dismissedIdentities: [`robinhood:${address}`] });
  assert.equal(calls, 1);
  assert.equal(loader.state.page, null);
  time += 20000;
  await loader.update(input, true);
  assert.equal(calls, 2);
  assert.deepEqual(loader.state.page.items, []);
  let shortCalls = 0;
  const short = createRadarGainersLoader(async () => {
    shortCalls += 1; throw Object.assign(new Error('busy'), { retryAfterMs: 1000 });
  }, () => {}, () => time);
  await short.update(input);
  time += 1000;
  await short.update(input, true);
  assert.equal(shortCalls, 1);
});

it('rejects a cross-chain or unbounded top and prevents oversized requests', async () => {
  for (const response of [{ ...page(), chain: 'solana' }, { ...page(), items: Array(21).fill(page().items[0]) },
    { ...page(), items: [{ ...page().items[0], priceChangePct: 'Infinity' }] }]) {
    const loader = createRadarGainersLoader(async () => response);
    await loader.update(input);
    assert.equal(loader.state.page, null);
    assert.match(loader.state.message, /unavailable/);
  }
  const loader = createRadarGainersLoader(async () => assert.fail('oversized request reached API'));
  await loader.update({ ...input, dismissedIdentities: Array.from({ length: 5001 }, (_, n) => (
    `robinhood:0x${n.toString(16).padStart(40, '0')}`
  )) });
  assert.match(loader.state.message, /Too many/);
});
