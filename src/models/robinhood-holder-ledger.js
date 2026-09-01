const db = require('./db');

const CHAIN = 'robinhood';
const STREAM = 'live';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const MAX_UINT256 = (1n << 256n) - 1n;
const REORG_FENCE_LOCK_ID = '8241992116082026';
const HOT_FRESH_BLOCK_WINDOW = 200;
const HOT_RECENT_SHADOW_BLOCK_WINDOW = 20000;
const HOT_PRIORITY_CLASSES = new Set([
  'fresh-live', 'recent-shadow', 'stale-live', 'stale-shadow',
]);

function decimalQuantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw).toString();
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function hex(value, bytes, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function normalizeTransfer(value = {}) {
  return Object.freeze({
    blockNumber: decimalQuantity(value.blockNumber, 'transfer.blockNumber'),
    blockHash: hex(value.blockHash, 32, 'transfer.blockHash'),
    transactionHash: hex(value.transactionHash, 32, 'transfer.transactionHash'),
    transactionIndex: nonNegativeInteger(value.transactionIndex, 'transfer.transactionIndex'),
    logIndex: nonNegativeInteger(value.logIndex, 'transfer.logIndex'),
    tokenAddress: hex(value.tokenAddress, 20, 'transfer.tokenAddress'),
    fromWallet: hex(value.fromWallet, 20, 'transfer.fromWallet'),
    toWallet: hex(value.toWallet, 20, 'transfer.toWallet'),
    amountRaw: decimalQuantity(value.amountRaw, 'transfer.amountRaw'),
  });
}

function normalizeCursor(value = {}) {
  const checkpoint = value.checkpoint || {};
  const expectedVersion = value.expectedVersion == null
    ? null : nonNegativeInteger(value.expectedVersion, 'cursor.expectedVersion');
  return Object.freeze({
    rangeStart: decimalQuantity(value.rangeStart, 'cursor.rangeStart'),
    nextBlock: decimalQuantity(value.nextBlock, 'cursor.nextBlock'),
    safeHead: value.safeHead == null ? null : decimalQuantity(value.safeHead, 'cursor.safeHead'),
    checkpointBlock: decimalQuantity(checkpoint.number, 'cursor.checkpoint.number'),
    checkpointHash: hex(checkpoint.hash, 32, 'cursor.checkpoint.hash'),
    bufferedAllTransfers: value.bufferedAllTransfers === true,
    expectedVersion,
  });
}

function normalizeRewind(value = {}) {
  const nextBlock = decimalQuantity(value.nextBlock, 'rewind.nextBlock');
  const safeHead = value.safeHead == null
    ? null : decimalQuantity(value.safeHead, 'rewind.safeHead');
  const expectedVersion = nonNegativeInteger(
    value.expectedVersion, 'rewind.expectedVersion'
  );
  const checkpoint = value.checkpoint == null ? null : Object.freeze({
    number: decimalQuantity(value.checkpoint.number, 'rewind.checkpoint.number'),
    hash: hex(value.checkpoint.hash, 32, 'rewind.checkpoint.hash'),
  });
  const next = BigInt(nextBlock);
  if ((next === 0n) !== (checkpoint === null)) {
    throw new Error('rewind checkpoint must be null only at genesis');
  }
  if (checkpoint && BigInt(checkpoint.number) + 1n !== next) {
    throw new Error('rewind checkpoint must immediately precede nextBlock');
  }
  if (safeHead != null && checkpoint && BigInt(safeHead) < BigInt(checkpoint.number)) {
    throw new Error('rewind safeHead cannot precede its checkpoint');
  }
  return Object.freeze({ nextBlock, safeHead, expectedVersion, checkpoint });
}

function validateRange(transfers, cursor) {
  const rangeStart = BigInt(cursor.rangeStart);
  const nextBlock = BigInt(cursor.nextBlock);
  const checkpointBlock = BigInt(cursor.checkpointBlock);
  if (nextBlock !== checkpointBlock + 1n) {
    throw new Error('cursor.nextBlock must immediately follow its checkpoint');
  }
  if (rangeStart > nextBlock || (cursor.safeHead != null && checkpointBlock > BigInt(cursor.safeHead))) {
    throw new Error('capture range bounds are invalid');
  }
  if (transfers.some(({ blockNumber }) => (
    BigInt(blockNumber) < rangeStart || BigInt(blockNumber) > checkpointBlock
  ))) {
    throw new Error('transfer must be inside the captured range');
  }
}

const TRANSFER_EVIDENCE_FIELDS = Object.freeze([
  'blockNumber', 'blockHash', 'transactionHash', 'transactionIndex', 'logIndex',
  'tokenAddress', 'fromWallet', 'toWallet', 'amountRaw',
]);

function captureConflict() {
  const error = new Error('captured transfer conflicts with existing journal evidence');
  error.code = 'holder_capture_conflict';
  return error;
}

function uniqueTransferEvidence(transfers) {
  const unique = new Map();
  for (const transfer of transfers) {
    const identity = `${transfer.transactionHash}:${transfer.logIndex}`;
    const existing = unique.get(identity);
    if (existing && TRANSFER_EVIDENCE_FIELDS.some(
      (field) => existing[field] !== transfer[field]
    )) throw captureConflict();
    if (!existing) unique.set(identity, transfer);
  }
  return [...unique.values()];
}

async function insertTransfers(client, transfers) {
  const unique = uniqueTransferEvidence(transfers);
  if (!unique.length) return 0;
  const result = await client.query(
    `WITH inserted AS (
       INSERT INTO robinhood_holder_transfer_journal (
         chain, block_number, block_hash, transaction_hash, transaction_index,
         log_index, token_address, from_wallet, to_wallet, amount_raw
       )
       SELECT 'robinhood', item.block_number::bigint, item.block_hash,
              item.transaction_hash, item.transaction_index, item.log_index,
              item.token_address, item.from_wallet, item.to_wallet,
              item.amount_raw::numeric
         FROM jsonb_to_recordset($1::jsonb) AS item(
           block_number text, block_hash text, transaction_hash text,
           transaction_index int, log_index int, token_address text,
           from_wallet text, to_wallet text, amount_raw text
         )
       ON CONFLICT (chain, transaction_hash, log_index) DO UPDATE SET
         captured_at = robinhood_holder_transfer_journal.captured_at
       WHERE robinhood_holder_transfer_journal.block_number = EXCLUDED.block_number
         AND robinhood_holder_transfer_journal.block_hash = EXCLUDED.block_hash
         AND robinhood_holder_transfer_journal.transaction_index = EXCLUDED.transaction_index
         AND robinhood_holder_transfer_journal.token_address = EXCLUDED.token_address
         AND robinhood_holder_transfer_journal.from_wallet = EXCLUDED.from_wallet
         AND robinhood_holder_transfer_journal.to_wallet = EXCLUDED.to_wallet
         AND robinhood_holder_transfer_journal.amount_raw = EXCLUDED.amount_raw
       RETURNING (xmax = 0) AS inserted
     )
     SELECT COUNT(*)::int AS matched,
            COUNT(*) FILTER (WHERE inserted)::int AS inserted
       FROM inserted`,
    [JSON.stringify(unique.map((transfer) => ({
      block_number: transfer.blockNumber,
      block_hash: transfer.blockHash,
      transaction_hash: transfer.transactionHash,
      transaction_index: transfer.transactionIndex,
      log_index: transfer.logIndex,
      token_address: transfer.tokenAddress,
      from_wallet: transfer.fromWallet,
      to_wallet: transfer.toWallet,
      amount_raw: transfer.amountRaw,
    })))]
  );
  if (Number(result.rows[0]?.matched) !== unique.length) throw captureConflict();
  return Number(result.rows[0]?.inserted) || 0;
}

async function advanceCursor(client, cursor) {
  const result = await client.query(
    `INSERT INTO robinhood_holder_cursors (
       chain, stream, next_block, safe_head, checkpoint_block, checkpoint_hash,
       journal_floor_block, buffer_floor_block
     ) VALUES ('robinhood', 'live', $1, $2, $3, $4, $6,
               CASE WHEN $7::boolean THEN $6::bigint ELSE NULL END)
     ON CONFLICT (chain, stream) DO UPDATE SET
       next_block = EXCLUDED.next_block,
       safe_head = EXCLUDED.safe_head,
       checkpoint_block = EXCLUDED.checkpoint_block,
       checkpoint_hash = EXCLUDED.checkpoint_hash,
       journal_floor_block = COALESCE(
         robinhood_holder_cursors.journal_floor_block, EXCLUDED.journal_floor_block
       ),
       buffer_floor_block = CASE WHEN $7::boolean THEN COALESCE(
         robinhood_holder_cursors.buffer_floor_block, EXCLUDED.buffer_floor_block
       ) ELSE robinhood_holder_cursors.buffer_floor_block END,
       version = robinhood_holder_cursors.version + 1,
       updated_at = NOW()
     WHERE $5::bigint IS NOT NULL
       AND robinhood_holder_cursors.version = $5::bigint
       AND robinhood_holder_cursors.next_block = $6::bigint
     RETURNING version`,
    [
      cursor.nextBlock, cursor.safeHead, cursor.checkpointBlock,
      cursor.checkpointHash, cursor.expectedVersion, cursor.rangeStart,
      cursor.bufferedAllTransfers,
    ]
  );
  if (!result.rowCount) {
    const error = new Error('holder capture cursor is stale');
    error.code = 'holder_cursor_stale';
    throw error;
  }
  return Number(result.rows[0].version);
}

function normalizeCursorRow(row) {
  if (!row) return null;
  return Object.freeze({
    stream: row.stream,
    nextBlock: String(row.next_block),
    safeHead: row.safe_head == null ? null : String(row.safe_head),
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash,
    journalFloorBlock: row.journal_floor_block == null
      ? null : String(row.journal_floor_block),
    bufferFloorBlock: row.buffer_floor_block == null
      ? null : String(row.buffer_floor_block),
    version: Number(row.version),
  });
}

function assertHolderBalance(value, transfer, walletAddress) {
  if (value <= MAX_UINT256) return;
  const error = new Error('projected holder balance exceeds uint256');
  error.code = 'holder_balance_overflow';
  error.tokenAddress = transfer.tokenAddress;
  error.walletAddress = walletAddress;
  error.balanceRaw = value.toString();
  error.failedBlock = transfer.blockNumber;
  throw error;
}

function deriveBalanceChanges(value, balances = {}) {
  const transfer = normalizeTransfer(value);
  const amount = BigInt(transfer.amountRaw);
  const getBalance = (wallet) => BigInt(String(balances[wallet] ?? 0));
  const transitions = new Map();
  const record = (wallet, before, after) => transitions.set(wallet, {
    walletAddress: wallet, before: before.toString(), after: after.toString(),
  });
  let fromBefore = null;
  let fromAfter = null;
  let toBefore = null;
  let toAfter = null;

  if (transfer.fromWallet !== ZERO_ADDRESS) {
    fromBefore = getBalance(transfer.fromWallet);
    assertHolderBalance(fromBefore, transfer, transfer.fromWallet);
    if (fromBefore < amount) {
      const error = new Error('transfer amount exceeds the indexed sender balance');
      error.code = 'holder_negative_balance';
      throw error;
    }
    fromAfter = transfer.toWallet === transfer.fromWallet ? fromBefore : fromBefore - amount;
    record(transfer.fromWallet, fromBefore, fromAfter);
  }
  if (transfer.toWallet !== ZERO_ADDRESS) {
    toBefore = transfer.toWallet === transfer.fromWallet
      ? fromBefore : getBalance(transfer.toWallet);
    assertHolderBalance(toBefore, transfer, transfer.toWallet);
    toAfter = transfer.toWallet === transfer.fromWallet
      ? fromBefore : toBefore + amount;
    assertHolderBalance(toAfter, transfer, transfer.toWallet);
    record(transfer.toWallet, toBefore, toAfter);
  }
  const ordered = [...transitions.values()].sort((left, right) => (
    left.walletAddress.localeCompare(right.walletAddress)
  ));
  const holderDelta = ordered.reduce((total, transition) => (
    total + (BigInt(transition.after) > 0n ? 1 : 0)
      - (BigInt(transition.before) > 0n ? 1 : 0)
  ), 0);
  return Object.freeze({
    transfer, transitions: ordered, holderDelta,
    fromBalanceBefore: fromBefore?.toString() ?? null,
    fromBalanceAfter: fromAfter?.toString() ?? null,
    toBalanceBefore: toBefore?.toString() ?? null,
    toBalanceAfter: toAfter?.toString() ?? null,
  });
}

function tokenFilter(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 50_000) throw new Error(`${label} is invalid`);
  return [...new Set(value.map((token) => hex(token, 20, label)))];
}

async function lockReorgFence(client, mode = 'shared') {
  if (!['shared', 'exclusive'].includes(mode)) throw new Error('reorg fence mode is invalid');
  const suffix = mode === 'shared' ? '_shared' : '';
  await client.query(
    `SELECT pg_advisory_xact_lock${suffix}($1::bigint)`, [REORG_FENCE_LOCK_ID]
  );
}

async function lockNextApplicableEvent(client, input = {}) {
  const excluded = tokenFilter(input.excludeTokenAddresses, 'excluded token');
  const onlyToken = input.onlyTokenAddress == null
    ? null : hex(input.onlyTokenAddress, 20, 'only token');
  await lockReorgFence(client, 'shared');
  const result = await client.query(
    `SELECT journal.block_number, journal.block_hash, journal.transaction_hash,
            journal.transaction_index, journal.log_index, journal.token_address,
            journal.from_wallet, journal.to_wallet, journal.amount_raw,
            state.holder_count, state.version, state.ledger_status,
            state.backfill_next_block, state.live_through_block
       FROM robinhood_holder_transfer_journal journal
       INNER JOIN robinhood_holder_token_states state
         ON state.chain = journal.chain AND state.token_address = journal.token_address
        AND state.ledger_status IN ('shadow', 'live')
       INNER JOIN robinhood_holder_cursors cursor
         ON cursor.chain = journal.chain AND cursor.stream = 'live'
      WHERE journal.chain = 'robinhood' AND journal.applied = false
        AND NOT (journal.token_address = ANY($1::varchar[]))
        AND ($2::varchar IS NULL OR journal.token_address = $2)
      ORDER BY journal.block_number, journal.transaction_index, journal.log_index
      LIMIT 1
      FOR UPDATE OF journal, state SKIP LOCKED`,
    [excluded, onlyToken]
  );
  if (!result.rowCount) {
    const cursor = await client.query(
      `SELECT 1 FROM robinhood_holder_cursors
        WHERE chain = 'robinhood' AND stream = 'live'`
    );
    if (!cursor.rowCount) {
      const error = new Error('holder live cursor is missing');
      error.code = 'holder_cursor_missing';
      throw error;
    }
  }
  return result.rows[0] || null;
}

async function lockApplicableTokenEvents(client, first, limit) {
  if (limit === 1) return [first];
  const result = await client.query(
    `SELECT journal.block_number, journal.block_hash, journal.transaction_hash,
            journal.transaction_index, journal.log_index, journal.token_address,
            journal.from_wallet, journal.to_wallet, journal.amount_raw,
            state.holder_count, state.version, state.ledger_status,
            state.backfill_next_block, state.live_through_block
       FROM robinhood_holder_transfer_journal journal
       INNER JOIN robinhood_holder_token_states state
         ON state.chain = journal.chain AND state.token_address = journal.token_address
        AND state.ledger_status IN ('shadow', 'live')
      WHERE journal.chain = 'robinhood' AND journal.applied = false
        AND journal.token_address = $1
      ORDER BY journal.block_number, journal.transaction_index, journal.log_index
      LIMIT $2::int
      FOR UPDATE OF journal, state`,
    [first.token_address, limit]
  );
  return result.rows;
}

async function lockDirectApplicableTokenEvents(client, input, limit) {
  const tokenAddress = hex(input.onlyTokenAddress, 20, 'only token');
  const excluded = tokenFilter(input.excludeTokenAddresses, 'excluded token');
  await lockReorgFence(client, 'shared');
  if (excluded.includes(tokenAddress)) return [];
  const result = await client.query(
    `SELECT journal.block_number, journal.block_hash, journal.transaction_hash,
            journal.transaction_index, journal.log_index, journal.token_address,
            journal.from_wallet, journal.to_wallet, journal.amount_raw,
            state.holder_count, state.version, state.ledger_status,
            state.backfill_next_block, state.live_through_block
       FROM robinhood_holder_transfer_journal journal
       INNER JOIN robinhood_holder_token_states state
         ON state.chain = journal.chain AND state.token_address = journal.token_address
        AND state.ledger_status IN ('shadow', 'live')
       INNER JOIN robinhood_holder_cursors cursor
         ON cursor.chain = journal.chain AND cursor.stream = 'live'
      WHERE journal.chain = 'robinhood' AND journal.applied = false
        AND journal.token_address = $1
      ORDER BY journal.block_number, journal.transaction_index, journal.log_index
      LIMIT $2::int
      FOR UPDATE OF journal, state`,
    [tokenAddress, limit]
  );
  if (!result.rowCount) {
    const cursor = await client.query(
      `SELECT 1 FROM robinhood_holder_cursors
        WHERE chain = 'robinhood' AND stream = 'live'`
    );
    if (!cursor.rowCount) {
      const error = new Error('holder live cursor is missing');
      error.code = 'holder_cursor_missing';
      throw error;
    }
  }
  return result.rows;
}

function transferFromRow(row) {
  return normalizeTransfer({
    blockNumber: row.block_number, blockHash: row.block_hash,
    transactionHash: row.transaction_hash, transactionIndex: row.transaction_index,
    logIndex: row.log_index, tokenAddress: row.token_address,
    fromWallet: row.from_wallet, toWallet: row.to_wallet, amountRaw: row.amount_raw,
  });
}

async function loadLockedBalanceBook(client, tokenAddress, rows) {
  const wallets = [...new Set(rows.flatMap((row) => [row.from_wallet, row.to_wallet])
    .filter((wallet) => wallet !== ZERO_ADDRESS))].sort();
  if (!wallets.length) return { balances: {}, provenance: {} };
  const result = await client.query(
    `SELECT wallet_address, balance_raw, last_block_number,
            last_transaction_hash, last_log_index
       FROM robinhood_holder_balances
      WHERE chain = 'robinhood' AND token_address = $1
        AND wallet_address = ANY($2::varchar[])
      ORDER BY wallet_address FOR UPDATE`,
    [tokenAddress, wallets]
  );
  return {
    balances: Object.fromEntries(result.rows.map((row) => (
      [row.wallet_address, String(row.balance_raw)]
    ))),
    provenance: Object.fromEntries(result.rows.map((row) => [row.wallet_address, {
      blockNumber: String(row.last_block_number),
      transactionHash: row.last_transaction_hash,
      logIndex: Number(row.last_log_index),
    }])),
  };
}

async function persistBatchBalances(client, tokenAddress, finalRows) {
  const rows = [...finalRows.values()];
  const zeroWallets = rows.filter(({ balanceRaw }) => BigInt(balanceRaw) === 0n)
    .map(({ walletAddress }) => walletAddress);
  const positiveRows = rows.filter(({ balanceRaw }) => BigInt(balanceRaw) > 0n);
  if (zeroWallets.length) {
    await client.query(
      `DELETE FROM robinhood_holder_balances
        WHERE chain = 'robinhood' AND token_address = $1
          AND wallet_address = ANY($2::varchar[])`,
      [tokenAddress, zeroWallets]
    );
  }
  if (!positiveRows.length) return;
  await client.query(
    `INSERT INTO robinhood_holder_balances (
       chain, token_address, wallet_address, balance_raw, last_block_number,
       last_transaction_hash, last_log_index
     ) SELECT 'robinhood', $1, item.wallet_address, item.balance_raw::numeric,
              item.block_number::bigint, item.transaction_hash, item.log_index
         FROM jsonb_to_recordset($2::jsonb) AS item(
           wallet_address text, balance_raw text, block_number text,
           transaction_hash text, log_index int
         )
     ON CONFLICT (chain, token_address, wallet_address) DO UPDATE SET
       balance_raw = EXCLUDED.balance_raw,
       last_block_number = EXCLUDED.last_block_number,
       last_transaction_hash = EXCLUDED.last_transaction_hash,
       last_log_index = EXCLUDED.last_log_index,
       updated_at = NOW()`,
    [tokenAddress, JSON.stringify(positiveRows.map((row) => ({
      wallet_address: row.walletAddress, balance_raw: row.balanceRaw,
      block_number: row.blockNumber, transaction_hash: row.transactionHash,
      log_index: row.logIndex,
    })))]
  );
}

async function markTokenDrifted(client, tokenAddress) {
  const result = await client.query(
    `UPDATE robinhood_holder_token_states
        SET ledger_status = 'drifted', version = version + 1, updated_at = NOW()
      WHERE chain = 'robinhood' AND token_address = $1
        AND ledger_status IN ('shadow', 'live')
      RETURNING token_address`,
    [tokenAddress]
  );
  if (!result.rowCount) throw new Error('holder live drift confirmation is stale');
}

function liveDeficit(transfer, row, balances) {
  const fingerprint = [
    transfer.blockHash, transfer.transactionHash, transfer.logIndex,
    transfer.fromWallet, transfer.amountRaw, balances[transfer.fromWallet] ?? '0',
  ].join(':');
  const recoveryFromBlock = row.backfill_next_block == null
    ? null : String(row.backfill_next_block);
  const recoverySafe = recoveryFromBlock !== null && (
    row.live_through_block == null
    || BigInt(row.live_through_block) < BigInt(recoveryFromBlock)
  );
  return Object.freeze({
    status: 'drift-suspected', tokenAddress: transfer.tokenAddress,
    reason: 'holder_negative_balance', fingerprint,
    failedBlock: transfer.blockNumber, failedTransactionHash: transfer.transactionHash,
    failedLogIndex: transfer.logIndex, recoveryFromBlock, recoverySafe,
  });
}

function tailWalletSnapshots(rows) {
  const snapshots = new Map();
  for (const row of rows) {
    for (const side of ['from', 'to']) {
      const walletAddress = row[`${side}_wallet`];
      if (walletAddress === ZERO_ADDRESS) continue;
      const before = row[`${side}_balance_before`];
      const after = row[`${side}_balance_after`];
      if (before == null || after == null) throw new Error('holder tail evidence is incomplete');
      if (!snapshots.has(walletAddress)) {
        snapshots.set(walletAddress, {
          walletAddress, balanceRaw: String(before),
          blockNumber: row[`${side}_last_block_before`],
          transactionHash: row[`${side}_last_transaction_hash_before`],
          logIndex: row[`${side}_last_log_index_before`],
        });
      }
      snapshots.get(walletAddress).expected = {
        balanceRaw: String(after), blockNumber: String(row.block_number),
        transactionHash: row.transaction_hash, logIndex: Number(row.log_index),
      };
    }
  }
  return [...snapshots.values()];
}

function driftTailIneligibility(row, backfillNextBlock) {
  if (!row) return 'state-stale';
  if (row.journal_floor_block == null
      || BigInt(backfillNextBlock) < BigInt(row.journal_floor_block)) {
    return 'below-journal-floor';
  }
  if (row.live_through_block == null
      || BigInt(row.live_through_block) < BigInt(backfillNextBlock)) {
    return 'tail-not-applied';
  }
  if (Number(row.applied_events) < 1) return 'applied-evidence-missing';
  if (Number(row.pending_events) < 1) return 'pending-event-missing';
  if (row.evidence_complete !== true) return 'applied-evidence-incomplete';
  return null;
}

function assertTailBalances(snapshots, currentRows) {
  const current = new Map(currentRows.map((row) => [row.wallet_address, row]));
  for (const snapshot of snapshots) {
    const row = current.get(snapshot.walletAddress);
    const expected = snapshot.expected;
    const matches = BigInt(expected.balanceRaw) === 0n ? !row : row
      && String(row.balance_raw) === expected.balanceRaw
      && String(row.last_block_number) === expected.blockNumber
      && row.last_transaction_hash === expected.transactionHash
      && Number(row.last_log_index) === expected.logIndex;
    if (!matches) {
      const error = new Error('holder balance no longer matches tail rollback evidence');
      error.code = 'holder_tail_rollback_conflict';
      throw error;
    }
  }
}

async function restoreTailBalances(client, tokenAddress, snapshots) {
  const wallets = snapshots.map(({ walletAddress }) => walletAddress);
  const current = await client.query(
    `SELECT wallet_address, balance_raw, last_block_number,
            last_transaction_hash, last_log_index
       FROM robinhood_holder_balances
      WHERE chain = 'robinhood' AND token_address = $1
        AND wallet_address = ANY($2::varchar[]) FOR UPDATE`,
    [tokenAddress, wallets]
  );
  assertTailBalances(snapshots, current.rows);
  await client.query(
    `DELETE FROM robinhood_holder_balances
      WHERE chain = 'robinhood' AND token_address = $1
        AND wallet_address = ANY($2::varchar[])`,
    [tokenAddress, wallets]
  );
  const restored = snapshots.filter(({ balanceRaw }) => BigInt(balanceRaw) > 0n);
  for (const snapshot of restored) {
    if (snapshot.blockNumber == null || snapshot.transactionHash == null
        || snapshot.logIndex == null) throw new Error('holder tail baseline provenance is missing');
  }
  if (!restored.length) return;
  await client.query(
    `INSERT INTO robinhood_holder_balances (
       chain, token_address, wallet_address, balance_raw, last_block_number,
       last_transaction_hash, last_log_index
     ) SELECT 'robinhood', $1, item.wallet_address, item.balance_raw::numeric,
              item.block_number::bigint, item.transaction_hash, item.log_index
         FROM jsonb_to_recordset($2::jsonb) AS item(
           wallet_address text, balance_raw text, block_number text,
           transaction_hash text, log_index int
         )`,
    [tokenAddress, JSON.stringify(restored.map((snapshot) => ({
      wallet_address: snapshot.walletAddress, balance_raw: snapshot.balanceRaw,
      block_number: String(snapshot.blockNumber), transaction_hash: snapshot.transactionHash,
      log_index: Number(snapshot.logIndex),
    })))]
  );
}

function priorPosition(provenance, walletAddress) {
  return provenance[walletAddress] || {};
}

function journalEvidence(changes, provenance) {
  const fromPrior = priorPosition(provenance, changes.transfer.fromWallet);
  const toPrior = priorPosition(provenance, changes.transfer.toWallet);
  return {
    block_number: changes.transfer.blockNumber,
    transaction_hash: changes.transfer.transactionHash,
    log_index: changes.transfer.logIndex,
    from_balance_before: changes.fromBalanceBefore,
    from_balance_after: changes.fromBalanceAfter,
    to_balance_before: changes.toBalanceBefore,
    to_balance_after: changes.toBalanceAfter,
    holder_delta: changes.holderDelta,
    from_last_block_before: fromPrior.blockNumber ?? null,
    from_last_transaction_hash_before: fromPrior.transactionHash ?? null,
    from_last_log_index_before: fromPrior.logIndex ?? null,
    to_last_block_before: toPrior.blockNumber ?? null,
    to_last_transaction_hash_before: toPrior.transactionHash ?? null,
    to_last_log_index_before: toPrior.logIndex ?? null,
  };
}

function applyTransitionToBook(changes, balances, provenance, finalRows) {
  for (const transition of changes.transitions) {
    balances[transition.walletAddress] = transition.after;
    finalRows.set(transition.walletAddress, {
      walletAddress: transition.walletAddress, balanceRaw: transition.after,
      blockNumber: changes.transfer.blockNumber,
      transactionHash: changes.transfer.transactionHash,
      logIndex: changes.transfer.logIndex,
    });
    if (BigInt(transition.after) === 0n) {
      delete provenance[transition.walletAddress];
    } else {
      provenance[transition.walletAddress] = {
        blockNumber: changes.transfer.blockNumber,
        transactionHash: changes.transfer.transactionHash,
        logIndex: changes.transfer.logIndex,
      };
    }
  }
}

function computeApplicablePrefix(rows, locked) {
  const balances = { ...locked.balances };
  const provenance = { ...locked.provenance };
  const journalRows = [];
  const finalRows = new Map();
  let holderCount = BigInt(rows[0].holder_count);
  let holderDelta = 0;
  let holderCountChanged = false;
  let latestChanges = null;
  let suspicion = null;
  for (const row of rows) {
    const transfer = transferFromRow(row);
    let changes;
    try {
      changes = deriveBalanceChanges(transfer, balances);
    } catch (error) {
      if (error.code !== 'holder_negative_balance') throw error;
      suspicion = liveDeficit(transfer, {
        ...row,
        live_through_block: latestChanges?.transfer.blockNumber ?? row.live_through_block,
      }, balances);
      break;
    }
    const nextHolderCount = holderCount + BigInt(changes.holderDelta);
    if (nextHolderCount < 0n) throw new Error('holder token state rejected an ordered transfer');
    journalRows.push(journalEvidence(changes, provenance));
    applyTransitionToBook(changes, balances, provenance, finalRows);
    holderCount = nextHolderCount;
    holderDelta += changes.holderDelta;
    holderCountChanged ||= changes.holderDelta !== 0;
    latestChanges = changes;
  }
  return {
    tokenAddress: rows[0].token_address,
    initialVersion: String(rows[0].version), finalRows, journalRows,
    holderDelta, holderCountChanged, latestChanges, suspicion,
  };
}

async function advanceAppliedState(client, computed) {
  const first = computed.journalRows[0];
  const latest = computed.latestChanges.transfer;
  const state = await client.query(
    `UPDATE robinhood_holder_token_states
        SET holder_count = holder_count + $2::bigint,
            live_through_block = $3, live_through_hash = $4,
            version = version + $5::bigint, updated_at = NOW()
      WHERE chain = 'robinhood' AND token_address = $1
        AND ledger_status IN ('shadow', 'live')
        AND holder_count + $2::bigint >= 0
        AND version = $6::bigint
        AND (live_through_block IS NULL OR live_through_block <= $7::bigint)
      RETURNING holder_count, version, ledger_status, updated_at,
                live_through_block, live_through_hash`,
    [
      computed.tokenAddress, String(computed.holderDelta),
      latest.blockNumber, latest.blockHash, computed.journalRows.length,
      computed.initialVersion, first.block_number,
    ]
  );
  if (!state.rowCount) throw new Error('holder token state rejected an ordered transfer');
  return state.rows[0];
}

async function persistJournalEvidence(client, journalRows) {
  const result = await client.query(
    `UPDATE robinhood_holder_transfer_journal
        SET from_balance_before = item.from_balance_before::numeric,
            from_balance_after = item.from_balance_after::numeric,
            to_balance_before = item.to_balance_before::numeric,
            to_balance_after = item.to_balance_after::numeric,
            holder_delta = item.holder_delta,
            from_last_block_before = item.from_last_block_before::bigint,
            from_last_transaction_hash_before = item.from_last_transaction_hash_before,
            from_last_log_index_before = item.from_last_log_index_before,
            to_last_block_before = item.to_last_block_before::bigint,
            to_last_transaction_hash_before = item.to_last_transaction_hash_before,
            to_last_log_index_before = item.to_last_log_index_before,
            applied = true, applied_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS item(
         transaction_hash text, log_index int,
         from_balance_before text, from_balance_after text,
         to_balance_before text, to_balance_after text, holder_delta smallint,
         from_last_block_before text, from_last_transaction_hash_before text,
         from_last_log_index_before int, to_last_block_before text,
         to_last_transaction_hash_before text, to_last_log_index_before int
       )
      WHERE chain = 'robinhood'
        AND robinhood_holder_transfer_journal.transaction_hash = item.transaction_hash
        AND robinhood_holder_transfer_journal.log_index = item.log_index
        AND applied = false
      RETURNING robinhood_holder_transfer_journal.transaction_hash`,
    [JSON.stringify(journalRows)]
  );
  if (result.rowCount !== journalRows.length) {
    throw new Error('holder journal event was concurrently applied');
  }
}

async function syncHotQueue(client, tokenAddress) {
  await client.query(
    `WITH bounds AS MATERIALIZED (
       SELECT MIN(block_number) AS first_block, MAX(block_number) AS last_block,
              MIN(captured_at) AS first_at, MAX(captured_at) AS last_at
         FROM robinhood_holder_transfer_journal
        WHERE chain = 'robinhood' AND token_address = $1 AND applied = FALSE
     ), refreshed AS (
       INSERT INTO robinhood_holder_hot_queue (
         chain, token_address, first_pending_block, last_pending_block,
         first_enqueued_at, last_enqueued_at, updated_at
       )
       SELECT 'robinhood', $1, first_block, last_block, first_at, last_at, NOW()
         FROM bounds WHERE first_block IS NOT NULL
       ON CONFLICT (chain, token_address) DO UPDATE SET
         first_pending_block = EXCLUDED.first_pending_block,
         last_pending_block = EXCLUDED.last_pending_block,
         first_enqueued_at = EXCLUDED.first_enqueued_at,
         last_enqueued_at = EXCLUDED.last_enqueued_at,
         updated_at = EXCLUDED.updated_at
       RETURNING token_address
     )
     DELETE FROM robinhood_holder_hot_queue queue
      WHERE queue.chain = 'robinhood' AND queue.token_address = $1
        AND NOT EXISTS (SELECT 1 FROM bounds WHERE first_block IS NOT NULL)`,
    [tokenAddress]
  );
}

async function commitAppliedPrefix(client, computed) {
  if (!computed.journalRows.length) return null;
  await persistBatchBalances(client, computed.tokenAddress, computed.finalRows);
  const row = await advanceAppliedState(client, computed);
  await persistJournalEvidence(client, computed.journalRows);
  await syncHotQueue(client, computed.tokenAddress);
  const latest = computed.latestChanges;
  const publication = row.ledger_status === 'live' && computed.holderCountChanged
    ? Object.freeze({
        tokenAddress: computed.tokenAddress,
        holderCount: String(row.holder_count), ledgerVersion: String(row.version),
        observedAt: row.updated_at,
        liveThroughBlock: String(row.live_through_block),
        liveThroughHash: row.live_through_hash,
      })
    : null;
  return Object.freeze({
    status: 'applied', tokenAddress: computed.tokenAddress,
    holderCount: String(row.holder_count), holderDelta: latest.holderDelta,
    appliedEvents: computed.journalRows.length,
    attemptedEvents: computed.journalRows.length,
    ...(publication ? { publication } : {}),
  });
}

async function lockCursorForRewind(client, rewind) {
  const result = await client.query(
    `SELECT next_block, journal_floor_block, version
       FROM robinhood_holder_cursors
      WHERE chain = 'robinhood' AND stream = 'live' FOR UPDATE`
  );
  if (!result.rowCount) {
    const error = new Error('holder live cursor is missing');
    error.code = 'holder_cursor_missing';
    throw error;
  }
  const row = result.rows[0];
  if (Number(row.version) !== rewind.expectedVersion) {
    const error = new Error('holder rewind cursor is stale');
    error.code = 'holder_cursor_stale';
    throw error;
  }
  if (BigInt(rewind.nextBlock) >= BigInt(row.next_block)) {
    const error = new Error('holder rewind must move the cursor backward');
    error.code = 'holder_rewind_not_behind';
    throw error;
  }
  if (row.journal_floor_block == null) {
    const error = new Error('holder journal floor is not initialized');
    error.code = 'holder_journal_floor_uninitialized';
    throw error;
  }
  if (BigInt(rewind.nextBlock) < BigInt(row.journal_floor_block)) {
    const error = new Error('holder rewind is below the retained journal floor');
    error.code = 'holder_rewind_below_floor';
    throw error;
  }
}

async function loadOrphanedEvents(client, nextBlock) {
  const result = await client.query(
    `SELECT block_number, block_hash, transaction_hash, transaction_index,
            log_index, token_address, from_wallet, to_wallet,
            from_balance_before, from_balance_after,
            to_balance_before, to_balance_after, holder_delta, applied,
            from_last_block_before, from_last_transaction_hash_before,
            from_last_log_index_before, to_last_block_before,
            to_last_transaction_hash_before, to_last_log_index_before
       FROM robinhood_holder_transfer_journal
      WHERE chain = 'robinhood' AND block_number >= $1
      ORDER BY block_number DESC, transaction_index DESC, log_index DESC
      FOR UPDATE`,
    [nextBlock]
  );
  return result.rows;
}

function rollbackTransitions(row) {
  const transitions = new Map();
  const add = (walletAddress, before, after, prior) => {
    if (walletAddress === ZERO_ADDRESS) return;
    const transition = {
      walletAddress, before: String(before), after: String(after), prior,
    };
    const existing = transitions.get(walletAddress);
    if (existing && JSON.stringify(existing) !== JSON.stringify(transition)) {
      const error = new Error('self-transfer rollback evidence is inconsistent');
      error.code = 'holder_rollback_corrupt';
      throw error;
    }
    transitions.set(walletAddress, transition);
  };
  add(row.from_wallet, row.from_balance_before, row.from_balance_after, {
    blockNumber: row.from_last_block_before,
    transactionHash: row.from_last_transaction_hash_before,
    logIndex: row.from_last_log_index_before,
  });
  add(row.to_wallet, row.to_balance_before, row.to_balance_after, {
    blockNumber: row.to_last_block_before,
    transactionHash: row.to_last_transaction_hash_before,
    logIndex: row.to_last_log_index_before,
  });
  return [...transitions.values()].sort((left, right) => (
    left.walletAddress.localeCompare(right.walletAddress)
  ));
}

async function restoreBalance(client, row, transition) {
  const current = await client.query(
    `SELECT balance_raw, last_block_number, last_transaction_hash, last_log_index
       FROM robinhood_holder_balances
      WHERE chain = 'robinhood' AND token_address = $1 AND wallet_address = $2
      FOR UPDATE`,
    [row.token_address, transition.walletAddress]
  );
  const expectedPositive = BigInt(transition.after) > 0n;
  const value = current.rows[0];
  const matches = expectedPositive
    ? value && String(value.balance_raw) === transition.after
      && String(value.last_block_number) === String(row.block_number)
      && value.last_transaction_hash === row.transaction_hash
      && Number(value.last_log_index) === Number(row.log_index)
    : !value;
  if (!matches) {
    const error = new Error('holder balance no longer matches rollback evidence');
    error.code = 'holder_rollback_conflict';
    throw error;
  }
  if (BigInt(transition.before) === 0n) {
    await client.query(
      `DELETE FROM robinhood_holder_balances
        WHERE chain = 'robinhood' AND token_address = $1 AND wallet_address = $2`,
      [row.token_address, transition.walletAddress]
    );
    return;
  }
  if (transition.prior.blockNumber == null || transition.prior.transactionHash == null
      || transition.prior.logIndex == null) {
    const error = new Error('holder rollback is missing prior balance provenance');
    error.code = 'holder_rollback_corrupt';
    throw error;
  }
  await client.query(
    `INSERT INTO robinhood_holder_balances (
       chain, token_address, wallet_address, balance_raw, last_block_number,
       last_transaction_hash, last_log_index
     ) VALUES ('robinhood', $1, $2, $3::numeric, $4, $5, $6)
     ON CONFLICT (chain, token_address, wallet_address) DO UPDATE SET
       balance_raw = EXCLUDED.balance_raw,
       last_block_number = EXCLUDED.last_block_number,
       last_transaction_hash = EXCLUDED.last_transaction_hash,
       last_log_index = EXCLUDED.last_log_index,
       updated_at = NOW()`,
    [
      row.token_address, transition.walletAddress, transition.before,
      transition.prior.blockNumber, transition.prior.transactionHash,
      transition.prior.logIndex,
    ]
  );
}

async function revertAppliedEvent(client, row) {
  for (const transition of rollbackTransitions(row)) {
    await restoreBalance(client, row, transition);
  }
  const state = await client.query(
    `UPDATE robinhood_holder_token_states
        SET holder_count = holder_count - $2::smallint,
            version = version + 1, updated_at = NOW()
      WHERE chain = 'robinhood' AND token_address = $1
        AND holder_count - $2::smallint >= 0
      RETURNING token_address`,
    [row.token_address, row.holder_delta]
  );
  if (!state.rowCount) throw new Error('holder token state rejected an orphan rollback');
}

async function markStatesCrossingBaseline(client, nextBlock) {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT token_address, ledger_status AS prior_status
         FROM robinhood_holder_token_states
        WHERE chain = 'robinhood' AND ledger_status IN ('shadow', 'live')
          AND (backfill_next_block IS NULL OR backfill_next_block > $1)
        FOR UPDATE
     ), updated AS (
       UPDATE robinhood_holder_token_states AS state
          SET ledger_status = 'resyncing', version = version + 1, updated_at = NOW()
         FROM candidates
        WHERE state.chain = 'robinhood'
          AND state.token_address = candidates.token_address
       RETURNING state.token_address
     )
     SELECT updated.token_address, candidates.prior_status
       FROM updated INNER JOIN candidates USING (token_address)`,
    [nextBlock]
  );
  return result.rows;
}

async function loadRewindPublications(
  client, affectedTokens, resyncingStates, checkpoint
) {
  const affected = new Set(affectedTokens);
  const invalidated = new Set(resyncingStates
    .filter((row) => row.prior_status === 'live')
    .map((row) => row.token_address));
  const publicTokens = [...new Set([...affected, ...invalidated])];
  if (!publicTokens.length || !checkpoint) return [];
  const result = await client.query(
    `SELECT token_address, holder_count, ledger_status, version, updated_at,
            live_through_block, live_through_hash
       FROM robinhood_holder_token_states
      WHERE chain = 'robinhood' AND token_address = ANY($1::varchar[])`,
    [publicTokens]
  );
  return result.rows.flatMap((row) => {
    if (invalidated.has(row.token_address)) {
      return [{
        tokenAddress: row.token_address, invalidated: true,
        ledgerVersion: String(row.version), observedAt: row.updated_at,
        liveThroughBlock: checkpoint.number, liveThroughHash: checkpoint.hash,
      }];
    }
    if (affected.has(row.token_address) && row.ledger_status === 'live') {
      return [{
        tokenAddress: row.token_address, holderCount: String(row.holder_count),
        ledgerVersion: String(row.version), observedAt: row.updated_at,
        liveThroughBlock: String(row.live_through_block),
        liveThroughHash: row.live_through_hash,
      }];
    }
    return [];
  });
}

async function commitRewind(client, rewind, affectedTokens) {
  if (affectedTokens.length) {
    await client.query(
      `UPDATE robinhood_holder_token_states
          SET live_through_block = $2, live_through_hash = $3, updated_at = NOW()
        WHERE chain = 'robinhood' AND token_address = ANY($1::varchar[])`,
      [
        affectedTokens, rewind.checkpoint?.number ?? null,
        rewind.checkpoint?.hash ?? null,
      ]
    );
  }
  const removed = await client.query(
    `DELETE FROM robinhood_holder_transfer_journal
      WHERE chain = 'robinhood' AND block_number >= $1`,
    [rewind.nextBlock]
  );
  await client.query(
    `DELETE FROM robinhood_holder_hot_queue queue
      WHERE queue.chain = 'robinhood' AND NOT EXISTS (
        SELECT 1 FROM robinhood_holder_transfer_journal journal
         WHERE journal.chain = queue.chain AND journal.token_address = queue.token_address
           AND journal.applied = FALSE
      )`
  );
  const cursor = await client.query(
    `UPDATE robinhood_holder_cursors
        SET next_block = $1, safe_head = $2, checkpoint_block = $3,
            checkpoint_hash = $4,
            buffer_floor_block = CASE
              WHEN buffer_floor_block > $1::bigint THEN NULL ELSE buffer_floor_block
            END,
            version = version + 1, updated_at = NOW()
      WHERE chain = 'robinhood' AND stream = 'live' AND version = $5
      RETURNING version`,
    [
      rewind.nextBlock, rewind.safeHead, rewind.checkpoint?.number ?? null,
      rewind.checkpoint?.hash ?? null, rewind.expectedVersion,
    ]
  );
  if (!cursor.rowCount) throw new Error('holder rewind cursor was concurrently changed');
  return { removedEvents: removed.rowCount, cursorVersion: Number(cursor.rows[0].version) };
}

async function withTransaction(database, operation) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

function createRobinhoodHolderLedgerRepository(options = {}) {
  const database = options.database || db;

  async function appendCapturedRange(input = {}) {
    const transfers = (Array.isArray(input.transfers) ? input.transfers : [])
      .map(normalizeTransfer);
    const cursor = normalizeCursor(input.cursor);
    validateRange(transfers, cursor);
    return withTransaction(database, async (client) => {
      await lockReorgFence(client, 'shared');
      const insertedTransfers = await insertTransfers(client, transfers);
      const version = await advanceCursor(client, cursor);
      return Object.freeze({
        insertedTransfers,
        duplicateTransfers: transfers.length - insertedTransfers,
        cursorVersion: version,
      });
    });
  }

  async function repairCapturedRange(input = {}) {
    const transfers = (Array.isArray(input.transfers) ? input.transfers : [])
      .map(normalizeTransfer);
    const tokenAddress = hex(input.tokenAddress, 20, 'repair.tokenAddress');
    const fromBlock = decimalQuantity(input.fromBlock, 'repair.fromBlock');
    const toBlock = decimalQuantity(input.toBlock, 'repair.toBlock');
    const checkpointBlock = decimalQuantity(
      input.checkpoint?.number, 'repair.checkpoint.number'
    );
    hex(input.checkpoint?.hash, 32, 'repair.checkpoint.hash');
    if (BigInt(fromBlock) > BigInt(toBlock)
        || checkpointBlock !== toBlock
        || transfers.some((transfer) => transfer.tokenAddress !== tokenAddress
          || BigInt(transfer.blockNumber) < BigInt(fromBlock)
          || BigInt(transfer.blockNumber) > BigInt(toBlock))) {
      throw new Error('holder repair range is invalid');
    }
    return withTransaction(database, async (client) => {
      await lockReorgFence(client, 'exclusive');
      const cursor = await client.query(
        `SELECT next_block, safe_head, journal_floor_block
           FROM robinhood_holder_cursors
          WHERE chain = 'robinhood' AND stream = 'live'`
      );
      const row = cursor.rows[0];
      if (!row || row.journal_floor_block == null || row.safe_head == null
          || BigInt(fromBlock) < BigInt(row.journal_floor_block)
          || BigInt(toBlock) >= BigInt(row.next_block)
          || BigInt(toBlock) > BigInt(row.safe_head)) {
        const error = new Error('holder repair range is outside retained live evidence');
        error.code = 'holder_live_repair_unavailable';
        throw error;
      }
      const insertedTransfers = await insertTransfers(client, transfers);
      return Object.freeze({
        status: 'repaired', tokenAddress, insertedTransfers,
        duplicateTransfers: transfers.length - insertedTransfers,
      });
    });
  }

  async function applyNextPendingEvent(input = {}) {
    const maxEvents = nonNegativeInteger(input.maxEvents ?? 1, 'apply.maxEvents');
    if (maxEvents < 1 || maxEvents > 1000) throw new Error('apply.maxEvents is invalid');
    return withTransaction(database, async (client) => {
      let rows;
      if (input.onlyTokenAddress != null) {
        rows = await lockDirectApplicableTokenEvents(client, input, maxEvents);
      } else {
        const first = await lockNextApplicableEvent(client, input);
        rows = first ? await lockApplicableTokenEvents(client, first, maxEvents) : [];
      }
      if (!rows.length) return Object.freeze({ status: 'idle' });
      const locked = await loadLockedBalanceBook(client, rows[0].token_address, rows);
      const computed = computeApplicablePrefix(rows, locked);
      if (computed.suspicion && input.confirmDriftFingerprint != null
          && String(input.confirmDriftFingerprint) !== computed.suspicion.fingerprint) {
        const stale = new Error('holder live drift evidence changed before confirmation');
        stale.code = 'holder_live_drift_stale';
        throw stale;
      }
      const applied = await commitAppliedPrefix(client, computed);
      if (!computed.suspicion) {
        return Object.freeze({
          ...applied,
          tokenDrained: rows.length < maxEvents,
        });
      }
      const result = {
        ...computed.suspicion,
        appliedEvents: computed.journalRows.length,
        attemptedEvents: computed.journalRows.length + 1,
        ...(applied?.publication ? { publication: applied.publication } : {}),
      };
      if (input.confirmDriftFingerprint == null) return Object.freeze(result);
      await markTokenDrifted(client, computed.tokenAddress);
      return Object.freeze({ ...result, status: 'drifted' });
    });
  }

  async function promoteReadyShadowTokens(input = {}) {
    const limit = nonNegativeInteger(input.limit ?? 5000, 'shadowPromotion.limit');
    if (limit < 1 || limit > 50_000) throw new Error('shadowPromotion.limit is invalid');
    const tokenAddress = input.tokenAddress == null
      ? null : hex(input.tokenAddress, 20, 'shadowPromotion.tokenAddress');
    return withTransaction(database, async (client) => {
      await lockReorgFence(client, 'shared');
      const cursorResult = await client.query(
        `SELECT next_block, checkpoint_block, checkpoint_hash
           FROM robinhood_holder_cursors
          WHERE chain = 'robinhood' AND stream = 'live'`
      );
      const cursor = cursorResult.rows[0];
      if (!cursor || cursor.checkpoint_block == null || cursor.checkpoint_hash == null
          || BigInt(cursor.checkpoint_block) + 1n !== BigInt(cursor.next_block)) {
        const error = new Error('holder live cursor checkpoint is inconsistent');
        error.code = 'holder_cursor_corrupt';
        throw error;
      }
      const result = await client.query(
        `WITH candidates AS MATERIALIZED (
           SELECT state.token_address
             FROM robinhood_holder_token_states state
            WHERE state.chain = 'robinhood' AND state.ledger_status = 'shadow'
              AND ($5::varchar IS NULL OR state.token_address = $5)
              AND state.deployment_block IS NOT NULL
              AND state.deployment_block < $1::bigint
              AND NOT EXISTS (
                SELECT 1 FROM robinhood_holder_transfer_journal journal
                 WHERE journal.chain = state.chain
                   AND journal.token_address = state.token_address
                   AND journal.applied = false
              )
            ORDER BY state.updated_at DESC, state.token_address
            LIMIT $4::int FOR UPDATE OF state SKIP LOCKED
         )
         UPDATE robinhood_holder_token_states state
            SET ledger_status = 'live', live_through_block = $2::bigint,
                live_through_hash = $3, version = version + 1, updated_at = NOW()
           FROM candidates
          WHERE state.chain = 'robinhood'
            AND state.token_address = candidates.token_address
            AND state.ledger_status = 'shadow'
          RETURNING state.token_address, state.holder_count, state.version,
                    state.updated_at, state.live_through_block, state.live_through_hash`,
        [cursor.next_block, cursor.checkpoint_block, cursor.checkpoint_hash, limit, tokenAddress]
      );
      return Object.freeze({
        status: result.rowCount ? 'promoted' : 'idle',
        promotedTokens: result.rowCount,
        publications: Object.freeze(result.rows.map((row) => Object.freeze({
          tokenAddress: row.token_address, holderCount: String(row.holder_count),
          ledgerVersion: String(row.version), observedAt: row.updated_at,
          liveThroughBlock: String(row.live_through_block),
          liveThroughHash: row.live_through_hash,
        }))),
      });
    });
  }

  async function inspectDriftedAppliedTail(input = {}) {
    const tokenAddress = hex(input.tokenAddress, 20, 'driftTail.tokenAddress');
    const backfillNextBlock = decimalQuantity(
      input.backfillNextBlock, 'driftTail.backfillNextBlock'
    );
    const expectedVersion = decimalQuantity(input.expectedVersion, 'driftTail.expectedVersion');
    const result = await database.query(
      `SELECT state.live_through_block, cursor.journal_floor_block,
              (SELECT COUNT(*)::int FROM robinhood_holder_transfer_journal journal
                WHERE journal.chain = state.chain
                  AND journal.token_address = state.token_address
                  AND journal.applied = true
                  AND journal.block_number >= state.backfill_next_block) AS applied_events,
              (SELECT COUNT(*)::int FROM robinhood_holder_transfer_journal journal
                WHERE journal.chain = state.chain
                  AND journal.token_address = state.token_address
                  AND journal.applied = false
                  AND journal.block_number >= state.backfill_next_block) AS pending_events,
              COALESCE((SELECT BOOL_AND(
                       journal.holder_delta IS NOT NULL
                       AND (journal.from_wallet = $4
                         OR (journal.from_balance_before IS NOT NULL
                           AND journal.from_balance_after IS NOT NULL
                           AND (journal.from_balance_before = 0
                             OR journal.from_last_block_before IS NOT NULL)))
                       AND (journal.to_wallet = $4
                         OR (journal.to_balance_before IS NOT NULL
                           AND journal.to_balance_after IS NOT NULL
                           AND (journal.to_balance_before = 0
                             OR journal.to_last_block_before IS NOT NULL))))
                  FROM robinhood_holder_transfer_journal journal
                 WHERE journal.chain = state.chain
                   AND journal.token_address = state.token_address
                   AND journal.applied = true
                   AND journal.block_number >= state.backfill_next_block), false)
                AS evidence_complete
         FROM robinhood_holder_token_states state
         INNER JOIN robinhood_holder_cursors cursor
           ON cursor.chain = state.chain AND cursor.stream = 'live'
        WHERE state.chain = 'robinhood' AND state.token_address = $1
          AND state.ledger_status = 'drifted' AND state.version = $2::bigint
          AND state.backfill_next_block = $3::bigint`,
      [tokenAddress, expectedVersion, backfillNextBlock, ZERO_ADDRESS]
    );
    const row = result.rows[0];
    const reason = driftTailIneligibility(row, backfillNextBlock);
    return Object.freeze({
      eligible: reason == null, reason, tokenAddress,
      appliedEvents: Number(row?.applied_events) || 0,
      pendingEvents: Number(row?.pending_events) || 0,
    });
  }

  async function rollbackAppliedTailInternal(input, driftRecovery) {
    const tokenAddress = hex(input.tokenAddress, 20, 'tailRollback.tokenAddress');
    const backfillNextBlock = decimalQuantity(
      input.backfillNextBlock, 'tailRollback.backfillNextBlock'
    );
    const expectedVersion = driftRecovery
      ? decimalQuantity(input.expectedVersion, 'tailRollback.expectedVersion') : null;
    const failedBlock = driftRecovery ? null
      : decimalQuantity(input.failedBlock, 'tailRollback.failedBlock');
    const failedTransactionHash = driftRecovery ? null : hex(
      input.failedTransactionHash, 32, 'tailRollback.failedTransactionHash'
    );
    const failedLogIndex = driftRecovery ? null : nonNegativeInteger(
      input.failedLogIndex, 'tailRollback.failedLogIndex'
    );
    return withTransaction(database, async (client) => {
      await lockReorgFence(client, 'exclusive');
      const cursorResult = await client.query(
        `SELECT next_block, journal_floor_block FROM robinhood_holder_cursors
          WHERE chain = 'robinhood' AND stream = 'live' FOR UPDATE`
      );
      const stateResult = await client.query(
        `SELECT holder_count, ledger_status, backfill_next_block,
                live_through_block, live_through_hash, version
           FROM robinhood_holder_token_states
          WHERE chain = 'robinhood' AND token_address = $1 FOR UPDATE`,
        [tokenAddress]
      );
      const state = stateResult.rows[0];
      const allowedStatus = driftRecovery
        ? state?.ledger_status === 'drifted'
        : ['shadow', 'live'].includes(state?.ledger_status);
      if (!state || !allowedStatus || String(state.backfill_next_block) !== backfillNextBlock
          || (driftRecovery && String(state.version) !== expectedVersion)) {
        const error = new Error('holder tail rollback state is stale');
        error.code = 'holder_tail_rollback_stale';
        throw error;
      }
      const journalFloorBlock = cursorResult.rows[0]?.journal_floor_block;
      if (driftRecovery && (journalFloorBlock == null
          || BigInt(backfillNextBlock) < BigInt(journalFloorBlock))) {
        const error = new Error('holder tail rollback is below retained evidence');
        error.code = 'holder_tail_rollback_unavailable';
        throw error;
      }
      const pending = await client.query(
        `SELECT block_number, transaction_hash, log_index
           FROM robinhood_holder_transfer_journal
          WHERE chain = 'robinhood' AND token_address = $1 AND applied = false
          ORDER BY block_number, transaction_index, log_index
          LIMIT 1 FOR UPDATE`,
        [tokenAddress]
      );
      const failed = pending.rows[0];
      if (!failed || (!driftRecovery && (String(failed.block_number) !== failedBlock
          || failed.transaction_hash !== failedTransactionHash
          || Number(failed.log_index) !== failedLogIndex))) {
        const error = new Error('holder tail rollback pending event is stale');
        error.code = 'holder_tail_rollback_stale';
        throw error;
      }
      const applied = await client.query(
        `SELECT block_number, transaction_hash, transaction_index, log_index,
                from_wallet, to_wallet, from_balance_before, from_balance_after,
                to_balance_before, to_balance_after, holder_delta,
                from_last_block_before, from_last_transaction_hash_before,
                from_last_log_index_before, to_last_block_before,
                to_last_transaction_hash_before, to_last_log_index_before
           FROM robinhood_holder_transfer_journal
          WHERE chain = 'robinhood' AND token_address = $1 AND applied = true
            AND block_number >= $2::bigint
          ORDER BY block_number, transaction_index, log_index FOR UPDATE`,
        [tokenAddress, backfillNextBlock]
      );
      if (!applied.rowCount) {
        const error = new Error('holder tail rollback has no applied evidence');
        error.code = 'holder_tail_rollback_unavailable';
        throw error;
      }
      await restoreTailBalances(client, tokenAddress, tailWalletSnapshots(applied.rows));
      const holderDelta = applied.rows.reduce(
        (total, row) => total + BigInt(row.holder_delta), 0n
      );
      const reverted = await client.query(
        `UPDATE robinhood_holder_transfer_journal
            SET from_balance_before = NULL, from_balance_after = NULL,
                to_balance_before = NULL, to_balance_after = NULL,
                holder_delta = NULL, from_last_block_before = NULL,
                from_last_transaction_hash_before = NULL, from_last_log_index_before = NULL,
                to_last_block_before = NULL, to_last_transaction_hash_before = NULL,
                to_last_log_index_before = NULL, applied = false, applied_at = NULL
          WHERE chain = 'robinhood' AND token_address = $1 AND applied = true
            AND block_number >= $2::bigint`,
        [tokenAddress, backfillNextBlock]
      );
      if (reverted.rowCount !== applied.rowCount) {
        throw new Error('holder tail rollback journal changed while locked');
      }
      const reset = await client.query(
        `UPDATE robinhood_holder_token_states
            SET holder_count = holder_count - $3::bigint,
                ledger_status = 'backfilling', live_through_block = NULL,
                live_through_hash = NULL, version = version + 1, updated_at = NOW()
          WHERE chain = 'robinhood' AND token_address = $1 AND version = $2::bigint
            AND ledger_status = ANY($4::varchar[])
            AND holder_count - $3::bigint >= 0
          RETURNING version, updated_at`,
        [tokenAddress, state.version, holderDelta.toString(),
          driftRecovery ? ['drifted'] : ['shadow', 'live']]
      );
      if (!reset.rowCount) throw new Error('holder tail rollback state changed while locked');
      await syncHotQueue(client, tokenAddress);
      const publication = state.ledger_status === 'live' ? Object.freeze({
        tokenAddress, invalidated: true, ledgerVersion: String(reset.rows[0].version),
        observedAt: reset.rows[0].updated_at,
        liveThroughBlock: String(state.live_through_block),
        liveThroughHash: state.live_through_hash,
      }) : null;
      return Object.freeze({
        status: 'requeued', tokenAddress, priorStatus: state.ledger_status,
        backfillNextBlock, revertedEvents: applied.rowCount,
        ...(publication ? { publication } : {}),
      });
    });
  }

  async function rollbackAppliedTail(input = {}) {
    return rollbackAppliedTailInternal(input, false);
  }

  async function rollbackDriftedAppliedTail(input = {}) {
    return rollbackAppliedTailInternal(input, true);
  }

  async function requeueWideShadowTail(input = {}) {
    const tokenAddress = hex(input.tokenAddress, 20, 'wideTail.tokenAddress');
    const backfillNextBlock = decimalQuantity(
      input.backfillNextBlock, 'wideTail.backfillNextBlock'
    );
    const failedBlock = decimalQuantity(input.failedBlock, 'wideTail.failedBlock');
    const failedTransactionHash = hex(
      input.failedTransactionHash, 32, 'wideTail.failedTransactionHash'
    );
    const failedLogIndex = nonNegativeInteger(
      input.failedLogIndex, 'wideTail.failedLogIndex'
    );
    const receiptBlockLimit = nonNegativeInteger(
      input.receiptBlockLimit, 'wideTail.receiptBlockLimit'
    );
    if (receiptBlockLimit < 1 || receiptBlockLimit > 1000) {
      throw new Error('wideTail.receiptBlockLimit is invalid');
    }
    return withTransaction(database, async (client) => {
      await lockReorgFence(client, 'exclusive');
      const stateResult = await client.query(
        `SELECT backfill_next_block, live_through_block, version
           FROM robinhood_holder_token_states
          WHERE chain = 'robinhood' AND token_address = $1
            AND ledger_status = 'shadow' FOR UPDATE`,
        [tokenAddress]
      );
      const state = stateResult.rows[0];
      if (!state || String(state.backfill_next_block) !== backfillNextBlock
          || state.live_through_block == null
          || BigInt(state.live_through_block) + 1n !== BigInt(backfillNextBlock)) {
        return Object.freeze({ status: 'not-requeued', reason: 'state-not-safe' });
      }
      const pending = await client.query(
        `SELECT block_number, transaction_hash, log_index
           FROM robinhood_holder_transfer_journal
          WHERE chain = 'robinhood' AND token_address = $1 AND applied = false
          ORDER BY block_number, transaction_index, log_index
          LIMIT 1 FOR UPDATE`,
        [tokenAddress]
      );
      const failed = pending.rows[0];
      const receiptBlocks = BigInt(failedBlock) - BigInt(backfillNextBlock) + 1n;
      if (!failed || String(failed.block_number) !== failedBlock
          || failed.transaction_hash !== failedTransactionHash
          || Number(failed.log_index) !== failedLogIndex
          || receiptBlocks <= BigInt(receiptBlockLimit)) {
        return Object.freeze({ status: 'not-requeued', reason: 'pending-event-changed' });
      }
      const applied = await client.query(
        `SELECT 1 FROM robinhood_holder_transfer_journal
          WHERE chain = 'robinhood' AND token_address = $1 AND applied = true
            AND block_number >= $2::bigint LIMIT 1 FOR UPDATE`,
        [tokenAddress, backfillNextBlock]
      );
      if (applied.rowCount) {
        return Object.freeze({ status: 'not-requeued', reason: 'applied-tail-present' });
      }
      const reset = await client.query(
        `UPDATE robinhood_holder_token_states
            SET ledger_status = 'backfilling', version = version + 1, updated_at = NOW()
          WHERE chain = 'robinhood' AND token_address = $1
            AND ledger_status = 'shadow' AND version = $2::bigint
          RETURNING version`,
        [tokenAddress, state.version]
      );
      if (!reset.rowCount) throw new Error('holder wide-tail requeue state changed while locked');
      return Object.freeze({
        status: 'requeued', recovery: 'wide-shadow-tail', tokenAddress,
        backfillNextBlock, receiptBlocks: receiptBlocks.toString(),
        revertedEvents: 0, version: String(reset.rows[0].version),
      });
    });
  }

  async function rewindOrphanedRange(input = {}) {
    const rewind = normalizeRewind(input);
    return withTransaction(database, async (client) => {
      await lockReorgFence(client, 'exclusive');
      await lockCursorForRewind(client, rewind);
      const events = await loadOrphanedEvents(client, rewind.nextBlock);
      const applied = events.filter((row) => row.applied);
      for (const row of applied) await revertAppliedEvent(client, row);
      const affectedTokens = [...new Set(applied.map((row) => row.token_address))];
      const resyncingStates = await markStatesCrossingBaseline(client, rewind.nextBlock);
      const committed = await commitRewind(client, rewind, affectedTokens);
      const publications = await loadRewindPublications(
        client, affectedTokens, resyncingStates, rewind.checkpoint
      );
      return Object.freeze({
        status: 'rewound', revertedEvents: applied.length,
        affectedTokens: affectedTokens.length, resyncingTokens: resyncingStates.length,
        publications: Object.freeze(publications.map(Object.freeze)), ...committed,
      });
    });
  }

  async function getCursor() {
    const result = await database.query(
      `SELECT stream, next_block, safe_head, checkpoint_block, checkpoint_hash,
              journal_floor_block, buffer_floor_block, version
         FROM robinhood_holder_cursors
        WHERE chain = $1 AND stream = $2`,
      [CHAIN, STREAM]
    );
    return normalizeCursorRow(result.rows[0]);
  }

  async function listTrackedTokenAddresses() {
    const result = await database.query(
      `SELECT token_address FROM robinhood_holder_token_states
        WHERE chain = $1 AND ledger_status IN ('backfilling', 'shadow', 'live')
       UNION
       SELECT token.token_address
         FROM robinhood_holder_global_backfill_tokens token
         INNER JOIN robinhood_holder_global_backfill_runs run
           ON run.id = token.run_id AND run.chain = token.chain
        WHERE token.chain = $1 AND token.status = 'active'
          AND run.barrier_block IS NOT NULL AND run.status <> 'completed'
        ORDER BY token_address`,
      [CHAIN]
    );
    return Object.freeze(result.rows.map((row) => row.token_address));
  }

  async function listPendingTokenAddresses(input = {}) {
    const excluded = tokenFilter(input.excludeTokenAddresses, 'excluded token');
    const limit = nonNegativeInteger(input.limit ?? 5000, 'pendingTokens.limit');
    if (limit < 1 || limit > 50_000) throw new Error('pendingTokens.limit is invalid');
    const result = await database.query(
      `SELECT state.token_address
         FROM robinhood_holder_token_states state
         INNER JOIN LATERAL (
           SELECT journal.block_number, journal.transaction_index, journal.log_index
             FROM robinhood_holder_transfer_journal journal
            WHERE journal.chain = state.chain
              AND journal.token_address = state.token_address
              AND journal.applied = false
            ORDER BY journal.block_number, journal.transaction_index, journal.log_index
            LIMIT 1
         ) pending ON true
        WHERE state.chain = 'robinhood'
          AND state.ledger_status IN ('shadow', 'live')
          AND NOT (state.token_address = ANY($1::varchar[]))
        ORDER BY pending.block_number DESC, pending.transaction_index DESC,
                 pending.log_index DESC,
                 (state.ledger_status = 'live') DESC, state.token_address
        LIMIT $2::int`,
      [excluded, limit]
    );
    return Object.freeze(result.rows.map((row) => row.token_address));
  }

  async function listHotPendingTokenAddresses(input = {}) {
    const excluded = tokenFilter(input.excludeTokenAddresses, 'excluded hot token');
    const limit = nonNegativeInteger(input.limit ?? 25, 'hotPendingTokens.limit');
    if (limit < 1 || limit > 1000) throw new Error('hotPendingTokens.limit is invalid');
    const priorityClass = input.priorityClass == null ? null : String(input.priorityClass);
    if (priorityClass != null && !HOT_PRIORITY_CLASSES.has(priorityClass)) {
      throw new Error('hotPendingTokens.priorityClass is invalid');
    }
    const result = await database.query(
      `SELECT queue.token_address
         FROM robinhood_holder_hot_queue queue
         INNER JOIN robinhood_holder_token_states state
           ON state.chain = queue.chain AND state.token_address = queue.token_address
         INNER JOIN robinhood_holder_cursors cursor
           ON cursor.chain = queue.chain AND cursor.stream = 'live'
        WHERE queue.chain = 'robinhood'
          AND state.ledger_status IN ('shadow', 'live')
          AND NOT (queue.token_address = ANY($1::varchar[]))
          AND (
            $3::varchar IS NULL
            OR ($3 = 'fresh-live' AND state.ledger_status = 'live'
              AND queue.first_pending_block >= GREATEST(
                cursor.next_block - ${HOT_FRESH_BLOCK_WINDOW}, 0
              ))
            OR ($3 = 'recent-shadow' AND state.ledger_status = 'shadow'
              AND queue.first_pending_block >= GREATEST(
                cursor.next_block - ${HOT_RECENT_SHADOW_BLOCK_WINDOW}, 0
              ))
            OR ($3 = 'stale-live' AND state.ledger_status = 'live'
              AND queue.first_pending_block < GREATEST(
                cursor.next_block - ${HOT_FRESH_BLOCK_WINDOW}, 0
              ))
            OR ($3 = 'stale-shadow' AND state.ledger_status = 'shadow'
              AND queue.first_pending_block < GREATEST(
                cursor.next_block - ${HOT_RECENT_SHADOW_BLOCK_WINDOW}, 0
              ))
          )
        ORDER BY (state.ledger_status = 'live') DESC, queue.updated_at,
                 queue.last_pending_block DESC, queue.token_address
        LIMIT $2::int`,
      [excluded, limit, priorityClass]
    );
    return Object.freeze(result.rows.map((row) => row.token_address));
  }

  async function getHotQueueFreshness() {
    const result = await database.query(
      `WITH hot AS (
         SELECT queue.token_address, queue.first_pending_block, queue.first_enqueued_at,
                state.ledger_status, cursor.safe_head, cursor.next_block
           FROM robinhood_holder_hot_queue queue
           INNER JOIN robinhood_holder_token_states state
             ON state.chain = queue.chain AND state.token_address = queue.token_address
           INNER JOIN robinhood_holder_cursors cursor
             ON cursor.chain = queue.chain AND cursor.stream = 'live'
          WHERE queue.chain = 'robinhood' AND state.ledger_status IN ('shadow', 'live')
       )
       SELECT COUNT(token_address)::int AS pending_tokens,
              COUNT(*) FILTER (WHERE ledger_status = 'live'
                AND first_pending_block >= GREATEST(
                  next_block - ${HOT_FRESH_BLOCK_WINDOW}, 0
                ))::int AS fresh_live_tokens,
              COUNT(*) FILTER (WHERE ledger_status = 'shadow'
                AND first_pending_block >= GREATEST(
                  next_block - ${HOT_RECENT_SHADOW_BLOCK_WINDOW}, 0
                ))::int AS recent_shadow_tokens,
              COUNT(*) FILTER (WHERE ledger_status = 'shadow'
                AND first_pending_block < GREATEST(
                  next_block - ${HOT_RECENT_SHADOW_BLOCK_WINDOW}, 0
                ))::int AS stale_shadow_tokens,
              COUNT(*) FILTER (WHERE ledger_status = 'live'
                AND first_pending_block < GREATEST(
                  next_block - ${HOT_FRESH_BLOCK_WINDOW}, 0
                ))::int AS stale_live_tokens,
              COALESCE(MAX(GREATEST(safe_head - first_pending_block, 0)), 0)
                AS worst_lag_blocks,
              COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(first_enqueued_at))) * 1000, 0)
                AS oldest_age_ms
         FROM hot`
    );
    const row = result.rows[0] || {};
    return Object.freeze({
      pendingTokens: Number(row.pending_tokens) || 0,
      freshLiveTokens: Number(row.fresh_live_tokens) || 0,
      recentShadowTokens: Number(row.recent_shadow_tokens) || 0,
      staleShadowTokens: Number(row.stale_shadow_tokens) || 0,
      staleLiveTokens: Number(row.stale_live_tokens) || 0,
      worstLagBlocks: Number(row.worst_lag_blocks) || 0,
      oldestAgeMs: Math.round(Number(row.oldest_age_ms) || 0),
    });
  }

  async function quarantineMalformedToken(input = {}) {
    const tokenAddress = hex(input.tokenAddress, 20, 'malformed.tokenAddress');
    const exclusionReason = input.exclusionReason == null
      ? 'malformed_transfer_log_live' : String(input.exclusionReason);
    if (!['malformed_transfer_log_live', 'balance_overflow_live'].includes(exclusionReason)) {
      throw new Error('holder quarantine exclusion reason is invalid');
    }
    return withTransaction(database, async (client) => {
      await lockReorgFence(client, 'exclusive');
      await client.query(
        `SELECT next_block FROM robinhood_holder_cursors
          WHERE chain = $1 AND stream = $2`, [CHAIN, STREAM]
      );
      const prior = await client.query(
        `SELECT ledger_status FROM robinhood_holder_token_states
          WHERE chain = $1 AND token_address = $2
            AND ledger_status IN ('backfilling', 'shadow', 'live') FOR UPDATE`,
        [CHAIN, tokenAddress]
      );
      const balances = await client.query(
        `DELETE FROM robinhood_holder_balances
          WHERE chain = $1 AND token_address = $2`, [CHAIN, tokenAddress]
      );
      const journal = await client.query(
        `DELETE FROM robinhood_holder_transfer_journal
          WHERE chain = $1 AND token_address = $2`, [CHAIN, tokenAddress]
      );
      await client.query(
        `DELETE FROM robinhood_holder_hot_queue WHERE chain = $1 AND token_address = $2`,
        [CHAIN, tokenAddress]
      );
      const states = await client.query(
        `UPDATE robinhood_holder_token_states
            SET holder_count = 0, ledger_status = 'drifted',
                backfill_next_block = deployment_block,
                live_through_block = NULL, live_through_hash = NULL,
                last_reconciled_at = NULL, version = version + 1, updated_at = NOW()
          WHERE chain = $1 AND token_address = $2
            AND ledger_status IN ('backfilling', 'shadow', 'live')
        RETURNING version`, [CHAIN, tokenAddress]
      );
      const cohort = await client.query(
        `UPDATE robinhood_holder_global_backfill_tokens
            SET holder_count = 0, status = 'excluded',
                exclusion_reason = $3, updated_at = NOW()
          WHERE chain = $1 AND token_address = $2
            AND status IN ('active', 'materialized')`,
        [CHAIN, tokenAddress, exclusionReason]
      );
      if (!states.rowCount && !cohort.rowCount) {
        const error = new Error('malformed holder token is no longer tracked');
        error.code = 'holder_malformed_token_stale';
        throw error;
      }
      return Object.freeze({
        status: 'quarantined', tokenAddress,
        priorStatus: prior.rows[0]?.ledger_status || null,
        version: states.rows[0] ? String(states.rows[0].version) : null,
        deletedBalances: balances.rowCount, deletedJournalEvents: journal.rowCount,
        excludedCohortTokens: cohort.rowCount,
      });
    });
  }

  async function listJournalBlockCheckpoints(input = {}) {
    const fromBlock = decimalQuantity(input.fromBlock, 'journal.fromBlock');
    const toBlock = decimalQuantity(input.toBlock, 'journal.toBlock');
    if (BigInt(fromBlock) > BigInt(toBlock)) throw new Error('journal range is inverted');
    const result = await database.query(
      `SELECT block_number, MIN(block_hash) AS block_hash,
              COUNT(DISTINCT block_hash)::int AS hash_count
         FROM robinhood_holder_transfer_journal
        WHERE chain = $1 AND block_number BETWEEN $2 AND $3
        GROUP BY block_number ORDER BY block_number`,
      [CHAIN, fromBlock, toBlock]
    );
    return Object.freeze(result.rows.map((row) => {
      if (Number(row.hash_count) !== 1) {
        const error = new Error('holder journal contains conflicting block hashes');
        error.code = 'holder_journal_corrupt';
        throw error;
      }
      return Object.freeze({
        number: decimalQuantity(row.block_number, 'journal.blockNumber'),
        hash: hex(row.block_hash, 32, 'journal.blockHash'),
      });
    }));
  }

  return Object.freeze({
    appendCapturedRange, applyNextPendingEvent, promoteReadyShadowTokens,
    inspectDriftedAppliedTail, repairCapturedRange, requeueWideShadowTail,
    rollbackAppliedTail, rollbackDriftedAppliedTail,
    rewindOrphanedRange,
    getCursor, getHotQueueFreshness, listHotPendingTokenAddresses,
    listJournalBlockCheckpoints, listPendingTokenAddresses,
    listTrackedTokenAddresses,
    quarantineMalformedToken,
  });
}

module.exports = {
  createRobinhoodHolderLedgerRepository,
  deriveHolderBalanceChanges: deriveBalanceChanges,
  normalizeHolderTransfer: normalizeTransfer,
  __private: {
    deriveBalanceChanges, lockReorgFence,
    normalizeCursor, normalizeRewind, normalizeTransfer, validateRange,
  },
};
