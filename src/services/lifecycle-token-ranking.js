'use strict';

const { createTokenIdentity } = require('../utils/token-identity');

const LIFECYCLE_RANK_VERSION = 'launchpad-lifecycle-v1';

function finite(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function timestamp(value) {
  const parsed = new Date(value || '').getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
function compareNullableDesc(left, right) {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  return right - left;
}
function evidenceOrder(item) {
  return [BigInt(item.evidenceBlockNumber), BigInt(item.evidenceLogIndex)];
}
function newerEvidence(left, right) {
  const [leftBlock, leftLog] = evidenceOrder(left);
  const [rightBlock, rightLog] = evidenceOrder(right);
  return leftBlock > rightBlock || (leftBlock === rightBlock && leftLog > rightLog);
}
function acceleration(row) {
  const volume5m = finite(row.volume5mUsd);
  const volume1h = finite(row.volume1hUsd);
  if (volume5m == null || volume1h == null
      || row.coverage?.['5m'] !== 'complete' || row.coverage?.['1h'] !== 'complete') return null;
  return volume5m / Math.max(volume1h / 12, 1);
}
function normalizeCandidate(item, view, asOfMs) {
  const lifecycle = item?.lifecycle;
  const row = item?.row;
  if (lifecycle?.status !== view || lifecycle.evidenceSource !== 'canonical_event') return null;
  const identity = createTokenIdentity(lifecycle.chain, lifecycle.tokenAddress);
  if (row?.identity?.key !== identity.key) return null;
  const lastEventAt = timestamp(lifecycle.lastEventAt);
  if (lastEventAt == null || lastEventAt > asOfMs) return null;
  const bondProgressBps = finite(lifecycle.bondProgressBps);
  if (view === 'pre_bonded'
      && (bondProgressBps == null || bondProgressBps < 0 || bondProgressBps > 10_000)) return null;
  return { identity, row, lifecycle: { ...lifecycle, bondProgressBps }, lastEventAt,
    migratedAt: timestamp(lifecycle.migratedAt), volume5m: finite(row.volume5mUsd),
    volume1h: finite(row.volume1hUsd), acceleration5m: acceleration(row) };
}
function compareIdentity(left, right) {
  return left.identity.chain.localeCompare(right.identity.chain)
    || left.identity.address.localeCompare(right.identity.address);
}
function compareMigrated(left, right) {
  return compareNullableDesc(left.migratedAt, right.migratedAt)
    || compareNullableDesc(left.volume5m, right.volume5m)
    || compareNullableDesc(left.volume1h, right.volume1h)
    || compareIdentity(left, right);
}
function comparePreBonded(left, right) {
  return compareNullableDesc(left.lifecycle.bondProgressBps, right.lifecycle.bondProgressBps)
    || compareNullableDesc(left.acceleration5m, right.acceleration5m)
    || compareNullableDesc(left.volume5m, right.volume5m)
    || compareNullableDesc(left.lastEventAt, right.lastEventAt)
    || compareIdentity(left, right);
}

function rankLifecycleTokens(items = [], options = {}) {
  const view = String(options.view || '');
  if (!['migrated', 'pre_bonded'].includes(view)) throw new RangeError('lifecycle view is invalid');
  const asOfMs = timestamp(options.asOf || new Date());
  if (asOfMs == null) throw new RangeError('lifecycle asOf is invalid');
  const byIdentity = new Map();
  for (const item of items) {
    const candidate = normalizeCandidate(item, view, asOfMs);
    const current = candidate && byIdentity.get(candidate.identity.key);
    if (candidate && (!current || newerEvidence(candidate.lifecycle, current.lifecycle))) {
      byIdentity.set(candidate.identity.key, candidate);
    }
  }
  const ranked = [...byIdentity.values()].sort(
    view === 'migrated' ? compareMigrated : comparePreBonded
  );
  return Object.freeze(ranked.slice(0, Math.min(40, Math.max(1, Number(options.limit) || 40))));
}

module.exports = { LIFECYCLE_RANK_VERSION, rankLifecycleTokens };
