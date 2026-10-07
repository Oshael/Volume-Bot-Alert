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
  assert.equal(shortCalls, 2);
});

it('keeps the visible ranking while a price refresh is in flight and coalesces its catch-up', async () => {
  const releases = [];
  const h = liveHarness((call) => call === 1 ? page() : new Promise((resolve) => releases.push(resolve)));
  await h.loader.update(input);
  h.loader.invalidate(invalidation({ prices: '1' })); await h.tick(500);
  assert.equal(h.loader.state.page.items[0].identity.address, address);
  assert.equal(h.loader.state.loading, true);
  for (let version = 2; version <= 100; version += 1) h.loader.invalidate(invalidation({ prices: String(version) }));
  releases[0](page()); await h.tick(0);
  assert.equal(h.calls.length, 2);
  await h.tick(500); assert.equal(h.calls.length, 3);
  releases[1](page()); await h.tick(0);
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

function liveHarness(source) {
  let time = Date.parse('2026-10-06T12:00:45Z');
  let visible = true;
  let sequence = 0;
  const timers = new Map();
  const calls = [];
  const loader = createRadarGainersLoader(async (query, signal) => {
    calls.push({ query, signal });
    return source ? source(calls.length) : { ...page(), asOf: new Date(time).toISOString() };
  }, () => {}, () => time, { visible: () => visible,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return { loader, calls, timers, visible(value) { visible = value; loader.resume(); },
    async tick(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > time || !timers.has(id)) continue;
        timers.delete(id); timer.callback();
      }
      await new Promise(setImmediate);
    },
  };
}
const invalidation = (revisions) => ({ type: 'wallet-ranking:invalidate', chain: 'robinhood',
  version: 1, revisions, publishedAt: '2026-10-06T12:00:45Z' });

it('coalesces committed price bursts within the same minute without polling or wallet-only refreshes', async () => {
  const h = liveHarness();
  await h.loader.update(input);
  h.loader.connection(true);
  assert.equal(h.loader.invalidate(invalidation({ positions: '100' })), false);
  for (let version = 1; version <= 100; version += 1) h.loader.invalidate(invalidation({ prices: String(version) }));
  assert.equal(h.loader.invalidate(invalidation({ prices: '100' })), false);
  assert.equal(h.loader.invalidate(invalidation({ prices: '2' })), false);
  assert.equal(h.loader.invalidate({ ...invalidation({ prices: '101' }), chain: 'solana' }), false);
  assert.equal(h.timers.size, 2); // One pending refresh, one display-only freshness deadline.
  assert.equal(h.loader.state.stale, true);
  await h.tick(499); assert.equal(h.calls.length, 1);
  await h.tick(1); assert.equal(h.calls.length, 2);
  assert.equal(h.loader.state.page.asOf, '2026-10-06T12:00:45.500Z');
  assert.equal(h.loader.state.stale, false);
  await h.tick(120000);
  assert.equal(h.loader.state.stale, true);
  assert.equal(h.calls.length, 2); // Expiration never discovers changes through HTTP.
  h.loader.resume(false); await h.tick(0);
  assert.equal(h.calls.length, 2); // A normal render is not a return to the panel.
  h.visible(false); h.visible(true); await h.tick(0);
  assert.equal(h.calls.length, 3);
});

it('clears reorg-invalid snapshots, ignores old in-flight responses and recovers a missed revision', async () => {
  const releases = [];
  const h = liveHarness((call) => call === 1 ? page() : new Promise((resolve) => { releases.push(resolve); }));
  await h.loader.update(input);
  h.loader.invalidate(invalidation({ prices: '1' }));
  await h.tick(15000);
  h.loader.invalidate(invalidation({ reorg: '4' }));
  assert.equal(h.loader.state.page, null);
  assert.equal(h.calls[1].signal.aborted, true);
  await h.tick(5000); assert.equal(h.calls.length, 3);
  releases[0](page()); await h.tick(0);
  assert.equal(h.loader.state.page, null);
  releases[1]({ ...page(), items: [], total: 0 }); await h.tick(0);
  assert.deepEqual(h.loader.state.page.items, []);
  assert.equal(h.loader.invalidate(invalidation({ reorg: '3' })), false);
  h.loader.connection(false);
  h.loader.recover();
  assert.equal(h.loader.state.page, null);
  await h.tick(5000); assert.equal(h.calls.length, 4);
  releases[2](page()); await h.tick(0);
  h.loader.connection(true);
  assert.equal(h.loader.state.connected, true);
});

it('pauses hidden panels, respects live Retry-After and stops after one recovery retry', async () => {
  const h = liveHarness((call) => {
    if (call > 1) throw Object.assign(new Error('busy'), { retryAfterMs: 20000 });
    return page();
  });
  await h.loader.update(input);
  h.loader.invalidate(invalidation({ prices: '1' }));
  h.visible(false);
  await h.tick(15000); assert.equal(h.calls.length, 1);
  h.visible(true); await h.tick(0); assert.equal(h.calls.length, 2);
  await h.tick(19999); assert.equal(h.calls.length, 2);
  await h.tick(1); assert.equal(h.calls.length, 3);
  await h.tick(300000); assert.equal(h.calls.length, 3);
  assert.match(h.loader.state.message, /temporarily unavailable/);
  h.loader.invalidate(invalidation({ prices: '2' }));
  await h.loader.update({ ...input, available: false });
  await h.tick(60000); assert.equal(h.calls.length, 3);
});
