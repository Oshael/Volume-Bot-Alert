const db = require('./db');
const {
  MAX_LOOKUP_ADDRESSES,
  createRobinhoodInfrastructureRegistryRepository,
} = require('./robinhood-infrastructure-registry');
const { normalizeTokenAddress } = require('../utils/token-identity');

function normalizeHolderRows(rows) {
  if (!rows.length) {
    return Object.freeze({ ready: false, reason: 'holder_state_missing', wallets: Object.freeze([]) });
  }
  const [state] = rows;
  if (state.ledger_status !== 'live' || state.live_through_block == null
      || state.live_through_hash == null) {
    return Object.freeze({
      ready: false, reason: 'holder_frontier_unavailable', wallets: Object.freeze([]),
    });
  }
  return Object.freeze({
    ready: true,
    tokenAddress: state.token_address,
    frontier: Object.freeze({
      blockNumber: String(state.live_through_block), blockHash: state.live_through_hash,
    }),
    wallets: Object.freeze(rows.filter(({ wallet_address: wallet }) => wallet)
      .map(({ wallet_address: wallet }) => wallet)),
  });
}

function createRobinhoodHolderCexSource(options = {}) {
  const database = options.database || db;
  const infrastructure = options.infrastructure
    || createRobinhoodInfrastructureRegistryRepository(options);

  async function loadCexEvidence(inputTokenAddress) {
    const tokenAddress = normalizeTokenAddress('robinhood', inputTokenAddress);
    const { rows } = await database.query(
      `SELECT state.token_address, state.ledger_status,
              state.live_through_block::text, state.live_through_hash,
              balance.wallet_address
         FROM robinhood_holder_token_states state
         LEFT JOIN robinhood_holder_balances balance
           ON balance.chain = state.chain AND balance.token_address = state.token_address
        WHERE state.chain = 'robinhood' AND state.token_address = $1
        ORDER BY balance.wallet_address`,
      [tokenAddress]
    );
    const holders = normalizeHolderRows(rows);
    if (!holders.ready) return holders;
    const entries = [];
    for (let offset = 0; offset < holders.wallets.length; offset += MAX_LOOKUP_ADDRESSES) {
      entries.push(...await infrastructure.listActiveAtBlock({
        addresses: holders.wallets.slice(offset, offset + MAX_LOOKUP_ADDRESSES),
        kinds: ['cex'], blockNumber: holders.frontier.blockNumber,
      }));
    }
    return Object.freeze({
      ready: true, tokenAddress: holders.tokenAddress, frontier: holders.frontier,
      entries: Object.freeze(entries),
    });
  }

  return Object.freeze({ loadCexEvidence });
}

module.exports = {
  createRobinhoodHolderCexSource,
  __private: { normalizeHolderRows },
};
