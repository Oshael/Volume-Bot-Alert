const {
  createRobinhoodPossibleBundleSource,
} = require('../models/robinhood-possible-bundle-source');
const {
  materializePossibleBundles,
} = require('./robinhood-possible-bundle-materializer');

const MAX_THRESHOLDS = 12;

function integer(value, fallback, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function normalizeThresholds(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_THRESHOLDS) {
    throw new Error(`thresholdsWei must contain between 1 and ${MAX_THRESHOLDS} values`);
  }
  const normalized = values.map((value) => String(value));
  if (normalized.some((value) => !/^\d+$/.test(value) || BigInt(value) < 1n)) {
    throw new Error('thresholdsWei values must be positive integers');
  }
  return Object.freeze([...new Set(normalized)].sort((left, right) => (
    BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
  )));
}

function emptyThresholdSummary(minimumValueWei) {
  return { minimumValueWei, tokensWithGroups: 0, groups: 0, members: 0,
    connections: 0, maximumGroupMembers: 0,
    groupSizes: { two: 0, threeToFive: 0, sixPlus: 0 },
    connectionKinds: { memberFunder: 0, commonFunder: 0, connectedAncestor: 0 },
    memberKinds: { directMemberFunding: 0, connectedFundingAncestor: 0, mixed: 0 } };
}

function addSnapshot(summary, snapshot) {
  if (snapshot.groups.length) summary.tokensWithGroups += 1;
  summary.groups += snapshot.groups.length;
  summary.members += snapshot.members.length;
  for (const group of snapshot.groups) {
    summary.maximumGroupMembers = Math.max(summary.maximumGroupMembers, group.memberCount);
    if (group.memberCount === 2) summary.groupSizes.two += 1;
    else if (group.memberCount <= 5) summary.groupSizes.threeToFive += 1;
    else summary.groupSizes.sixPlus += 1;
    const connections = group.evidenceJson?.connections || [];
    summary.connections += connections.length;
    for (const connection of connections) {
      if (connection.kind === 'member_funder') summary.connectionKinds.memberFunder += 1;
      else if (connection.kind === 'common_funder') summary.connectionKinds.commonFunder += 1;
      else if (connection.kind === 'connected_ancestor') {
        summary.connectionKinds.connectedAncestor += 1;
      }
    }
  }
  for (const member of snapshot.members) {
    if (member.connectionKind === 'direct_member_funding') {
      summary.memberKinds.directMemberFunding += 1;
    } else if (member.connectionKind === 'connected_funding_ancestor') {
      summary.memberKinds.connectedFundingAncestor += 1;
    } else if (member.connectionKind === 'mixed') summary.memberKinds.mixed += 1;
  }
}

function createRobinhoodPossibleBundleCalibrator(deps = {}) {
  const source = deps.source || createRobinhoodPossibleBundleSource(deps);
  const materialize = deps.materialize || materializePossibleBundles;
  if (typeof source?.listSeedTokens !== 'function'
      || typeof source?.loadSeedToken !== 'function' || typeof materialize !== 'function') {
    throw new TypeError('possible bundle calibrator dependencies are invalid');
  }

  async function evaluateToken(tokenAddress, policy) {
    const evidence = await source.loadSeedToken({ runId: policy.runId, tokenAddress });
    if (!evidence.ready) return { status: 'deferred', reason: evidence.reason };
    return { status: 'evaluated', snapshots: policy.thresholdsWei.map((minimumValueWei) => (
      materialize({ ...evidence, minimumValueWei })
    )) };
  }

  async function evaluatePage(tokens, policy, concurrency, totals) {
    for (let offset = 0; offset < tokens.length; offset += concurrency) {
      const batch = tokens.slice(offset, offset + concurrency);
      const settled = await Promise.allSettled(batch.map((tokenAddress) => (
        evaluateToken(tokenAddress, policy)
      )));
      for (const [index, result] of settled.entries()) {
        const tokenAddress = batch[index];
        if (result.status === 'rejected') {
          totals.failedTokens.push(Object.freeze({ tokenAddress,
            error: String(result.reason?.message || result.reason).slice(0, 500) }));
        } else if (result.value.status === 'deferred') {
          totals.deferredTokens.push(Object.freeze({ tokenAddress,
            reason: result.value.reason || 'unknown' }));
        } else {
          totals.evaluatedTokens += 1;
          result.value.snapshots.forEach((snapshot, thresholdIndex) => {
            addSnapshot(totals.thresholds[thresholdIndex], snapshot);
          });
        }
      }
    }
  }

  async function audit(input = {}) {
    const policy = Object.freeze({
      runId: String(integer(input.runId, null, Number.MAX_SAFE_INTEGER, 'runId')),
      thresholdsWei: normalizeThresholds(input.thresholdsWei),
    });
    const pageSize = integer(input.pageSize, 100, 100, 'pageSize');
    const concurrency = integer(input.concurrency, 4, 4, 'concurrency');
    const maxPages = integer(input.maxPages, 1, 1_000, 'maxPages');
    const totals = { pages: 0, candidateTokens: 0, evaluatedTokens: 0,
      deferredTokens: [], failedTokens: [],
      thresholds: policy.thresholdsWei.map(emptyThresholdSummary) };
    const startAfterToken = input.afterToken || null;
    let cursor = startAfterToken;
    let retryAfterToken = null;
    let exhausted = false;
    for (let page = 0; page < maxPages; page += 1) {
      const tokens = await source.listSeedTokens({
        runId: policy.runId, afterToken: cursor, limit: pageSize,
      });
      totals.pages += 1;
      totals.candidateTokens += tokens.length;
      if (!tokens.length) { exhausted = true; break; }
      const pageAfterToken = cursor;
      await evaluatePage(tokens, policy, concurrency, totals);
      if (totals.deferredTokens.length || totals.failedTokens.length) {
        retryAfterToken = pageAfterToken;
        break;
      }
      cursor = tokens.at(-1);
      if (tokens.length < pageSize) { exhausted = true; break; }
    }
    const blocked = totals.deferredTokens.length > 0 || totals.failedTokens.length > 0;
    return Object.freeze({ mode: 'read-only', ...policy, pageSize, concurrency, maxPages,
      ...totals, startAfterToken, blocked, retryAfterToken,
      nextToken: blocked ? null : cursor, exhausted: !blocked && exhausted });
  }

  return Object.freeze({ audit });
}

module.exports = { createRobinhoodPossibleBundleCalibrator,
  __private: { addSnapshot, normalizeThresholds } };
