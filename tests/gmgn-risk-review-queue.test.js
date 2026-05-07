const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const queue = require('../src/services/gmgn-risk-review-queue');

const TOKEN_A = 'So11111111111111111111111111111111111111112';
const TOKEN_B = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

describe('gmgn risk review queue', () => {
  beforeEach(() => {
    queue.stop();
    queue.clear();
  });

  it('dedupes queued addresses and processes within token limit', async () => {
    const processed = [];

    assert.equal(queue.enqueue({ address: TOKEN_A }).queued, true);
    assert.equal(queue.enqueue({ address: TOKEN_A }).reason, 'already-queued');
    assert.equal(queue.enqueue({ address: TOKEN_B }).queued, true);

    const result = await queue.runOnce({
      tokenLimit: 1,
      processor: async (task) => {
        processed.push(task.address);
        return { passed: true };
      },
    });
    const status = queue.getStatus();

    assert.deepEqual(processed, [TOKEN_A]);
    assert.equal(result.processed, 1);
    assert.equal(status.queuedCount, 1);
    assert.equal(status.freshPassedCount, 1);
    assert.equal(queue.hasFreshPassedReview(TOKEN_A), true);
  });

  it('skips enqueue when a token has a fresh passed review', async () => {
    queue.markPassed(TOKEN_A, { passedTtlMs: 60000 });

    const result = queue.enqueue({ address: TOKEN_A });

    assert.equal(result.queued, false);
    assert.equal(result.reason, 'fresh-passed');
    assert.equal(queue.getStatus().queuedCount, 0);
  });
});
