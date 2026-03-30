const { query, getClient } = require('./db');

const VALID_STATUSES = new Set(['pending', 'awaiting_payment', 'paid', 'failed', 'expired', 'cancelled']);

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_STATUSES.has(normalized) ? normalized : 'pending';
}

function mapRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    planKey: row.plan_key,
    planName: row.plan_name,
    accessDays: row.access_days,
    provider: row.provider,
    providerPaylinkId: row.provider_paylink_id,
    providerChargeId: row.provider_charge_id,
    providerChargeToken: row.provider_charge_token,
    providerCheckoutUrl: row.provider_checkout_url,
    providerStatus: row.provider_status,
    currencyCode: row.currency_code,
    currencyAmountMinor: Number(row.currency_amount_minor),
    status: normalizeStatus(row.status),
    checkoutExpiresAt: row.checkout_expires_at ? new Date(row.checkout_expires_at).toISOString() : null,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    lastError: row.last_error || null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function createOrder(input, runner = { query }) {
  const { rows } = await runner.query(
    `INSERT INTO billing_orders (
       user_id,
       plan_key,
       plan_name,
       access_days,
       provider,
       provider_paylink_id,
       currency_code,
       currency_amount_minor,
       status,
       metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9::jsonb)
     RETURNING *`,
    [
      input.userId,
      input.planKey,
      input.planName,
      input.accessDays,
      input.provider,
      input.providerPaylinkId || null,
      input.currencyCode,
      input.currencyAmountMinor,
      JSON.stringify(input.metadata || {}),
    ]
  );
  return mapRow(rows[0]);
}

async function markCheckoutReady(orderId, input, runner = { query }) {
  const { rows } = await runner.query(
    `UPDATE billing_orders
     SET status = 'awaiting_payment',
         provider_charge_id = COALESCE($2, provider_charge_id),
         provider_charge_token = COALESCE($3, provider_charge_token),
         provider_checkout_url = COALESCE($4, provider_checkout_url),
         provider_status = COALESCE($5, provider_status),
         checkout_expires_at = COALESCE($6, checkout_expires_at),
         metadata = COALESCE(metadata, '{}'::jsonb) || $7::jsonb,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      orderId,
      input.providerChargeId || null,
      input.providerChargeToken || null,
      input.providerCheckoutUrl || null,
      input.providerStatus || null,
      input.checkoutExpiresAt || null,
      JSON.stringify(input.metadata || {}),
    ]
  );
  return mapRow(rows[0]);
}

async function markFailed(orderId, input, runner = { query }) {
  const { rows } = await runner.query(
    `UPDATE billing_orders
     SET status = $2,
         provider_status = COALESCE($3, provider_status),
         last_error = $4,
         metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      orderId,
      normalizeStatus(input.status || 'failed'),
      input.providerStatus || null,
      input.lastError || null,
      JSON.stringify(input.metadata || {}),
    ]
  );
  return mapRow(rows[0]);
}

async function markPaid(orderId, input, runner = { query }) {
  const { rows } = await runner.query(
    `UPDATE billing_orders
     SET status = 'paid',
         provider_status = COALESCE($2, provider_status),
         paid_at = COALESCE($3, paid_at, NOW()),
         provider_charge_id = COALESCE($4, provider_charge_id),
         metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      orderId,
      input.providerStatus || null,
      input.paidAt || null,
      input.providerChargeId || null,
      JSON.stringify(input.metadata || {}),
    ]
  );
  return mapRow(rows[0]);
}

async function findById(orderId, runner = { query }) {
  const { rows } = await runner.query('SELECT * FROM billing_orders WHERE id = $1', [orderId]);
  return mapRow(rows[0]);
}

async function findByIdForUser(orderId, userId) {
  const { rows } = await query('SELECT * FROM billing_orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
  return mapRow(rows[0]);
}

async function findByProviderChargeId(provider, providerChargeId, runner = { query }) {
  const { rows } = await runner.query(
    'SELECT * FROM billing_orders WHERE provider = $1 AND provider_charge_id = $2',
    [provider, providerChargeId]
  );
  return mapRow(rows[0]);
}

async function listForUser(userId, limit = 20) {
  const { rows } = await query(
    `SELECT *
     FROM billing_orders
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows.map(mapRow);
}

async function withTransaction(handler) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  VALID_STATUSES,
  mapRow,
  createOrder,
  markCheckoutReady,
  markFailed,
  markPaid,
  findById,
  findByIdForUser,
  findByProviderChargeId,
  listForUser,
  withTransaction,
};
