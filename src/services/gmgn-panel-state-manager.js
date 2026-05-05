const tokenCatalog = require('../models/token-catalog');
const gmgnPanelState = require('../models/token-gmgn-panel-state');

const DEFAULT_PANEL_STALE_AFTER_MS = 15000;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolvePanelOptions(options = {}) {
  const now = options.now || (() => new Date());
  return {
    staleAfterMs: parsePositiveInteger(
      options.staleAfterMs || process.env.GMGN_PANEL_STALE_AFTER_MS,
      DEFAULT_PANEL_STALE_AFTER_MS
    ),
    now,
    panelStateModel: options.panelStateModel || gmgnPanelState,
    tokenCatalogModel: options.tokenCatalogModel || tokenCatalog,
  };
}

function getSeenAddresses(tokens) {
  return [...new Set((Array.isArray(tokens) ? tokens : [])
    .map((token) => String(token?.address || token?.tokenAddress || '').trim())
    .filter(Boolean))];
}

function calculateStaleBefore(now, staleAfterMs) {
  const base = now instanceof Date ? now : new Date(now);
  return new Date(base.getTime() - staleAfterMs);
}

async function scheduleDexHandoff(address, tokenCatalogModel) {
  try {
    const scheduled = await tokenCatalogModel.scheduleImmediateEvaluation(address);
    return { address, scheduled: Boolean(scheduled), error: null };
  } catch (error) {
    return { address, scheduled: false, error: error.message };
  }
}

async function applyPanelCycle(tokens, options = {}) {
  const resolved = resolvePanelOptions(options);
  const now = resolved.now();
  const seenAddresses = getSeenAddresses(tokens);
  const staleBefore = calculateStaleBefore(now, resolved.staleAfterMs);

  const activeRows = await resolved.panelStateModel.markTokensSeen(tokens, { seenAt: now });
  const staleRows = await resolved.panelStateModel.markMissingActiveTokensStale(seenAddresses, {
    staleBefore,
  });

  const handoffs = [];
  for (const row of staleRows) {
    handoffs.push(await scheduleDexHandoff(row.tokenAddress, resolved.tokenCatalogModel));
  }

  return {
    seenCount: activeRows.length,
    staleCount: staleRows.length,
    handoffCount: handoffs.filter((handoff) => handoff.scheduled).length,
    handoffs,
    activeRows,
    staleRows,
  };
}

module.exports = {
  applyPanelCycle,
  __private: {
    calculateStaleBefore,
    getSeenAddresses,
    parsePositiveInteger,
    resolvePanelOptions,
    scheduleDexHandoff,
  },
};
