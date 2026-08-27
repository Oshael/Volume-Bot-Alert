const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createRobinhoodPossibleBundleCalibrator } = require(
  '../src/services/robinhood-possible-bundle-calibrator'
);
const { main, parseArgs } = require(
  '../src/utils/calibrate-robinhood-possible-bundles'
);

const A = `0x${'1'.repeat(40)}`;
const B = `0x${'2'.repeat(40)}`;
const C = `0x${'3'.repeat(40)}`;

function group(memberCount, kind) {
  return { memberCount, evidenceJson: { connections: [{ kind }] } };
}

function members(count, connectionKind) {
  return Array.from({ length: count }, () => ({ connectionKind }));
}

describe('Robinhood possible-bundle threshold calibrator', () => {
  it('aggregates comparable metrics across bounded pages from one evidence load', async () => {
    const loads = [];
    const calibrator = createRobinhoodPossibleBundleCalibrator({
      source: {
        async countSeedTokens() { return 3; },
        async listSeedTokens({ afterToken }) {
          if (afterToken == null) return [A, B];
          if (afterToken === B) return [C];
          return [];
        },
        async loadSeedToken({ tokenAddress }) {
          loads.push(tokenAddress);
          return { ready: true, tokenAddress };
        },
      },
      materialize({ tokenAddress, minimumValueWei }) {
        if (minimumValueWei === '100' && tokenAddress !== A) {
          return { groups: [], members: [] };
        }
        if (minimumValueWei === '100') {
          return { groups: [group(6, 'member_funder')],
            members: members(6, 'direct_member_funding') };
        }
        return { groups: [group(2, 'common_funder')],
          members: members(2, 'connected_funding_ancestor') };
      },
    });
    const report = await calibrator.audit({
      runId: 1, thresholdsWei: ['100', '10', '10'], pageSize: 2,
      concurrency: 2, maxPages: 5,
    });

    assert.deepEqual(loads, [A, B, C]);
    assert.equal(report.pages, 2);
    assert.equal(report.candidateTokens, 3);
    assert.equal(report.totalCandidateTokens, 3);
    assert.equal(report.progressBps, 10_000);
    assert.equal(report.evaluatedTokens, 3);
    assert.equal(report.exhausted, true);
    assert.equal(report.blocked, false);
    assert.equal(report.nextToken, C);
    assert.deepEqual(report.thresholds[0], {
      minimumValueWei: '10', tokensWithGroups: 3, groups: 3, members: 6,
      connections: 3, maximumGroupMembers: 2,
      groupSizes: { two: 3, threeToFive: 0, sixPlus: 0 },
      connectionKinds: { memberFunder: 0, commonFunder: 3, connectedAncestor: 0 },
      memberKinds: { directMemberFunding: 0, connectedFundingAncestor: 6, mixed: 0 },
    });
    assert.equal(report.thresholds[1].tokensWithGroups, 1);
    assert.equal(report.thresholds[1].groupSizes.sixPlus, 1);
    assert.equal(report.thresholds[1].connectionKinds.memberFunder, 1);
  });

  it('fails closed on token errors or deferred evidence', async () => {
    const calibrator = createRobinhoodPossibleBundleCalibrator({
      source: {
        async countSeedTokens() { return 2; },
        async listSeedTokens() { return [A, B]; },
        async loadSeedToken({ tokenAddress }) {
          return tokenAddress === B
            ? { ready: false, reason: 'candidate_cap' }
            : { ready: true, tokenAddress };
        },
      },
      materialize() { throw new Error('invalid graph'); },
    });
    const report = await calibrator.audit({ runId: 1, thresholdsWei: ['10'] });
    assert.equal(report.blocked, true);
    assert.equal(report.nextToken, null);
    assert.equal(report.exhausted, false);
    assert.equal(report.retryAfterToken, null);
    assert.deepEqual(report.failedTokens, [{ tokenAddress: A, error: 'invalid graph' }]);
    assert.deepEqual(report.deferredTokens, [{ tokenAddress: B, reason: 'candidate_cap' }]);
  });

  it('requires explicit positive thresholds and bounded execution', async () => {
    const calibrator = createRobinhoodPossibleBundleCalibrator({
      source: { countSeedTokens: async () => 0,
        listSeedTokens: async () => [], loadSeedToken: async () => ({}) },
    });
    await assert.rejects(calibrator.audit({ runId: 1, thresholdsWei: [] }), /thresholdsWei/);
    await assert.rejects(calibrator.audit({
      runId: 1, thresholdsWei: ['0'], concurrency: 5,
    }), /positive integers/);
  });

  it('resumes cumulative metrics from the last completed page', async () => {
    const progress = [];
    const source = {
      async countSeedTokens() { return 3; },
      async listSeedTokens({ afterToken }) { return afterToken ? [C] : [A, B]; },
      async loadSeedToken({ tokenAddress }) { return { ready: true, tokenAddress }; },
    };
    const materialize = () => ({ groups: [group(2, 'common_funder')],
      members: members(2, 'connected_funding_ancestor') });
    const calibrator = createRobinhoodPossibleBundleCalibrator({
      source, materialize, now: () => 1_000,
    });
    const first = await calibrator.audit({ runId: 1, thresholdsWei: ['10'],
      pageSize: 2, maxPages: 1, onProgress: (value) => progress.push(value) });
    assert.equal(first.nextToken, B);
    assert.equal(first.exhausted, false);
    const resumed = await calibrator.audit({ runId: 1, thresholdsWei: ['10'],
      pageSize: 2, maxPages: 5, resume: first });
    assert.equal(progress.length, 1);
    assert.equal(resumed.pages, 2);
    assert.equal(resumed.evaluatedTokens, 3);
    assert.equal(resumed.thresholds[0].groups, 3);
    assert.equal(resumed.exhausted, true);
    await assert.rejects(calibrator.audit({ runId: 1, thresholdsWei: ['11'],
      pageSize: 2, maxPages: 5, resume: first }), /checkpoint does not match/);
  });
});

describe('Robinhood possible-bundle calibration command', () => {
  it('accepts central database variants and remains read-only', async () => {
    assert.throws(() => parseArgs([]), /run-id is required/);
    assert.throws(() => parseArgs(['--run-id=1']), /thresholds-wei is required/);
    assert.throws(() => parseArgs([
      '--run-id=1', '--thresholds-wei=10', '--max-pages=2',
    ]), /checkpoint-file is required/);
    const options = parseArgs([
      '--run-id=1', '--thresholds-wei=10,100', '--page-size=50', '--max-pages=10',
      '--checkpoint-file=/tmp/possible-bundle-test.json',
    ]);
    let received;
    let persisted;
    const expected = { mode: 'read-only', candidateTokens: 2, blocked: false };
    const report = await main([], {
      options, env: { POSTGRES_URL: 'postgres://test' }, logger: { log() {} },
      readCheckpoint: () => null, writeCheckpoint: (_, value) => { persisted = value; },
      calibrator: { async audit(input) { received = input; return expected; } },
    });
    assert.equal(report, expected);
    assert.deepEqual(received.thresholdsWei, ['10', '100']);
    assert.equal(received.pageSize, 50);
    assert.equal(received.maxPages, 10);
    assert.equal(received.resume, null);
    assert.equal(persisted, expected);
  });
});
