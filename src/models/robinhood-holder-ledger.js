const db = require('./db');

const CHAIN = 'robinhood';
const STREAM = 'live';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

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

async function insertTransfer(client, transfer) {
  const result = await client.query(
    `INSERT INTO robinhood_holder_transfer_journal (
       chain, block_number, block_hash, transaction_hash, transaction_index,
       log_index, token_address, from_wallet, to_wallet, amount_raw
     ) VALUES ('robinhood', $1, $2, $3, $4, $5, $6, $7, $8, $9::numeric)
     ON CONFLICT (chain, transaction_hash, log_index) DO UPDATE SET
       captured_at = robinhood_holder_transfer_journal.captured_at
     WHERE robinhood_holder_transfer_journal.block_number = EXCLUDED.block_number
       AND robinhood_holder_transfer_journal.block_hash = EXCLUDED.block_hash
       AND robinhood_holder_transfer_journal.transaction_index = EXCLUDED.transaction_index
       AND robinhood_holder_transfer_journal.token_address = EXCLUDED.token_address
       AND robinhood_holder_transfer_journal.from_wallet = EXCLUDED.from_wallet
       AND robinhood_holder_transfer_journal.to_wallet = EXCLUDED.to_wallet
       AND robinhood_holder_transfer_journal.amount_raw = EXCLUDED.amount_raw
     RETURNING (xmax = 0) AS inserted`,
    [
      transfer.blockNumber, transfer.blockHash, transfer.transactionHash,
      transfer.transactionIndex, transfer.logIndex, transfer.tokenAddress,
      transfer.fromWallet, transfer.toWallet, transfer.amountRaw,
    ]
  );
  if (!result.rowCount) {
    const error = new Error('captured transfer conflicts with existing journal evidence');
    error.code = 'holder_capture_conflict';
    throw error;
  }
  return result.rows[0]?.inserted === true;
}

async function advanceCursor(client, cursor) {
  const result = await client.query(
    `INSERT INTO robinhood_holder_cursors (
       chain, stream, next_block, safe_head, checkpoint_block, checkpoint_hash,
       journal_floor_block
     ) VALUES ('robinhood', 'live', $1, $2, $3, $4, $6)
     ON CONFLICT (chain, stream) DO UPDATE SET
       next_block = EXCLUDED.next_block,
       safe_head = EXCLUDED.safe_head,
       checkpoint_block = EXCLUDED.checkpoint_block,
       checkpoint_hash = EXCLUDED.checkpoint_hash,
       journal_floor_block = COALESCE(
         robinhood_holder_cursors.journal_floor_block, EXCLUDED.journal_floor_block
       ),
       version = robinhood_holder_cursors.version + 1,
       updated_at = NOW()
     WHERE $5::bigint IS NOT NULL
       AND robinhood_holder_cursors.version = $5::bigint
       AND robinhood_holder_cursors.next_block = $6::bigint
     RETURNING version`,
    [
      cursor.nextBlock, cursor.safeHead, cursor.checkpointBlock,
      cursor.checkpointHash, cursor.expectedVersion, cursor.rangeStart,
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
    version: Number(row.version),
  });
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
    toAfter = transfer.toWallet === transfer.fromWallet
      ? fromBefore : toBefore + amount;
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

async function lockNextApplicableEvent(client) {
  const cursor = await client.query(
    `SELECT next_block FROM robinhood_holder_cursors
      WHERE chain = 'robinhood' AND stream = 'live' FOR UPDATE`
  );
  if (!cursor.rowCount) {
    const error = new Error('holder live cursor is missing');
    error.code = 'holder_cursor_missing';
    throw error;
  }
  const result = await client.query(
    `SELECT journal.block_number, journal.block_hash, journal.transaction_hash,
            journal.transaction_index, journal.log_index, journal.token_address,
            journal.from_wallet, journal.to_wallet, journal.amount_raw,
            state.backfill_next_block, state.live_through_block
       FROM robinhood_holder_transfer_journal journal
       INNER JOIN robinhood_holder_token_states state
         ON state.chain = journal.chain AND state.token_address = journal.token_address
        AND state.ledger_status IN ('shadow', 'live')
      WHERE journal.chain = 'robinhood' AND journal.applied = false
      ORDER BY journal.block_number, journal.transaction_index, journal.log_index
      LIMIT 1
      FOR UPDATE OF journal, state SKIP LOCKED`
  );
  return result.rows[0] || null;
}

function transferFromRow(row) {
  return normalizeTransfer({
    blockNumber: row.block_number, blockHash: row.block_hash,
    transactionHash: row.transaction_hash, transactionIndex: row.transaction_index,
    logIndex: row.log_index, tokenAddress: row.token_address,
    fromWallet: row.from_wallet, toWallet: row.to_wallet, amountRaw: row.amount_raw,
  });
}

async function loadLockedBalances(client, transfer) {
  const wallets = [...new Set([transfer.fromWallet, transfer.toWallet]
    .filter((wallet) => wallet !== ZERO_ADDRESS))].sort();
  if (!wallets.length) return { balances: {}, provenance: {} };
  const result = await client.query(
    `SELECT wallet_address, balance_raw, last_block_number,
            last_transaction_hash, last_log_index
       FROM robinhood_holder_balances
      WHERE chain = 'robinhood' AND token_address = $1
        AND wallet_address = ANY($2::varchar[])
      ORDER BY wallet_address FOR UPDATE`,
    [transfer.tokenAddress, wallets]
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

async function persistBalance(client, transfer, transition) {
  if (BigInt(transition.after) === 0n) {
    await client.query(
      `DELETE FROM robinhood_holder_balances
        WHERE chain = 'robinhood' AND token_address = $1 AND wallet_address = $2`,
      [transfer.tokenAddress, transition.walletAddress]
    );
    return;
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
      transfer.tokenAddress, transition.walletAddress, transition.after,
      transfer.blockNumber, transfer.transactionHash, transfer.logIndex,
    ]
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
    failedBlock: transfer.blockNumber, recoveryFromBlock, recoverySafe,
  });
}

async function commitAppliedEvent(client, changes, priorProvenance) {
  for (const transition of changes.transitions) {
    await persistBalance(client, changes.transfer, transition);
  }
  const state = await client.query(
    `UPDATE robinhood_holder_token_states
        SET holder_count = holder_count + $2::smallint,
            live_through_block = $3, live_through_hash = $4,
            version = version + 1, updated_at = NOW()
      WHERE chain = 'robinhood' AND token_address = $1
        AND ledger_status IN ('shadow', 'live')
        AND holder_count + $2::smallint >= 0
        AND (live_through_block IS NULL OR live_through_block <= $3)
      RETURNING holder_count, version, ledger_status, updated_at,
                live_through_block, live_through_hash`,
    [
      changes.transfer.tokenAddress, changes.holderDelta,
      changes.transfer.blockNumber, changes.transfer.blockHash,
    ]
  );
  if (!state.rowCount) throw new Error('holder token state rejected an ordered transfer');
  const fromPrior = priorProvenance[changes.transfer.fromWallet] || {};
  const toPrior = priorProvenance[changes.transfer.toWallet] || {};
  const journal = await client.query(
    `UPDATE robinhood_holder_transfer_journal
        SET from_balance_before = $3::numeric, from_balance_after = $4::numeric,
            to_balance_before = $5::numeric, to_balance_after = $6::numeric,
            holder_delta = $7,
            from_last_block_before = $8, from_last_transaction_hash_before = $9,
            from_last_log_index_before = $10,
            to_last_block_before = $11, to_last_transaction_hash_before = $12,
            to_last_log_index_before = $13,
            applied = true, applied_at = NOW()
      WHERE chain = 'robinhood' AND transaction_hash = $1 AND log_index = $2
        AND applied = false
      RETURNING transaction_hash`,
    [
      changes.transfer.transactionHash, changes.transfer.logIndex,
      changes.fromBalanceBefore, changes.fromBalanceAfter,
      changes.toBalanceBefore, changes.toBalanceAfter, changes.holderDelta,
      fromPrior.blockNumber ?? null, fromPrior.transactionHash ?? null,
      fromPrior.logIndex ?? null, toPrior.blockNumber ?? null,
      toPrior.transactionHash ?? null, toPrior.logIndex ?? null,
    ]
  );
  if (!journal.rowCount) throw new Error('holder journal event was concurrently applied');
  const row = state.rows[0];
  const publication = row.ledger_status === 'live' && changes.holderDelta !== 0
    ? Object.freeze({
        tokenAddress: changes.transfer.tokenAddress,
        holderCount: String(row.holder_count), ledgerVersion: String(row.version),
        observedAt: row.updated_at,
        liveThroughBlock: String(row.live_through_block),
        liveThroughHash: row.live_through_hash,
      })
    : null;
  return Object.freeze({
    status: 'applied', tokenAddress: changes.transfer.tokenAddress,
    holderCount: String(row.holder_count), holderDelta: changes.holderDelta,
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
  const cursor = await client.query(
    `UPDATE robinhood_holder_cursors
        SET next_block = $1, safe_head = $2, checkpoint_block = $3,
            checkpoint_hash = $4, version = version + 1, updated_at = NOW()
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
      let insertedTransfers = 0;
      for (const transfer of transfers) {
        if (await insertTransfer(client, transfer)) insertedTransfers += 1;
      }
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
      const cursor = await client.query(
        `SELECT next_block, safe_head, journal_floor_block
           FROM robinhood_holder_cursors
          WHERE chain = 'robinhood' AND stream = 'live' FOR UPDATE`
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
      let insertedTransfers = 0;
      for (const transfer of transfers) {
        if (await insertTransfer(client, transfer)) insertedTransfers += 1;
      }
      return Object.freeze({
        status: 'repaired', tokenAddress, insertedTransfers,
        duplicateTransfers: transfers.length - insertedTransfers,
      });
    });
  }

  async function applyNextPendingEvent(input = {}) {
    return withTransaction(database, async (client) => {
      const row = await lockNextApplicableEvent(client);
      if (!row) return Object.freeze({ status: 'idle' });
      const transfer = transferFromRow(row);
      const locked = await loadLockedBalances(client, transfer);
      let changes;
      try {
        changes = deriveBalanceChanges(transfer, locked.balances);
      } catch (error) {
        if (error.code !== 'holder_negative_balance') throw error;
        const suspicion = liveDeficit(transfer, row, locked.balances);
        if (input.confirmDriftFingerprint == null) return suspicion;
        if (String(input.confirmDriftFingerprint) !== suspicion.fingerprint) {
          const stale = new Error('holder live drift evidence changed before confirmation');
          stale.code = 'holder_live_drift_stale';
          throw stale;
        }
        await markTokenDrifted(client, transfer.tokenAddress);
        return Object.freeze({ ...suspicion, status: 'drifted' });
      }
      return commitAppliedEvent(client, changes, locked.provenance);
    });
  }

  async function rewindOrphanedRange(input = {}) {
    const rewind = normalizeRewind(input);
    return withTransaction(database, async (client) => {
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
              journal_floor_block, version
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
        ORDER BY token_address`,
      [CHAIN]
    );
    return Object.freeze(result.rows.map((row) => row.token_address));
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
    appendCapturedRange, applyNextPendingEvent, repairCapturedRange, rewindOrphanedRange,
    getCursor, listJournalBlockCheckpoints, listTrackedTokenAddresses,
  });
}

module.exports = {
  createRobinhoodHolderLedgerRepository,
  deriveHolderBalanceChanges: deriveBalanceChanges,
  normalizeHolderTransfer: normalizeTransfer,
  __private: {
    deriveBalanceChanges, normalizeCursor, normalizeRewind, normalizeTransfer, validateRange,
  },
};
