const {
  createRobinhoodPossibleBundleSource,
} = require('../models/robinhood-possible-bundle-source');
const {
  createRobinhoodPossibleBundleSnapshotRepository,
} = require('../models/robinhood-possible-bundle-snapshot');
const {
  materializePossibleBundles,
} = require('./robinhood-possible-bundle-materializer');

function integer(value, fallback, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function positive(value, label) {
  const normalized = String(value ?? '');
  if (!/^\d+$/.test(normalized) || BigInt(normalized) < 1n) {
    throw new Error(`${label} must be positive`);
  }
  return normalized;
}

function createRobinhoodPossibleBundleRunner(deps = {}) {
  const source = deps.source || createRobinhoodPossibleBundleSource(deps);
  const snapshots = deps.snapshots || createRobinhoodPossibleBundleSnapshotRepository(deps);
  const materialize = deps.materialize || materializePossibleBundles;
  if (typeof source?.listSeedTokens !== 'function'
      || typeof source?.loadSeedToken !== 'function'
      || typeof snapshots?.replaceSnapshot !== 'function') {
    throw new TypeError('possible bundle runner dependencies are invalid');
  }

  async function materializeToken(tokenAddress, policy) {
    const evidence = await source.loadSeedToken({
      runId: policy.runId, tokenAddress,
    });
    if (!evidence.ready) return { status: 'deferred', reason: evidence.reason,
      groups: 0, members: 0 };
    const snapshot = materialize({ ...evidence,
      minimumValueWei: policy.minimumValueWei });
    const stored = await snapshots.replaceSnapshot(snapshot);
    return { ...stored, groups: snapshot.groups.length, members: snapshot.members.length };
  }

  async function runPage(input = {}) {
    const policy = Object.freeze({
      runId: String(integer(input.runId, null, Number.MAX_SAFE_INTEGER, 'runId')),
      minimumValueWei: positive(input.minimumValueWei, 'minimumValueWei'),
    });
    const limit = integer(input.limit, 25, 100, 'limit');
    const concurrency = integer(input.concurrency, 2, 4, 'concurrency');
    const tokens = await source.listSeedTokens({
      runId: policy.runId, afterToken: input.afterToken || null, limit,
    });
    const totals = { completed: 0, deferred: 0, failed: 0, groups: 0, members: 0,
      deferredTokens: [], failedTokens: [] };
    for (let offset = 0; offset < tokens.length; offset += concurrency) {
      const batch = tokens.slice(offset, offset + concurrency);
      const settled = await Promise.allSettled(batch
        .map((tokenAddress) => materializeToken(tokenAddress, policy)));
      for (const [index, result] of settled.entries()) {
        if (result.status === 'rejected') {
          totals.failed += 1;
          totals.failedTokens.push(Object.freeze({ tokenAddress: batch[index],
            error: String(result.reason?.message || result.reason) }));
        } else if (result.value.status === 'deferred') {
          totals.deferred += 1;
          totals.deferredTokens.push(Object.freeze({ tokenAddress: batch[index],
            reason: result.value.reason || 'unknown' }));
        }
        else {
          totals.completed += 1;
          totals.groups += result.value.groups;
          totals.members += result.value.members;
        }
      }
    }
    const pageEndToken = tokens.at(-1) || null;
    const blocked = totals.failed > 0 || totals.deferred > 0;
    return Object.freeze({ mode: 'shadow', ...policy, candidates: tokens.length, ...totals,
      pageAfterToken: input.afterToken || null, pageEndToken, blocked,
      nextToken: blocked ? null : pageEndToken, exhausted: !blocked && tokens.length < limit });
  }

  return Object.freeze({ runPage });
}

module.exports = { createRobinhoodPossibleBundleRunner };
