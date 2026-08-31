const db = require('./db');
const {
  createRobinhoodWalletSignedOriginRepository,
} = require('./robinhood-wallet-signed-origin');

const CHAIN = 'robinhood';

function uint(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be an unsigned integer`);
  return BigInt(normalized).toString();
}

function hash(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be a block hash`);
  return normalized;
}

function normalizeCursor(row) {
  if (!row) return null;
  return Object.freeze({
    stream: row.stream, originBlock: String(row.origin_block),
    originBlockHash: row.origin_block_hash, nextBlock: String(row.next_block),
    safeHead: String(row.safe_head), safeHeadHash: row.safe_head_hash,
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash,
    checkpointTimestamp: row.checkpoint_timestamp?.toISOString?.()
      || row.checkpoint_timestamp || null,
    lifecycleState: row.lifecycle_state, version: Number(row.version),
  });
}

function frozenPlan(input = {}) {
  const result = {
    stream: String(input.stream || 'seed'),
    originBlock: uint(input.originBlock, 'originBlock'),
    originBlockHash: hash(input.originBlockHash, 'originBlockHash'),
    safeHead: uint(input.safeHead, 'safeHead'),
    safeHeadHash: hash(input.safeHeadHash, 'safeHeadHash'),
  };
  if (result.stream !== 'seed' || BigInt(result.safeHead) < BigInt(result.originBlock)) {
    throw new Error('signed-origin bootstrap frozen plan is invalid');
  }
  return result;
}

function cursorConflict(message) {
  return Object.assign(new Error(message), { code: 'signed_origin_cursor_conflict' });
}

function reorgConflict(message) {
  return Object.assign(new Error(message), { code: 'persistent_reorg', fatal: true });
}

function blocks(input, cursor) {
  if (!Array.isArray(input.blocks) || !input.blocks.length) {
    throw new Error('signed-origin batch must contain explicit blocks');
  }
  let expected = BigInt(cursor.nextBlock);
  return input.blocks.map((value) => {
    const number = BigInt(uint(value.number, 'block.number'));
    if (number !== expected || number > BigInt(cursor.safeHead)) {
      throw new Error('signed-origin batch is not contiguous from the cursor');
    }
    expected += 1n;
    const blockTime = new Date(value.blockTime);
    if (!Number.isFinite(blockTime.getTime())) throw new Error('block.blockTime is invalid');
    const blockHash = hash(value.hash, 'block.hash');
    if ((number === BigInt(cursor.originBlock) && blockHash !== cursor.originBlockHash)
        || (number === BigInt(cursor.safeHead) && blockHash !== cursor.safeHeadHash)) {
      throw cursorConflict('signed-origin batch diverged from its frozen frontier');
    }
    return { number: number.toString(), hash: blockHash, blockTime: blockTime.toISOString() };
  });
}

function assertFrozen(cursor, plan) {
  if (!cursor || cursor.stream !== plan.stream || cursor.originBlock !== plan.originBlock
      || cursor.originBlockHash !== plan.originBlockHash || cursor.safeHead !== plan.safeHead
      || cursor.safeHeadHash !== plan.safeHeadHash) {
    throw cursorConflict('signed-origin bootstrap frozen frontier diverged');
  }
}

function assertOrigins(values, cursor, acceptedBlocks) {
  for (const origin of values || []) {
    const block = BigInt(uint(origin.blockNumber, 'origin.blockNumber'));
    const sourceBlock = acceptedBlocks.find((item) => BigInt(item.number) === block);
    if (origin.sourceStream !== cursor.stream
        || String(origin.coverageOriginBlock) !== cursor.originBlock
        || !sourceBlock || hash(origin.blockHash, 'origin.blockHash') !== sourceBlock.hash
        || new Date(origin.blockTime).toISOString() !== sourceBlock.blockTime) {
      throw new Error('signed-origin evidence is outside the committed batch');
    }
  }
}

function liveBlocks(input, cursor, safeHead) {
  const liveCursor = { ...cursor, safeHead, safeHeadHash: input.safeHeadHash };
  return blocks(input, liveCursor);
}

function createRobinhoodWalletSignedOriginCursorRepository(options = {}) {
  const database = options.database || db;
  const origins = options.origins || createRobinhoodWalletSignedOriginRepository({ database });

  async function loadCursor(stream = 'seed', client = database, lock = false) {
    const result = await client.query(`SELECT * FROM robinhood_wallet_signed_origin_cursors
      WHERE chain = $1 AND stream = $2${lock ? ' FOR UPDATE' : ''}`, [CHAIN, stream]);
    return normalizeCursor(result.rows[0]);
  }

  async function createOrResume(input) {
    const plan = frozenPlan(input);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO robinhood_wallet_signed_origin_cursors(
        chain, stream, origin_block, origin_block_hash, next_block,
        safe_head, safe_head_hash, lifecycle_state
      ) VALUES ($1, $2, $3::bigint, $4, $3::bigint, $5::bigint, $6, 'running')
      ON CONFLICT (chain, stream) DO NOTHING`, [
        CHAIN, plan.stream, plan.originBlock, plan.originBlockHash,
        plan.safeHead, plan.safeHeadHash,
      ]);
      const cursor = normalizeCursor((await client.query(`SELECT *
        FROM robinhood_wallet_signed_origin_cursors
        WHERE chain = $1 AND stream = $2 FOR UPDATE`, [CHAIN, plan.stream])).rows[0]);
      assertFrozen(cursor, plan);
      await client.query('COMMIT');
      return cursor;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
  }

  async function initializeLiveFromSeed() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const seed = normalizeCursor((await client.query(`SELECT *
        FROM robinhood_wallet_signed_origin_cursors
        WHERE chain = $1 AND stream = 'seed' FOR UPDATE`, [CHAIN])).rows[0]);
      if (!seed || seed.lifecycleState !== 'completed') {
        throw Object.assign(new Error('signed-origin seed coverage is incomplete'), {
          code: 'signed_origin_seed_incomplete',
        });
      }
      await client.query(`INSERT INTO robinhood_wallet_signed_origin_cursors(
        chain, stream, origin_block, origin_block_hash, next_block,
        safe_head, safe_head_hash, checkpoint_block, checkpoint_hash,
        checkpoint_timestamp, lifecycle_state
      ) VALUES ($1, 'live', $2::bigint, $3, $4::bigint, $5::bigint, $6,
        $7::bigint, $8, $9::timestamptz, 'caught_up')
      ON CONFLICT (chain, stream) DO NOTHING`, [CHAIN, seed.originBlock,
        seed.originBlockHash, seed.nextBlock, seed.safeHead, seed.safeHeadHash,
        seed.checkpointBlock, seed.checkpointHash, seed.checkpointTimestamp]);
      const live = normalizeCursor((await client.query(`SELECT *
        FROM robinhood_wallet_signed_origin_cursors
        WHERE chain = $1 AND stream = 'live' FOR UPDATE`, [CHAIN])).rows[0]);
      if (!live || live.originBlock !== seed.originBlock
          || live.originBlockHash !== seed.originBlockHash
          || BigInt(live.nextBlock) < BigInt(seed.nextBlock)
          || BigInt(live.safeHead) < BigInt(seed.safeHead)) {
        throw cursorConflict('signed-origin LIVE cursor diverged from seed handoff');
      }
      await client.query('COMMIT');
      return live;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
  }

  async function commitBatch(input = {}) {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const cursor = await loadCursor(input.stream || 'seed', client, true);
      if (!cursor || cursor.version !== Number(input.expectedVersion)
          || cursor.nextBlock !== String(input.expectedNextBlock)
          || cursor.lifecycleState !== 'running') {
        throw cursorConflict('signed-origin cursor changed before batch commit');
      }
      const acceptedBlocks = blocks(input, cursor);
      assertOrigins(input.origins, cursor, acceptedBlocks);
      const persist = origins.persistForwardOrigins || origins.persistOrigins;
      const persisted = await persist.call(origins, input.origins || [], { client });
      const checkpoint = acceptedBlocks.at(-1);
      const nextBlock = (BigInt(checkpoint.number) + 1n).toString();
      const completed = nextBlock === (BigInt(cursor.safeHead) + 1n).toString();
      const updated = (await client.query(`UPDATE robinhood_wallet_signed_origin_cursors SET
        next_block = $3::bigint, checkpoint_block = $4::bigint,
        checkpoint_hash = $5, checkpoint_timestamp = $6::timestamptz,
        lifecycle_state = $7, version = version + 1, updated_at = NOW()
        WHERE chain = $1 AND stream = $2 AND version = $8
        RETURNING *`, [CHAIN, cursor.stream, nextBlock, checkpoint.number,
        checkpoint.hash, checkpoint.blockTime, completed ? 'completed' : 'running',
        cursor.version])).rows[0];
      if (!updated) throw cursorConflict('signed-origin cursor update lost optimistic lock');
      await client.query('COMMIT');
      return Object.freeze({ cursor: normalizeCursor(updated), ...persisted,
        blocksCommitted: acceptedBlocks.length });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
  }


  async function commitLiveBatch(input = {}) {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const cursor = await loadCursor('live', client, true);
      if (!cursor || cursor.version !== Number(input.expectedVersion)
          || cursor.nextBlock !== String(input.expectedNextBlock)
          || !['running', 'caught_up'].includes(cursor.lifecycleState)) {
        throw cursorConflict('signed-origin LIVE cursor changed before batch commit');
      }
      const safeHead = uint(input.safeHead, 'safeHead');
      const safeHeadHash = hash(input.safeHeadHash, 'safeHeadHash');
      if (BigInt(safeHead) < BigInt(cursor.safeHead)) {
        throw reorgConflict('signed-origin LIVE safe frontier regressed');
      }
      const acceptedBlocks = liveBlocks(input, cursor, safeHead);
      assertOrigins(input.origins, cursor, acceptedBlocks);
      const persist = origins.persistForwardOrigins || origins.persistOrigins;
      const persisted = await persist.call(origins, input.origins || [], { client });
      const checkpoint = acceptedBlocks.at(-1);
      const nextBlock = (BigInt(checkpoint.number) + 1n).toString();
      const lifecycle = BigInt(nextBlock) > BigInt(safeHead) ? 'caught_up' : 'running';
      const updated = (await client.query(`UPDATE robinhood_wallet_signed_origin_cursors SET
        next_block = $3::bigint, safe_head = $4::bigint, safe_head_hash = $5,
        checkpoint_block = $6::bigint, checkpoint_hash = $7,
        checkpoint_timestamp = $8::timestamptz, lifecycle_state = $9,
        last_error_code = NULL, last_error_message = NULL,
        version = version + 1, updated_at = NOW()
        WHERE chain = $1 AND stream = 'live' AND version = $2 RETURNING *`, [
        CHAIN, cursor.version, nextBlock, safeHead, safeHeadHash, checkpoint.number,
        checkpoint.hash, checkpoint.blockTime, lifecycle,
      ])).rows[0];
      if (!updated) throw cursorConflict('signed-origin LIVE cursor lost optimistic lock');
      await client.query('COMMIT');
      return Object.freeze({ cursor: normalizeCursor(updated), ...persisted,
        blocksCommitted: acceptedBlocks.length });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
  }

  return Object.freeze({ commitBatch, commitLiveBatch, createOrResume,
    initializeLiveFromSeed, loadCursor });
}

module.exports = { createRobinhoodWalletSignedOriginCursorRepository };
