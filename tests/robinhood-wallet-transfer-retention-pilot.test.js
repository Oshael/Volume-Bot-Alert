const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodWalletTransferRetentionPilot } = require(
  '../src/models/robinhood-wallet-transfer-retention-pilot'
);
const { CONFIRM_FLAG, main, parseArgs } = require(
  '../src/utils/drop-robinhood-wallet-transfer-retention-pilot'
);

const DAY = '2026-07-19';
const HASH = `0x${'7'.repeat(64)}`;
const REPORT = { day: DAY, watermarkVersion: '0', checkpointHash: HASH,
  archiveReplay: { status: 'matched', evidenceReference: 'archive-pilot-report-19' },
  approvedBy: 'operator', approvedAt: '2026-09-23T00:00:00Z' };
const INPUT = { day: DAY, expectedWatermarkVersion: '0', expectedCheckpointHash: HASH,
  pilotReport: REPORT, apply: true, confirmed: true };

describe('Robinhood transfer retention pilot command', () => {
  it('requires an exact day, apply, approval and matching parity report', async () => {
    let gateCalls = 0;
    const pilot = createRobinhoodWalletTransferRetentionPilot({
      gate: { withVerifiedPartition: async () => { gateCalls += 1; } },
    });
    for (const invalid of [
      { ...INPUT, day: '2026-07-18' },
      { ...INPUT, apply: false },
      { ...INPUT, confirmed: false },
      { ...INPUT, pilotReport: { ...REPORT, checkpointHash: `0x${'8'.repeat(64)}` } },
      { ...INPUT, pilotReport: { ...REPORT, archiveReplay: { status: 'matched' } } },
      { ...INPUT, pilotReport: { ...REPORT, approvedBy: '' } },
    ]) await assert.rejects(pilot.drop(invalid));
    assert.equal(gateCalls, 0);
  });

  it('rejects a checkpoint changed inside the transaction', async () => {
    const pilot = createRobinhoodWalletTransferRetentionPilot({
      gate: { withVerifiedPartition: async (_input, action) => action({
        query: async () => { throw new Error('must not query'); },
      }, { day: DAY, partition: 'public.robinhood_token_transfer_events_2026_07_19',
        watermarkVersion: '0', checkpointHash: `0x${'8'.repeat(64)}` }) },
    });
    await assert.rejects(pilot.drop(INPUT), /checkpoint changed/);
  });

  it('parses the exact pilot flags and passes the approved report to the executor', async () => {
    const argv = [`--day=${DAY}`, '--expected-watermark-version=0',
      `--expected-checkpoint-hash=${HASH}`, '--pilot-report=/tmp/pilot.json',
      '--apply', CONFIRM_FLAG];
    assert.deepEqual(parseArgs(argv), { day: DAY, expectedWatermarkVersion: '0',
      expectedCheckpointHash: HASH, pilotReportPath: '/tmp/pilot.json',
      apply: true, confirmed: true });
    assert.throws(() => parseArgs(argv.filter((value) => value !== CONFIRM_FLAG)),
      /pilot requires/);
    assert.throws(() => parseArgs([...argv, '--force']), /unknown argument/);
    const result = await main(argv, {
      readFile: () => JSON.stringify(REPORT), logger: { log() {} },
      pilotFactory: () => ({ drop: async (input) => {
        assert.deepEqual(input.pilotReport, REPORT);
        return { dropped: true };
      } }),
    });
    assert.deepEqual(result, { dropped: true });
  });
});
