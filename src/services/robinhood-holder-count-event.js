const { createTokenIdentity } = require('../utils/token-identity');

function decimal(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized).toString();
}

function iso(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function normalizeLatency(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = [
    'headObservedAt', 'receiptsAvailableAt', 'captureCommittedAt',
    'projectionCommittedAt', 'publishedAt',
  ];
  const normalized = {};
  for (const field of fields) {
    if (value[field] == null) continue;
    try { normalized[field] = iso(value[field], `latency.${field}`); } catch (_) { /* optional */ }
  }
  return Object.keys(normalized).length ? Object.freeze(normalized) : undefined;
}

function normalizeRobinhoodHolderRealtimeEvent(value = {}) {
  let identity;
  try {
    identity = createTokenIdentity('robinhood', value.address || value.tokenAddress);
  } catch (_) {
    return null;
  }
  try {
    const ledgerVersion = decimal(value.ledgerVersion, 'ledger version');
    const liveThroughBlock = decimal(value.liveThroughBlock, 'live block');
    const liveThroughHash = String(value.liveThroughHash || '').toLowerCase();
    const invalidated = value.invalidated === true || value.type === 'holder:invalidate';
    const finality = String(value.finality || (invalidated
      ? 'invalidated' : 'observed'));
    const latency = normalizeLatency(value.latency);
    if (!/^0x[0-9a-f]{64}$/.test(liveThroughHash)
        || !['observed', 'finalized', 'invalidated'].includes(finality)
        || invalidated !== (finality === 'invalidated')) return null;
    const common = {
      chain: 'robinhood', address: identity.address, source: 'ledger_live',
      observedAt: iso(value.observedAt, 'observedAt'), finality,
      ledgerVersion, liveThroughBlock, liveThroughHash,
      sequence: `robinhood-holder:${identity.address}:${ledgerVersion.padStart(24, '0')}`,
      ...(latency ? { latency } : {}),
    };
    if (invalidated) {
      return Object.freeze({
        type: 'holder:invalidate', ...common, reason: 'reorg_resync',
      });
    }
    const holderCount = Number(decimal(value.holderCount, 'holder count'));
    if (!Number.isSafeInteger(holderCount)) return null;
    return Object.freeze({ type: 'holder:count', ...common, holderCount });
  } catch (_) {
    return null;
  }
}

function normalizeRobinhoodHolderCountEvent(value = {}) {
  const event = normalizeRobinhoodHolderRealtimeEvent(value);
  return event?.type === 'holder:count' ? event : null;
}

module.exports = {
  normalizeRobinhoodHolderCountEvent,
  normalizeRobinhoodHolderRealtimeEvent,
};
