const tokenCatalog = require('../models/token-catalog');
const {
  createRobinhoodDashboardReadRepository,
} = require('../models/robinhood-dashboard-read');
const {
  buildExactMonitoredPage,
  buildMonitoredSlice,
  normalizeMonitoredQuery,
  rankTopPerformerRows,
} = require('./dashboard-chain-aggregation');
const {
  createSolanaWorkspaceTokenReader,
} = require('./solana-workspace-token-reader');
const {
  createRobinhoodWorkspaceTokenReader,
} = require('./robinhood-workspace-token-reader');
const { evaluateWorkspaceVisibility } = require('./workspace-visibility-policy');
const {
  createTokenIdentity,
  normalizeTokenChain,
  parseTokenIdentityKey,
} = require('../utils/token-identity');

const MAX_UNPAGED_LIMIT = 5000;
const MAX_PINNED_IDENTITIES = 500;
const EXACT_CHAINS = new Set(['solana', 'robinhood']);

function hasChain(chains, chain) {
  return chains.includes(chain);
}

function normalizeLimit(value, fallback = 500) {
  const parsed = Number(value);
  return Math.max(1, Math.min(Number.isFinite(parsed) ? Math.trunc(parsed) : fallback,
    MAX_UNPAGED_LIMIT));
}

function isTopPerformerCandidate(row, options) {
  return Number(row.last_vol_24h) >= options.minVol24h
    && Number(row.last_price_change_24h) > 0;
}

function normalizeExactChains(values) {
  if (!Array.isArray(values) || !values.length) {
    throw new Error('Exact monitored query requires at least one chain');
  }
  const chains = [...new Set(values.map((value) => normalizeTokenChain(value)))];
  for (const chain of chains) {
    if (!EXACT_CHAINS.has(chain)) throw new Error(`${chain} workspace adapter is unavailable`);
  }
  return Object.freeze(chains);
}

function normalizeExcludedIdentities(values, chains) {
  if (values != null && !Array.isArray(values)) {
    throw new TypeError('excludedIdentities must be an array');
  }
  const selected = new Set(chains);
  const grouped = Object.fromEntries(chains.map((chain) => [chain, new Set()]));
  for (const value of values || []) {
    const identity = typeof value === 'string'
      ? parseTokenIdentityKey(value)
      : createTokenIdentity(value?.chain, value?.address);
    if (selected.has(identity.chain)) grouped[identity.chain].add(identity.address);
  }
  return Object.freeze(Object.fromEntries(chains.map((chain) => [
    chain, Object.freeze([...grouped[chain]]),
  ])));
}

function normalizePinnedItems(values, chains, excluded) {
  if (!Array.isArray(values)) throw new TypeError('pinnedItems must be an array');
  if (values.length > MAX_PINNED_IDENTITIES) {
    throw new RangeError(`pinnedItems cannot exceed ${MAX_PINNED_IDENTITIES}`);
  }
  const selected = new Set(chains);
  const seen = new Set();
  const normalized = [];
  for (const item of values) {
    const identity = createTokenIdentity(item?.chain, item?.address);
    if (!selected.has(identity.chain)) throw new Error('pinned identity chain is not selected');
    const sortOrder = Number(item?.sortOrder);
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) {
      throw new Error('pinned sortOrder is invalid');
    }
    if (seen.has(identity.key)) continue;
    seen.add(identity.key);
    if (!excluded[identity.chain].includes(identity.address)) {
      normalized.push(Object.freeze({ identity, sortOrder,
        pinnedAt: item.pinnedAt || null, updatedAt: item.updatedAt || null }));
    }
  }
  normalized.sort((left, right) => left.sortOrder - right.sortOrder
    || left.identity.key.localeCompare(right.identity.key));
  return Object.freeze(normalized);
}

function pinnedFilterMismatch(row, input, asOf) {
  const identity = createTokenIdentity(row?.identity?.chain, row?.identity?.address);
  const isSolana = identity.chain === 'solana';
  const minValue = input[isSolana ? 'minMcap' : 'minFdv'] ?? 30_000;
  const maxValue = input[isSolana ? 'maxMcap' : 'maxFdv'];
  return evaluateWorkspaceVisibility({
    identity,
    state: { lastActivityAt: row.lastActivityAt, riskState: row.riskState },
    valuation: row.valuation,
    filters: { minValuationUsd: minValue, maxValuationUsd: maxValue },
  }, { nowMs: new Date(asOf).getTime() }).filterMismatch;
}

function buildExactAdapterInput(chain, query, input, excludedAddresses = []) {
  const output = {
    asOf: query.asOf,
    page: query.page,
    perPage: query.perPage,
    sorts: query.sorts,
    excludedAddresses,
  };
  if (input.statementTimeoutMs != null) output.statementTimeoutMs = input.statementTimeoutMs;
  if (chain === 'robinhood' && input.preferCatalogValuation === true) {
    output.preferCatalogValuation = true;
  }
  const valuationFields = chain === 'solana'
    ? ['minMcap', 'maxMcap'] : ['minFdv', 'maxFdv'];
  for (const field of valuationFields) {
    if (input[field] != null) output[field] = input[field];
  }
  return output;
}

function createDashboardChainReader(deps = {}) {
  const catalog = deps.tokenCatalog || tokenCatalog;
  const robinhoodRead = deps.robinhoodDashboardRead
    || createRobinhoodDashboardReadRepository();
  const exactReaders = Object.freeze({
    solana: deps.solanaWorkspaceTokenReader || createSolanaWorkspaceTokenReader(),
    robinhood: deps.robinhoodWorkspaceTokenReader || createRobinhoodWorkspaceTokenReader(),
  });
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();

  async function loadActiveRows(options) {
    return Promise.all([
      hasChain(options.chains, 'solana')
        ? catalog.listDashboardMonitoredForMerge(options.minMcap) : [],
      hasChain(options.chains, 'robinhood')
        ? robinhoodRead.listActiveCatalogRows({ minFdv: options.minFdv }) : [],
    ]);
  }

  async function listMonitored(options) {
    if (options.chains.length === 1 && options.chains[0] === 'solana') {
      if (options.pagination) {
        return catalog.listDashboardMonitoredSlice(
          options.pagination.page, options.pagination.perPage,
          options.minMcap, options.sorts,
        );
      }
      return {
        rows: await catalog.listDashboardMonitored(
          normalizeLimit(options.limit), options.minMcap,
        ),
        pagination: null,
      };
    }
    const groups = await loadActiveRows(options);
    const pagination = options.pagination || {
      page: 0, perPage: normalizeLimit(options.limit),
    };
    const slice = buildMonitoredSlice(groups, {
      ...pagination, sorts: options.sorts,
    });
    return options.pagination ? slice : { rows: slice.rows, pagination: null };
  }

  async function listExactMonitored(input = {}) {
    const chains = normalizeExactChains(input.chains);
    const query = normalizeMonitoredQuery({
      ...input,
      asOf: input.asOf == null ? now() : input.asOf,
    });
    const excluded = normalizeExcludedIdentities(input.excludedIdentities, chains);
    const prefixes = await Promise.all(chains.map((chain) => (
      exactReaders[chain].listMonitoredPrefix(
        buildExactAdapterInput(chain, query, input, excluded[chain]),
      )
    )));
    return buildExactMonitoredPage(prefixes, query);
  }

  async function listExactPinned(input = {}) {
    const chains = normalizeExactChains(input.chains);
    const query = normalizeMonitoredQuery({
      asOf: input.asOf == null ? now() : input.asOf, page: 0, perPage: 1,
    });
    const excluded = normalizeExcludedIdentities(input.excludedIdentities, chains);
    const pins = normalizePinnedItems(input.pinnedItems || [], chains, excluded);
    const byChain = Object.fromEntries(chains.map((chain) => [chain, []]));
    for (const pin of pins) byChain[pin.identity.chain].push(pin.identity.address);
    const groups = await Promise.all(chains.map((chain) => (
      exactReaders[chain].getTokensByAddresses({
        addresses: byChain[chain], asOf: query.asOf,
        statementTimeoutMs: input.statementTimeoutMs,
      })
    )));
    const rowsByIdentity = new Map();
    for (const rows of groups) {
      for (const row of rows) {
        const identity = createTokenIdentity(row?.identity?.chain, row?.identity?.address);
        if (!byChain[identity.chain]?.includes(identity.address)
          || rowsByIdentity.has(identity.key)) {
          throw new Error('pinned adapter returned an invalid identity set');
        }
        rowsByIdentity.set(identity.key, row);
      }
    }
    return Object.freeze(pins.flatMap((pin) => {
      const row = rowsByIdentity.get(pin.identity.key);
      return row ? [Object.freeze({ row, sortOrder: pin.sortOrder,
        filterMismatch: pinnedFilterMismatch(row, input, query.asOf),
        pinnedAt: pin.pinnedAt, updatedAt: pin.updatedAt })] : [];
    }));
  }

  async function listTopPerformers(options) {
    if (options.chains.length === 1 && options.chains[0] === 'solana') {
      return catalog.listDashboardTopPerformers(options);
    }
    const groups = await Promise.all([
      hasChain(options.chains, 'solana')
        ? catalog.listDashboardTopPerformerCandidates(options) : [],
      hasChain(options.chains, 'robinhood')
        ? robinhoodRead.listActiveCatalogRows({ minFdv: options.minFdv })
          .then((rows) => rows.filter((row) => isTopPerformerCandidate(row, options)))
        : [],
    ]);
    return rankTopPerformerRows(groups, options);
  }

  return Object.freeze({
    listExactMonitored, listExactPinned, listMonitored, listTopPerformers,
  });
}

const dashboardChainReader = createDashboardChainReader();

module.exports = {
  ...dashboardChainReader,
  createDashboardChainReader,
  __private: {
    buildExactAdapterInput, isTopPerformerCandidate, normalizeExactChains,
    normalizeExcludedIdentities, normalizeLimit, normalizePinnedItems,
    pinnedFilterMismatch,
  },
};
