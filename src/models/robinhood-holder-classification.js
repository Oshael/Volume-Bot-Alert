const db = require('./db');
const {
  CLASSIFICATION_STATUSES,
  HOLDER_CLASSIFICATION_VERSION,
  HOLDER_TAGS,
  compareClassificationFrontiers,
  normalizeClassificationFrontier,
  normalizeHolderClassification,
} = require('../services/robinhood-holder-classification-domain');

const CHAIN = 'robinhood';
const MAX_SNAPSHOT_RECORDS = 10_000;
const FRONTIER_STATUSES = new Set(['ready', 'stale', 'reorged']);

function fixedHex(value, label, bytes) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function version(value) {
  const normalized = String(value ?? HOLDER_CLASSIFICATION_VERSION).trim();
  if (!/^rh_holder_v[1-9]\d*$/.test(normalized)) {
    throw new Error('classificationVersion must match rh_holder_vN');
  }
  return normalized;
}

function instant(value, label) {
  const normalized = String(value ?? '').trim();
  const parsed = Date.parse(normalized);
  if (!normalized || !Number.isFinite(parsed)) throw new Error(`${label} must be an ISO instant`);
  return new Date(parsed).toISOString();
}

function identifier(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(`${label} must be a lowercase identifier`);
  }
  return normalized;
}

function enumValue(value, label, allowed) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!allowed.includes(normalized)) throw new Error(`Unsupported ${label}: ${normalized}`);
  return normalized;
}

function optionalStateFrontier(input, status) {
  const block = input.throughBlockNumber ?? input.through_block_number;
  const hash = input.throughBlockHash ?? input.through_block_hash;
  if ((block == null) !== (hash == null)) {
    throw new Error(`${status} classification state has an incoherent frontier`);
  }
  const hasFrontier = block != null;
  if (FRONTIER_STATUSES.has(status) !== hasFrontier) {
    throw new Error(`${status} classification state has an incoherent frontier`);
  }
  return hasFrontier ? normalizeClassificationFrontier({ blockNumber: block, blockHash: hash }) : null;
}

function normalizeState(input = {}) {
  if (input.chain != null && String(input.chain).trim().toLowerCase() !== CHAIN) {
    throw new Error(`Unsupported classification chain: ${input.chain}`);
  }
  const classifier = enumValue(input.classifier, 'classifier', HOLDER_TAGS);
  const status = enumValue(input.status, 'classification status', CLASSIFICATION_STATUSES);
  const frontier = optionalStateFrontier(input, status);
  return Object.freeze({
    chain: CHAIN,
    tokenAddress: fixedHex(input.tokenAddress ?? input.token_address, 'tokenAddress', 20),
    classifier,
    classificationVersion: version(
      input.classificationVersion ?? input.classification_version
    ),
    status,
    statusReason: identifier(input.statusReason ?? input.status_reason, 'statusReason'),
    throughBlockNumber: frontier?.blockNumber ?? null,
    throughBlockHash: frontier?.blockHash ?? null,
    observedAt: instant(input.observedAt ?? input.observed_at, 'observedAt'),
  });
}

function semanticSignature(value) {
  const { observedAt: _observedAt, ...semantic } = value;
  return JSON.stringify(semantic);
}

function assertRecordScope(input, state) {
  if (input.chain != null && String(input.chain).trim().toLowerCase() !== state.chain) {
    throw new Error('Classification record chain does not match its snapshot');
  }
  const suppliedToken = input.tokenAddress ?? input.token_address;
  const suppliedTag = input.tag;
  const suppliedVersion = input.classificationVersion ?? input.classification_version;
  const suppliedBlock = input.throughBlockNumber ?? input.through_block_number;
  const suppliedHash = input.throughBlockHash ?? input.through_block_hash;
  if (suppliedToken != null
      && fixedHex(suppliedToken, 'record.tokenAddress', 20) !== state.tokenAddress) {
    throw new Error('Classification record token does not match its snapshot');
  }
  if (suppliedTag != null && String(suppliedTag).trim().toLowerCase() !== state.classifier) {
    throw new Error('Classification record tag does not match its snapshot');
  }
  if (suppliedVersion != null && version(suppliedVersion) !== state.classificationVersion) {
    throw new Error('Classification record version does not match its snapshot');
  }
  if (suppliedBlock != null && BigInt(String(suppliedBlock)) !== BigInt(state.throughBlockNumber)) {
    throw new Error('Classification record block does not match its snapshot');
  }
  if (suppliedHash != null
      && fixedHex(suppliedHash, 'record.throughBlockHash', 32) !== state.throughBlockHash) {
    throw new Error('Classification record hash does not match its snapshot');
  }
}

function normalizeSnapshot(input = {}) {
  const state = normalizeState(input);
  if (!Array.isArray(input.records)) throw new TypeError('classification records must be a list');
  if (input.records.length > MAX_SNAPSHOT_RECORDS) {
    throw new RangeError(`classification records exceed ${MAX_SNAPSHOT_RECORDS}`);
  }
  if (state.status !== 'ready' && input.records.length) {
    throw new Error('Only a ready classification state can publish records');
  }
  const compacted = new Map();
  for (const inputRecord of input.records) {
    assertRecordScope(inputRecord, state);
    const record = normalizeHolderClassification({
      ...inputRecord,
      chain: CHAIN,
      tokenAddress: state.tokenAddress,
      tag: state.classifier,
      classificationVersion: state.classificationVersion,
      throughBlockNumber: state.throughBlockNumber,
      throughBlockHash: state.throughBlockHash,
      observedAt: inputRecord.observedAt ?? state.observedAt,
    });
    const current = compacted.get(record.walletAddress);
    if (current && semanticSignature(current) !== semanticSignature(record)) {
      throw new Error(`Conflicting classification evidence for ${record.walletAddress}`);
    }
    compacted.set(record.walletAddress, record);
  }
  return Object.freeze({
    state,
    records: Object.freeze([...compacted.values()].sort((left, right) => (
      left.walletAddress.localeCompare(right.walletAddress)
    ))),
  });
}

function stateFrontier(state) {
  if (state.throughBlockNumber == null) return null;
  return { blockNumber: state.throughBlockNumber, blockHash: state.throughBlockHash };
}

function planStateTransition(currentInput, candidateInput, options = {}) {
  if (!currentInput) return 'replace';
  const current = normalizeState(currentInput);
  const candidate = normalizeState(candidateInput);
  const sameKey = current.tokenAddress === candidate.tokenAddress
    && current.classifier === candidate.classifier
    && current.classificationVersion === candidate.classificationVersion;
  if (!sameKey) throw new Error('Cannot transition different classifier states');
  const currentFrontier = stateFrontier(current);
  const candidateFrontier = stateFrontier(candidate);
  if (currentFrontier && !candidateFrontier) {
    if (options.allowReset === true) return 'replace';
    throw new Error('Classifier frontier reset requires explicit replacement');
  }
  if (!currentFrontier && candidateFrontier) return 'replace';
  if (currentFrontier && candidateFrontier) {
    const relation = compareClassificationFrontiers(candidateFrontier, currentFrontier);
    if (relation === 'behind') return 'ignore';
    if (relation === 'ahead') return 'replace';
    if (relation === 'fork') {
      if (options.allowForkReplacement === true) return 'replace';
      throw new Error('Classifier frontier fork requires explicit replacement');
    }
  }
  return semanticSignature(current) === semanticSignature(candidate) ? 'compare' : 'replace';
}

function normalizeRecordRow(row) {
  return normalizeHolderClassification({
    chain: row.chain,
    tokenAddress: row.token_address,
    walletAddress: row.wallet_address,
    tag: row.tag,
    classificationVersion: row.classification_version,
    confidence: row.confidence,
    reasonCode: row.reason_code,
    evidence: row.evidence_json,
    throughBlockNumber: row.through_block_number,
    throughBlockHash: row.through_block_hash,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
  });
}

function normalizeStateRow(row) {
  return row ? normalizeState(row) : null;
}

function equalRecords(left, right) {
  return left.length === right.length && left.every((record, index) => (
    semanticSignature(record) === semanticSignature(right[index])
  ));
}

async function withTransaction(database, operation) {
  if (typeof database.getClient !== 'function') {
    throw new Error('classification repository requires database.getClient()');
  }
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function createRobinhoodHolderClassificationRepository(options = {}) {
  const database = options.database || db;

  async function loadStored(client, state, includeRecords = true) {
    const stateResult = await client.query(
      `SELECT * FROM robinhood_holder_classification_states
        WHERE chain = $1 AND token_address = $2 AND classifier = $3
          AND classification_version = $4 FOR UPDATE`,
      [CHAIN, state.tokenAddress, state.classifier, state.classificationVersion]
    );
    let records = [];
    if (includeRecords) {
      const result = await client.query(
        `SELECT * FROM robinhood_holder_classifications
          WHERE chain = $1 AND token_address = $2 AND tag = $3
            AND classification_version = $4 ORDER BY wallet_address`,
        [CHAIN, state.tokenAddress, state.classifier, state.classificationVersion]
      );
      records = result.rows.map(normalizeRecordRow);
    }
    return { state: normalizeStateRow(stateResult.rows[0]), records };
  }

  async function replaceClassifierSnapshot(input = {}, options = {}) {
    const snapshot = normalizeSnapshot(input);
    return withTransaction(database, async (client) => {
      const lockKey = [
        CHAIN, snapshot.state.tokenAddress, snapshot.state.classifier,
        snapshot.state.classificationVersion,
      ].join(':');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
      const stored = await loadStored(client, snapshot.state, snapshot.state.status === 'ready');
      const transition = planStateTransition(stored.state, snapshot.state, options);
      if (transition === 'ignore') {
        return Object.freeze({ status: 'stale_ignored', records: stored.records.length });
      }
      if (transition === 'compare' && snapshot.state.status !== 'ready') {
        return Object.freeze({ status: 'unchanged', records: 0 });
      }
      if (transition === 'compare' && equalRecords(stored.records, snapshot.records)) {
        return Object.freeze({ status: 'unchanged', records: stored.records.length });
      }
      const sameReadyFrontier = stored.state?.status === 'ready'
        && snapshot.state.status === 'ready'
        && compareClassificationFrontiers(
          stateFrontier(snapshot.state), stateFrontier(stored.state)
        ) === 'same';
      if (sameReadyFrontier && !equalRecords(stored.records, snapshot.records)
          && options.allowSameFrontierReplacement !== true) {
        throw new Error('Conflicting ready snapshot at the same classifier frontier');
      }
      const replaceRecords = snapshot.state.status === 'ready'
        && (!sameReadyFrontier || options.allowSameFrontierReplacement === true);
      if (replaceRecords) {
        await client.query(
          `DELETE FROM robinhood_holder_classifications
            WHERE chain = $1 AND token_address = $2 AND tag = $3
              AND classification_version = $4`,
          [CHAIN, snapshot.state.tokenAddress, snapshot.state.classifier,
            snapshot.state.classificationVersion]
        );
        if (snapshot.records.length) {
          await client.query(
            `INSERT INTO robinhood_holder_classifications (
               chain, token_address, wallet_address, tag, classification_version,
               confidence, reason_code, evidence_json, through_block_number,
               through_block_hash, observed_at, expires_at
             ) SELECT item.chain, item."tokenAddress", item."walletAddress", item.tag,
                      item."classificationVersion", item.confidence, item."reasonCode",
                      item.evidence::jsonb, item."throughBlockNumber"::bigint,
                      item."throughBlockHash", item."observedAt"::timestamptz,
                      item."expiresAt"::timestamptz
               FROM jsonb_to_recordset($1::jsonb) AS item(
                 chain text, "tokenAddress" text, "walletAddress" text, tag text,
                 "classificationVersion" text, confidence text, "reasonCode" text,
                 evidence jsonb, "throughBlockNumber" text, "throughBlockHash" text,
                 "observedAt" text, "expiresAt" text
               )`,
            [JSON.stringify(snapshot.records)]
          );
        }
      }
      const state = snapshot.state;
      await client.query(
        `INSERT INTO robinhood_holder_classification_states (
           chain, token_address, classifier, classification_version, status,
           status_reason, through_block_number, through_block_hash, observed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9::timestamptz)
         ON CONFLICT (chain, token_address, classifier, classification_version)
         DO UPDATE SET status = EXCLUDED.status, status_reason = EXCLUDED.status_reason,
           through_block_number = EXCLUDED.through_block_number,
           through_block_hash = EXCLUDED.through_block_hash,
           observed_at = EXCLUDED.observed_at, updated_at = NOW()`,
        [
          CHAIN, state.tokenAddress, state.classifier, state.classificationVersion,
          state.status, state.statusReason, state.throughBlockNumber,
          state.throughBlockHash, state.observedAt,
        ]
      );
      return Object.freeze({
        status: replaceRecords ? 'published' : 'state_updated',
        records: snapshot.records.length,
      });
    });
  }

  async function loadClassifierSnapshot(input = {}) {
    const key = normalizeState({
      ...input, status: 'pending', statusReason: 'read', observedAt: new Date(0).toISOString(),
      throughBlockNumber: null, throughBlockHash: null,
    });
    const client = typeof database.getClient === 'function' ? await database.getClient() : database;
    try {
      const stored = await loadStored(client, key);
      return Object.freeze({ state: stored.state, records: Object.freeze(stored.records) });
    } finally {
      if (client !== database) client.release();
    }
  }

  return Object.freeze({ loadClassifierSnapshot, replaceClassifierSnapshot });
}

module.exports = {
  MAX_SNAPSHOT_RECORDS,
  createRobinhoodHolderClassificationRepository,
  __private: { normalizeSnapshot, normalizeState, planStateTransition },
};
