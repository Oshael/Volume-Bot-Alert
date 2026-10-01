'use strict';
const { createHash } = require('node:crypto');
const { normalizeCandidates } = require('./robinhood-wallet-transfer-token-selection');
const READER_VERSION = 'canonical-global-v1';
const MAX_BLOCK = 9223372036854775806n;
function integer(value, label, maximum = MAX_BLOCK) {
  const text = String(value ?? '');
  if ((typeof value === 'number' && !Number.isSafeInteger(value))
    || !/^\d+$/.test(text) || BigInt(text) > maximum) throw new Error(`invalid ${label}`);
  return BigInt(text).toString();
}
function buildGlobalScanProof(capture) {
  if (capture?.source !== 'canonical-journal' || capture.complete !== true
    || capture.selectedLogsValidated !== true) throw new Error('global proof requires a complete validated canonical read');
  const fromBlock = integer(capture.fromBlock, 'fromBlock');
  const throughBlock = integer(capture.throughBlock, 'throughBlock');
  if (BigInt(throughBlock) < BigInt(fromBlock) || BigInt(throughBlock) - BigInt(fromBlock) >= 5000n) {
    throw new Error('invalid global proof range');
  }
  if (!/^0x[0-9a-f]{64}$/.test(capture.checkpointHash)) throw new Error('invalid checkpointHash');
  const observed = normalizeCandidates(capture.observedTokenAddresses);
  const selected = new Set(normalizeCandidates(capture.selectedTokenAddresses));
  const excludedTokenAddresses = observed.filter((token) => !selected.has(token));
  const observedLogs = Number(integer(capture.observedLogs, 'observedLogs', 100000n));
  if (observedLogs < observed.length || (observedLogs === 0) !== (observed.length === 0)) {
    throw new Error('observedLogs cannot prove the observed contracts');
  }
  const proof = { fromBlock, throughBlock, checkpointHash: capture.checkpointHash, readerVersion: READER_VERSION,
    observedLogs, observedContracts: observed.length, selectedContracts: observed.length - excludedTokenAddresses.length,
    excludedTokenAddresses };
  return { ...proof, proofHash: createHash('sha256').update(JSON.stringify(proof)).digest('hex') };
}

// The projection must own the transaction and cursor lock, and commit its advance with this proof.
async function persistGlobalScanProof(client, batch, capture) {
  const proof = buildGlobalScanProof(capture);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(batch.projectionVersion) || !['seed', 'live'].includes(batch.stream)) {
    throw new Error('invalid global proof identity');
  }
  const expectedVersion = integer(batch.expectedVersion, 'expectedVersion');
  const nextBlock = integer(batch.nextBlock, 'nextBlock', MAX_BLOCK + 1n);
  if (proof.throughBlock !== integer(batch.checkpointBlock, 'checkpointBlock')
    || proof.checkpointHash !== batch.checkpointHash || BigInt(nextBlock) !== BigInt(proof.throughBlock) + 1n) {
    throw new Error('global proof does not match the committed batch');
  }
  const locked = (await client.query(`SELECT version,next_block,next_transaction_index,next_log_index,lifecycle_state
    FROM robinhood_wallet_transfer_cursors WHERE chain='robinhood' AND projection_version=$1 AND stream=$2 FOR UPDATE`,
  [batch.projectionVersion, batch.stream])).rows[0];
  if (!locked || String(locked.version) !== expectedVersion || String(locked.next_block) !== proof.fromBlock
    || locked.next_transaction_index !== 0 || locked.next_log_index !== 0
    || !['pending', 'running'].includes(locked.lifecycle_state)) throw new Error('global proof cursor conflict');
  const cursorVersion = (BigInt(expectedVersion) + 1n).toString();
  const params = [batch.projectionVersion, batch.stream, proof.fromBlock, proof.throughBlock, proof.checkpointHash,
    cursorVersion, proof.readerVersion, proof.observedLogs, proof.observedContracts, proof.selectedContracts,
    proof.excludedTokenAddresses, proof.proofHash];
  const inserted = await client.query(`INSERT INTO robinhood_wallet_transfer_global_scans (
    chain,projection_version,stream,from_block,through_block,checkpoint_hash,cursor_version,reader_version,
    observed_logs,observed_contracts,selected_contracts,excluded_token_addresses,proof_hash)
    SELECT 'robinhood',$1::varchar,$2::varchar,$3::bigint,$4::bigint,$5::varchar,$6::bigint,$7::varchar,
      $8::integer,$9::integer,$10::integer,$11::text[],$12::varchar
    WHERE EXISTS (SELECT 1 FROM robinhood_chain_blocks WHERE chain='robinhood'
      AND block_number=$4::bigint AND block_hash=$5 AND canonical)
    ON CONFLICT ON CONSTRAINT rh_transfer_global_scan_identity DO NOTHING RETURNING global_scan_id::text`, params);
  if (inserted.rows.length) return { format: 'global', globalScanId: inserted.rows[0].global_scan_id };
  const existing = (await client.query(`SELECT global_scan_id::text,proof_hash FROM robinhood_wallet_transfer_global_scans
    WHERE chain='robinhood' AND projection_version=$1 AND stream=$2 AND from_block=$3 AND through_block=$4
      AND checkpoint_hash=$5 AND cursor_version=$6 AND reader_version=$7
      AND EXISTS (SELECT 1 FROM robinhood_chain_blocks WHERE chain='robinhood' AND block_number=$4
        AND block_hash=$5 AND canonical)`, params.slice(0, 7))).rows[0];
  if (!existing || existing.proof_hash !== proof.proofHash) throw new Error('global proof conflict or noncanonical checkpoint');
  return { format: 'global', globalScanId: existing.global_scan_id };
}
module.exports = { buildGlobalScanProof, persistGlobalScanProof, READER_VERSION };
