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

function normalizeTextValue(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeUpperTextValue(value) {
  const normalized = normalizeTextValue(value);
  return normalized ? normalized.toUpperCase() : null;
}

function normalizeIntegerLikeString(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(Math.trunc(value)) : null;
  }

  const normalized = String(value).trim();
  if (!/^-?\d+$/.test(normalized)) {
    return null;
  }

  return String(BigInt(normalized));
}

function getAdditionalUserId(payload) {
  const additional = getWebhookAdditionalJson(payload);
  const userId = Number(additional.appUserId);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

function getAdditionalPlanKey(payload) {
  const additional = getWebhookAdditionalJson(payload);
  const planKey = String(additional.billingPlanKey || '').trim();
  return planKey || null;
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

function buildProviderChargeMetadata(providerCharge) {
  return {
    providerChargeLookupAt: new Date().toISOString(),
    providerChargeLookupStatus: normalizeUpperTextValue(
      providerCharge?.providerTransactionStatus
        || providerCharge?.providerStatus
    ),
    providerChargeLookupTransactionId: normalizeTextValue(providerCharge?.providerTransactionId),
    providerChargeLookupTransactionSignature: normalizeTextValue(providerCharge?.providerTransactionSignature),
    providerChargeLookupPaylinkId: normalizeTextValue(providerCharge?.providerPaylinkId),
    providerChargeLookupAmount: normalizeIntegerLikeString(providerCharge?.providerRequestAmount),
    providerChargeLookupCurrency: normalizeUpperTextValue(providerCharge?.providerCurrencySymbol),
  };
}

function buildValidationFailure(reason, details = null) {
  return {
    reason,
    details: details && typeof details === 'object' ? details : null,
  };
}

function findFirstValidationFailure(failures) {
  return failures.find(Boolean) || null;
}

function compareRequiredField({ reason, expected, received, expectedKey, receivedKey }) {
  if (!expected || !received || expected !== received) {
    return buildValidationFailure(reason, {
      [expectedKey]: expected,
      [receivedKey]: received,
    });
  }

  return null;
}

function compareOptionalField({ reason, expected, received, expectedKey, receivedKey }) {
  if (!expected) {
    return null;
  }

  if (!received || expected !== received) {
    return buildValidationFailure(reason, {
      [expectedKey]: expected,
      [receivedKey]: received,
    });
  }

  return null;
}

function validateWebhookAgainstOrder(order, payload) {
  if (!order) {
    return buildValidationFailure('Billing order not found for webhook');
  }

  if (order.provider !== billingCatalog.PROVIDER) {
    return buildValidationFailure('Billing order provider mismatch', {
      orderProvider: order.provider,
    });
  }

  const webhookPlanKey = getAdditionalPlanKey(payload);
  if (webhookPlanKey && webhookPlanKey !== order.planKey) {
    return buildValidationFailure('Webhook billingPlanKey does not match billing order', {
      expectedPlanKey: order.planKey,
      receivedPlanKey: webhookPlanKey,
    });
  }

  const webhookUserId = getAdditionalUserId(payload);
  if (webhookUserId && webhookUserId !== order.userId) {
    return buildValidationFailure('Webhook appUserId does not match billing order user', {
      expectedUserId: order.userId,
      receivedUserId: webhookUserId,
    });
  }

  return null;
}

function validateProviderChargeAgainstOrder(order, payload, providerCharge) {
  if (!providerCharge) {
    return buildValidationFailure('MoonPay charge lookup did not return a charge');
  }

  const directFieldFailure = findFirstValidationFailure([
    compareRequiredField({
      reason: 'MoonPay charge id does not match billing order',
      expected: normalizeTextValue(order.providerChargeId),
      received: normalizeTextValue(providerCharge.providerChargeId),
      expectedKey: 'expectedChargeId',
      receivedKey: 'receivedChargeId',
    }),
    compareRequiredField({
      reason: 'MoonPay paylink id does not match billing order',
      expected: normalizeTextValue(order.providerPaylinkId),
      received: normalizeTextValue(providerCharge.providerPaylinkId),
      expectedKey: 'expectedPaylinkId',
      receivedKey: 'receivedPaylinkId',
    }),
    compareRequiredField({
      reason: 'MoonPay request amount does not match billing order',
      expected: normalizeIntegerLikeString(order.currencyAmountMinor),
      received: normalizeIntegerLikeString(providerCharge.providerRequestAmount),
      expectedKey: 'expectedAmount',
      receivedKey: 'receivedAmount',
    }),
    compareRequiredField({
      reason: 'MoonPay currency does not match billing order',
      expected: normalizeUpperTextValue(order.currencyCode),
      received: normalizeUpperTextValue(providerCharge.providerCurrencySymbol),
      expectedKey: 'expectedCurrency',
      receivedKey: 'receivedCurrency',
    }),
    compareRequiredField({
      reason: 'MoonPay transaction id does not match webhook payload',
      expected: normalizeTextValue(getWebhookTransactionObject(payload)?.id),
      received: normalizeTextValue(providerCharge.providerTransactionId),
      expectedKey: 'expectedTransactionId',
      receivedKey: 'receivedTransactionId',
    }),
    compareOptionalField({
      reason: 'MoonPay transaction signature does not match webhook payload',
      expected: normalizeTextValue(getWebhookMeta(payload)?.transactionSignature),
      received: normalizeTextValue(providerCharge.providerTransactionSignature),
      expectedKey: 'expectedTransactionSignature',
      receivedKey: 'receivedTransactionSignature',
    }),
  ]);
  if (directFieldFailure) {
    return directFieldFailure;
  }

  const resolvedTransactionStatus = normalizeUpperTextValue(providerCharge.providerTransactionStatus);
  if (resolvedTransactionStatus !== 'SUCCESS') {
    return buildValidationFailure('MoonPay charge lookup did not confirm a successful transaction', {
      receivedTransactionStatus: resolvedTransactionStatus,
    });
  }

  return null;
}

async function markReceivedEvent(receivedEvent, processStatus, runner) {
  if (!receivedEvent) {
    return null;
  }

  return billingEvent.markProcessed(receivedEvent.id, processStatus, runner);
}

async function rejectReceivedEvent(receivedEvent, order, reason, details = null, runner) {
  if (receivedEvent) {
    await markReceivedEvent(receivedEvent, 'rejected', runner);
  }

  if (reason) {
    console.warn('MoonPay Commerce webhook rejected:', {
      orderId: order?.id || null,
      reason,
      details: details || null,
    });
  }

  return {
    duplicate: false,
    event: receivedEvent,
    order: order || null,
    ignored: true,
    rejected: true,
    reason,
  };
}

function buildDuplicateWebhookResult(event, order) {
  return {
    duplicate: true,
    event,
    order,
  };
}

function buildProcessedWebhookResult(event, order) {
  return {
    duplicate: false,
    event,
    order,
  };
}

async function resolveReceivedWebhookEvent(orderId, eventType, deliveryKey, transactionObject, payload) {
  const existingEvent = await billingEvent.findByDeliveryKey(billingCatalog.PROVIDER, deliveryKey);
  if (existingEvent && existingEvent.processStatus !== 'received') {
    return {
      done: true,
      result: buildDuplicateWebhookResult(
        existingEvent,
        orderId ? await billingOrder.findById(orderId) : null
      ),
    };
  }

  const receivedEvent = existingEvent || await billingEvent.createEvent({
    orderId,
    provider: billingCatalog.PROVIDER,
    eventType,
    providerEventId: transactionObject?.id || null,
    deliveryIdempotencyKey: deliveryKey,
    transactionIdempotencyKey: payload?.txIdempotencyKey || null,
    payload,
  });

  if (receivedEvent?.processStatus !== 'received') {
    return {
      done: true,
      result: buildDuplicateWebhookResult(
        receivedEvent,
        orderId ? await billingOrder.findById(orderId) : null
      ),
    };
  }

  return {
    done: false,
    receivedEvent,
  };
}

async function resolveWebhookOrderContext(payload, receivedEvent, orderId) {
  const order = await billingOrder.findById(orderId);
  if (!order) {
    return {
      done: true,
      result: await rejectReceivedEvent(receivedEvent, null, 'Billing order not found for webhook'),
    };
  }

  const localValidationFailure = validateWebhookAgainstOrder(order, payload);
  if (localValidationFailure) {
    return {
      done: true,
      result: await rejectReceivedEvent(
        receivedEvent,
        order,
        localValidationFailure.reason,
        localValidationFailure.details
      ),
    };
  }

  if (billingCatalog.isMoonpayMockMode()) {
    return {
      done: false,
      order,
      providerCharge: null,
    };
  }

  if (!order.providerChargeId) {
    return {
      done: true,
      result: await rejectReceivedEvent(receivedEvent, order, 'Billing order is missing providerChargeId'),
    };
  }

  const providerCharge = await moonpayCommerce.getChargeById(order.providerChargeId);
  const providerValidationFailure = validateProviderChargeAgainstOrder(order, payload, providerCharge);
  if (providerValidationFailure) {
    return {
      done: true,
      result: await rejectReceivedEvent(
        receivedEvent,
        order,
        providerValidationFailure.reason,
        providerValidationFailure.details
      ),
    };
  }

  return {
    done: false,
    order,
    providerCharge,
  };
}

async function finalizeWebhookPayment({ orderId, payload, eventType, receivedEvent, providerCharge }) {
  return billingOrder.withTransaction(async (client) => {
    const lockedOrder = await billingOrder.findById(orderId, client);
    if (!lockedOrder) {
      return rejectReceivedEvent(receivedEvent, null, 'Billing order not found during webhook transaction', null, client);
    }

    if (lockedOrder.status === 'paid') {
      await markReceivedEvent(receivedEvent, 'duplicate_paid', client);
      return buildProcessedWebhookResult(receivedEvent, lockedOrder);
    }

    const lockedLocalValidationFailure = validateWebhookAgainstOrder(lockedOrder, payload);
    if (lockedLocalValidationFailure) {
      return rejectReceivedEvent(
        receivedEvent,
        lockedOrder,
        lockedLocalValidationFailure.reason,
        lockedLocalValidationFailure.details,
        client
      );
    }

    if (!billingCatalog.isMoonpayMockMode()) {
      const lockedProviderValidationFailure = validateProviderChargeAgainstOrder(lockedOrder, payload, providerCharge);
      if (lockedProviderValidationFailure) {
        return rejectReceivedEvent(
          receivedEvent,
          lockedOrder,
          lockedProviderValidationFailure.reason,
          lockedProviderValidationFailure.details,
          client
        );
      }
    }

    const paidOrder = await billingOrder.markPaid(orderId, {
      providerStatus: normalizeUpperTextValue(
        providerCharge?.providerTransactionStatus
          || providerCharge?.providerStatus
          || getWebhookTransactionStatus(payload)
          || eventType
      ),
      providerChargeId: lockedOrder.providerChargeId,
      metadata: {
        ...buildOrderMetadataFromWebhook(payload),
        ...buildProviderChargeMetadata(providerCharge),
      },
    }, client);

    await userAccess.extendForUserWithRunner(client, paidOrder.userId, {
      days: paidOrder.accessDays,
      source: 'payment',
    });

    await markReceivedEvent(receivedEvent, 'processed', client);
    return buildProcessedWebhookResult(receivedEvent, paidOrder);
  });
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

  const receivedEventResolution = await resolveReceivedWebhookEvent(
    orderId,
    eventType,
    deliveryKey,
    transactionObject,
    payload
  );
  if (receivedEventResolution.done) {
    return receivedEventResolution.result;
  }
  const { receivedEvent } = receivedEventResolution;

  if (!orderId) {
    await markReceivedEvent(receivedEvent, 'ignored');
    return {
      duplicate: false,
      event: receivedEvent,
      order: null,
      ignored: true,
      reason: 'billingOrderId missing from webhook additionalJSON',
    };
  }

  if (!isSuccessfulWebhookEvent(payload)) {
    await markReceivedEvent(receivedEvent, 'ignored');
    return {
      duplicate: false,
      event: receivedEvent,
      order: await billingOrder.findById(orderId),
      ignored: true,
      reason: 'Webhook event is not a successful settlement event',
    };
  }

  const orderContext = await resolveWebhookOrderContext(payload, receivedEvent, orderId);
  if (orderContext.done) {
    return orderContext.result;
  }

  return finalizeWebhookPayment({
    orderId,
    payload,
    eventType,
    receivedEvent,
    providerCharge: orderContext.providerCharge,
  });
}

module.exports = {
  createOrderForUser,
  listBillingStateForUser,
  processMoonpayWebhook,
};
