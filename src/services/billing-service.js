const config = require('../../config');
const billingOrder = require('../models/billing-order');
const billingEvent = require('../models/billing-event');
const userAccess = require('../models/user-access');
const billingCatalog = require('./billing-catalog');
const moonpayCommerce = require('./moonpay-commerce');

function parseAdditionalJson(rawValue) {
  if (!rawValue) {
    return {};
  }

  if (typeof rawValue === 'object') {
    return rawValue;
  }

  try {
    return JSON.parse(rawValue);
  } catch (_) {
    return {};
  }
}

function getWebhookTransactionObject(payload) {
  return payload?.transactionObject || null;
}

function getWebhookMeta(payload) {
  return getWebhookTransactionObject(payload)?.meta || null;
}

function getWebhookAdditionalJson(payload) {
  return parseAdditionalJson(
    getWebhookMeta(payload)?.customerDetails?.additionalJSON
      || payload?.customerDetails?.additionalJSON
      || null
  );
}

function buildWebhookDeliveryKey(payload) {
  return String(
    payload?.webhookDeliveryIdempotencyKey
      || `${payload?.event || 'UNKNOWN'}:${getWebhookTransactionObject(payload)?.id || getWebhookMeta(payload)?.transactionSignature || 'unknown'}`
  ).trim();
}

function getWebhookTransactionStatus(payload) {
  return String(
    getWebhookMeta(payload)?.transactionStatus
      || payload?.transactionStatus
      || ''
  ).trim().toUpperCase();
}

function isSuccessfulWebhookEvent(payload) {
  const eventType = String(payload?.event || '').trim().toUpperCase();
  const transactionStatus = getWebhookTransactionStatus(payload);

  if (eventType === 'CREATED' && transactionStatus === 'SUCCESS') {
    return true;
  }

  if (eventType === 'DEPOSIT_TX_CONFIRMED') {
    return true;
  }

  if (eventType === 'DEPOSIT_TX_ENRICHED' && transactionStatus === 'SUCCESS') {
    return true;
  }

  return false;
}

function getWebhookOrderId(payload) {
  const additional = getWebhookAdditionalJson(payload);
  const orderId = Number(additional.billingOrderId);
  return Number.isInteger(orderId) && orderId > 0 ? orderId : null;
}

function buildOrderMetadataFromWebhook(payload) {
  const transactionObject = getWebhookTransactionObject(payload);
  const meta = getWebhookMeta(payload);

  return {
    lastWebhookEvent: String(payload?.event || '').trim() || null,
    lastWebhookAt: new Date().toISOString(),
    providerTransactionId: transactionObject?.id || null,
    providerTransactionSignature: meta?.transactionSignature || null,
    providerTransactionStatus: getWebhookTransactionStatus(payload) || null,
    providerWebhookAmount: payload?.amount || meta?.amount || null,
    providerWebhookCurrency: payload?.currency?.symbol || meta?.currency?.symbol || null,
  };
}

function getPublicBillingState(userId, plans, orders) {
  return {
    enabled: Boolean(config.billing.enabled),
    provider: billingCatalog.PROVIDER,
    providerReady: billingCatalog.isMoonpayProviderReady(),
    providerMocked: billingCatalog.isMoonpayMockMode(),
    userId,
    plans,
    orders,
  };
}

async function createOrderForUser(user, planKey, options = {}) {
  const plan = billingCatalog.getPlanByKey(planKey);
  if (!plan) {
    const error = new Error('Billing plan not found');
    error.statusCode = 404;
    throw error;
  }

  if (!config.billing.enabled) {
    const error = new Error('Billing is disabled');
    error.statusCode = 503;
    throw error;
  }

  if (!billingCatalog.isMoonpayProviderReady()) {
    const error = new Error('MoonPay Commerce is not configured');
    error.statusCode = 503;
    throw error;
  }

  if (!plan.providerPaylinkId) {
    const error = new Error('Billing plan is not linked to a MoonPay Commerce paylink');
    error.statusCode = 503;
    throw error;
  }

  const order = await billingOrder.createOrder({
    userId: user.id,
    planKey: plan.key,
    planName: plan.label,
    accessDays: plan.accessDays,
    provider: billingCatalog.PROVIDER,
    providerPaylinkId: plan.providerPaylinkId,
    currencyCode: plan.currencyCode,
    currencyAmountMinor: plan.amountMinor,
    metadata: {
      createdBy: 'user',
      moonpayNetwork: config.billing.moonpay.network,
      successRedirectUrl: options.successRedirectUrl || config.billing.checkoutReturnUrl || null,
      ...(options.metadata || {}),
    },
  });

  try {
    const charge = await moonpayCommerce.createCharge({
      orderId: order.id,
      planKey: plan.key,
      userId: user.id,
      providerPaylinkId: plan.providerPaylinkId,
      successRedirectUrl: options.successRedirectUrl || config.billing.checkoutReturnUrl || null,
    });

    return billingOrder.markCheckoutReady(order.id, {
      providerChargeId: charge.providerChargeId,
      providerChargeToken: charge.providerChargeToken,
      providerCheckoutUrl: charge.providerCheckoutUrl,
      providerStatus: charge.providerStatus,
      metadata: {
        successRedirectUrl: options.successRedirectUrl || config.billing.checkoutReturnUrl || null,
        providerCreateChargeResponse: charge.raw,
      },
    });
  } catch (error) {
    await billingOrder.markFailed(order.id, {
      status: 'failed',
      lastError: error.message,
      metadata: {
        providerCreateChargeFailedAt: new Date().toISOString(),
      },
    });
    throw error;
  }
}

async function listBillingStateForUser(userId) {
  const plans = billingCatalog.getPublicPlans();
  const orders = await billingOrder.listForUser(userId, 20);
  return getPublicBillingState(userId, plans, orders);
}

async function processMoonpayWebhook(payload) {
  const eventType = String(payload?.event || '').trim().toUpperCase() || 'UNKNOWN';
  const orderId = getWebhookOrderId(payload);
  const deliveryKey = buildWebhookDeliveryKey(payload);
  const transactionObject = getWebhookTransactionObject(payload);

  const existingEvent = await billingEvent.findByDeliveryKey(billingCatalog.PROVIDER, deliveryKey);
  if (existingEvent) {
    return {
      duplicate: true,
      event: existingEvent,
      order: orderId ? await billingOrder.findById(orderId) : null,
    };
  }

  const receivedEvent = await billingEvent.createEvent({
    orderId,
    provider: billingCatalog.PROVIDER,
    eventType,
    providerEventId: transactionObject?.id || null,
    deliveryIdempotencyKey: deliveryKey,
    transactionIdempotencyKey: payload?.txIdempotencyKey || null,
    payload,
  });

  if (!orderId) {
    if (receivedEvent) {
      await billingEvent.markProcessed(receivedEvent.id, 'ignored');
    }
    return {
      duplicate: false,
      event: receivedEvent,
      order: null,
      ignored: true,
      reason: 'billingOrderId missing from webhook additionalJSON',
    };
  }

  if (!isSuccessfulWebhookEvent(payload)) {
    if (receivedEvent) {
      await billingEvent.markProcessed(receivedEvent.id, 'ignored');
    }
    return {
      duplicate: false,
      event: receivedEvent,
      order: await billingOrder.findById(orderId),
      ignored: true,
      reason: 'Webhook event is not a successful settlement event',
    };
  }

  const updatedOrder = await billingOrder.withTransaction(async (client) => {
    const lockedOrder = await billingOrder.findById(orderId, client);
    if (!lockedOrder) {
      throw new Error('Billing order not found for webhook');
    }

    if (lockedOrder.status === 'paid') {
      if (receivedEvent) {
        await billingEvent.markProcessed(receivedEvent.id, 'duplicate_paid', client);
      }
      return lockedOrder;
    }

    const paidOrder = await billingOrder.markPaid(orderId, {
      providerStatus: getWebhookTransactionStatus(payload) || eventType,
      providerChargeId: lockedOrder.providerChargeId,
      metadata: buildOrderMetadataFromWebhook(payload),
    }, client);

    await userAccess.extendForUserWithRunner(client, paidOrder.userId, {
      days: paidOrder.accessDays,
      source: 'payment',
    });

    if (receivedEvent) {
      await billingEvent.markProcessed(receivedEvent.id, 'processed', client);
    }

    return paidOrder;
  });

  return {
    duplicate: false,
    event: receivedEvent,
    order: updatedOrder,
  };
}

module.exports = {
  createOrderForUser,
  listBillingStateForUser,
  processMoonpayWebhook,
};
