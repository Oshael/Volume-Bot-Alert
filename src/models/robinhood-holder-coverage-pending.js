'use strict';

const { TRANSFER_TOPIC, ZERO_TOPIC } = require('../services/evm-erc20-supply-delta');
const { classifyTokenEligibility } = require('../services/robinhood-market-policy');
const { lockRobinhoodCanonicalRecoveryShared } = require('./robinhood-canonical-projection-fence');

function candidates(events) {
  const selected = new Map();
  for (const event of events) {
    if (event.topic0 !== TRANSFER_TOPIC || event.topics[1] !== ZERO_TOPIC) continue;
    const compatible = event.topics.length === 3 && /^0x[0-9a-f]{64}$/i.test(event.data)
      && event.topics.slice(1).every((topic) => /^0x0{24}[0-9a-f]{40}$/.test(topic));
    const eligibility = classifyTokenEligibility(event.address);
    const reason = !compatible ? 'incompatible_transfer' : eligibility.reason;
    const previous = selected.get(event.address);
    // A valid ERC-20 mint takes precedence over a malformed hint in the batch.
    if (previous && (previous.reason !== 'incompatible_transfer' || !compatible)) continue;
    selected.set(event.address, {
      token_address: event.address, from_block: event.block_number,
      block_hash: event.block_hash, transaction_hash: event.transaction_hash,
      status: reason ? 'excluded' : 'pending',
      reason: reason || 'coverage_and_handoff_unconfirmed',
    });
  }
  return [...selected.values()];
}

// Capture owns the cursor lock and transaction; hints never admit holder states.
async function appendCoveragePending(client, events, generation) {
  const rows = candidates(events);
  if (!rows.length) return;
  await client.query(`/* holder-coverage:append */
    INSERT INTO robinhood_holder_coverage_pending
      (chain, token_address, from_block, block_hash, transaction_hash, generation, status, reason)
    SELECT 'robinhood', item.token_address, item.from_block, item.block_hash,
      item.transaction_hash, $2::bigint,
      CASE WHEN blocked.address IS NOT NULL THEN 'excluded' ELSE item.status END,
      CASE WHEN blocked.address IS NOT NULL THEN 'admin_blocked' ELSE item.reason END
    FROM jsonb_to_recordset($1::jsonb) AS item(token_address varchar(42), from_block bigint,
      block_hash varchar(66), transaction_hash varchar(66), status varchar(16), reason varchar(40))
    LEFT JOIN admin_blocked_tokens blocked ON blocked.chain='robinhood'
      AND blocked.address=item.token_address
    WHERE true
    ON CONFLICT (chain, token_address) DO UPDATE SET
      from_block=EXCLUDED.from_block, block_hash=EXCLUDED.block_hash,
      transaction_hash=EXCLUDED.transaction_hash, generation=EXCLUDED.generation,
      status=EXCLUDED.status, reason=EXCLUDED.reason, created_at=NOW()
    WHERE robinhood_holder_coverage_pending.reason='incompatible_transfer'
      AND EXCLUDED.status='pending'`, [JSON.stringify(rows), generation]);
}

// A conservative range gate preserves raw, empty blocks and applied journal rows.
// Forward capture only introduces candidates beyond the consumed prune cutoff.
// Recovery is fenced; orphaned candidates keep protecting their original range.
async function coveragePruneBlocker(client, cutoffBlock) {
  await lockRobinhoodCanonicalRecoveryShared(client);
  const result = await client.query(`/* holder-coverage:prune-gate */
    SELECT from_block::text FROM robinhood_holder_coverage_pending
    WHERE chain='robinhood' AND status='pending' AND from_block < $1::bigint
    ORDER BY from_block LIMIT 1`, [String(cutoffBlock)]);
  return result.rows.length ? {
    status: 'blocked', reason: 'holder_coverage_pending', blockedBlock: result.rows[0].from_block,
  } : null;
}

async function inspectCoveragePending(client) {
  const result = await client.query(`/* holder-coverage:audit */
    SELECT pending.status, pending.reason, COUNT(*)::int AS items,
      MIN(pending.from_block)::text AS oldest_block,
      EXTRACT(EPOCH FROM (NOW() - MIN(pending.created_at)))::bigint::text AS oldest_age_s,
      COUNT(*) FILTER (WHERE pending.status='pending' AND block.block_hash IS NULL)::int
        AS unproven_anchors
    FROM robinhood_holder_coverage_pending pending
    LEFT JOIN robinhood_chain_blocks block ON block.chain=pending.chain
      AND block.block_number=pending.from_block AND block.block_hash=pending.block_hash
      AND block.canonical
    WHERE pending.chain='robinhood' GROUP BY pending.status, pending.reason
    ORDER BY pending.status, pending.reason`);
  return result.rows;
}

module.exports = { appendCoveragePending, coveragePruneBlocker, inspectCoveragePending };
