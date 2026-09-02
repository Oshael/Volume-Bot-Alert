'use strict';

const RANGE_ERROR = 'V4 liquidity range update conflicted or became negative';

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

// The input is in on-chain order. A failed V4 predecessor fences its whole
// remaining pool suffix, even across recursive bisections; other pools proceed.
async function persistWithFailureIsolation(items, commit) {
  if (!items.length) return { processed: [], failed: [] };
  try {
    await commit(items);
    return { processed: items, failed: [] };
  } catch (error) {
    if (items.length === 1 || !commitErrorMessage(error).includes(RANGE_ERROR)) {
      return { processed: [], failed: items.map((item) => ({ item, error })) };
    }
    const middle = Math.floor(items.length / 2);
    const left = await persistWithFailureIsolation(items.slice(0, middle), commit);
    const { ready, blocked } = splitBlockedSuffix(items.slice(middle), left.failed);
    const right = await persistWithFailureIsolation(ready, commit);
    return {
      processed: [...left.processed, ...right.processed],
      failed: [...left.failed, ...blocked, ...right.failed],
    };
  }
}

module.exports = { commitErrorMessage, persistWithFailureIsolation };
