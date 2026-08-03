const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodDexscreenerProfileSync,
} = require('../src/services/robinhood-dexscreener-profile-sync');

const ADDR_A = '0x27436d7f4add44aca19a0b10387c17da5d5de9a0';
const ICON = 'https://cdn.example.com/a.png';

function catalogRow(overrides = {}) {
  return {
    address: ADDR_A,
    last_image_url: null,
    robinhood_blockscout_checked_at: '2026-08-02T00:00:00.000Z',
    robinhood_dexscreener_checked_at: null,
    ...overrides,
  };
}

function fakeCatalog(rows = []) {
  const byAddress = new Map(rows.map((row) => [row.address, row]));
  const records = [];
  return {
    records,
    listCalls: [],
    async listMetadata(addresses) {
      this.listCalls.push([...addresses]);
      return addresses.map((address) => byAddress.get(address)).filter(Boolean);
    },
    async recordDexscreenerMetadata(input) {
      records.push(input);
      return { address: input.address };
    },
  };
}

function fakeDex(items, overrides = {}) {
  return {
    calls: 0,
    getThrottleState: overrides.getThrottleState || (() => ({ pauseDiscovery: false })),
    async getLatestTokenProfiles() {
      this.calls += 1;
      if (overrides.throwFeed) throw new Error('feed down');
      return typeof items === 'function' ? items() : items;
    },
  };
}

function profileItem(overrides = {}) {
  return {
    chainId: 'robinhood',
    tokenAddress: ADDR_A,
    icon: ICON,
    links: [],
    ...overrides,
  };
}

describe('Robinhood DexScreener profile sync', () => {
  it('ignores non-robinhood chains and dedups robinhood addresses by identity', async () => {
    const catalog = fakeCatalog([]);
    const dex = fakeDex([
      { chainId: 'solana', tokenAddress: 'SoLaNaMint1111111111111111111111111111111', icon: ICON },
      profileItem(),
      profileItem({ tokenAddress: ADDR_A.toUpperCase() }),
    ]);
    const sync = createRobinhoodDexscreenerProfileSync({ dexClient: dex, catalog });

    const summary = await sync.runOnce();

    assert.equal(summary.received, 3);
    assert.equal(summary.robinhood, 2);
    assert.equal(summary.valid, 1);
    assert.deepEqual(catalog.listCalls[0], [ADDR_A]);
  });

  it('does not persist and does not mark checked when icon is missing or unsafe', async () => {
    const catalog = fakeCatalog([catalogRow()]);
    const dex = fakeDex([profileItem({ icon: 'javascript:alert(1)' })]);
    const sync = createRobinhoodDexscreenerProfileSync({ dexClient: dex, catalog });

    const summary = await sync.runOnce();

    assert.equal(catalog.records.length, 0);
    assert.equal(summary.invalid, 1);
    assert.equal(summary.resolvedImages, 0);
    assert.equal(summary.pending, 0);
  });

  it('overwrites an existing image from another source with the profile icon', async () => {
    const catalog = fakeCatalog([catalogRow({ last_image_url: 'https://old.example.com/x.png' })]);
    const dex = fakeDex([profileItem()]);
    const sync = createRobinhoodDexscreenerProfileSync({ dexClient: dex, catalog });

    const summary = await sync.runOnce();

    assert.equal(catalog.records.length, 1);
    assert.equal(catalog.records[0].imageUrl, ICON);
    assert.equal(catalog.records[0].overwriteImage, true);
    assert.equal(summary.resolvedImages, 1);
    assert.equal(summary.pending, 0);
  });

  it('skips a token that already carries the same profile icon', async () => {
    const catalog = fakeCatalog([catalogRow({ last_image_url: ICON })]);
    const dex = fakeDex([profileItem()]);
    const sync = createRobinhoodDexscreenerProfileSync({ dexClient: dex, catalog });

    const summary = await sync.runOnce();

    assert.equal(catalog.records.length, 0);
    assert.equal(summary.existingImages, 1);
    assert.equal(summary.resolvedImages, 0);
    assert.equal(summary.pending, 0);
  });

  it('keeps a token pending until priority is ready, then resolves it from pending', async () => {
    let clock = 0;
    const now = () => clock;
    // Blockscout not yet checked on the first cycle, checked on the second.
    const rows = [catalogRow({ robinhood_blockscout_checked_at: null })];
    const catalog = fakeCatalog(rows);
    let feed = [profileItem()];
    const dex = fakeDex(() => feed);
    const sync = createRobinhoodDexscreenerProfileSync({ dexClient: dex, catalog, now });

    const first = await sync.runOnce();
    assert.equal(catalog.records.length, 0);
    assert.equal(first.skippedPriorityPending, 1);
    assert.equal(first.pending, 1);

    // Priority source finished and the feed no longer carries the profile; the
    // pending entry alone must be enough to resolve the image.
    rows[0].robinhood_blockscout_checked_at = '2026-08-02T00:00:00.000Z';
    catalog.listMetadata = async (addresses) => addresses.map((a) => (
      a === ADDR_A ? rows[0] : null
    )).filter(Boolean);
    feed = [];
    clock = 60_000;

    const second = await sync.runOnce();
    assert.equal(second.resolvedImages, 1);
    assert.equal(second.pending, 0);
    assert.equal(catalog.records[0].address, ADDR_A);
  });

  it('writes the safe image once on-chain and blockscout sources have failed', async () => {
    const catalog = fakeCatalog([catalogRow()]);
    const dex = fakeDex([profileItem()]);
    const sync = createRobinhoodDexscreenerProfileSync({ dexClient: dex, catalog });

    const summary = await sync.runOnce();

    assert.equal(catalog.records.length, 1);
    assert.equal(catalog.records[0].address, ADDR_A);
    assert.equal(catalog.records[0].imageUrl, ICON);
    assert.equal(summary.resolvedImages, 1);
  });

  it('keeps missing-catalog tokens pending without persisting', async () => {
    const catalog = fakeCatalog([]);
    const dex = fakeDex([profileItem()]);
    const sync = createRobinhoodDexscreenerProfileSync({ dexClient: dex, catalog });

    const summary = await sync.runOnce();

    assert.equal(catalog.records.length, 0);
    assert.equal(summary.skippedMissingCatalog, 1);
    assert.equal(summary.pending, 1);
  });

  it('skips the cycle under DexScreener throttle without fetching', async () => {
    const catalog = fakeCatalog([catalogRow()]);
    const dex = fakeDex([profileItem()], { getThrottleState: () => ({ pauseDiscovery: true }) });
    const sync = createRobinhoodDexscreenerProfileSync({ dexClient: dex, catalog });

    const summary = await sync.runOnce();

    assert.equal(summary.status, 'paused');
    assert.equal(dex.calls, 0);
  });

  it('reports feed errors without throwing to the caller', async () => {
    const catalog = fakeCatalog([catalogRow()]);
    const dex = fakeDex([], { throwFeed: true });
    const sync = createRobinhoodDexscreenerProfileSync({
      dexClient: dex, catalog, logger: { log() {}, warn() {}, error() {} },
    });

    const summary = await sync.runOnce();

    assert.equal(summary.status, 'error');
    assert.equal(summary.errors, 1);
  });

  it('persists social links only when the social metadata flag is enabled', async () => {
    const links = [
      { type: 'twitter', url: 'https://x.com/example' },
      { label: 'Website', url: 'https://example.com' },
    ];
    const withoutFlag = fakeCatalog([catalogRow()]);
    await createRobinhoodDexscreenerProfileSync({
      dexClient: fakeDex([profileItem({ links })]), catalog: withoutFlag,
    }).runOnce();
    assert.equal(withoutFlag.records[0].twitterUrl, undefined);
    assert.equal(withoutFlag.records[0].websiteUrl, undefined);

    const withFlag = fakeCatalog([catalogRow()]);
    await createRobinhoodDexscreenerProfileSync({
      dexClient: fakeDex([profileItem({ links })]),
      catalog: withFlag,
      socialMetadataEnabled: true,
    }).runOnce();
    assert.equal(withFlag.records[0].twitterUrl, 'https://x.com/example');
    assert.equal(withFlag.records[0].websiteUrl, 'https://example.com/');
  });
});
