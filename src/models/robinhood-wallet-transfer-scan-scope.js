'use strict';

const { createHash } = require('node:crypto');
const { persistVersionedScope } = require('./robinhood-wallet-transfer-scope-writer');
const { persistGlobalScanProof } = require('./robinhood-wallet-transfer-global-scan-proof');

// The caller supplies the sorted, unique, normalized set actually scanned.
async function persistCaptureScope(client, batch) {
  if (batch.globalScan) return persistGlobalScanProof(client, { ...batch, nextBlock: batch.next.block }, batch.globalScan);
  const scope = batch.captureScope;
  if (!scope?.tokenAddresses.length) return;
  const scopeHash = createHash('sha256').update(scope.tokenAddresses.join('\n')).digest('hex');
  const manifest = await persistVersionedScope(client, batch, scopeHash);
  if (manifest.format === 'versioned') return manifest;
  const existing = await client.query(
    `SELECT scope_hash FROM robinhood_wallet_transfer_token_scopes
      WHERE chain=$1 AND scope_hash=$2`, ['robinhood', scopeHash]
  );
  if (!existing.rows.length) {
    await client.query(
      `INSERT INTO robinhood_wallet_transfer_token_scopes (chain, scope_hash, token_addresses)
       VALUES ($1, $2, $3::text[]) ON CONFLICT (chain, scope_hash) DO NOTHING`,
      ['robinhood', scopeHash, scope.tokenAddresses]
    );
  }
  // No in-memory cache: a rollback/restart must never retain an uncommitted reference.
  await client.query(
    `INSERT INTO robinhood_wallet_transfer_scan_scopes (
       chain, projection_version, stream, from_block, through_block,
       checkpoint_hash, token_scope_hash, filter_mode
     ) VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6, $7, $8)`,
    ['robinhood', batch.projectionVersion, batch.stream, scope.fromBlock,
      batch.checkpointBlock, batch.checkpointHash, scopeHash, scope.filterMode]
  );
  return manifest;
}

module.exports = { persistCaptureScope };
