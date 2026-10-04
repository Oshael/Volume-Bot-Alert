const { compareClassificationFrontiers } = require('../services/robinhood-holder-classification-domain');
const { __private: { normalizeFrontiers } } = require('./robinhood-canonical-projection-fence');

function matchesDevHoldCandidate(candidate, creator, frontier) {
  if (candidate.status === 'unavailable') {
    return candidate.statusReason === 'creator_unavailable'
      && creator.address === null && creator.source === 'rpc_code_transition';
  }
  return candidate.status === 'ready'
    && creator.address === candidate.evidence.creator?.address
    && creator.source === candidate.evidence.creator?.source
    && frontier.block_number === candidate.throughBlockNumber
    && frontier.block_hash === candidate.throughBlockHash;
}

function normalizeDevHoldSource(input, candidate) {
  if (input == null) return null;
  const frontiers = normalizeFrontiers(input.frontier);
  const [frontier] = frontiers;
  const creator = input.creator;
  const updatedAt = new Date(creator?.updatedAt);
  if (candidate.metric !== 'dev_hold' || frontiers.length !== 1
      || typeof creator?.updatedAt !== 'string' || !Number.isFinite(updatedAt.getTime())
      || !matchesDevHoldCandidate(candidate, creator, frontier)) {
    throw new Error('DEV HOLD source observation is incoherent');
  }
  return Object.freeze({
    frontier: Object.freeze({ blockNumber: frontier.block_number, blockHash: frontier.block_hash }),
    creator: Object.freeze({ ...creator }), unavailable: candidate.status === 'unavailable',
  });
}

async function lockDevHoldSource(client, observation, tokenAddress) {
  const { rows } = await client.query(`SELECT state.ledger_status,
      state.live_through_block::text, state.live_through_hash,
      attribution.creator_address, attribution.source, attribution.attribution_block::text
    FROM robinhood_holder_token_states state
    JOIN robinhood_token_attributions attribution
      ON attribution.chain=state.chain AND attribution.token_address=state.token_address
    WHERE state.chain='robinhood' AND state.token_address=$1
      AND attribution.updated_at=$2::timestamptz
    FOR SHARE OF state, attribution`, [tokenAddress, observation.creator.updatedAt]);
  const row = rows[0];
  return Boolean(row && row.ledger_status === 'live'
    && row.live_through_block === observation.frontier.blockNumber
    && row.live_through_hash === observation.frontier.blockHash
    && row.creator_address === observation.creator.address
    && row.source === observation.creator.source
    && row.attribution_block === observation.creator.blockNumber
    && (!observation.unavailable || (row.attribution_block != null
      && BigInt(row.attribution_block) <= BigInt(row.live_through_block))));
}

function canInvalidateDevHoldCreator(current, observation) {
  if (!observation.unavailable || current.evidence.creator?.source !== 'blockscout'
      || !/^0x[0-9a-f]{40}$/.test(current.evidence.creator?.address || '')) return false;
  const relation = compareClassificationFrontiers(observation.frontier, {
    blockNumber: current.throughBlockNumber, blockHash: current.throughBlockHash,
  });
  return relation === 'ahead' || relation === 'same';
}

module.exports = { normalizeDevHoldSource, lockDevHoldSource, canInvalidateDevHoldCreator };
