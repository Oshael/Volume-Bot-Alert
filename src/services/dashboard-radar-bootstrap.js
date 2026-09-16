const { normalizeRadarQuery } = require('./dashboard-radar-query');
const { parseTokenIdentityKey, tokenIdentityKey } = require('../utils/token-identity');

// Product rollout policy; the underlying reader remains multichain.
const RADAR_CHAINS = Object.freeze(['robinhood']);

function validateFilterTypes(body) {
  if (body.starredOnly != null && typeof body.starredOnly !== 'boolean') {
    throw new Error('starredOnly must be a boolean');
  }
  for (const field of ['page', 'perPage', 'ageMinMinutes', 'ageMaxMinutes',
    'minMcap', 'maxMcap', 'minFdv', 'maxFdv']) {
    if (body[field] != null && (typeof body[field] !== 'number' || !Number.isFinite(body[field]))) {
      throw new Error(`${field} must be a number`);
    }
  }
  if (body.asOf != null && typeof body.asOf !== 'string') throw new Error('asOf must be a timestamp');
  if (body.searchQuery != null && typeof body.searchQuery !== 'string') {
    throw new Error('searchQuery must be a string');
  }
}

function parseRadarBootstrap(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('radar payload must be an object');
  }
  const chains = body.chains ?? RADAR_CHAINS;
  if (!Array.isArray(chains) || !chains.length
    || chains.some((chain) => !RADAR_CHAINS.includes(chain))) {
    throw new Error('radar chains are not available');
  }
  validateFilterTypes(body);
  const pins = body.pinnedIdentities ?? [];
  if (!Array.isArray(pins) || pins.length > 500) throw new Error('radar pins cannot exceed 500');
  const pinnedIdentities = [...new Set(pins.map((value) => parseTokenIdentityKey(value).key))];
  const query = normalizeRadarQuery({
    bucket: 'all', chains, asOf: body.asOf,
    page: body.page, perPage: body.perPage, sorts: body.sorts,
    ageMinMinutes: body.ageMinMinutes, ageMaxMinutes: body.ageMaxMinutes,
    minMcap: body.minMcap, maxMcap: body.maxMcap,
    minFdv: body.minFdv, maxFdv: body.maxFdv,
    searchQuery: body.searchQuery, starredOnly: body.starredOnly,
    dismissedIdentities: body.dismissedIdentities, starredIdentities: body.starredIdentities,
  });
  return { query, pinnedIdentities };
}

function createRadarBootstrapHandler({ reader, blocklist, loadTickerPeers, buildToken, buildPage }) {
  return async function radarBootstrap(req, res) {
    let parsed;
    try {
      parsed = parseRadarBootstrap(req.body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      const { query, pinnedIdentities } = parsed;
      const blocked = await blocklist.getAllForChains(req.user.id, query.chains);
      const excludedIdentities = blocked.map((item) => tokenIdentityKey(item.chain, item.address));
      const input = { ...query, dismissedIdentities: [...query.dismissedIdentities, ...excludedIdentities] };
      const page = await reader.listExactRadar(input);
      const pins = await reader.listRadarPins({
        ...input, pinnedIdentities, excludedIdentities, pageRows: page.rows,
      });
      const peers = await loadTickerPeers([...page.rows, ...pins].map(buildToken));
      return res.json({
        source: 'workspace-radar-v1', asOf: query.asOf, generatedAt: query.asOf,
        chains: query.chains, all: buildPage(page, pins, peers),
      });
    } catch (error) {
      console.error('POST /dashboard/radar-bootstrap error:', error.message);
      return res.status(500).json({ error: 'Failed to load radar workspace bootstrap' });
    }
  };
}

module.exports = { createRadarBootstrapHandler, parseRadarBootstrap };
