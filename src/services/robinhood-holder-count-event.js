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

function normalizeRobinhoodHolderCountEvent(value = {}) {
  let identity;
  try {
    identity = createTokenIdentity('robinhood', value.address || value.tokenAddress);
  } catch (_) {
    return null;
  }
  try {
    const holderCountRaw = decimal(value.holderCount, 'holder count');
    const holderCount = Number(holderCountRaw);
    const ledgerVersion = decimal(value.ledgerVersion, 'ledger version');
    const liveThroughBlock = decimal(value.liveThroughBlock, 'live block');
    const liveThroughHash = String(value.liveThroughHash || '').toLowerCase();
    if (!Number.isSafeInteger(holderCount) || !/^0x[0-9a-f]{64}$/.test(liveThroughHash)) {
      return null;
    }
    return Object.freeze({
      type: 'holder:count', chain: 'robinhood', address: identity.address,
      holderCount, source: 'ledger_live', observedAt: iso(value.observedAt, 'observedAt'),
      ledgerVersion, liveThroughBlock, liveThroughHash,
      sequence: `robinhood-holder:${identity.address}:${ledgerVersion.padStart(24, '0')}`,
    });
  } catch (_) {
    return null;
  }
}

module.exports = { normalizeRobinhoodHolderCountEvent };
