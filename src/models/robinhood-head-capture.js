const db = require('./db');

const CHAIN = 'robinhood';
const CURSOR_NOTIFY_CHANNEL = 'robinhood_head_capture_cursor';
const STREAMS = new Set(['discovery', 'market']);
const PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
const CAPTURE_INSERT_BATCH_SIZE = 500;
const CAPTURE_PARAMETER_COUNT = 13;

function decimalQuantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw).toString();
}

function hexWord(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be 32 bytes`);
  return normalized;
}

function hexAddress(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} must be 20 bytes`);
  return normalized;
}

function normalizeStream(value, label) {
  const stream = String(value || '').trim().toLowerCase();
  if (!STREAMS.has(stream)) throw new Error(`${label} must be discovery or market`);
  return stream;
}

function normalizeProtocol(value) {
  const protocol = String(value || '').trim().toLowerCase();
  if (!protocol) return null;
  if (!PROTOCOLS.has(protocol)) throw new Error('capture protocol is invalid');
  return protocol;
}

function normalizeEvidenceVersion(value) {
  const version = value == null ? 1 : Number(value);
  if (!Number.isInteger(version) || version < 1) throw new Error('evidence_version must be a positive integer');
  return version;
}

function normalizeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('capture evidence must be a JSON object');
  }
  return JSON.stringify(value);
}

function normalizeTopics(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error('capture topics must be a non-empty array');
  const topics = value.map((topic, index) => hexWord(topic, `topics[${index}]`));
  return JSON.stringify(topics);
}

function normalizeCaptureEntry(entry) {
  const log = entry?.log;
  if (!log) throw new Error('capture entry.log is required');
  return {
    stream: normalizeStream(entry.stream, 'capture stream'),
    transactionHash: hexWord(log.transactionHash, 'log.transactionHash'),
    logIndex: decimalQuantity(log.logIndex, 'log.logIndex'),
    blockNumber: decimalQuantity(log.blockNumber, 'log.blockNumber'),
    blockHash: hexWord(log.blockHash, 'log.blockHash'),
    transactionIndex: decimalQuantity(log.transactionIndex, 'log.transactionIndex'),
    address: hexAddress(log.address, 'log.address'),
    topics: normalizeTopics(log.topics),
    data: String(log.data ?? ''),
    protocol: normalizeProtocol(entry.protocol),
    marketKey: String(entry.marketKey || '').trim().toLowerCase() || null,
    evidenceVersion: normalizeEvidenceVersion(entry.evidenceVersion),
    evidence: normalizeEvidence(entry.evidence),
  };
}

function normalizeCaptureCursor(cursor = {}) {
  const checkpoint = cursor.checkpoint || null;
  return {
    stream: normalizeStream(cursor.stream, 'cursor.stream'),
    nextBlock: decimalQuantity(cursor.nextBlock, 'cursor.nextBlock'),
    safeHead: cursor.safeHead == null ? null : decimalQuantity(cursor.safeHead, 'cursor.safeHead'),
    checkpointBlock: checkpoint?.number == null
      ? null
      : decimalQuantity(checkpoint.number, 'cursor.checkpoint.number'),
    checkpointHash: checkpoint?.hash == null
      ? null
      : hexWord(checkpoint.hash, 'cursor.checkpoint.hash'),
    checkpointTimestamp: checkpoint?.timestamp == null ? null : new Date(checkpoint.timestamp),
  };
}

function captureParameters(entry) {
  return [
    entry.stream, entry.transactionHash, entry.logIndex, entry.blockNumber,
    entry.blockHash, entry.transactionIndex, entry.address, entry.topics,
    entry.data, entry.protocol, entry.marketKey, entry.evidenceVersion, entry.evidence,
  ];
}

function capturePlaceholders(rowIndex) {
  const offset = rowIndex * CAPTURE_PARAMETER_COUNT;
  const parameter = (position) => `$${offset + position}`;
  return `(
    'robinhood', ${parameter(1)}, ${parameter(2)}, ${parameter(3)}, ${parameter(4)},
    ${parameter(5)}, ${parameter(6)}, ${parameter(7)}, ${parameter(8)}::jsonb,
    ${parameter(9)}, ${parameter(10)}, ${parameter(11)}, ${parameter(12)},
    ${parameter(13)}::jsonb
  )`;
}

async function insertCaptureBatch(client, entries) {
  if (!entries.length) return 0;
  const placeholders = entries.map((_, index) => capturePlaceholders(index)).join(',');
  const parameters = entries.flatMap(captureParameters);
  return client.query(
    `INSERT INTO robinhood_head_captures (
       chain, stream, transaction_hash, log_index, block_number, block_hash,
       transaction_index, address, topics, data, protocol, market_key,
       evidence_version, evidence
     ) VALUES ${placeholders}
     ON CONFLICT (chain, transaction_hash, log_index) DO NOTHING
     RETURNING 1`,
    parameters
  );
}

async function upsertCaptureCursor(client, cursor) {
  await client.query(
    `INSERT INTO robinhood_head_capture_cursors (
       chain, stream, next_block, safe_head, checkpoint_block, checkpoint_hash,
       checkpoint_timestamp
     ) VALUES ('robinhood', $1, $2, $3, $4, $5, $6)
     ON CONFLICT (chain, stream) DO UPDATE SET
       next_block = EXCLUDED.next_block,
       safe_head = EXCLUDED.safe_head,
       checkpoint_block = EXCLUDED.checkpoint_block,
       checkpoint_hash = EXCLUDED.checkpoint_hash,
       checkpoint_timestamp = EXCLUDED.checkpoint_timestamp,
       version = robinhood_head_capture_cursors.version + 1,
       updated_at = NOW()
     WHERE robinhood_head_capture_cursors.next_block <= EXCLUDED.next_block`,
    [
      cursor.stream, cursor.nextBlock, cursor.safeHead, cursor.checkpointBlock,
      cursor.checkpointHash, cursor.checkpointTimestamp,
    ]
  );
}

function createRobinhoodHeadCaptureRepository(options = {}) {
  const database = options.database || db;

  async function appendCaptureEntries(input = {}) {
    const entries = (Array.isArray(input.entries) ? input.entries : []).map(normalizeCaptureEntry);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      let insertedCaptures = 0;
      for (let index = 0; index < entries.length; index += CAPTURE_INSERT_BATCH_SIZE) {
        const inserted = await insertCaptureBatch(
          client, entries.slice(index, index + CAPTURE_INSERT_BATCH_SIZE)
        );
        insertedCaptures += inserted.rowCount;
      }
      await client.query('COMMIT');
      return { insertedCaptures, duplicateCaptures: entries.length - insertedCaptures };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function appendCaptures(input = {}) {
    const cursor = normalizeCaptureCursor(input.cursor);
    const entries = (Array.isArray(input.entries) ? input.entries : []).map(normalizeCaptureEntry);
    if (entries.some((entry) => entry.stream !== cursor.stream)) {
      throw new Error('capture entries must share the cursor stream');
    }
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      let insertedCaptures = 0;
      for (let index = 0; index < entries.length; index += CAPTURE_INSERT_BATCH_SIZE) {
        const batch = entries.slice(index, index + CAPTURE_INSERT_BATCH_SIZE);
        const inserted = await insertCaptureBatch(client, batch);
        insertedCaptures += inserted.rowCount;
      }
      await upsertCaptureCursor(client, cursor);
      await client.query('SELECT pg_notify($1, $2)', [CURSOR_NOTIFY_CHANNEL, cursor.stream]);
      await client.query('COMMIT');
      return {
        insertedCaptures,
        duplicateCaptures: entries.length - insertedCaptures,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function getCaptureCursor(stream) {
    const normalizedStream = normalizeStream(stream, 'stream');
    const result = await database.query(
      `SELECT stream, next_block, safe_head, checkpoint_block, checkpoint_hash,
              checkpoint_timestamp, version
         FROM robinhood_head_capture_cursors
        WHERE chain = $1 AND stream = $2`,
      [CHAIN, normalizedStream]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      stream: row.stream,
      nextBlock: String(row.next_block),
      safeHead: row.safe_head == null ? null : String(row.safe_head),
      checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
      checkpointHash: row.checkpoint_hash,
      checkpointTimestamp: row.checkpoint_timestamp,
      version: Number(row.version),
    };
  }

  return Object.freeze({ appendCaptureEntries, appendCaptures, getCaptureCursor });
}

module.exports = { CURSOR_NOTIFY_CHANNEL, createRobinhoodHeadCaptureRepository };
