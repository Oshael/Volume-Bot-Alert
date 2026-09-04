'use strict';

const db = require('./db');

const CHAIN = 'robinhood';
const DOMAINS = new Set(['discovery', 'market']);

function domainOf(value) {
  const domain = String(value || '').trim().toLowerCase();
  if (!DOMAINS.has(domain)) throw new Error('domain must be discovery or market');
  return domain;
}
function ownerOf(value) {
  const owner = String(value || '').trim();
  if (!owner || owner.length > 160) throw new Error('owner is required');
  return owner;
}
function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}
function identityOf(value, label) {
  const blockHash = String(value?.blockHash || '').toLowerCase();
  const logIndex = Number(value?.logIndex);
  if (!/^0x[0-9a-f]{64}$/.test(blockHash) || !Number.isInteger(logIndex) || logIndex < 0) {
    throw new Error(`${label} identity is invalid`);
  }
  return { domain: domainOf(value.domain), blockHash, logIndex };
}
function workRows(values, label, extra = () => ({})) {
  return (Array.isArray(values) ? values : []).map((value) => ({
    ...identityOf(value, label), ...extra(value),
  }));
}

function createRobinhoodChainDomainOutboxRepository(options = {}) {
  const database = options.database || db;

  async function claimNextBlock(input = {}) {
    const owner = ownerOf(input.owner);
    const leaseMs = positiveInt(input.leaseMs, 'leaseMs');
    const maxBlocks = positiveInt(input.maxBlocks || 1, 'maxBlocks');
    const result = await database.query(
      `WITH frontiers AS (
         SELECT block_number,
                BOOL_AND(status='pending' AND next_attempt_at<=NOW()) AS ready
           FROM robinhood_chain_domain_outbox
          WHERE chain=$1 AND status<>'complete'
          GROUP BY block_number ORDER BY block_number LIMIT $4
       ), ready AS (
         SELECT block_number FROM (
           SELECT block_number,
                  BOOL_AND(ready) OVER (
                    ORDER BY block_number ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) AS prefix_ready
             FROM frontiers
         ) ordered WHERE prefix_ready
       ), claimable AS (
         SELECT outbox.chain, outbox.domain, outbox.block_hash, outbox.log_index
           FROM robinhood_chain_domain_outbox outbox JOIN ready USING (block_number)
          WHERE outbox.chain=$1 AND outbox.status='pending'
          ORDER BY outbox.block_number,
                   CASE outbox.domain WHEN 'discovery' THEN 0 ELSE 1 END,
                   outbox.transaction_index, outbox.log_index
          FOR UPDATE OF outbox SKIP LOCKED
       ), leased AS (
         UPDATE robinhood_chain_domain_outbox outbox
            SET status='leased', lease_owner=$2,
                lease_until=NOW() + ($3::bigint * INTERVAL '1 millisecond'),
                attempt_count=outbox.attempt_count+1, updated_at=NOW()
           FROM claimable
          WHERE outbox.chain=claimable.chain AND outbox.domain=claimable.domain
            AND outbox.block_hash=claimable.block_hash AND outbox.log_index=claimable.log_index
         RETURNING outbox.*
       )
       SELECT leased.*, event.transaction_hash, event.address, event.topic0,
              event.topics, event.data, block.block_timestamp
         FROM leased
         JOIN robinhood_chain_events event USING (chain, block_hash, log_index)
         JOIN robinhood_chain_blocks block USING (chain, block_hash)
        ORDER BY leased.block_number,
                 CASE leased.domain WHEN 'discovery' THEN 0 ELSE 1 END,
                 leased.transaction_index, leased.log_index`,
      [CHAIN, owner, leaseMs, maxBlocks]
    );
    return result.rows;
  }

  async function claimReady(input = {}) {
    const domain = domainOf(input.domain);
    const owner = ownerOf(input.owner);
    const limit = positiveInt(input.limit, 'limit');
    const leaseMs = positiveInt(input.leaseMs, 'leaseMs');
    const result = await database.query(
      `WITH claimable AS (
         SELECT chain, domain, block_hash, log_index
           FROM robinhood_chain_domain_outbox
          WHERE chain=$1 AND domain=$2 AND status='pending' AND next_attempt_at<=NOW()
          ORDER BY block_number, transaction_index, log_index
          LIMIT $3 FOR UPDATE SKIP LOCKED
       ), leased AS (
         UPDATE robinhood_chain_domain_outbox outbox
            SET status='leased', lease_owner=$4,
                lease_until=NOW() + ($5::bigint * INTERVAL '1 millisecond'),
                attempt_count=outbox.attempt_count+1, updated_at=NOW()
           FROM claimable
          WHERE outbox.chain=claimable.chain AND outbox.domain=claimable.domain
            AND outbox.block_hash=claimable.block_hash AND outbox.log_index=claimable.log_index
         RETURNING outbox.*
       )
       SELECT leased.*, event.transaction_hash, event.address, event.topic0,
              event.topics, event.data, block.block_timestamp
         FROM leased
         JOIN robinhood_chain_events event USING (chain, block_hash, log_index)
         JOIN robinhood_chain_blocks block USING (chain, block_hash)
        ORDER BY leased.block_number, leased.transaction_index, leased.log_index`,
      [CHAIN, domain, limit, owner, leaseMs]
    );
    return result.rows;
  }

  async function claimShadow(input = {}) {
    const domain = domainOf(input.domain);
    const owner = ownerOf(input.owner);
    const limit = positiveInt(input.limit, 'limit');
    const leaseMs = positiveInt(input.leaseMs, 'leaseMs');
    const result = await database.query(
      `WITH claimable AS (
         SELECT outbox.chain, outbox.domain, outbox.block_hash, outbox.log_index
           FROM robinhood_chain_domain_outbox outbox
           JOIN robinhood_head_capture_cursors cursor
             ON cursor.chain=outbox.chain AND cursor.stream=outbox.domain
          WHERE outbox.chain=$1 AND outbox.domain=$2 AND outbox.status='pending'
            AND outbox.next_attempt_at <= NOW()
            AND outbox.block_number < cursor.next_block
          ORDER BY outbox.block_number, outbox.transaction_index, outbox.log_index
          LIMIT $3 FOR UPDATE OF outbox SKIP LOCKED
       ), leased AS (
         UPDATE robinhood_chain_domain_outbox outbox
            SET status='leased', lease_owner=$4,
                lease_until=NOW() + ($5::bigint * INTERVAL '1 millisecond'),
                attempt_count=outbox.attempt_count+1, updated_at=NOW()
           FROM claimable
          WHERE outbox.chain=claimable.chain AND outbox.domain=claimable.domain
            AND outbox.block_hash=claimable.block_hash AND outbox.log_index=claimable.log_index
         RETURNING outbox.*
       )
       SELECT leased.*, event.transaction_hash, event.address, event.topic0,
              event.topics, event.data,
              legacy.block_hash AS legacy_block_hash,
              legacy.block_number AS legacy_block_number,
              legacy.transaction_index AS legacy_transaction_index,
              legacy.address AS legacy_address, legacy.topics AS legacy_topics,
              legacy.data AS legacy_data
         FROM leased
         JOIN robinhood_chain_events event USING (chain, block_hash, log_index)
         LEFT JOIN robinhood_head_captures legacy
           ON legacy.chain=leased.chain AND legacy.stream=leased.domain
          AND legacy.transaction_hash=event.transaction_hash
          AND legacy.log_index=event.log_index
        ORDER BY leased.block_number, leased.transaction_index, leased.log_index`,
      [CHAIN, domain, limit, owner, leaseMs]
    );
    return result.rows;
  }

  async function settle(input = {}) {
    const owner = ownerOf(input.owner);
    const maxAttempts = positiveInt(input.maxAttempts || 5, 'maxAttempts');
    const complete = workRows(input.complete, 'complete');
    const blocked = workRows(input.blocked, 'blocked', (value) => ({ error: value.error || {} }));
    const retry = workRows(input.retry, 'retry', (value) => ({
      error: value.error || {}, backoffMs: positiveInt(value.backoffMs, 'retry.backoffMs'),
    }));
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const completed = await client.query(
        `UPDATE robinhood_chain_domain_outbox outbox
            SET status='complete', lease_owner=NULL, lease_until=NULL,
                completed_at=NOW(), last_error=NULL, updated_at=NOW()
           FROM jsonb_to_recordset($1::jsonb) item(
             domain text, "blockHash" text, "logIndex" integer
           )
          WHERE outbox.chain=$2 AND outbox.domain=item.domain
            AND outbox.block_hash=item."blockHash" AND outbox.log_index=item."logIndex"
            AND outbox.status='leased' AND outbox.lease_owner=$3 AND outbox.lease_until>NOW()`,
        [JSON.stringify(complete), CHAIN, owner]
      );
      const dead = await client.query(
        `UPDATE robinhood_chain_domain_outbox outbox
            SET status='blocked', lease_owner=NULL, lease_until=NULL,
                last_error=item.error, updated_at=NOW()
           FROM jsonb_to_recordset($1::jsonb) item(
             domain text, "blockHash" text, "logIndex" integer, error jsonb
           )
          WHERE outbox.chain=$2 AND outbox.domain=item.domain
            AND outbox.block_hash=item."blockHash" AND outbox.log_index=item."logIndex"
            AND outbox.status='leased' AND outbox.lease_owner=$3 AND outbox.lease_until>NOW()`,
        [JSON.stringify(blocked), CHAIN, owner]
      );
      const retried = await client.query(
        `UPDATE robinhood_chain_domain_outbox outbox
            SET status=CASE WHEN outbox.attempt_count >= $4 THEN 'blocked' ELSE 'pending' END,
                lease_owner=NULL, lease_until=NULL, last_error=item.error,
                next_attempt_at=NOW() + (item."backoffMs" * INTERVAL '1 millisecond'),
                updated_at=NOW()
           FROM jsonb_to_recordset($1::jsonb) item(
             domain text, "blockHash" text, "logIndex" integer, error jsonb, "backoffMs" bigint
           )
          WHERE outbox.chain=$2 AND outbox.domain=item.domain
            AND outbox.block_hash=item."blockHash" AND outbox.log_index=item."logIndex"
            AND outbox.status='leased' AND outbox.lease_owner=$3 AND outbox.lease_until>NOW()
        RETURNING outbox.status`,
        [JSON.stringify(retry), CHAIN, owner, maxAttempts]
      );
      await client.query('COMMIT');
      const newlyBlocked = retried.rows.filter((row) => row.status === 'blocked').length;
      return {
        completed: completed.rowCount, blocked: dead.rowCount + newlyBlocked,
        retried: retried.rowCount - newlyBlocked,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function reclaimExpiredLeases() {
    const result = await database.query(
      `UPDATE robinhood_chain_domain_outbox
          SET status='pending', lease_owner=NULL, lease_until=NULL, updated_at=NOW()
        WHERE chain=$1 AND status='leased' AND lease_until<=NOW()`, [CHAIN]
    );
    return result.rowCount;
  }

  return Object.freeze({
    claimNextBlock, claimReady, claimShadow, settle, reclaimExpiredLeases,
  });
}

module.exports = { createRobinhoodChainDomainOutboxRepository };
