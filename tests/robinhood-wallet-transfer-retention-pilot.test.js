const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodWalletTransferRetentionPilot } = require(
  '../src/models/robinhood-wallet-transfer-retention-pilot'
);
const { CONFIRM_FLAG, main, parseArgs } = require(
  '../src/utils/drop-robinhood-wallet-transfer-retention-pilot'
);
const SAMPLED_DRAFT = require('../docs/robinhood-transfer-raw-pilot-2026-07-19-report.json');
const JULY18_DRAFT = require('../docs/robinhood-transfer-raw-pilot-2026-07-18-report.json');

const DAY = '2026-07-19';
const HASH = `0x${'7'.repeat(64)}`;
const REPORT = { day: DAY, watermarkVersion: '0', checkpointHash: HASH,
  archiveReplay: { status: 'matched', evidenceReference: 'archive-pilot-report-19' },
  approvedBy: 'operator', approvedAt: '2026-09-23T00:00:00Z' };
const INPUT = { day: DAY, expectedWatermarkVersion: '0', expectedCheckpointHash: HASH,
  pilotReport: REPORT, apply: true, confirmed: true };
const sampledReport = () => ({ ...SAMPLED_DRAFT,
  approvedBy: 'test-operator', approvedAt: '2026-09-23T00:00:00Z' });
const sampledInput = () => ({ ...INPUT, expectedCheckpointHash: SAMPLED_DRAFT.checkpointHash,
  pilotReport: sampledReport() });
const july18Input = () => ({ ...INPUT, day: JULY18_DRAFT.day,
  expectedWatermarkVersion: JULY18_DRAFT.watermarkVersion,
  expectedCheckpointHash: JULY18_DRAFT.checkpointHash,
  pilotReport: structuredClone(JULY18_DRAFT) });

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

  it('accepts only the approved, exact 12-exception sample manifest', async () => {
    let gateCalls = 0;
    const pilot = createRobinhoodWalletTransferRetentionPilot({
      gate: { withVerifiedPartition: async () => { gateCalls += 1; } },
    });
    await pilot.drop(sampledInput());
    assert.equal(gateCalls, 1);
    const changed = sampledReport();
    changed.archiveReplay = { ...changed.archiveReplay,
      exceptions: changed.archiveReplay.exceptions.map((item, index) => index === 0
        ? { ...item, logIndex: item.logIndex + 1 } : item) };
    for (const invalid of [
      { ...sampledReport(), archiveReplay: { ...SAMPLED_DRAFT.archiveReplay,
        status: 'matched_with_exceptions' } },
      { ...sampledReport(), archiveReplay: { ...SAMPLED_DRAFT.archiveReplay,
        receiptsMatched: 55 } },
      { ...sampledReport(), archiveReplay: { ...SAMPLED_DRAFT.archiveReplay,
        missingKinds: ['wallet_self'] } },
      changed,
      { ...SAMPLED_DRAFT },
    ]) await assert.rejects(pilot.drop({ ...sampledInput(), pilotReport: invalid }),
      /missing, mismatched or unapproved/);
    assert.equal(gateCalls, 1);
  });

  it('rechecks every approved self-transfer exception under the drop gate', async () => {
    const exceptions = SAMPLED_DRAFT.archiveReplay.exceptions;
    let checked = 0;
    const client = { query: async (sql, params) => {
      if (sql.includes('COUNT(*)::int AS events')) {
        return { rows: [{ events: 35, equal_endpoints: 35 }] };
      }
      if (sql.includes('SELECT block_number::text')) {
        const item = exceptions.find((entry) => entry.transactionHash === params[1]);
        checked += 1;
        return { rows: [{ block_number: String(item.blockNumber), block_hash: item.blockHash,
          transaction_index: item.transactionIndex, transfer_kind: 'wallet_self',
          classification_version: 'rh_transfer_v1', equal_endpoints: true }] };
      }
      if (sql.includes('pg_relation_filepath')) {
        return { rows: [{ heap_path: 'base/1/2', total_bytes: '4096' }] };
      }
      if (sql.includes('UPDATE robinhood_wallet_transfer_compaction_watermarks')) {
        return { rowCount: 1, rows: [{ version: '1' }] };
      }
      if (sql.includes('DROP TABLE')) return { rowCount: 0 };
      throw new Error('unexpected pilot query');
    } };
    const pilot = createRobinhoodWalletTransferRetentionPilot({ gate: {
      withVerifiedPartition: async (_input, action) => action(client, {
        day: DAY, partition: 'public.robinhood_token_transfer_events_2026_07_19',
        watermarkVersion: '0', checkpointHash: SAMPLED_DRAFT.checkpointHash,
      }),
    } });
    const result = await pilot.drop(sampledInput());
    assert.equal(checked, 12);
    assert.equal(result.dropped, true);
    const validQuery = client.query;
    client.query = async (sql, params) => {
      const response = await validQuery(sql, params);
      return sql.includes('SELECT block_number::text')
        && params[1] === exceptions[0].transactionHash
        ? { rows: [{ ...response.rows[0], transfer_kind: 'unknown' }] } : response;
    };
    await assert.rejects(pilot.drop(sampledInput()), /pilot exception changed/);
    client.query = async (sql) => sql.includes('COUNT(*)::int AS events')
      ? { rows: [{ events: 34, equal_endpoints: 34 }] }
      : assert.fail('should stop before checking exception rows');
    await assert.rejects(pilot.drop(sampledInput()), /wallet_self population changed/);
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

  it('accepts only the exact July 18 scoped exception and matching day flag', async () => {
    let gateCalls = 0;
    const pilot = createRobinhoodWalletTransferRetentionPilot({
      gate: { withVerifiedPartition: async (input) => {
        gateCalls += 1;
        assert.equal(input.day, '2026-07-18');
        assert.equal(input.expectedWatermarkVersion, '1');
      } },
    });
    await pilot.drop(july18Input());
    assert.equal(gateCalls, 1);
    for (const change of [
      (report) => { report.archiveReplay.status = 'matched'; },
      (report) => { report.archiveReplay.decisionMatches = 24; },
      (report) => { report.archiveReplay.walletSelfEqualEndpoints = 171; },
      (report) => { report.archiveReplay.exceptions[0].recipientCodeBytesAtEvent = 1; },
      (report) => { report.archiveReplay.exceptions[0].amountRaw = '1'; },
    ]) {
      const invalid = july18Input();
      change(invalid.pilotReport);
      await assert.rejects(pilot.drop(invalid), /missing, mismatched or unapproved/);
    }
    await assert.rejects(pilot.drop({ ...july18Input(), day: DAY }),
      /missing, mismatched or unapproved/);
    assert.equal(gateCalls, 1);

    const argv = ['--day=2026-07-18', '--expected-watermark-version=1',
      `--expected-checkpoint-hash=${JULY18_DRAFT.checkpointHash}`,
      '--pilot-report=docs/robinhood-transfer-raw-pilot-2026-07-18-report.json',
      '--apply', '--confirm-drop-robinhood-transfer-raw-2026-07-18'];
    assert.equal(parseArgs(argv).confirmed, true);
    assert.throws(() => parseArgs([...argv.slice(0, -1), CONFIRM_FLAG]), /pilot requires/);
  });
});
