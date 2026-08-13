'use strict';

// Persistence for token image fingerprints (Bloco 1). The matcher (Bloco 5)
// keeps hashes in memory; this model is only the write path from the catalog and
// the candidate selection that decides which tokens still need (re)fingerprinting.

const db = require('../models/db');

// Our hashes are unsigned 64-bit BigInts; Postgres BIGINT is signed 64-bit.
// Wrap to the signed range on write and back to unsigned on read so the stored
// value round-trips exactly. Hamming is computed in memory, never in SQL, so the
// signed representation is purely a storage detail.
function toSignedBigInt(hash) {
  if (hash === null || hash === undefined) return null;
  return BigInt.asIntN(64, BigInt(hash));
}

function fromSignedBigInt(value) {
  if (value === null || value === undefined) return null;
  return BigInt.asUintN(64, BigInt(value));
}

// Tokens that have an image but no fresh fingerprint: either never computed, or
// the catalog image changed since we last computed, or a previous attempt failed
// and the retry backoff has elapsed.
async function selectCandidates({ limit, retryIntervalMs, now = Date.now } = {}) {
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 50, 1000));
  const retryBeforeIso = new Date(now() - Math.max(0, Number(retryIntervalMs) || 0)).toISOString();
  const { rows } = await db.query(
    `SELECT tc.chain, tc.address AS token_address, tc.last_image_url AS source_image_url
       FROM token_catalog tc
       LEFT JOIN token_image_fingerprint f
         ON f.chain = tc.chain AND f.token_address = tc.address
      WHERE tc.last_image_url IS NOT NULL AND tc.last_image_url <> ''
        AND (
          f.token_address IS NULL
          OR f.source_image_url IS DISTINCT FROM tc.last_image_url
          OR (f.ok = FALSE AND f.computed_at < $1)
        )
      ORDER BY tc.last_seen_at DESC
      LIMIT $2`,
    [retryBeforeIso, cappedLimit],
  );
  return rows.map((row) => ({
    chain: row.chain,
    tokenAddress: row.token_address,
    sourceImageUrl: row.source_image_url,
  }));
}

async function upsertFingerprint(entry) {
  const {
    chain,
    tokenAddress,
    sourceImageUrl,
    phash = null,
    dhash = null,
    phashMirror = null,
    dhashMirror = null,
    ok = true,
  } = entry;
  await db.query(
    `INSERT INTO token_image_fingerprint
       (chain, token_address, source_image_url, phash, dhash, phash_mirror, dhash_mirror, ok, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (chain, token_address) DO UPDATE SET
       source_image_url = EXCLUDED.source_image_url,
       phash = EXCLUDED.phash,
       dhash = EXCLUDED.dhash,
       phash_mirror = EXCLUDED.phash_mirror,
       dhash_mirror = EXCLUDED.dhash_mirror,
       ok = EXCLUDED.ok,
       computed_at = EXCLUDED.computed_at`,
    [
      chain,
      tokenAddress,
      sourceImageUrl,
      toSignedBigInt(phash),
      toSignedBigInt(dhash),
      toSignedBigInt(phashMirror),
      toSignedBigInt(dhashMirror),
      ok === true,
    ],
  );
}

module.exports = {
  toSignedBigInt,
  fromSignedBigInt,
  selectCandidates,
  upsertFingerprint,
};
