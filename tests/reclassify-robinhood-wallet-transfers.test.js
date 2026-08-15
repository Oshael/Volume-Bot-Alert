const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runRobinhoodWalletTransferReclassification,
} = require('../src/services/robinhood-wallet-transfer-reclassification');
const {
  CONFIRM_FLAG, buildRuntime, main, parseArgs,
} = require('../src/utils/reclassify-robinhood-wallet-transfers');

const DAY = '2099-10-01';
const ALICE = `0x${'1'.repeat(40)}`;
const BOB = `0x${'2'.repeat(40)}`;

function candidate() {
  const role = {
    endpointRole: 'wallet', evidenceSource: 'pc_archive', evidenceBlock: '100',
    evidenceBlockHash: `0x${'3'.repeat(64)}`,
    resolverVersion: 'rh_endpoint_v1', observedFromBlock: '100', observedThroughBlock: '100',
  };
  return {
    blockNumber: '100', blockHash: `0x${'3'.repeat(64)}`,
    blockTime: `${DAY}T00:00:00.000Z`, transactionHash: `0x${'4'.repeat(64)}`,
    transactionIndex: '0', logIndex: '1', tokenAddress: `0x${'5'.repeat(40)}`,
    fromWallet: ALICE, toWallet: BOB, amountRaw: '25', transferKind: 'unknown',
    classificationVersion: 'rh_transfer_v1', fromRoleEvidence: role, toRoleEvidence: role,
  };
}

function harness() {
  const calls = { applied: [], context: [] };
  return {
    calls,
    deps: {
      repository: {
        listCandidates: async () => [candidate()],
        applyTransition: async (transition) => {
          calls.applied.push(transition);
          return { applied: true };
        },
      },
      source: { loadBackfillRangeContext: async (input) => {
        calls.context.push(input);
        return {
          ready: true, swapCoverageComplete: true, swaps: [], poolAddresses: [],
          routerAddresses: [], contractAddresses: [], walletAddresses: [ALICE, BOB],
        };
      } },
    },
  };
}

describe('Robinhood wallet transfer reclassification command', () => {
  it('requires a UTC day, bounded limit and long confirmation flag', () => {
    assert.deepEqual(parseArgs([`--day=${DAY}`]), { confirm: false, day: DAY, limit: 100 });
    assert.deepEqual(parseArgs([`--day=${DAY}`, '--limit=1000', CONFIRM_FLAG]), {
      confirm: true, day: DAY, limit: 1000,
    });
    assert.throws(() => parseArgs([]), /day must be provided/);
    assert.throws(() => parseArgs([`--day=${DAY}`, '--limit=1001']), /between 1 and 1000/);
    assert.throws(() => parseArgs([`--day=${DAY}`, '--commit']), /unknown argument/);
  });

  it('uses full classification context and writes only after confirmation', async () => {
    const test = harness();
    const dryRun = await runRobinhoodWalletTransferReclassification(test.deps, {
      day: DAY, limit: 10,
    });
    assert.deepEqual(dryRun, {
      status: 'dry-run', day: DAY, candidates: 1, actionable: 1,
      skipped: 0, firstBlock: '100', lastBlock: '100',
      skippedReasons: {}, classifications: { wallet_transfer: 1 },
    });
    assert.equal(test.calls.applied.length, 0);
    assert.deepEqual(test.calls.context[0].endpointAddresses, [ALICE, BOB]);
    const confirmed = await runRobinhoodWalletTransferReclassification(test.deps, {
      day: DAY, limit: 10, commit: true,
    });
    assert.equal(confirmed.status, 'confirmed');
    assert.deepEqual(confirmed.outcomes, {
      applied: 1, alreadyApplied: 0, conflicts: 0, notFound: 0,
    });
    assert.equal(test.calls.applied[0].decisionReason, 'known_wallet_pair');
  });

  it('builds a PostgreSQL-only runtime and keeps main dry-run by default', async () => {
    const created = {};
    const runtime = await buildRuntime({
      env: { DATABASE_URL: 'postgres://tunnel' },
      database: { query: async () => ({ rows: [{
        events: 'events', roles: 'roles', audits: 'audits', edges: 'edges',
        evidence: 'evidence', summaries: 'summaries', watermarks: 'watermarks',
      }] }) },
      repositoryFactory: ({ database }) => { created.repository = database; return {}; },
      sourceFactory: ({ database }) => { created.source = database; return {}; },
    });
    assert.deepEqual(Object.keys(runtime).sort(), ['repository', 'source']);
    assert.equal(created.repository, created.source);
    await assert.rejects(buildRuntime({
      env: { DATABASE_URL: 'postgres://tunnel' }, database: { query: async () => ({ rows: [] }) },
    }), /schema not ready/);
    const runs = [];
    const deps = {
      runtime, logger: { log: () => {} },
      runReclassification: async (_runtime, input) => {
        runs.push(input);
        return { status: input.commit ? 'confirmed' : 'dry-run' };
      },
    };
    assert.equal((await main([`--day=${DAY}`], deps)).mode, 'dry-run');
    assert.equal((await main([`--day=${DAY}`, CONFIRM_FLAG], deps)).mode, 'confirmed');
    assert.deepEqual(runs.map(({ commit }) => commit), [false, true]);
  });
});
