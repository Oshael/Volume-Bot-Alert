'use strict';

const RANGE_ERROR = 'V4 liquidity range update conflicted or became negative';
const MAX_COMMIT_BATCH_SIZE = 2000;

function commitErrorMessage(error) {
  return String(error?.message || error).slice(0, 200);
}

function v4Pool(item) {
  return item.row.protocol === 'uniswap-v4' ? item.row.market_key : null;
}

function splitBlockedSuffix(items, failures) {
  const failedPools = new Map(failures
    .filter(({ item }) => v4Pool(item))
    .map(({ item, error }) => [v4Pool(item), error]));
  const ready = [];
  const blocked = [];
  for (const item of items) {
    const error = failedPools.get(v4Pool(item));
    if (error) blocked.push({ item, error });
    else ready.push(item);
  }
  return { ready, blocked };
}

async function persistParts(items, commit, middle) {
  const left = await persistWithFailureIsolation(items.slice(0, middle), commit);
  const remaining = items.slice(middle);
  // Database/transport errors must not turn a large claim into repeated writes
  // against an unavailable backend. Previously committed prefixes remain valid.
  const transient = left.failed.find(({ error }) => !commitErrorMessage(error).includes(RANGE_ERROR));
  if (transient) return {
    processed: left.processed,
    failed: [...left.failed, ...remaining.map((item) => ({ item, error: transient.error }))],
  };
  const { ready, blocked } = splitBlockedSuffix(remaining, left.failed);
  const right = await persistWithFailureIsolation(ready, commit);
  return {
    processed: [...left.processed, ...right.processed],
    failed: [...left.failed, ...blocked, ...right.failed],
  };
}

// The input is in on-chain order. Large claims commit bounded sequential parts.
// A failed V4 predecessor fences its whole remaining pool suffix, across both
// transaction boundaries and recursive bisections; other pools may proceed.
async function persistWithFailureIsolation(items, commit) {
  if (!items.length) return { processed: [], failed: [] };
  if (items.length > MAX_COMMIT_BATCH_SIZE) {
    return persistParts(items, commit, MAX_COMMIT_BATCH_SIZE);
  }
  try {
    await commit(items);
    return { processed: items, failed: [] };
  } catch (error) {
    if (items.length === 1 || !commitErrorMessage(error).includes(RANGE_ERROR)) {
      return { processed: [], failed: items.map((item) => ({ item, error })) };
    }
    return persistParts(items, commit, Math.floor(items.length / 2));
  }
}

module.exports = { commitErrorMessage, persistWithFailureIsolation };
