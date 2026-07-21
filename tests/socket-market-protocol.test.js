const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const socketHub = require('../src/services/socket-hub');
const config = require('../config');

const SOLANA_ADDRESS = 'So11111111111111111111111111111111111111112';
const EVM_ADDRESS = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01';
const VISIBLE_CONFIG = { robinhoodUserVisibility: { enabled: true } };

const {
  createMarketSubscriptionProtocolTelemetry,
  getMarketSubscriptionRooms,
  getMarketSubscriptionRoom,
  normalizeMarketBucketUpdate,
  recordMarketSubscriptionProtocolUsage,
  resolveMarketIdentity,
} = socketHub.__private;

describe('chain-aware socket market protocol', () => {
  it('fits the maximum subscription sync inside the configured transport buffer', () => {
    const count = config.security.socket.maxSubscriptionsPerSocket;
    const subscriptions = Array.from({ length: count }, (_, index) => ({
      chain: 'robinhood',
      address: `0x${index.toString(16).padStart(40, '0')}`,
    }));
    const packet = `42${JSON.stringify(['market:sync', { subscriptions }])}`;

    assert.ok(Buffer.byteLength(packet) < config.security.socket.maxHttpBufferSize);
  });

  it('separates canonical and legacy address-only request telemetry', () => {
    const telemetry = createMarketSubscriptionProtocolTelemetry('2026-07-16T10:00:00.000Z');
    recordMarketSubscriptionProtocolUsage(telemetry, {
      address: SOLANA_ADDRESS,
    }, '2026-07-16T10:01:00.000Z');
    recordMarketSubscriptionProtocolUsage(telemetry, {
      chain: 'robinhood', address: EVM_ADDRESS,
    }, '2026-07-16T10:02:00.000Z');
    recordMarketSubscriptionProtocolUsage(telemetry, { subscriptions: [
      { address: SOLANA_ADDRESS },
      { chain: 'robinhood', address: EVM_ADDRESS },
    ] }, '2026-07-16T10:03:00.000Z');

    assert.deepEqual(telemetry, {
      observedSince: '2026-07-16T10:00:00.000Z',
      canonicalRequests: 2,
      legacyAddressOnlyRequests: 2,
      lastCanonicalAt: '2026-07-16T10:03:00.000Z',
      lastLegacyAddressOnlyAt: '2026-07-16T10:03:00.000Z',
    });
  });

  it('keeps address-only subscriptions as a Solana adapter', () => {
    assert.equal(
      getMarketSubscriptionRoom({ address: SOLANA_ADDRESS }),
      `market:solana:${SOLANA_ADDRESS}`,
    );
    assert.equal(resolveMarketIdentity({ address: EVM_ADDRESS }), null);
  });

  it('isolates the same EVM address in canonical chain rooms', () => {
    const robinhoodRoom = getMarketSubscriptionRoom(
      { chain: 'robinhood', address: EVM_ADDRESS },
      { config: VISIBLE_CONFIG },
    );
    const baseRoom = getMarketSubscriptionRoom({ chain: 'base', address: EVM_ADDRESS });

    assert.equal(robinhoodRoom, `market:robinhood:${EVM_ADDRESS.toLowerCase()}`);
    assert.equal(baseRoom, `market:base:${EVM_ADDRESS.toLowerCase()}`);
    assert.notEqual(robinhoodRoom, baseRoom);
  });

  it('normalizes a batch subscription atomically and deduplicates rooms', () => {
    assert.deepEqual([...getMarketSubscriptionRooms({ subscriptions: [
      { chain: 'robinhood', address: EVM_ADDRESS },
      { chain: 'base', address: EVM_ADDRESS },
      { chain: 'robinhood', address: EVM_ADDRESS.toLowerCase() },
    ] }, { config: VISIBLE_CONFIG })], [
      `market:robinhood:${EVM_ADDRESS.toLowerCase()}`,
      `market:base:${EVM_ADDRESS.toLowerCase()}`,
    ]);
    assert.deepEqual([...getMarketSubscriptionRooms({ subscriptions: [] })], []);
    assert.equal(getMarketSubscriptionRooms({ subscriptions: [{ chain: 'base', address: 'bad' }] }), null);
    assert.equal(getMarketSubscriptionRooms({}), null);
  });

  it('rejects Robinhood subscriptions while user visibility is disabled', () => {
    assert.equal(getMarketSubscriptionRoom(
      { chain: 'robinhood', address: EVM_ADDRESS },
      { config: { robinhoodUserVisibility: { enabled: false } } },
    ), null);
  });

  it('rejects invalid or unsupported explicit identities', () => {
    assert.equal(getMarketSubscriptionRoom({ chain: 'robinhood', address: SOLANA_ADDRESS }), null);
    assert.equal(getMarketSubscriptionRoom({ chain: 'unknown', address: EVM_ADDRESS }), null);
    assert.equal(getMarketSubscriptionRoom({ chain: 'solana', address: 'short' }), null);
  });

  it('normalizes an ordered market event without guessing its chain', () => {
    const event = normalizeMarketBucketUpdate({
      chain: 'robinhood',
      address: EVM_ADDRESS,
      bucketTs: '2026-07-15T12:00:00.000Z',
      sequence: '6880646:12:0xabc',
      candle: { bucketTs: '2026-07-15T12:00:00.000Z', closePrice: 1.25 },
    });

    assert.equal(event.type, 'market:bucket');
    assert.equal(event.chain, 'robinhood');
    assert.equal(event.address, EVM_ADDRESS.toLowerCase());
    assert.equal(event.bucketTs, '2026-07-15T12:00:00.000Z');
    assert.equal(event.sequence, '6880646:12:0xabc');
    assert.equal(normalizeMarketBucketUpdate({ address: SOLANA_ADDRESS, sequence: '1', bucketTs: event.bucketTs }), null);
    assert.equal(normalizeMarketBucketUpdate({ chain: 'solana', address: SOLANA_ADDRESS, bucketTs: event.bucketTs }), null);
  });
});
