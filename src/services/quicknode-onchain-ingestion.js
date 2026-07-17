const adminBlockedToken = require('../models/admin-blocked-token');
const quicknodeOnchainEvent = require('./quicknode-onchain-event');

function normalizeText(value) {
  return String(value || '').trim();
}

function createEmptySummary() {
  return {
    accepted: 0,
    skipped: 0,
    blocked: 0,
    lowVolume: 0,
    candidates: [],
    skippedEvents: [],
  };
}

function uniqueTokenMints(candidates = []) {
  return [...new Set(
    candidates
      .map((candidate) => normalizeText(candidate?.tokenMint))
      .filter(Boolean),
  )];
}

function blockedAddressSet(rows = []) {
  return new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => normalizeText(row?.address || row))
      .filter(Boolean),
  );
}

async function loadBlockedTokenAddresses(tokenMints, options = {}) {
  const model = options.adminBlockedTokenModel || adminBlockedToken;
  if (!tokenMints.length) {
    return new Set();
  }
  const rows = await model.listByAddresses(tokenMints);
  return blockedAddressSet(rows);
}

async function evaluateTransactionSummaries(summaries = [], options = {}) {
  const summary = createEmptySummary();
  const preliminary = (Array.isArray(summaries) ? summaries : [])
    .map((item) => ({
      raw: item,
      candidate: quicknodeOnchainEvent.buildOnchainSwapCandidate(item, {
        minSolVolume: options.minSolVolume,
        minUsdVolume: options.minUsdVolume,
      }),
    }));

  const acceptedPreliminary = preliminary
    .filter((item) => item.candidate.accepted)
    .map((item) => item.candidate);
  const blocked = await loadBlockedTokenAddresses(uniqueTokenMints(acceptedPreliminary), options);

  for (const item of preliminary) {
    const candidate = item.candidate.accepted
      ? quicknodeOnchainEvent.buildOnchainSwapCandidate(item.raw, {
        blockedTokenAddresses: [...blocked],
        minSolVolume: options.minSolVolume,
        minUsdVolume: options.minUsdVolume,
      })
      : item.candidate;

    if (candidate.accepted) {
      summary.accepted += 1;
      summary.candidates.push(candidate);
      continue;
    }

    summary.skipped += 1;
    if (candidate.skipReason === 'admin_blocked') {
      summary.blocked += 1;
    } else if (candidate.skipReason === 'low_volume' || candidate.skipReason === 'low_sol_volume') {
      summary.lowVolume += 1;
    }
    summary.skippedEvents.push(candidate);
  }

  return summary;
}

async function evaluateTransactionSummary(summary, options = {}) {
  const result = await evaluateTransactionSummaries([summary], options);
  return result.candidates[0] || result.skippedEvents[0] || {
    accepted: false,
    skipReason: 'empty_result',
  };
}

module.exports = {
  evaluateTransactionSummaries,
  evaluateTransactionSummary,
  __private: {
    blockedAddressSet,
    createEmptySummary,
    loadBlockedTokenAddresses,
    normalizeText,
    uniqueTokenMints,
  },
};
