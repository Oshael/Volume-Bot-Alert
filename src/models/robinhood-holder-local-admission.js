'use strict';
const { createRobinhoodCanonicalHolderSource } = require('./robinhood-canonical-holder-source');
const { fenceLocalReplay, gap } = require('./robinhood-holder-local-proof');
const { acquireRobinhoodHolderReorgFence } = require('./robinhood-holder-ledger');
const { lockRobinhoodCanonicalProjection, lockRobinhoodCanonicalRecoveryExclusive } = require('./robinhood-canonical-projection-fence');

function candidatesSql(locked = false) {
  return `SELECT pending.token_address, attribution.attribution_block::text AS deployment_block,
    attribution.attribution_tx_hash, birth.block_hash AS birth_hash
    FROM robinhood_holder_coverage_pending pending
    JOIN token_catalog catalog ON catalog.chain=pending.chain AND catalog.address=pending.token_address
    JOIN robinhood_token_attributions attribution ON attribution.chain=pending.chain
      AND attribution.token_address=pending.token_address
    JOIN robinhood_chain_capture_cursor capture ON capture.chain=pending.chain
    JOIN robinhood_chain_blocks mint ON mint.chain=pending.chain AND mint.canonical
      AND mint.block_number=pending.from_block AND mint.block_hash=pending.block_hash
    JOIN robinhood_chain_blocks birth ON birth.chain=pending.chain AND birth.canonical
      AND birth.block_number=attribution.attribution_block
    JOIN robinhood_chain_transactions creation ON creation.chain=birth.chain
      AND creation.block_hash=birth.block_hash
      AND creation.transaction_hash=attribution.attribution_tx_hash AND creation.receipt_succeeded
    WHERE pending.chain='robinhood' AND pending.status='pending'
      AND pending.admitted_tail_from_block IS NULL AND pending.generation=capture.generation
      AND capture.recovery_state='running' AND attribution.creator_address IS NOT NULL
      AND attribution.source=ANY($1::varchar[]) AND attribution.attribution_block <= pending.from_block
      AND (attribution.source <> 'rpc_direct' OR creation.contract_address=pending.token_address)
      AND attribution.attribution_block BETWEEN $2::bigint AND $3::bigint
      AND $3::bigint-attribution.attribution_block+1 <= $6::bigint
      AND pending.from_block <= $3::bigint AND ($5::varchar IS NULL OR pending.token_address=$5)
      AND NOT EXISTS (SELECT 1 FROM robinhood_holder_token_states state
        WHERE state.chain=pending.chain AND state.token_address=pending.token_address)
      AND NOT EXISTS (SELECT 1 FROM admin_blocked_tokens blocked
        WHERE blocked.chain=pending.chain AND blocked.address=pending.token_address)
      AND NOT EXISTS (SELECT 1 FROM robinhood_holder_global_backfill_tokens token
        JOIN robinhood_holder_global_backfill_runs run ON run.id=token.run_id AND run.chain=token.chain
        WHERE token.chain=pending.chain AND token.token_address=pending.token_address
          AND token.status='active' AND run.status <> 'completed')
    ORDER BY pending.from_block, pending.token_address LIMIT $4::int
    ${locked ? 'FOR UPDATE OF pending, attribution SKIP LOCKED' : ''}`;
}

async function proveRange(source, candidate, through) {
  let proof;
  // Overlap one block so the next chunk also proves the parent link at its boundary.
  for (let from = BigInt(candidate.deployment_block); from <= through; from += 4999n) {
    const end = from + 4999n < through ? from + 4999n : through;
    const next = await source.readRange({ tokenAddress: candidate.token_address,
      fromBlock: String(from), toBlock: String(end) });
    if (proof && proof.localProof.generation !== next.localProof.generation) throw gap('generation-changed');
    proof = next;
    if (end === through) break;
  }
  return proof;
}

async function protectBirth(database, params, candidate) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='2s'");
    await lockRobinhoodCanonicalRecoveryExclusive(client);
    await lockRobinhoodCanonicalProjection(client, {
      blockNumber: candidate.deployment_block, blockHash: candidate.birth_hash,
    }, 'local holder birth');
    const current = (await client.query(candidatesSql(true),
      [...params.slice(0, 3), 1, candidate.token_address, params[5]])).rows[0];
    if (JSON.stringify(current) !== JSON.stringify(candidate)) throw gap('creation-changed');
    await client.query(`UPDATE robinhood_holder_coverage_pending SET from_block=$2,
      block_hash=$3,transaction_hash=$4 WHERE chain='robinhood' AND token_address=$1`,
    [candidate.token_address, candidate.deployment_block, candidate.birth_hash, candidate.attribution_tx_hash]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function admit(database, params, candidate, proof) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='2s'");
    await fenceLocalReplay(client, proof);
    await acquireRobinhoodHolderReorgFence(client, 'shared');
    const cursor = (await client.query(`SELECT next_block FROM robinhood_holder_cursors
      WHERE chain='robinhood' AND stream='live' FOR UPDATE SKIP LOCKED`)).rows[0];
    const current = cursor && (await client.query(candidatesSql(true),
      [...params.slice(0, 3), 1, candidate.token_address, params[5]])).rows[0];
    let row;
    if (current && BigInt(cursor.next_block) <= BigInt(proof.nextBlock)
        && JSON.stringify(current) === JSON.stringify(candidate)) {
      row = (await client.query(`INSERT INTO robinhood_holder_token_states
        (chain,token_address,holder_count,ledger_status,deployment_block,backfill_next_block,tail_capture_from_block)
        VALUES ('robinhood',$1,0,'backfilling',$2,$2,$3) ON CONFLICT DO NOTHING
        RETURNING token_address,deployment_block,backfill_next_block,tail_capture_from_block,ledger_status`,
      [candidate.token_address, candidate.deployment_block, proof.nextBlock])).rows[0];
      if (row) {
        await client.query(`UPDATE robinhood_holder_coverage_pending SET from_block=$2,
          block_hash=$3,transaction_hash=$4,admitted_tail_from_block=$5
          WHERE chain='robinhood' AND token_address=$1`,
        [candidate.token_address, candidate.deployment_block, candidate.birth_hash,
          candidate.attribution_tx_hash, proof.nextBlock]);
        await client.query(`UPDATE robinhood_holder_cursors SET version=version+1,updated_at=NOW()
          WHERE chain='robinhood' AND stream='live'`);
      }
    }
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function seedLocalTokens(database, options, exactSources) {
  const source = createRobinhoodCanonicalHolderSource({ database, localOnly: true, statementTimeoutMs: 2000 });
  const coverage = await source.getCoverage();
  const params = [exactSources, coverage.floorBlock, coverage.frontierBlock,
    Math.min(options.limit, 10), null, String(options.maxInitialGapBlocks)];
  const candidates = (await database.query(candidatesSql(), params)).rows;
  const seeded = [];
  let budget = BigInt(options.maxInitialGapBlocks);
  for (const candidate of candidates) {
    const through = BigInt(coverage.frontierBlock);
    const span = through - BigInt(candidate.deployment_block) + 1n;
    if (span > budget) continue;
    budget -= span;
    await protectBirth(database, params, candidate);
    const proof = await proveRange(source, candidate, through);
    const row = await admit(database, params, candidate, proof);
    if (row) seeded.push(row);
  }
  return seeded;
}
module.exports = { seedLocalTokens, __private: { proveRange } };
