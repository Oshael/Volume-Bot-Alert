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
    canonicalEventsVerified: true,
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
      return overrides.frontiers || { cursorChecksPassed: true,
        sources: [{ source: 'transfer', seedOriginBlock: '90', liveNextBlock: '111' }] };
    } },
    classificationRepository: { async inspectWindow(input) {
      calls.push({ source: 'classification', input });
      return overrides.classifications || [WALLET_A, WALLET_B].map((walletAddress) => ({
        tokenAddress: TOKEN, walletAddress, rawRowsClassified: true, reasons: [],
      }));
    } },
    boundsRepository: { async resolveWindow(input) {
      calls.push({ source: 'bounds', input });
      return overrides.bounds || { verified: true,
        fromBlock: '100', throughBlock: '109', reasons: [] };
    } },
    scanCoverageRepository: { async inspectBlockRange(input) {
      calls.push({ source: 'scan', input });
      return overrides.scans || [{ tokenAddress: TOKEN, scanProofReady: true,
        coverageReasons: [] }];
    } },
  });
  return { service, calls };
}

describe('Robinhood ranking window coverage composition', () => {
  it('marks event coverage complete only when canonical scan proof also passes', async () => {
    const { service, calls } = harness();
    const result = await service.getWindowEvents({ classificationVersion: VERSION });
    assert.equal(result.length, 2);
    for (const pair of result) {
      assert.equal(pair.preconditionsSatisfied, true);
      assert.equal(pair.eventsComplete, true);
      assert.equal(pair.sourceCoverageVerified, true);
      assert.deepEqual(pair.coverageReasons, []);
      assert.equal(pair.checks.swapPartitionsAvailable, true);
      assert.equal(pair.checks.transferWindowBoundsVerified, true);
    }
    assert.deepEqual(calls.find((call) => call.source === 'classification').input, {
      pairs: [{ tokenAddress: TOKEN, walletAddress: WALLET_A },
        { tokenAddress: TOKEN, walletAddress: WALLET_B }],
      windowStart: WINDOW_START, asOf: AS_OF, classificationVersion: VERSION,
    });
    assert.deepEqual(calls.find((call) => call.source === 'frontiers').input, {
      windowStart: WINDOW_START, asOf: AS_OF, transferVersion: VERSION,
    });
    assert.deepEqual(calls.find((call) => call.source === 'bounds').input, {
      windowStart: WINDOW_START, asOf: AS_OF,
      originBlock: '90', throughBlock: '110',
    });
    assert.deepEqual(calls.find((call) => call.source === 'scan').input, {
      tokenAddresses: [TOKEN], fromBlock: '100', throughBlock: '109',
      windowStart: WINDOW_START, asOf: AS_OF, classificationVersion: VERSION,
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
      'raw_transfer_partition_missing', 'swap_behind_as_of',
      'transfer_classification_unresolved', 'transfer_window_frontier_unverified',
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

  it('keeps a scan gap or unanchored time window incomplete', async () => {
    const gap = harness({ scans: [{ tokenAddress: TOKEN, scanProofReady: false,
      coverageReasons: ['transfer_scan_scope_gap'] }] });
    const [missing] = await gap.service.getWindowEvents({ classificationVersion: VERSION });
    assert.equal(missing.eventsComplete, false);
    assert.equal(missing.sourceCoverageVerified, false);
    assert.deepEqual(missing.coverageReasons, ['transfer_scan_scope_gap']);

    const bounds = harness({ bounds: { verified: false,
      reasons: ['transfer_window_boundary_unproven'] } });
    const [unanchored] = await bounds.service.getWindowEvents({ classificationVersion: VERSION });
    assert.equal(unanchored.eventsComplete, false);
    assert.deepEqual(unanchored.coverageReasons, ['transfer_window_boundary_unproven']);
    assert.equal(bounds.calls.some((call) => call.source === 'scan'), false);
  });

  it('does not certify events with unresolved transfer classifications', async () => {
    const { service } = harness({ classifications: [
      { tokenAddress: TOKEN, walletAddress: WALLET_A,
        rawRowsClassified: false, reasons: ['transfer_classification_unresolved'] },
      { tokenAddress: TOKEN, walletAddress: WALLET_B,
        rawRowsClassified: true, reasons: [] },
    ] });
    const [a, b] = await service.getWindowEvents({ classificationVersion: VERSION });
    assert.equal(a.sourceCoverageVerified, true);
    assert.equal(a.eventsComplete, false);
    assert.deepEqual(a.coverageReasons, ['transfer_classification_unresolved']);
    assert.equal(b.eventsComplete, true);
  });

  it('does not certify an orphaned event even with complete scan coverage', async () => {
    const { service } = harness({ events: [event(WALLET_A, {
      canonicalEventsVerified: false,
    })] });
    const [result] = await service.getWindowEvents({ classificationVersion: VERSION });
    assert.equal(result.sourceCoverageVerified, true);
    assert.equal(result.eventsComplete, false);
    assert.deepEqual(result.coverageReasons, ['window_event_canonicality_unverified']);
  });
});
