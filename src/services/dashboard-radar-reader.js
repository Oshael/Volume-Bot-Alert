const { createTokenIdentity, parseTokenIdentityKey } = require('../utils/token-identity');
const {
  compareRadarRows,
  normalizeRadarQuery,
} = require('./dashboard-radar-query');
const {
  createSolanaWorkspaceRadarReader,
} = require('./solana-workspace-radar-reader');
const {
  createRobinhoodWorkspaceRadarReader,
} = require('./robinhood-workspace-radar-reader');

function identitiesForChain(identities, chain) {
  return Object.freeze(identities.filter((identity) => identity.chain === chain));
}

function buildAdapterInput(query, chain, statementTimeoutMs) {
  const input = {
    asOf: query.asOf,
    bucket: query.bucket,
    page: query.page,
    perPage: query.perPage,
    sorts: query.sorts,
    ageMinMinutes: query.ageMinMinutes,
    ageMaxMinutes: query.ageMaxMinutes,
    searchQuery: query.searchQuery,
    dismissedIdentities: identitiesForChain(query.dismissedIdentities, chain),
    starredIdentities: identitiesForChain(query.starredIdentities, chain),
    starredOnly: query.starredOnly,
  };
  if (chain === 'solana') {
    input.minMcap = query.minMcap;
    input.maxMcap = query.maxMcap;
  } else {
    input.minFdv = query.minFdv;
    input.maxFdv = query.maxFdv;
  }
  if (statementTimeoutMs != null) input.statementTimeoutMs = statementTimeoutMs;
  return Object.freeze(input);
}

function normalizePrefix(prefix, expectedChain, query) {
  if (prefix?.chain !== expectedChain) throw new Error(`${expectedChain} radar prefix chain is invalid`);
  const parsedAsOf = new Date(prefix.asOf);
  if (!Number.isFinite(parsedAsOf.getTime()) || parsedAsOf.toISOString() !== query.asOf) {
    throw new Error(`${expectedChain} radar snapshot does not match query`);
  }
  const total = Number(prefix.total);
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(prefix.rows)) {
    throw new Error(`${expectedChain} radar prefix is invalid`);
  }
  const expectedCount = Math.min(total, query.requiredPrefix);
  if (prefix.rows.length !== expectedCount) {
    throw new Error(`${expectedChain} radar prefix returned ${prefix.rows.length}; ${expectedCount} required`);
  }
  const identities = new Set();
  for (let index = 0; index < prefix.rows.length; index += 1) {
    const identity = createTokenIdentity(
      prefix.rows[index]?.identity?.chain,
      prefix.rows[index]?.identity?.address,
    );
    if (identity.chain !== expectedChain || identities.has(identity.key)) {
      throw new Error(`${expectedChain} radar prefix contains an invalid identity set`);
    }
    identities.add(identity.key);
    if (index > 0 && compareRadarRows(
      prefix.rows[index - 1], prefix.rows[index], query.sorts,
    ) > 0) throw new Error(`${expectedChain} radar prefix is not sorted`);
  }
  return { total, rows: prefix.rows };
}

function buildExactRadarPage(prefixes, query) {
  const rowsByIdentity = new Map();
  let total = 0;
  for (const { chain, prefix } of prefixes) {
    const normalized = normalizePrefix(prefix, chain, query);
    total += normalized.total;
    if (!Number.isSafeInteger(total)) throw new Error('radar total is outside safe range');
    for (const row of normalized.rows) {
      const identity = createTokenIdentity(row.identity.chain, row.identity.address);
      if (rowsByIdentity.has(identity.key)) throw new Error('radar prefixes contain duplicate identity');
      rowsByIdentity.set(identity.key, row);
    }
  }
  const sorted = [...rowsByIdentity.values()].sort((left, right) => (
    compareRadarRows(left, right, query.sorts)
  ));
  const offset = query.page * query.perPage;
  const rows = sorted.slice(offset, offset + query.perPage);
  return Object.freeze({
    asOf: query.asOf, bucket: query.bucket, total,
    page: query.page, perPage: query.perPage,
    requiredPrefix: query.requiredPrefix,
    hasMore: offset + rows.length < total,
    rows: Object.freeze(rows),
  });
}

function createDashboardRadarReader(options = {}) {
  const readers = Object.freeze({
    solana: options.solanaReader || createSolanaWorkspaceRadarReader(),
    robinhood: options.robinhoodReader || createRobinhoodWorkspaceRadarReader(),
  });
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  async function listExactRadar(input = {}) {
    const query = normalizeRadarQuery({
      ...input,
      asOf: input.asOf == null ? now() : input.asOf,
    });
    if (query.empty) return buildExactRadarPage([], query);
    const prefixes = await Promise.all(query.chains.map(async (chain) => ({
      chain,
      prefix: await readers[chain].listRadarPrefix(
        buildAdapterInput(query, chain, input.statementTimeoutMs),
      ),
    })));
    return buildExactRadarPage(prefixes, query);
  }

  async function listRadarPins(input = {}) {
    const query = normalizeRadarQuery({
      ...input, page: 0, perPage: 1,
      asOf: input.asOf == null ? now() : input.asOf,
    });
    if (!Array.isArray(input.pinnedIdentities) || input.pinnedIdentities.length > 500) {
      throw new Error('radar pinned identities are invalid');
    }
    const selectedChains = new Set(query.chains);
    const excluded = new Set((input.excludedIdentities || []).map((value) => (
      typeof value === 'string' ? parseTokenIdentityKey(value).key
        : createTokenIdentity(value?.chain, value?.address).key
    )));
    const seen = new Set();
    const pins = input.pinnedIdentities.flatMap((value) => {
      const identity = typeof value === 'string' ? parseTokenIdentityKey(value)
        : createTokenIdentity(value?.chain, value?.address);
      if (!selectedChains.has(identity.chain) || excluded.has(identity.key) || seen.has(identity.key)) {
        return [];
      }
      seen.add(identity.key);
      return [identity];
    });
    const pageIdentities = new Set((input.pageRows || []).map((row) => (
      createTokenIdentity(row?.identity?.chain, row?.identity?.address).key
    )));
    const byChain = Object.fromEntries(query.chains.map((chain) => [chain, []]));
    for (const identity of pins) byChain[identity.chain].push(identity.address);
    const groups = await Promise.all(query.chains.map((chain) => (
      readers[chain].getRadarTokensByAddresses({
        addresses: byChain[chain], asOf: query.asOf,
        statementTimeoutMs: input.statementTimeoutMs,
      })
    )));
    const rowsByIdentity = new Map();
    for (const rows of groups) {
      for (const row of rows) {
        const identity = createTokenIdentity(row?.identity?.chain, row?.identity?.address);
        if (!byChain[identity.chain]?.includes(identity.address)
          || rowsByIdentity.has(identity.key)) throw new Error('radar pin lookup returned invalid identities');
        rowsByIdentity.set(identity.key, row);
      }
    }
    return Object.freeze(pins.flatMap((identity) => {
      const row = rowsByIdentity.get(identity.key);
      return row && !pageIdentities.has(identity.key) ? [row] : [];
    }));
  }

  return Object.freeze({ listExactRadar, listRadarPins });
}

module.exports = {
  createDashboardRadarReader,
  __private: { buildAdapterInput, buildExactRadarPage, normalizePrefix },
};
