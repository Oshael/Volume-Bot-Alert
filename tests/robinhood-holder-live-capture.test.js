const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodHolderLiveCapture } = require('../src/services/robinhood-holder-live-capture');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;

describe('Robinhood holder global live capture', () => {
  it('captures one confirmed global range with optimistic cursor continuity', async () => {
    const calls = [];
    const bootstrap = { seedNewTokens: async (input) => {
      calls.push(['seed', input]);
      return [{ ledgerStatus: 'backfilling' }];
    } };
    const ledger = {
      getCursor: async () => ({
        nextBlock: '103', checkpointBlock: '102', checkpointHash: HASH,
        journalFloorBlock: '90', version: 4,
      }),
      listJournalBlockCheckpoints: async () => [],
      getLiveCaptureScope: async () => ({
        tokenAddresses: [TOKEN],
        coverageAudit: { scopedTokens: 1, missingTailTokens: 0, incoherentTailTokens: 0 },
      }),
      quarantineMalformedToken: async () => { throw new Error('unexpected quarantine'); },
      appendCapturedRange: async (input) => {
        calls.push(['append', input]);
        return { insertedTransfers: 1, duplicateTransfers: 0, cursorVersion: 5 };
      },
      rewindOrphanedRange: async () => { throw new Error('unexpected rewind'); },
    };
    const transfer = { tokenAddress: TOKEN };
    const reader = {
      getSafeHead: async (confirmations) => {
        calls.push(['head', confirmations]);
        return { head: '117', safeHead: '105', confirmations };
      },
      matchesCheckpoint: async (checkpoint) => {
        calls.push(['checkpoint', checkpoint]);
        return true;
      },
      readGlobalRange: async (input) => {
        calls.push(['read', input]);
        return {
          fromBlock: '103', toBlock: '105', nextBlock: '106', scopeTokens: 1,
          checkpoint: { number: '105', hash: HASH }, transfers: [transfer],
          telemetry: {
            requests: 1, splits: 0, observedLogs: 2, ignoredLogs: 1,
            rawTransfersObserved: 2, trackedTransfers: 1,
            legacyExtraTransfers: 0, scopeTokens: 1,
          },
        };
      },
    };
    const result = await createRobinhoodHolderLiveCapture({
      bootstrap, ledger, reader,
    }).captureOnce({
      admittedAfter: '2026-08-10T00:00:00Z', seedLimit: 25,
      maxInitialGapBlocks: 20_000,
    });

    assert.equal(result.status, 'captured');
    assert.equal(result.cursorVersion, 5);
    assert.equal(result.bufferedSeededTokens, 0);
    assert.deepEqual(result.telemetry.tailCoverage, {
      scopedTokens: 1, missingTailTokens: 0, incoherentTailTokens: 0,
    });
    assert.deepEqual(calls, [
      ['head', 12],
      ['checkpoint', { number: '102', hash: HASH }],
      ['read', {
        tokenAddresses: [TOKEN], captureAllTransfers: true,
        fromBlock: '103', toBlock: '105',
      }],
      ['append', {
        transfers: [transfer],
        cursor: {
          rangeStart: '103', nextBlock: '106', safeHead: '105', expectedVersion: 4,
          bufferedAllTransfers: true,
          checkpoint: { number: '105', hash: HASH },
        },
      }],
      ['seed', {
        admittedAfter: '2026-08-10T00:00:00Z', limit: 25,
        maxInitialGapBlocks: 20_000,
      }],
    ]);
  });

  it('initializes at safe head and fails closed when a persisted checkpoint is orphaned', async () => {
    const appended = [];
    const reader = {
      getSafeHead: async () => ({ head: '112', safeHead: '100', confirmations: 12 }),
      matchesCheckpoint: async () => false,
      readGlobalRange: async (input) => ({
        ...input, nextBlock: '101', scopeTokens: 0,
        checkpoint: { number: '100', hash: HASH }, transfers: [],
        telemetry: { requests: 0, splits: 0, observedLogs: 0, ignoredLogs: 0 },
      }),
    };
    const initialLedger = {
      getCursor: async () => null,
      listJournalBlockCheckpoints: async () => [],
      getLiveCaptureScope: async () => ({
        tokenAddresses: [],
        coverageAudit: { scopedTokens: 0, missingTailTokens: 0, incoherentTailTokens: 0 },
      }),
      quarantineMalformedToken: async () => { throw new Error('unexpected quarantine'); },
      appendCapturedRange: async (input) => {
        appended.push(input);
        return { insertedTransfers: 0, duplicateTransfers: 0, cursorVersion: 0 };
      },
      rewindOrphanedRange: async () => { throw new Error('unexpected rewind'); },
    };
    const initialized = await createRobinhoodHolderLiveCapture({
      ledger: initialLedger, reader,
    }).captureOnce();
    assert.deepEqual([initialized.fromBlock, initialized.toBlock], ['100', '100']);
    assert.equal(appended[0].cursor.expectedVersion, null);

    const orphaned = await createRobinhoodHolderLiveCapture({
      ledger: { ...initialLedger, getCursor: async () => ({
        nextBlock: '101', checkpointBlock: '100', checkpointHash: HASH,
        journalFloorBlock: '90', version: 0,
      }) },
      reader,
    }).captureOnce();
    assert.deepEqual(orphaned, {
      status: 'reorg-unrecoverable', reason: 'canonical-evidence-unavailable',
      nextBlock: '101', checkpointBlock: '100', journalFloorBlock: '90',
      cursorVersion: 0, checkedCheckpoints: 0,
    });
    assert.equal(appended.length, 1);
  });

  it('finds the latest canonical journal evidence and rewinds atomically', async () => {
    const calls = [];
    const ledger = {
      getCursor: async () => ({
        nextBlock: '101', checkpointBlock: '100', checkpointHash: HASH,
        journalFloorBlock: '90', version: 7,
      }),
      listJournalBlockCheckpoints: async (input) => {
        calls.push(['candidates', input]);
        return [
          { number: '90', hash: HASH },
          { number: '95', hash: HASH_B },
          { number: '99', hash: HASH_C },
        ];
      },
      rewindOrphanedRange: async (input) => {
        calls.push(['rewind', input]);
        return { status: 'rewound', revertedEvents: 3, cursorVersion: 8 };
      },
      getLiveCaptureScope: async () => ({
        tokenAddresses: [],
        coverageAudit: { scopedTokens: 0, missingTailTokens: 0, incoherentTailTokens: 0 },
      }),
      quarantineMalformedToken: async () => { throw new Error('unexpected quarantine'); },
      appendCapturedRange: async () => { throw new Error('unexpected capture'); },
    };
    const reader = {
      getSafeHead: async () => ({ head: '112', safeHead: '100', confirmations: 12 }),
      matchesCheckpoint: async (checkpoint) => {
        calls.push(['checkpoint', checkpoint.number]);
        return BigInt(checkpoint.number) <= 95n;
      },
      readGlobalRange: async () => { throw new Error('unexpected read'); },
    };
    const result = await createRobinhoodHolderLiveCapture({ ledger, reader }).captureOnce();

    assert.deepEqual(result, {
      status: 'reorg-rewound', revertedEvents: 3, cursorVersion: 8,
      orphanedCheckpointBlock: '100', canonicalCheckpointBlock: '95',
      checkedCheckpoints: 2,
    });
    assert.deepEqual(calls, [
      ['checkpoint', '100'],
      ['candidates', { fromBlock: '90', toBlock: '99' }],
      ['checkpoint', '95'], ['checkpoint', '99'],
      ['rewind', {
        nextBlock: '96', safeHead: '100', expectedVersion: 7,
        checkpoint: { number: '95', hash: HASH_B },
        requireCanonicalCheckpoint: false,
      }],
    ]);
  });

  it('finds a canonical ancestor across blocks without holder transfers', async () => {
    const calls = [];
    const ledger = {
      getCursor: async () => ({
        nextBlock: '101', checkpointBlock: '100', checkpointHash: HASH,
        journalFloorBlock: '90', version: 7,
      }),
      listJournalBlockCheckpoints: async () => {
        throw new Error('holder transfer journal must not source canonical checkpoints');
      },
      listCanonicalBlockCheckpoints: async (input) => {
        calls.push(['candidates', input]);
        return [
          { number: '98', hash: HASH_B },
          { number: '99', hash: HASH_C },
        ];
      },
      getLiveCaptureScope: async () => { throw new Error('unexpected scope read'); },
      quarantineMalformedToken: async () => { throw new Error('unexpected quarantine'); },
      appendCapturedRange: async () => { throw new Error('unexpected capture'); },
      rewindOrphanedRange: async (input) => {
        calls.push(['rewind', input]);
        return { status: 'rewound', revertedEvents: 0, cursorVersion: 8 };
      },
    };
    const reader = {
      getSafeHead: async () => ({ safeHead: '100' }),
      matchesCheckpoint: async ({ number }) => {
        calls.push(['checkpoint', number]);
        return BigInt(number) <= 98n;
      },
      readGlobalRange: async () => { throw new Error('unexpected read'); },
    };
    const result = await createRobinhoodHolderLiveCapture({
      ledger, reader, sourceMode: 'canonical_journal',
    }).captureOnce();

    assert.equal(result.status, 'reorg-rewound');
    assert.equal(result.canonicalCheckpointBlock, '98');
    assert.equal(result.revertedEvents, 0);
    assert.deepEqual(calls, [
      ['checkpoint', '100'],
      ['candidates', { fromBlock: '90', toBlock: '100', checkpointHash: HASH }],
      ['checkpoint', '98'], ['checkpoint', '99'],
      ['rewind', {
        nextBlock: '99', safeHead: '100', expectedVersion: 7,
        checkpoint: { number: '98', hash: HASH_B },
        requireCanonicalCheckpoint: true,
      }],
    ]);
  });

  it('bounds canonical ancestor search and fails closed below retained evidence', async () => {
    let requested;
    const ledger = {
      getCursor: async () => ({
        nextBlock: '2001', checkpointBlock: '2000', checkpointHash: HASH,
        journalFloorBlock: '1', version: 7,
      }),
      listJournalBlockCheckpoints: async () => {
        throw new Error('unexpected holder journal read');
      },
      listCanonicalBlockCheckpoints: async (input) => {
        requested = input;
        return [{ number: '1000', hash: HASH_B }];
      },
      getLiveCaptureScope: async () => { throw new Error('unexpected scope read'); },
      quarantineMalformedToken: async () => { throw new Error('unexpected quarantine'); },
      appendCapturedRange: async () => { throw new Error('unexpected capture'); },
      rewindOrphanedRange: async () => { throw new Error('unexpected rewind'); },
    };
    const reader = {
      getSafeHead: async () => ({ safeHead: '2000' }),
      matchesCheckpoint: async () => false,
      readGlobalRange: async () => { throw new Error('unexpected read'); },
    };
    const result = await createRobinhoodHolderLiveCapture({
      ledger, reader, sourceMode: 'canonical_journal',
    }).captureOnce();

    assert.deepEqual(requested, {
      fromBlock: '1000', toBlock: '2000', checkpointHash: HASH,
    });
    assert.equal(result.status, 'reorg-unrecoverable');
    assert.equal(result.reason, 'canonical-evidence-unavailable');
  });

  it('recaptures a shallow canonical reorg once after rewind', async () => {
    let cursor = {
      nextBlock: '101', checkpointBlock: '100', checkpointHash: HASH,
      journalFloorBlock: '90', version: 7,
    };
    let appends = 0;
    const ledger = {
      getCursor: async () => cursor,
      listJournalBlockCheckpoints: async () => { throw new Error('unexpected journal read'); },
      listCanonicalBlockCheckpoints: async () => [{ number: '99', hash: HASH_B }],
      rewindOrphanedRange: async () => {
        cursor = { ...cursor, nextBlock: '100', checkpointBlock: '99',
          checkpointHash: HASH_B, version: 8 };
        return { status: 'rewound', revertedEvents: 1, cursorVersion: 8 };
      },
      getLiveCaptureScope: async () => ({ tokenAddresses: [], coverageAudit: {} }),
      quarantineMalformedToken: async () => { throw new Error('unexpected quarantine'); },
      appendCapturedRange: async () => {
        appends += 1;
        cursor = { ...cursor, nextBlock: '101', checkpointBlock: '100',
          checkpointHash: HASH_C, version: 9 };
        return { insertedTransfers: 0, cursorVersion: 9 };
      },
    };
    const reader = {
      getSafeHead: async () => ({ safeHead: '100' }),
      matchesCheckpoint: async ({ number, hash }) => (
        number === '99' || (number === '100' && hash === HASH_C)
      ),
      readGlobalRange: async () => ({
        fromBlock: '100', toBlock: '100', nextBlock: '101',
        checkpoint: { number: '100', hash: HASH_C },
        scopeTokens: 0, transfers: [], telemetry: {},
      }),
    };
    const capture = createRobinhoodHolderLiveCapture({
      ledger, reader, sourceMode: 'canonical_journal',
    });
    assert.equal((await capture.captureOnce()).status, 'reorg-rewound');
    assert.equal((await capture.captureOnce()).status, 'captured');
    assert.equal((await capture.captureOnce()).status, 'idle');
    assert.equal(appends, 1);
  });

  it('quarantines one malformed tracked token without advancing the live cursor', async () => {
    const calls = [];
    const invalid = new Error('Transfer log topics are invalid');
    invalid.code = 'holder_transfer_invalid_log';
    invalid.tokenAddress = TOKEN;
    const ledger = {
      getCursor: async () => ({
        nextBlock: '103', checkpointBlock: '102', checkpointHash: HASH,
        journalFloorBlock: '90', version: 4,
      }),
      listJournalBlockCheckpoints: async () => [],
      getLiveCaptureScope: async () => ({
        tokenAddresses: [TOKEN],
        coverageAudit: { scopedTokens: 1, missingTailTokens: 1, incoherentTailTokens: 0 },
      }),
      appendCapturedRange: async () => { throw new Error('unexpected capture'); },
      rewindOrphanedRange: async () => { throw new Error('unexpected rewind'); },
      quarantineMalformedToken: async (input) => {
        calls.push(input);
        return {
          status: 'quarantined', tokenAddress: TOKEN, priorStatus: 'live',
          version: '8', deletedBalances: 2, deletedJournalEvents: 3,
          excludedCohortTokens: 0,
        };
      },
    };
    const reader = {
      getSafeHead: async () => ({ head: '117', safeHead: '105', confirmations: 12 }),
      matchesCheckpoint: async () => true,
      readGlobalRange: async () => { throw invalid; },
    };

    const result = await createRobinhoodHolderLiveCapture({ ledger, reader }).captureOnce();

    assert.deepEqual(result, {
      status: 'malformed-token-quarantined', tokenAddress: TOKEN, priorStatus: 'live',
      version: '8', deletedBalances: 2, deletedJournalEvents: 3,
      excludedCohortTokens: 0, nextBlock: '103', safeHead: '105',
    });
    assert.deepEqual(calls, [{ tokenAddress: TOKEN }]);
  });
});
