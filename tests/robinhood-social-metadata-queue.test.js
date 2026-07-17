const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createMemoryMetadataStore,
  createRobinhoodSocialMetadataQueue,
  extractRobinhoodSocialMetadata,
} = require('../src/services/robinhood-social-metadata-queue');

const TOKEN = '0x1111111111111111111111111111111111111111';
const TOKEN_2 = '0x2222222222222222222222222222222222222222';

function pair(address = TOKEN) {
  return {
    chainId: 'robinhood',
    pairAddress: '0x3333333333333333333333333333333333333333',
    baseToken: { address },
    info: {
      imageUrl: 'https://cdn.example/token.png',
      websites: [{ label: 'Website', url: 'https://token.example' }],
      socials: [
        { type: 'twitter', url: 'https://x.com/token' },
        { type: 'telegram', url: 'https://t.me/token' },
      ],
    },
  };
}

function dexClient(options = {}) {
  const calls = [];
  return {
    calls,
    getThrottleState: () => options.throttle || { pauseDiscovery: false },
    batchGetTokens: async (addresses, requestOptions) => {
      calls.push({ addresses, requestOptions });
      if (options.error) throw new Error('Dex unavailable');
      return new Map(addresses.map((address) => [address,
        options.missing ? null : { pairs: [pair(address)] }]));
    },
    getBestPair: (data, chain) => data?.pairs?.find((item) => item.chainId === chain) || null,
  };
}

describe('Robinhood social metadata queue', () => {
  it('extracts only the four authorized DexScreener metadata fields', () => {
    const metadata = extractRobinhoodSocialMetadata(TOKEN, pair(), 1000);

    assert.deepEqual(metadata, {
      chain: 'robinhood',
      address: TOKEN,
      source: 'dexscreener',
      pairAddress: '0x3333333333333333333333333333333333333333',
      imageUrl: 'https://cdn.example/token.png',
      websiteUrl: 'https://token.example/',
      twitterUrl: 'https://x.com/token',
      telegramUrl: 'https://t.me/token',
      fetchedAtMs: 1000,
    });
    assert.equal('priceUsd' in metadata, false);
    assert.equal('volume' in metadata, false);
  });

  it('deduplicates tokens and resolves a conservative Robinhood-only batch', async () => {
    const dex = dexClient();
    const queue = createRobinhoodSocialMetadataQueue({ dexClient: dex, maxBatchSize: 2 });
    assert.equal(queue.enqueue(TOKEN.toUpperCase()), true);
    assert.equal(queue.enqueue(TOKEN), false);
    assert.equal(queue.enqueue(TOKEN_2), true);

    const result = await queue.drainOnce();
    const snapshot = queue.snapshot();

    assert.deepEqual(result, { status: 'processed', processed: 2 });
    assert.equal(dex.calls[0].requestOptions.chain, 'robinhood');
    assert.equal(dex.calls[0].requestOptions.delayMs, 0);
    assert.equal(snapshot.queued, 0);
    assert.equal(snapshot.metrics.resolved, 2);
    assert.equal((await queue.getMetadata(TOKEN)).telegramUrl, 'https://t.me/token');
  });

  it('prioritizes missing Blockscout images, then volume, within five per minute', async () => {
    let now = 1000;
    const dex = dexClient();
    const queue = createRobinhoodSocialMetadataQueue({
      dexClient: dex, now: () => now, maxBatchSize: 99,
    });
    const addresses = Array.from({ length: 7 }, (_, index) => (
      `0x${String(index + 3).repeat(40)}`
    ));
    queue.enqueue(addresses[0], { blockscoutMissingImage: false, volumeUsd: 1000 });
    queue.enqueue(addresses[1], { blockscoutMissingImage: true, volumeUsd: 10 });
    queue.enqueue(addresses[2], { blockscoutMissingImage: true, volumeUsd: 500 });
    queue.enqueue(addresses[3], { blockscoutMissingImage: true, volumeUsd: 100 });
    queue.enqueue(addresses[4], { blockscoutMissingImage: false, volumeUsd: 900 });
    queue.enqueue(addresses[5], { blockscoutMissingImage: true, volumeUsd: 50 });
    queue.enqueue(addresses[6], { blockscoutMissingImage: false, volumeUsd: 800 });

    assert.equal((await queue.drainOnce()).processed, 5);
    assert.deepEqual(dex.calls[0].addresses, [
      addresses[2], addresses[3], addresses[5], addresses[1], addresses[0],
    ]);
    assert.equal((await queue.drainOnce()).status, 'cooldown');
    now += 60_000;
    assert.equal((await queue.drainOnce()).processed, 2);
  });

  it('pauses Robinhood metadata before making a request during Dex throttling', async () => {
    const dex = dexClient({ throttle: { pauseDiscovery: true } });
    const queue = createRobinhoodSocialMetadataQueue({ dexClient: dex });
    queue.enqueue(TOKEN);

    assert.deepEqual(await queue.drainOnce(), { status: 'paused', processed: 0 });
    assert.equal(dex.calls.length, 0);
    assert.equal(queue.snapshot().queued, 1);
    assert.equal(queue.snapshot().metrics.pauses, 1);
  });

  it('contains external failures and schedules a slow retry without throwing', async () => {
    let now = 1000;
    const dex = dexClient({ error: true });
    const queue = createRobinhoodSocialMetadataQueue({
      dexClient: dex,
      now: () => now,
      retryDelaysMs: [60_000],
    });
    queue.enqueue(TOKEN);

    assert.deepEqual(await queue.drainOnce(), { status: 'error', processed: 0, error: 'Dex unavailable' });
    assert.equal(queue.snapshot().metrics.retries, 1);
    assert.equal((await queue.drainOnce()).status, 'cooldown');
    now += 60_000;
    await queue.drainOnce();
    assert.equal(queue.snapshot().queued, 0);
    assert.equal(queue.snapshot().metrics.unavailable, 1);
  });

  it('honors an injected persistent-store contract before calling DexScreener', async () => {
    const dex = dexClient();
    const store = createMemoryMetadataStore();
    await store.set(TOKEN, { address: TOKEN, imageUrl: 'https://cached.example/a.png' }, Date.now() + 60_000);
    const queue = createRobinhoodSocialMetadataQueue({ dexClient: dex, store });
    queue.enqueue(TOKEN);

    assert.equal((await queue.drainOnce()).status, 'idle');
    assert.equal(dex.calls.length, 0);
    assert.equal(queue.snapshot().metrics.cacheHits, 1);
  });
});
