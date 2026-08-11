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
    if (!/^0x[0-9a-f]{64}$/.test(liveThroughHash)) return null;
    const common = {
      chain: 'robinhood', address: identity.address, source: 'ledger_live',
      observedAt: iso(value.observedAt, 'observedAt'),
      ledgerVersion, liveThroughBlock, liveThroughHash,
      sequence: `robinhood-holder:${identity.address}:${ledgerVersion.padStart(24, '0')}`,
    };
    if (value.invalidated === true || value.type === 'holder:invalidate') {
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
