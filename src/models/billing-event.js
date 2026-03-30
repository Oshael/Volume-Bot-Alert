const { query } = require('./db');

function mapRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    eventType: row.event_type,
    providerEventId: row.provider_event_id || null,
    deliveryIdempotencyKey: row.delivery_idempotency_key || null,
    transactionIdempotencyKey: row.transaction_idempotency_key || null,
    processStatus: row.process_status,
    payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    processedAt: row.processed_at ? new Date(row.processed_at).toISOString() : null,
  };
}

async function createEvent(input, runner = { query }) {
  try {
    const { rows } = await runner.query(
      `INSERT INTO billing_events (
         order_id,
         provider,
         event_type,
         provider_event_id,
         delivery_idempotency_key,
         transaction_idempotency_key,
         process_status,
         payload
       )
       VALUES ($1, $2, $3, $4, $5, $6, 'received', $7::jsonb)
       RETURNING *`,
      [
        input.orderId || null,
        input.provider,
        input.eventType,
        input.providerEventId || null,
        input.deliveryIdempotencyKey || null,
        input.transactionIdempotencyKey || null,
        JSON.stringify(input.payload || {}),
      ]
    );
    return mapRow(rows[0]);
  } catch (error) {
    if (error && error.code === '23505' && input.deliveryIdempotencyKey) {
      return findByDeliveryKey(input.provider, input.deliveryIdempotencyKey, runner);
    }
    throw error;
  }
}

async function findByDeliveryKey(provider, deliveryIdempotencyKey, runner = { query }) {
  if (!deliveryIdempotencyKey) {
    return null;
  }

  const { rows } = await runner.query(
    `SELECT *
     FROM billing_events
     WHERE provider = $1 AND delivery_idempotency_key = $2`,
    [provider, deliveryIdempotencyKey]
  );
  return mapRow(rows[0]);
}

async function markProcessed(id, processStatus, runner = { query }) {
  const { rows } = await runner.query(
    `UPDATE billing_events
     SET process_status = $2,
         processed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, processStatus]
  );
  return mapRow(rows[0]);
}

module.exports = {
  createEvent,
  findByDeliveryKey,
  markProcessed,
};
