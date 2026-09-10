'use strict';

const db = require('./db');

const CHAIN = 'robinhood';
const NOTIFY_CHANNEL = 'robinhood_chain_recovery_outbox';

function generation(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error('recovery generation is invalid');
  return BigInt(raw).toString();
}
function timestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('recovery detectedAt is invalid');
  return parsed.toISOString();
}
function recoveryPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('recovery plan is required');
  }
  const normalizedGeneration = generation(value.generation);
  return { plan: value, generation: normalizedGeneration };
}

function createRobinhoodChainRecoveryJournal(options = {}) {
  const database = options.database || db;

  async function recordDetected(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('transactional recovery journal client is required');
    }
    const normalized = recoveryPlan(input.plan);
    const detectedAt = timestamp(input.detectedAt);
    const recovery = await client.query(
      `INSERT INTO robinhood_chain_recoveries(
         chain, generation, status, plan, detected_at
       ) VALUES ($1,$2::bigint,'detected',$3::jsonb,$4::timestamptz)
       ON CONFLICT (chain, generation) DO UPDATE
         SET updated_at=NOW()
       WHERE robinhood_chain_recoveries.plan=EXCLUDED.plan
       RETURNING status`,
      [CHAIN, normalized.generation, JSON.stringify(normalized.plan), detectedAt]
    );
    if (recovery.rowCount !== 1) {
      const error = new Error('recovery generation already has a different durable plan');
      error.code = 'capture_recovery_journal_conflict';
      throw error;
    }
    const payload = {
      type: 'chain:reorg:detected', generation: normalized.generation,
      detectedAt, plan: normalized.plan,
    };
    const event = await client.query(
      `INSERT INTO robinhood_chain_recovery_outbox(
         chain, generation, event_kind, payload
       ) VALUES ($1,$2::bigint,'detected',$3::jsonb)
       ON CONFLICT (chain, generation, event_kind, event_key) DO NOTHING
       RETURNING generation`,
      [CHAIN, normalized.generation, JSON.stringify(payload)]
    );
    if (event.rowCount === 1) {
      await client.query('SELECT pg_notify($1,$2)', [NOTIFY_CHANNEL, normalized.generation]);
    }
    return { status: recovery.rows[0].status, eventInserted: event.rowCount === 1 };
  }

  async function get(recoveryGeneration) {
    const result = await database.query(
      `SELECT generation, status, plan, detected_at, rewound_at,
              completed_at, last_error, created_at, updated_at
         FROM robinhood_chain_recoveries
        WHERE chain=$1 AND generation=$2::bigint`, [CHAIN, generation(recoveryGeneration)]
    );
    return result.rows[0] || null;
  }

  return Object.freeze({ get, recordDetected });
}

module.exports = {
  NOTIFY_CHANNEL, createRobinhoodChainRecoveryJournal,
  __private: { generation, recoveryPlan, timestamp },
};
