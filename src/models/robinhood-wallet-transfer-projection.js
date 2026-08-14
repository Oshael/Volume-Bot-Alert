const db = require('./db');
const CHAIN = 'robinhood';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const STREAMS = new Set(['seed', 'live']);
const EDGE_KINDS = new Set(['wallet_transfer', 'dex_flow']);
function identifier(value, label) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}
function address(value, label) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(result)) throw new Error(`${label} must be a 20-byte address`);
  return result;
}
function hash(value, label) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) throw new Error(`${label} must be a 32-byte hash`);
  return result;
}
function uint(value, label) {
  const result = String(value ?? '').trim();
  if (!/^\d+$/.test(result)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(result).toString();
}
function index(value, label) {
  const result = uint(value, label);
  if (BigInt(result) > 2_147_483_647n) throw new Error(`${label} exceeds PostgreSQL integer`);
  return Number(result);
}
function timestamp(value, label) {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a timestamp`);
  return date.toISOString();
}
function optionalDay(value) {
  if (value == null || value === '') return null;
  const result = String(value);
  const date = new Date(`${result}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(date.getTime())
      || date.toISOString().slice(0, 10) !== result) {
    throw new Error('summarizedThroughDay must be a valid UTC day');
  }
  return result;
}
function position(input, prefix = '') {
  return {
    block: uint(input[`${prefix}Block`], `${prefix}Block`),
    transactionIndex: index(input[`${prefix}TransactionIndex`] ?? 0, `${prefix}TransactionIndex`),
    logIndex: index(input[`${prefix}LogIndex`] ?? 0, `${prefix}LogIndex`),
  };
}
function comparePosition(left, right) {
  const block = BigInt(left.block) - BigInt(right.block);
  if (block !== 0n) return block < 0n ? -1 : 1;
  return left.transactionIndex - right.transactionIndex || left.logIndex - right.logIndex;
}
function normalizeEvent(input, projectionVersion) {
  const transferKind = String(input.transferKind ?? '').trim();
  if (!EDGE_KINDS.has(transferKind)) throw new Error('transferKind is not edge-eligible');
  if (identifier(input.classificationVersion, 'classificationVersion') !== projectionVersion) {
    throw new Error('classificationVersion must match projectionVersion');
  }
  const fromWallet = address(input.fromWallet, 'fromWallet');
  const toWallet = address(input.toWallet, 'toWallet');
  if (fromWallet === ZERO_ADDRESS || toWallet === ZERO_ADDRESS || fromWallet === toWallet) {
    throw new Error('edge endpoints must be distinct non-zero addresses');
  }
  return {
    block: uint(input.blockNumber, 'blockNumber'),
    transactionIndex: index(input.transactionIndex ?? 0, 'transactionIndex'),
    logIndex: index(input.logIndex ?? 0, 'logIndex'),
    blockTime: timestamp(input.blockTime, 'blockTime'),
    transactionHash: hash(input.transactionHash, 'transactionHash'),
    tokenAddress: address(input.tokenAddress, 'tokenAddress'),
    fromWallet, toWallet, amountRaw: uint(input.amountRaw, 'amountRaw'), transferKind,
  };
}
function earlier(left, right) { return comparePosition(left, right) < 0 ? left : right; }
function later(left, right) { return comparePosition(left, right) > 0 ? left : right; }
function larger(left, right) {
  const amount = BigInt(left.amountRaw) - BigInt(right.amountRaw);
  if (amount !== 0n) return amount > 0n ? left : right;
  return earlier(left, right);
}
function addDailySummary(summaries, event) {
  const summaryDay = event.blockTime.slice(0, 10);
  const key = `${summaryDay}:${event.tokenAddress}`;
  const summary = summaries.get(key) || {
    summaryDay, tokenAddress: event.tokenAddress, transferCount: 0n, totalAmountRaw: 0n,
    walletTransferCount: 0n, walletTransferAmountRaw: 0n,
    dexFlowCount: 0n, dexFlowAmountRaw: 0n, through: event,
  };
  const amount = BigInt(event.amountRaw);
  summary.transferCount += 1n;
  summary.totalAmountRaw += amount;
  if (event.transferKind === 'wallet_transfer') {
    summary.walletTransferCount += 1n;
    summary.walletTransferAmountRaw += amount;
  } else {
    summary.dexFlowCount += 1n;
    summary.dexFlowAmountRaw += amount;
  }
  summary.through = later(summary.through, event);
  summaries.set(key, summary);
}
function summarize(events, projectionVersion) {
  const normalized = events.map((event) => normalizeEvent(event, projectionVersion));
  const identities = new Set(normalized.map((event) => (
    `${event.transactionHash}:${event.logIndex}`
  )));
  if (identities.size !== normalized.length) throw new Error('batch has duplicate transfers');
  normalized.sort(comparePosition);

  const edges = new Map();
  const relationships = new Map();
  const dailySummaries = new Map();
  for (const event of normalized) {
    addDailySummary(dailySummaries, event);
    const edgeKey = `${event.tokenAddress}:${event.fromWallet}:${event.toWallet}`;
    const edge = edges.get(edgeKey) || {
      tokenAddress: event.tokenAddress, fromWallet: event.fromWallet,
      toWallet: event.toWallet, transferCount: 0n, totalAmountRaw: 0n,
      walletTransferCount: 0n, dexFlowCount: 0n,
      first: event, last: event, largest: event,
    };
    edge.transferCount += 1n;
    edge.totalAmountRaw += BigInt(event.amountRaw);
    edge.walletTransferCount += event.transferKind === 'wallet_transfer' ? 1n : 0n;
    edge.dexFlowCount += event.transferKind === 'dex_flow' ? 1n : 0n;
    edge.first = earlier(edge.first, event);
    edge.last = later(edge.last, event);
    edge.largest = larger(edge.largest, event);
    edges.set(edgeKey, edge);

    if (event.transferKind !== 'wallet_transfer') continue;
    const [leftWallet, rightWallet] = [event.fromWallet, event.toWallet].sort();
    const relationshipKey = `${event.tokenAddress}:${leftWallet}:${rightWallet}`;
    const relationship = relationships.get(relationshipKey) || {
      tokenAddress: event.tokenAddress, leftWallet, rightWallet,
      first: event, last: event, largest: event,
    };
    relationship.first = earlier(relationship.first, event);
    relationship.last = later(relationship.last, event);
    relationship.largest = larger(relationship.largest, event);
    relationships.set(relationshipKey, relationship);
  }
  return {
    events: normalized, edges: [...edges.values()], relationships: [...relationships.values()],
    dailySummaries: [...dailySummaries.values()],
  };
}
function cursor(row) {
  return row ? {
    projectionVersion: row.projection_version, stream: row.stream,
    originBlock: row.origin_block == null ? null : String(row.origin_block),
    nextBlock: String(row.next_block), nextTransactionIndex: row.next_transaction_index,
    nextLogIndex: row.next_log_index, nextBlockTime: new Date(row.next_block_time).toISOString(),
    safeHead: row.safe_head == null ? null : String(row.safe_head),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash || null,
    summarizedThroughDay: row.summarized_through_day == null
      ? null : new Date(row.summarized_through_day).toISOString().slice(0, 10),
    lifecycleState: row.lifecycle_state, version: Number(row.version),
  } : null;
}
function normalizeCommitInput(input) {
  const projectionVersion = identifier(input.projectionVersion, 'projectionVersion');
  const stream = identifier(input.stream, 'stream');
  if (!STREAMS.has(stream)) throw new Error('stream must be seed or live');
  const next = position(input, 'next');
  const nextBlockTime = timestamp(input.nextBlockTime, 'nextBlockTime');
  const safeHead = input.safeHead == null ? null : uint(input.safeHead, 'safeHead');
  const checkpointBlock = input.checkpointBlock == null
    ? null : uint(input.checkpointBlock, 'checkpointBlock');
  const checkpointHash = input.checkpointHash == null
    ? null : hash(input.checkpointHash, 'checkpointHash');
  if ((checkpointBlock === null) !== (checkpointHash === null)
      || (checkpointBlock !== null && BigInt(checkpointBlock) > BigInt(next.block))) {
    throw new Error('checkpoint is inconsistent with next position');
  }
  const summarizedThroughDay = optionalDay(input.summarizedThroughDay);
  if (summarizedThroughDay !== null && summarizedThroughDay >= nextBlockTime.slice(0, 10)) {
    throw new Error('summarizedThroughDay must precede nextBlockTime');
  }
  if (input.events != null && !Array.isArray(input.events)) throw new Error('events must be a list');
  return {
    projectionVersion, stream, expectedVersion: uint(input.expectedVersion, 'expectedVersion'),
    next, nextBlockTime, safeHead, checkpointBlock, checkpointHash, summarizedThroughDay,
    summary: summarize(Array.isArray(input.events) ? input.events : [], projectionVersion),
  };
}
function currentPosition(current) {
  return {
    block: String(current.next_block), transactionIndex: current.next_transaction_index,
    logIndex: current.next_log_index,
  };
}
function cursorConflict(current, batch, effectiveSafeHead) {
  return comparePosition(currentPosition(current), batch.next) >= 0
    || (batch.safeHead !== null && current.safe_head != null
      && BigInt(batch.safeHead) < BigInt(current.safe_head))
    || (batch.checkpointBlock !== null && current.checkpoint_block != null
      && BigInt(batch.checkpointBlock) < BigInt(current.checkpoint_block))
    || (batch.checkpointBlock !== null && String(current.checkpoint_block) === batch.checkpointBlock
      && current.checkpoint_hash !== batch.checkpointHash)
    || (batch.checkpointBlock !== null && effectiveSafeHead !== null
      && BigInt(batch.checkpointBlock) > BigInt(effectiveSafeHead))
    || new Date(batch.nextBlockTime) < new Date(current.next_block_time)
    || (batch.summarizedThroughDay !== null && current.summarized_through_day != null
      && batch.summarizedThroughDay
        < new Date(current.summarized_through_day).toISOString().slice(0, 10));
}
function hasEventOutsideRange(current, batch, effectiveSafeHead) {
  const start = currentPosition(current);
  const startTime = new Date(current.next_block_time).toISOString();
  return batch.summary.events.some((event) => (
    comparePosition(event, start) < 0 || comparePosition(event, batch.next) >= 0
    || event.blockTime < startTime || event.blockTime > batch.nextBlockTime
    || (effectiveSafeHead !== null && BigInt(event.block) > BigInt(effectiveSafeHead))
  ));
}
function rejectionReason(current, batch, effectiveSafeHead) {
  if (cursorConflict(current, batch, effectiveSafeHead)) return 'cursor_conflict';
  return hasEventOutsideRange(current, batch, effectiveSafeHead)
    ? 'event_outside_cursor_range' : null;
}
function createRobinhoodWalletTransferProjectionRepository(options = {}) {
  const database = options.database || db;
  async function loadCursor(projectionVersion, stream) {
    const result = await database.query(
      `SELECT * FROM robinhood_wallet_transfer_cursors
       WHERE chain = $1 AND projection_version = $2 AND stream = $3`,
      [CHAIN, identifier(projectionVersion, 'projectionVersion'), identifier(stream, 'stream')]
    );
    return cursor(result.rows[0]);
  }

  async function initCursor(input = {}) {
    const projectionVersion = identifier(input.projectionVersion, 'projectionVersion');
    const stream = identifier(input.stream, 'stream');
    if (!STREAMS.has(stream)) throw new Error('stream must be seed or live');
    const next = position(input, 'next');
    const originBlock = input.originBlock == null
      ? next.block : uint(input.originBlock, 'originBlock');
    if (BigInt(originBlock) > BigInt(next.block)) throw new Error('originBlock exceeds nextBlock');
    await database.query(
      `INSERT INTO robinhood_wallet_transfer_cursors (
         chain, projection_version, stream, next_block, next_transaction_index,
         next_log_index, next_block_time, safe_head, origin_block
       ) VALUES ($1, $2, $3, $4::bigint, $5::integer, $6::integer, $7::timestamptz,
                 $8::bigint, $9::bigint)
       ON CONFLICT (chain, projection_version, stream) DO NOTHING`,
      [CHAIN, projectionVersion, stream, next.block, next.transactionIndex, next.logIndex,
        timestamp(input.nextBlockTime, 'nextBlockTime'),
        input.safeHead == null ? null : uint(input.safeHead, 'safeHead'), originBlock]
    );
    return loadCursor(projectionVersion, stream);
  }

  async function commitBatch(input = {}) {
    const batch = normalizeCommitInput(input);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT * FROM robinhood_wallet_transfer_cursors
         WHERE chain = $1 AND projection_version = $2 AND stream = $3 FOR UPDATE`,
        [CHAIN, batch.projectionVersion, batch.stream]
      );
      const current = locked.rows[0];
      if (!current || String(current.version) !== batch.expectedVersion
          || !['pending', 'running'].includes(current.lifecycle_state)) {
        await client.query('ROLLBACK');
        return { committed: false, reason: 'cursor_conflict' };
      }
      const effectiveSafeHead = batch.safeHead
        ?? (current.safe_head == null ? null : String(current.safe_head));
      const reason = rejectionReason(current, batch, effectiveSafeHead);
      if (reason) {
        await client.query('ROLLBACK');
        return { committed: false, reason };
      }
      await persistEdges(client, batch.projectionVersion, batch.summary.edges);
      await persistDailySummaries(client, batch.projectionVersion, batch.summary.dailySummaries);
      await persistEvidence(client, batch.projectionVersion, batch.summary.relationships);
      const advanced = await advanceCursor(client, batch, effectiveSafeHead);
      if (!advanced.rows[0]) throw new Error('locked transfer cursor changed unexpectedly');
      await client.query('COMMIT');
      return {
        committed: true, edgeGroups: batch.summary.edges.length,
        dailySummaryGroups: batch.summary.dailySummaries.length,
        evidenceCandidates: batch.summary.relationships.length * 3, cursor: cursor(advanced.rows[0]),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return { commitBatch, initCursor, loadCursor };
}
async function advanceCursor(client, batch, effectiveSafeHead) {
  const complete = batch.stream === 'seed' && effectiveSafeHead !== null
    && BigInt(batch.next.block) > BigInt(effectiveSafeHead);
  return client.query(
    `UPDATE robinhood_wallet_transfer_cursors SET
       next_block = $4::bigint, next_transaction_index = $5::integer,
       next_log_index = $6::integer, next_block_time = $7::timestamptz,
       safe_head = COALESCE($8::bigint, safe_head),
       checkpoint_block = COALESCE($9::bigint, checkpoint_block),
       checkpoint_hash = COALESCE($10, checkpoint_hash),
       summarized_through_day = COALESCE($11::date, summarized_through_day),
       lifecycle_state = CASE WHEN $12::boolean THEN 'complete' ELSE 'running' END,
       completed_at = CASE WHEN $12::boolean THEN NOW() ELSE NULL END,
       state_reason = NULL, failed_at = NULL, version = version + 1, updated_at = NOW()
     WHERE chain = $1 AND projection_version = $2 AND stream = $3 AND version = $13::bigint
     RETURNING *`,
    [CHAIN, batch.projectionVersion, batch.stream, batch.next.block,
      batch.next.transactionIndex, batch.next.logIndex, batch.nextBlockTime,
      batch.safeHead, batch.checkpointBlock, batch.checkpointHash, batch.summarizedThroughDay,
      complete, batch.expectedVersion]
  );
}
async function persistEdges(client, projectionVersion, edges) {
  if (!edges.length) return;
  const rows = edges.map((edge) => ({
    token_address: edge.tokenAddress, from_wallet: edge.fromWallet, to_wallet: edge.toWallet,
    transfer_count: edge.transferCount.toString(), total_amount_raw: edge.totalAmountRaw.toString(),
    wallet_transfer_count: edge.walletTransferCount.toString(), dex_flow_count: edge.dexFlowCount.toString(),
    first_block: edge.first.block, first_log_index: edge.first.logIndex,
    first_seen_at: edge.first.blockTime, first_transaction_hash: edge.first.transactionHash,
    last_block: edge.last.block, last_log_index: edge.last.logIndex,
    last_seen_at: edge.last.blockTime, last_transaction_hash: edge.last.transactionHash,
    largest_amount_raw: edge.largest.amountRaw, largest_log_index: edge.largest.logIndex,
    largest_transaction_hash: edge.largest.transactionHash,
  }));
  await client.query(
    `INSERT INTO robinhood_wallet_transfer_edges (
       chain, classification_version, token_address, from_wallet, to_wallet,
       transfer_count, total_amount_raw, wallet_transfer_count, dex_flow_count,
       first_block, first_log_index, first_seen_at, first_transaction_hash,
       last_block, last_log_index, last_seen_at, last_transaction_hash,
       largest_amount_raw, largest_log_index, largest_transaction_hash
     ) SELECT $1, $2, item.token_address, item.from_wallet, item.to_wallet,
       item.transfer_count::bigint, item.total_amount_raw::numeric,
       item.wallet_transfer_count::bigint, item.dex_flow_count::bigint,
       item.first_block::bigint, item.first_log_index::integer, item.first_seen_at::timestamptz,
       item.first_transaction_hash, item.last_block::bigint, item.last_log_index::integer,
       item.last_seen_at::timestamptz, item.last_transaction_hash,
       item.largest_amount_raw::numeric, item.largest_log_index::integer,
       item.largest_transaction_hash FROM jsonb_to_recordset($3::jsonb) AS item(
         token_address text, from_wallet text, to_wallet text, transfer_count text,
         total_amount_raw text, wallet_transfer_count text, dex_flow_count text,
         first_block text, first_log_index int, first_seen_at text, first_transaction_hash text,
         last_block text, last_log_index int, last_seen_at text, last_transaction_hash text,
         largest_amount_raw text, largest_log_index int, largest_transaction_hash text
       ) ON CONFLICT (chain, classification_version, token_address, from_wallet, to_wallet)
     DO UPDATE SET transfer_count = robinhood_wallet_transfer_edges.transfer_count + EXCLUDED.transfer_count,
       total_amount_raw = robinhood_wallet_transfer_edges.total_amount_raw + EXCLUDED.total_amount_raw,
       wallet_transfer_count = robinhood_wallet_transfer_edges.wallet_transfer_count + EXCLUDED.wallet_transfer_count,
       dex_flow_count = robinhood_wallet_transfer_edges.dex_flow_count + EXCLUDED.dex_flow_count,
       first_block = CASE WHEN (EXCLUDED.first_block, EXCLUDED.first_log_index) <
         (robinhood_wallet_transfer_edges.first_block, robinhood_wallet_transfer_edges.first_log_index)
         THEN EXCLUDED.first_block ELSE robinhood_wallet_transfer_edges.first_block END,
       first_log_index = CASE WHEN (EXCLUDED.first_block, EXCLUDED.first_log_index) <
         (robinhood_wallet_transfer_edges.first_block, robinhood_wallet_transfer_edges.first_log_index)
         THEN EXCLUDED.first_log_index ELSE robinhood_wallet_transfer_edges.first_log_index END,
       first_seen_at = CASE WHEN (EXCLUDED.first_block, EXCLUDED.first_log_index) <
         (robinhood_wallet_transfer_edges.first_block, robinhood_wallet_transfer_edges.first_log_index)
         THEN EXCLUDED.first_seen_at ELSE robinhood_wallet_transfer_edges.first_seen_at END,
       first_transaction_hash = CASE WHEN (EXCLUDED.first_block, EXCLUDED.first_log_index) <
         (robinhood_wallet_transfer_edges.first_block, robinhood_wallet_transfer_edges.first_log_index)
         THEN EXCLUDED.first_transaction_hash ELSE robinhood_wallet_transfer_edges.first_transaction_hash END,
       last_block = CASE WHEN (EXCLUDED.last_block, EXCLUDED.last_log_index) >
         (robinhood_wallet_transfer_edges.last_block, robinhood_wallet_transfer_edges.last_log_index)
         THEN EXCLUDED.last_block ELSE robinhood_wallet_transfer_edges.last_block END,
       last_log_index = CASE WHEN (EXCLUDED.last_block, EXCLUDED.last_log_index) >
         (robinhood_wallet_transfer_edges.last_block, robinhood_wallet_transfer_edges.last_log_index)
         THEN EXCLUDED.last_log_index ELSE robinhood_wallet_transfer_edges.last_log_index END,
       last_seen_at = CASE WHEN (EXCLUDED.last_block, EXCLUDED.last_log_index) >
         (robinhood_wallet_transfer_edges.last_block, robinhood_wallet_transfer_edges.last_log_index)
         THEN EXCLUDED.last_seen_at ELSE robinhood_wallet_transfer_edges.last_seen_at END,
       last_transaction_hash = CASE WHEN (EXCLUDED.last_block, EXCLUDED.last_log_index) >
         (robinhood_wallet_transfer_edges.last_block, robinhood_wallet_transfer_edges.last_log_index)
         THEN EXCLUDED.last_transaction_hash ELSE robinhood_wallet_transfer_edges.last_transaction_hash END,
       largest_amount_raw = GREATEST(robinhood_wallet_transfer_edges.largest_amount_raw, EXCLUDED.largest_amount_raw),
       largest_log_index = CASE WHEN EXCLUDED.largest_amount_raw > robinhood_wallet_transfer_edges.largest_amount_raw
         THEN EXCLUDED.largest_log_index ELSE robinhood_wallet_transfer_edges.largest_log_index END,
       largest_transaction_hash = CASE WHEN EXCLUDED.largest_amount_raw > robinhood_wallet_transfer_edges.largest_amount_raw
         THEN EXCLUDED.largest_transaction_hash ELSE robinhood_wallet_transfer_edges.largest_transaction_hash END,
       updated_at = NOW()`,
    [CHAIN, projectionVersion, JSON.stringify(rows)]
  );
}
async function persistDailySummaries(client, projectionVersion, summaries) {
  if (!summaries.length) return;
  const rows = summaries.map((summary) => ({
    summary_day: summary.summaryDay, token_address: summary.tokenAddress,
    transfer_count: summary.transferCount.toString(),
    total_amount_raw: summary.totalAmountRaw.toString(),
    wallet_transfer_count: summary.walletTransferCount.toString(),
    wallet_transfer_amount_raw: summary.walletTransferAmountRaw.toString(),
    dex_flow_count: summary.dexFlowCount.toString(),
    dex_flow_amount_raw: summary.dexFlowAmountRaw.toString(),
    through_block: summary.through.block,
    through_transaction_index: summary.through.transactionIndex,
    through_log_index: summary.through.logIndex,
    through_block_time: summary.through.blockTime,
  }));
  await client.query(
    `INSERT INTO robinhood_wallet_transfer_daily_summaries (
       chain, projection_version, summary_day, token_address,
       transfer_count, total_amount_raw, wallet_transfer_count,
       wallet_transfer_amount_raw, dex_flow_count, dex_flow_amount_raw,
       through_block, through_transaction_index, through_log_index, through_block_time
     ) SELECT $1, $2, item.summary_day::date, item.token_address,
       item.transfer_count::bigint, item.total_amount_raw::numeric,
       item.wallet_transfer_count::bigint, item.wallet_transfer_amount_raw::numeric,
       item.dex_flow_count::bigint, item.dex_flow_amount_raw::numeric,
       item.through_block::bigint, item.through_transaction_index::integer,
       item.through_log_index::integer, item.through_block_time::timestamptz
       FROM jsonb_to_recordset($3::jsonb) AS item(
         summary_day text, token_address text, transfer_count text, total_amount_raw text,
         wallet_transfer_count text, wallet_transfer_amount_raw text,
         dex_flow_count text, dex_flow_amount_raw text, through_block text,
         through_transaction_index int, through_log_index int, through_block_time text
       ) ON CONFLICT (chain, projection_version, summary_day, token_address)
     DO UPDATE SET
       transfer_count = robinhood_wallet_transfer_daily_summaries.transfer_count
         + EXCLUDED.transfer_count,
       total_amount_raw = robinhood_wallet_transfer_daily_summaries.total_amount_raw
         + EXCLUDED.total_amount_raw,
       wallet_transfer_count = robinhood_wallet_transfer_daily_summaries.wallet_transfer_count
         + EXCLUDED.wallet_transfer_count,
       wallet_transfer_amount_raw = robinhood_wallet_transfer_daily_summaries.wallet_transfer_amount_raw
         + EXCLUDED.wallet_transfer_amount_raw,
       dex_flow_count = robinhood_wallet_transfer_daily_summaries.dex_flow_count
         + EXCLUDED.dex_flow_count,
       dex_flow_amount_raw = robinhood_wallet_transfer_daily_summaries.dex_flow_amount_raw
         + EXCLUDED.dex_flow_amount_raw,
       through_block = CASE WHEN (EXCLUDED.through_block, EXCLUDED.through_transaction_index,
         EXCLUDED.through_log_index) > (robinhood_wallet_transfer_daily_summaries.through_block,
         robinhood_wallet_transfer_daily_summaries.through_transaction_index,
         robinhood_wallet_transfer_daily_summaries.through_log_index)
         THEN EXCLUDED.through_block ELSE robinhood_wallet_transfer_daily_summaries.through_block END,
       through_transaction_index = CASE WHEN (EXCLUDED.through_block,
         EXCLUDED.through_transaction_index, EXCLUDED.through_log_index) >
         (robinhood_wallet_transfer_daily_summaries.through_block,
         robinhood_wallet_transfer_daily_summaries.through_transaction_index,
         robinhood_wallet_transfer_daily_summaries.through_log_index)
         THEN EXCLUDED.through_transaction_index
         ELSE robinhood_wallet_transfer_daily_summaries.through_transaction_index END,
       through_log_index = CASE WHEN (EXCLUDED.through_block, EXCLUDED.through_transaction_index,
         EXCLUDED.through_log_index) > (robinhood_wallet_transfer_daily_summaries.through_block,
         robinhood_wallet_transfer_daily_summaries.through_transaction_index,
         robinhood_wallet_transfer_daily_summaries.through_log_index)
         THEN EXCLUDED.through_log_index
         ELSE robinhood_wallet_transfer_daily_summaries.through_log_index END,
       through_block_time = CASE WHEN (EXCLUDED.through_block, EXCLUDED.through_transaction_index,
         EXCLUDED.through_log_index) > (robinhood_wallet_transfer_daily_summaries.through_block,
         robinhood_wallet_transfer_daily_summaries.through_transaction_index,
         robinhood_wallet_transfer_daily_summaries.through_log_index)
         THEN EXCLUDED.through_block_time
         ELSE robinhood_wallet_transfer_daily_summaries.through_block_time END,
       updated_at = NOW()`,
    [CHAIN, projectionVersion, JSON.stringify(rows)]
  );
}
async function persistEvidence(client, projectionVersion, relationships) {
  if (!relationships.length) return;
  const rows = relationships.flatMap((relationship) => (
    ['first', 'last', 'largest'].map((role) => {
      const event = relationship[role];
      return {
        token_address: relationship.tokenAddress, left_wallet: relationship.leftWallet,
        right_wallet: relationship.rightWallet, evidence_role: role,
        evidence_transaction_hash: event.transactionHash, evidence_block: event.block,
        evidence_log_index: event.logIndex, evidence_at: event.blockTime, amount_raw: event.amountRaw,
      };
    })
  ));
  await client.query(
    `INSERT INTO robinhood_wallet_relationship_evidence (
       chain, token_address, left_wallet, right_wallet, relationship_kind, evidence_role,
       evidence_transaction_hash, evidence_block, evidence_log_index, evidence_at,
       amount_raw, score_component, algorithm_version
     ) SELECT $1, item.token_address, item.left_wallet, item.right_wallet,
       'direct_token_transfer', item.evidence_role, item.evidence_transaction_hash,
       item.evidence_block::bigint, item.evidence_log_index::integer,
       item.evidence_at::timestamptz, item.amount_raw::numeric,
       'direct_token_transfer', $2 FROM jsonb_to_recordset($3::jsonb) AS item(
         token_address text, left_wallet text, right_wallet text, evidence_role text,
         evidence_transaction_hash text, evidence_block text, evidence_log_index int,
         evidence_at text, amount_raw text
       ) ON CONFLICT (chain, algorithm_version,
         (COALESCE(token_address, '0x0000000000000000000000000000000000000000')),
         left_wallet, right_wallet, relationship_kind, evidence_role)
     DO UPDATE SET evidence_transaction_hash = EXCLUDED.evidence_transaction_hash,
       evidence_block = EXCLUDED.evidence_block, evidence_log_index = EXCLUDED.evidence_log_index,
       evidence_at = EXCLUDED.evidence_at, amount_raw = EXCLUDED.amount_raw, created_at = NOW()
     WHERE (robinhood_wallet_relationship_evidence.evidence_role = 'first' AND
         (EXCLUDED.evidence_block, EXCLUDED.evidence_log_index) <
         (robinhood_wallet_relationship_evidence.evidence_block,
          robinhood_wallet_relationship_evidence.evidence_log_index))
       OR (robinhood_wallet_relationship_evidence.evidence_role = 'last' AND
         (EXCLUDED.evidence_block, EXCLUDED.evidence_log_index) >
         (robinhood_wallet_relationship_evidence.evidence_block,
          robinhood_wallet_relationship_evidence.evidence_log_index))
       OR (robinhood_wallet_relationship_evidence.evidence_role = 'largest' AND
         EXCLUDED.amount_raw > robinhood_wallet_relationship_evidence.amount_raw)`,
    [CHAIN, projectionVersion, JSON.stringify(rows)]
  );
}
module.exports = { createRobinhoodWalletTransferProjectionRepository };
