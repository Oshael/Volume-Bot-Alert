'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalHeadRunner,
} = require('../src/services/robinhood-canonical-head-runner');

function row(domain, logIndex) {
  return {
    domain, block_hash: `0x${'1'.repeat(64)}`, block_number: '100',
    transaction_hash: `0x${'2'.repeat(64)}`, transaction_index: '0',
    log_index: logIndex, address: `0x${'3'.repeat(40)}`,
    topics: [`0x${'4'.repeat(64)}`], data: '0x',
    block_timestamp: new Date('2026-09-03T20:00:00Z'), attempt_count: 1,
  };
}
function entry(log) {
  return {
    log, capture: {
      protocol: 'uniswap-v3', marketKey: 'market', evidenceVersion: 2, evidence: { ok: true },
    },
  };
}

describe('Robinhood canonical head runner', () => {
  it('processes discovery before market and settles the whole block after append', async () => {
    const calls = []; let settlement; let claimInput;
    const rows = [row('discovery', 2), row('market', 3), row('market', 4)];
    const runner = createRobinhoodCanonicalHeadRunner({
      outbox: {
        reclaimExpiredLeases: async () => 1,
        claimNextBlock: async (input) => { claimInput = input; return rows; },
        settle: async (input) => {
          calls.push('settle'); settlement = input;
          return { completed: input.complete.length, blocked: 0, retried: 0 };
        },
      },
      pipeline: {
        processDiscoveryRange: async (logs) => { calls.push('discovery'); return logs.map(entry); },
        processMarketRange: async (logs) => { calls.push('market'); return [entry(logs[0])]; },
      },
      headRepository: { appendCaptureEntries: async ({ entries }) => {
        calls.push('append');
        return { insertedCaptures: entries.length, duplicateCaptures: 0 };
      } },
    });
    assert.deepEqual(await runner.runOnce(), {
      reclaimed: 1, blockNumber: '100', throughBlock: '100', blocks: 1,
      claimed: 3, inserted: 2, duplicates: 0,
      ignored: 1, completed: 3, blocked: 0, retried: 0,
    });
    assert.deepEqual(calls, ['discovery', 'market', 'append', 'settle']);
    assert.equal(claimInput.maxBlocks, 16);
    assert.deepEqual(settlement.complete.map((item) => item.domain), [
      'discovery', 'market', 'market',
    ]);
  });

  it('retries the entire block when either domain fails', async () => {
    let settlement;
    const runner = createRobinhoodCanonicalHeadRunner({
      outbox: {
        reclaimExpiredLeases: async () => 0,
        claimNextBlock: async () => [row('discovery', 2), row('market', 3)],
        settle: async (input) => {
          settlement = input; return { completed: 0, blocked: 0, retried: 2 };
        },
      },
      pipeline: {
        processDiscoveryRange: async () => [],
        processMarketRange: async () => { throw new Error('state unavailable'); },
      },
      headRepository: { appendCaptureEntries: async () => assert.fail('must not append') },
    });
    const result = await runner.runOnce();
    assert.equal(result.blocks, 1);
    assert.equal(result.retried, 2);
    assert.deepEqual(settlement.retry.map((item) => item.domain), ['discovery', 'market']);
  });
});
