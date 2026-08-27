const {
  createRobinhoodPossibleBundleSource,
} = require('../models/robinhood-possible-bundle-source');
const {
  createRobinhoodPossibleBundleSnapshotRepository,
} = require('../models/robinhood-possible-bundle-snapshot');
const {
  materializePossibleBundles,
} = require('./robinhood-possible-bundle-materializer');

const CHECKPOINT_VERSION = 1;
const ADDRESS = /^0x[0-9a-f]{40}$/;

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

function nonNegative(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function restoreCheckpoint(resume, policy, limit, concurrency, totalCandidateTokens) {
  if (!resume) return { pages: 0, candidates: 0, completed: 0, groups: 0,
    members: 0, cursor: null, startAfterToken: null, elapsedMs: 0, exhausted: false };
  if (resume.checkpointVersion !== CHECKPOINT_VERSION || resume.mode !== 'shadow'
      || resume.runId !== policy.runId
      || resume.minimumValueWei !== policy.minimumValueWei || resume.limit !== limit
      || resume.concurrency !== concurrency || resume.blocked
      || resume.totalCandidateTokens !== totalCandidateTokens
      || (resume.nextToken != null && !ADDRESS.test(resume.nextToken))) {
    throw new Error('possible bundle shadow checkpoint does not match this run');
  }
  return {
    pages: nonNegative(resume.pages, 'checkpoint pages'),
    candidates: nonNegative(resume.candidates, 'checkpoint candidates'),
    completed: nonNegative(resume.completed, 'checkpoint completed'),
    groups: nonNegative(resume.groups, 'checkpoint groups'),
    members: nonNegative(resume.members, 'checkpoint members'),
    cursor: resume.nextToken, startAfterToken: resume.startAfterToken || null,
    elapsedMs: nonNegative(resume.elapsedMs, 'checkpoint elapsedMs'),
    exhausted: resume.exhausted === true,
  };
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

  async function runCampaign(input = {}) {
    if (typeof source.countSeedTokens !== 'function') {
      throw new TypeError('possible bundle campaign source cannot count seed tokens');
    }
    const policy = Object.freeze({
      runId: String(integer(input.runId, null, Number.MAX_SAFE_INTEGER, 'runId')),
      minimumValueWei: positive(input.minimumValueWei, 'minimumValueWei'),
    });
    const limit = integer(input.limit, 100, 100, 'limit');
    const concurrency = integer(input.concurrency, 4, 4, 'concurrency');
    const maxPages = integer(input.maxPages, 1, 1_000, 'maxPages');
    const scopeAfterToken = input.resume?.startAfterToken || input.afterToken || null;
    const totalCandidateTokens = await source.countSeedTokens({
      runId: policy.runId, afterToken: scopeAfterToken,
    });
    const restored = restoreCheckpoint(
      input.resume, policy, limit, concurrency, totalCandidateTokens
    );
    const totals = { pages: restored.pages, candidates: restored.candidates,
      completed: restored.completed, groups: restored.groups, members: restored.members };
    const startAfterToken = input.resume ? restored.startAfterToken : input.afterToken || null;
    let cursor = input.resume ? restored.cursor : startAfterToken;
    let exhausted = restored.exhausted;
    let blockedPage = null;
    const startedAt = Date.now();
    const report = () => {
      const elapsedMs = restored.elapsedMs + Math.max(0, Date.now() - startedAt);
      const remainingTokens = Math.max(0, totalCandidateTokens - totals.candidates);
      const estimatedRemainingMs = totals.candidates > 0
        ? Math.round((elapsedMs / totals.candidates) * remainingTokens) : null;
      return Object.freeze({ checkpointVersion: CHECKPOINT_VERSION, mode: 'shadow',
        ...policy, limit, concurrency, maxPages, totalCandidateTokens, ...totals,
        remainingTokens, progressBps: totalCandidateTokens === 0 ? 10_000
          : Math.floor((totals.candidates * 10_000) / totalCandidateTokens),
        elapsedMs, estimatedRemainingMs, startAfterToken,
        blocked: blockedPage != null, retryAfterToken: blockedPage?.pageAfterToken || null,
        deferredTokens: blockedPage?.deferredTokens || [],
        failedTokens: blockedPage?.failedTokens || [],
        nextToken: blockedPage ? null : cursor, exhausted: !blockedPage && exhausted });
    };
    if (exhausted) return report();
    for (let page = totals.pages; page < maxPages; page += 1) {
      const result = await runPage({ ...policy, limit, concurrency, afterToken: cursor });
      if (result.blocked) {
        blockedPage = result;
        break;
      }
      totals.pages += 1;
      totals.candidates += result.candidates;
      totals.completed += result.completed;
      totals.groups += result.groups;
      totals.members += result.members;
      cursor = result.nextToken;
      exhausted = totals.candidates >= totalCandidateTokens || result.exhausted;
      await input.onProgress?.(report());
      if (exhausted) break;
    }
    return report();
  }

  return Object.freeze({ runPage, runCampaign });
}

module.exports = { createRobinhoodPossibleBundleRunner };
