const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletRankingWindowCoverage,
} = require('../src/services/robinhood-wallet-ranking-window-coverage');

const TOKEN = `0x${'a'.repeat(40)}`;
const WALLET_A = `0x${'1'.repeat(40)}`;
const WALLET_B = `0x${'2'.repeat(40)}`;
const WINDOW_START = '2026-09-26T12:00:00.000Z';
const AS_OF = '2026-09-27T12:00:00.000Z';
const VERSION = 'rh_transfer_v1';

function event(walletAddress, overrides = {}) {
  return { tokenAddress: TOKEN, walletAddress, windowStart: WINDOW_START,
    asOf: AS_OF, events: [], truncated: false, orderingComplete: true,
    sourceCoverageVerified: false, ...overrides };
}

function harness(overrides = {}) {
  const calls = [];
  const service = createRobinhoodWalletRankingWindowCoverage({
    snapshotRunner: { run: (read) => read({}) },
    eventsRepository: { async getWindowEvents() {
      return overrides.events || [event(WALLET_A), event(WALLET_B)];
    } },
    availabilityRepository: { async inspectWindow(input) {
      calls.push({ source: 'availability', input });
      return overrides.availability || { rawTransferAvailable: true, partitions: [] };
    } },
    swapAvailabilityRepository: { async inspectWindow(input) {
      calls.push({ source: 'swapAvailability', input });
      return overrides.swapAvailability || { swapPartitionsAvailable: true, partitions: [] };
    } },
    frontiersRepository: { async inspectAsOf(input) {
      calls.push({ source: 'frontiers', input });
      return overrides.frontiers || { cursorChecksPassed: true, sources: [] };
    } },
    classificationRepository: { async inspectWindow(input) {
      calls.push({ source: 'classification', input });
      return overrides.classifications || [WALLET_A, WALLET_B].map((walletAddress) => ({
        tokenAddress: TOKEN, walletAddress, rawRowsClassified: true, reasons: [],
      }));
    } },
  });
  return { service, calls };
}

describe('Robinhood ranking window coverage composition', () => {
  it('keeps exact-event coverage closed even when available checks pass', async () => {
    const { service, calls } = harness();
    const result = await service.getWindowEvents({ classificationVersion: VERSION });
    assert.equal(result.length, 2);
    for (const pair of result) {
      assert.equal(pair.preconditionsSatisfied, true);
      assert.equal(pair.eventsComplete, false);
      assert.equal(pair.sourceCoverageVerified, false);
      assert.deepEqual(pair.coverageReasons, ['source_coverage_unverified']);
      assert.equal(pair.checks.swapPartitionsAvailable, true);
    }
    assert.deepEqual(calls.find((call) => call.source === 'classification').input, {
      pairs: [{ tokenAddress: TOKEN, walletAddress: WALLET_A },
        { tokenAddress: TOKEN, walletAddress: WALLET_B }],
      windowStart: WINDOW_START, asOf: AS_OF, classificationVersion: VERSION,
    });
    assert.deepEqual(calls.find((call) => call.source === 'frontiers').input, {
      windowStart: WINDOW_START, asOf: AS_OF, transferVersion: VERSION,
    });
  });

  it('keeps global and pair-specific failures separate', async () => {
    const { service } = harness({
      events: [event(WALLET_A, { truncated: true, orderingComplete: false }),
        event(WALLET_B)],
      availability: { rawTransferAvailable: false,
        partitions: [{ reasons: ['raw_transfer_partition_missing'] }] },
      frontiers: { cursorChecksPassed: false,
        sources: [{ reasons: ['swap_behind_as_of'] }] },
      classifications: [{ tokenAddress: TOKEN, walletAddress: WALLET_A,
        rawRowsClassified: false, reasons: ['transfer_classification_unresolved'] }],
    });
    const [a, b] = await service.getWindowEvents({ classificationVersion: VERSION });
    assert.equal(a.preconditionsSatisfied, false);
    assert.deepEqual(a.coverageReasons, [
      'raw_transfer_partition_missing', 'source_coverage_unverified',
      'swap_behind_as_of', 'transfer_classification_unresolved',
      'window_event_order_unverified', 'window_events_truncated',
    ]);
    assert.equal(b.preconditionsSatisfied, false);
    assert.ok(b.coverageReasons.includes('transfer_classification_unverified'));
    assert.ok(!b.coverageReasons.includes('transfer_classification_unresolved'));
  });

  it('does not query audits for an empty pair set', async () => {
    const { service, calls } = harness({ events: [] });
    assert.deepEqual(await service.getWindowEvents({ classificationVersion: VERSION }), []);
    assert.deepEqual(calls, []);
  });

  it('keeps a missing swap partition explicit and events incomplete', async () => {
    const { service } = harness({ swapAvailability: {
      swapPartitionsAvailable: false,
      partitions: [{ reasons: ['swap_partition_missing'] }],
    } });
    const [result] = await service.getWindowEvents({ classificationVersion: VERSION });
    assert.equal(result.preconditionsSatisfied, false);
    assert.equal(result.eventsComplete, false);
    assert.ok(result.coverageReasons.includes('swap_partition_missing'));
  });
});
