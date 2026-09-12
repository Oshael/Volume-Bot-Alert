const { normalizeTokenChain } = require('../utils/token-identity');
const { normalizeAsOf } = require('./workspace-window-metrics');

const TOKEN_VIEW_IDS = Object.freeze(['trending', 'migrated', 'pre_bonded', 'watchlist']);
const TOKEN_VIEW_CHAINS = Object.freeze(['robinhood']);
const TOKEN_VIEW_MAX_LIMIT = 40;

function normalizeView(value) {
  const view = String(value || '').trim().toLowerCase();
  if (!TOKEN_VIEW_IDS.includes(view)) throw new RangeError('unsupported token view');
  return view;
}

function normalizeChains(value) {
  let source = value == null ? TOKEN_VIEW_CHAINS : value;
  if (!Array.isArray(source)) {
    const text = String(source).trim();
    if (text.startsWith('[')) {
      try { source = JSON.parse(text); } catch (_) { source = []; }
    } else source = text.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (!Array.isArray(source) || !source.length) throw new RangeError('chains must select at least one chain');
  let chains;
  try { chains = [...new Set(source.map(normalizeTokenChain))]; } catch (_) {
    throw new RangeError('chains contains an unsupported chain');
  }
  if (chains.some((chain) => !TOKEN_VIEW_CHAINS.includes(chain))) {
    throw new RangeError('chains contains a chain unavailable for token views');
  }
  return Object.freeze(chains);
}

function normalizeLimit(value) {
  const limit = value == null || value === '' ? TOKEN_VIEW_MAX_LIMIT : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TOKEN_VIEW_MAX_LIMIT) {
    throw new RangeError(`limit must be between 1 and ${TOKEN_VIEW_MAX_LIMIT}`);
  }
  return limit;
}

function normalizeTokenViewRequest(input = {}) {
  return Object.freeze({
    view: normalizeView(input.view),
    chains: normalizeChains(input.chains),
    limit: normalizeLimit(input.limit),
    asOf: normalizeAsOf(input.asOf || new Date()).toISOString(),
  });
}

module.exports = {
  TOKEN_VIEW_CHAINS, TOKEN_VIEW_IDS, TOKEN_VIEW_MAX_LIMIT, normalizeTokenViewRequest,
};
