const config = require('../../config');
const billingOrder = require('../models/billing-order');
const billingEvent = require('../models/billing-event');
const userAccess = require('../models/user-access');
const userWallet = require('../models/user-wallet');
const User = require('../models/user');
const billingCatalog = require('./billing-catalog');
const moonpayCommerce = require('./moonpay-commerce');
const tokenHoldingService = require('./token-holding-service');

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

function normalizeDecimalAmountString(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const normalized = String(value).trim();
  const match = normalized.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) {
    return null;
  }

  const sign = match[1] === '-' ? '-' : '';
  const integerPart = String(BigInt(match[2]));
  const fractionalPart = String(match[3] || '').replace(/0+$/, '');
  return `${sign}${integerPart}${fractionalPart ? `.${fractionalPart}` : ''}`;
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
    providerChargeLookupAmount: normalizeDecimalAmountString(providerCharge?.providerRequestAmount),
    providerChargeLookupCurrency: normalizeUpperTextValue(providerCharge?.providerCurrencySymbol),
  };
}

function getProviderChargeLookupId(order) {
  return normalizeTextValue(order?.providerChargeToken)
    || normalizeTextValue(order?.providerChargeId)
    || null;
}

function buildCheckoutSuccessRedirectUrl(baseUrl, orderId) {
  const normalizedBaseUrl = normalizeTextValue(baseUrl);
  if (!normalizedBaseUrl) {
    return null;
  }

  try {
    const url = new URL(normalizedBaseUrl);
    url.searchParams.set('billing', 'success');
    url.searchParams.set('billingOrderId', String(orderId));
    return url.toString();
  } catch (_) {
    const separator = normalizedBaseUrl.includes('?') ? '&' : '?';
    return `${normalizedBaseUrl}${separator}billing=success&billingOrderId=${encodeURIComponent(String(orderId))}`;
  }
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

  const expectedProviderRequestAmount = order.metadata?.pricing?.providerRequestAmount
    || order.currencyAmountMinor;
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
      expected: normalizeDecimalAmountString(expectedProviderRequestAmount),
      received: normalizeDecimalAmountString(providerCharge.providerRequestAmount),
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

  const providerChargeLookupId = getProviderChargeLookupId(order);
  if (!providerChargeLookupId) {
    return {
      done: true,
      result: await rejectReceivedEvent(receivedEvent, order, 'Billing order is missing provider charge lookup token'),
    };
  }

  const providerCharge = await moonpayCommerce.getChargeById(providerChargeLookupId);
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

function buildNoDiscountContext(reason) {
  return {
    discountPercent: 0,
    tokenTier: 'none',
    tokenSnapshotId: null,
    tokenBalanceRaw: null,
    tokenBalanceUi: null,
    tokenSnapshotCheckedAt: null,
    tokenSnapshotExpiresAt: null,
    notAppliedReason: reason || null,
  };
}

async function resolveTokenDiscountContext(user, options = {}) {
  if (!config.tokenGate.enabled || !config.tokenGate.mintAddress) {
    return buildNoDiscountContext('token_gate_disabled');
  }

  const wallet = await (options.userWalletModel || userWallet).findByUserId(user.id);
  if (!wallet?.walletAddress) {
    return buildNoDiscountContext('wallet_not_linked');
  }

  const snapshot = await (options.tokenHoldingService || tokenHoldingService).refreshSnapshotForUser({
    userId: user.id,
    walletAddress: wallet.walletAddress,
  });

  return buildDiscountContextFromSnapshot(snapshot);
}

function buildDiscountContextFromSnapshot(snapshot) {
  return {
    discountPercent: Number(snapshot?.discountPercent) || 0,
    tokenTier: snapshot?.tier || 'none',
    tokenSnapshotId: snapshot?.id || null,
    tokenBalanceRaw: snapshot?.balanceRaw || null,
    tokenBalanceUi: snapshot?.balanceUiString || null,
    tokenSnapshotCheckedAt: snapshot?.checkedAt || null,
    tokenSnapshotExpiresAt: snapshot?.expiresAt || null,
    notAppliedReason: null,
  };
}

function buildProviderRequestAmount(plan, amountMinor) {
  if (!billingCatalog.isDynamicPaylinkPlan(plan)) {
    return null;
  }

  const amount = Number.parseInt(String(amountMinor ?? ''), 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    return null;
  }

  const whole = Math.trunc(amount / 100);
  const cents = amount % 100;
  if (cents === 0) {
    return String(whole);
  }
  return `${whole}.${String(cents).padStart(2, '0').replace(/0+$/, '')}`;
}

function canApplyTokenDiscount({ discountPercent, dynamicPaylink, discountWithoutPaylinkAllowed, plan }) {
  return discountPercent > 0
    && (discountWithoutPaylinkAllowed || dynamicPaylink || Boolean(plan.discountProviderPaylinkId));
}

function resolvePricingPaylinkId({ canApplyDiscount, dynamicPaylink, plan }) {
  if (canApplyDiscount && plan.discountProviderPaylinkId && !dynamicPaylink) {
    return plan.discountProviderPaylinkId;
  }
  return plan.providerPaylinkId;
}

function buildOrderPricing(plan, discountContext, options = {}) {
  const discountPercent = Math.max(0, Math.min(Number(discountContext?.discountPercent) || 0, 100));
  const discountedAmountMinor = billingCatalog.applyDiscountToAmount(plan.amountMinor, discountPercent);
  const discountWithoutPaylinkAllowed = options.discountWithoutPaylinkAllowed
    ?? billingCatalog.isDiscountWithoutPaylinkAllowed();
  const dynamicPaylink = billingCatalog.isDynamicPaylinkPlan(plan);
  const canApplyDiscount = canApplyTokenDiscount({
    discountPercent,
    dynamicPaylink,
    discountWithoutPaylinkAllowed,
    plan,
  });
  const finalAmountMinor = canApplyDiscount ? discountedAmountMinor : plan.amountMinor;
  const providerPaylinkId = resolvePricingPaylinkId({ canApplyDiscount, dynamicPaylink, plan });

  return {
    baseAmountMinor: plan.amountMinor,
    finalAmountMinor,
    discountPercent: canApplyDiscount ? discountPercent : 0,
    discountAmountMinor: canApplyDiscount ? plan.amountMinor - finalAmountMinor : 0,
    providerPaylinkId,
    providerPaylinkDynamic: dynamicPaylink,
    providerRequestAmount: buildProviderRequestAmount(plan, finalAmountMinor),
    discountApplied: canApplyDiscount,
    discountNotAppliedReason: canApplyDiscount
      ? null
      : discountPercent > 0
        ? 'discount_paylink_missing'
        : discountContext?.notAppliedReason || null,
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

  const discountContext = await resolveTokenDiscountContext(user, options);
  const pricing = buildOrderPricing(plan, discountContext);
  const baseSuccessRedirectUrl = options.successRedirectUrl || config.billing.checkoutReturnUrl || null;

  const order = await billingOrder.createOrder({
    userId: user.id,
    planKey: plan.key,
    planName: plan.label,
    accessDays: plan.accessDays,
    provider: billingCatalog.PROVIDER,
    providerPaylinkId: pricing.providerPaylinkId,
    currencyCode: plan.currencyCode,
    currencyAmountMinor: pricing.finalAmountMinor,
    metadata: {
      createdBy: 'user',
      moonpayNetwork: config.billing.moonpay.network,
      pricing: {
        baseAmountMinor: pricing.baseAmountMinor,
        finalAmountMinor: pricing.finalAmountMinor,
        discountAmountMinor: pricing.discountAmountMinor,
        discountPercent: pricing.discountPercent,
        discountApplied: pricing.discountApplied,
        discountNotAppliedReason: pricing.discountNotAppliedReason,
        providerPaylinkDynamic: pricing.providerPaylinkDynamic,
        providerRequestAmount: pricing.providerRequestAmount,
      },
      tokenDiscount: discountContext,
      successRedirectUrl: baseSuccessRedirectUrl,
      ...(options.metadata || {}),
    },
  });

  try {
    const successRedirectUrl = buildCheckoutSuccessRedirectUrl(baseSuccessRedirectUrl, order.id);
    const charge = await moonpayCommerce.createCharge({
      orderId: order.id,
      planKey: plan.key,
      userId: user.id,
      providerPaylinkId: pricing.providerPaylinkId,
      requestAmount: pricing.providerRequestAmount,
      successRedirectUrl,
    });

    return billingOrder.markCheckoutReady(order.id, {
      providerChargeId: charge.providerChargeId,
      providerChargeToken: charge.providerChargeToken,
      providerCheckoutUrl: charge.providerCheckoutUrl,
      providerStatus: charge.providerStatus,
      metadata: {
        successRedirectUrl,
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
  const user = await User.findById(userId);
  const access = user ? await userAccess.buildResolvedAccessSnapshot(user) : null;
  const plans = billingCatalog.getPublicPlans({ discountPercent: access?.discountPercent || 0 });
  const orders = await billingOrder.listForUser(userId, 20);
  return getPublicBillingState(userId, plans, orders);
}

async function syncOrderPaymentFromProvider(user, orderId) {
  const normalizedOrderId = Number(orderId);
  if (!Number.isInteger(normalizedOrderId) || normalizedOrderId <= 0) {
    const error = new Error('Invalid billing order id');
    error.statusCode = 400;
    throw error;
  }

  const order = await billingOrder.findByIdForUser(normalizedOrderId, user.id);
  if (!order) {
    const error = new Error('Billing order not found');
    error.statusCode = 404;
    throw error;
  }

  if (order.status === 'paid') {
    return {
      synced: false,
      reason: 'already_paid',
      order,
    };
  }

  if (billingCatalog.isMoonpayMockMode()) {
    return {
      synced: false,
      reason: 'mock_mode',
      order,
    };
  }

  const providerChargeLookupId = getProviderChargeLookupId(order);
  if (!providerChargeLookupId) {
    const error = new Error('Billing order is missing provider charge lookup token');
    error.statusCode = 409;
    throw error;
  }

  const providerCharge = await moonpayCommerce.getChargeById(providerChargeLookupId);
  const providerTransactionStatus = normalizeUpperTextValue(providerCharge.providerTransactionStatus);
  if (providerTransactionStatus !== 'SUCCESS') {
    return {
      synced: false,
      reason: 'provider_charge_not_successful',
      order,
      providerStatus: providerTransactionStatus || null,
    };
  }

  const transactionId = providerCharge.providerTransactionId || providerCharge.providerChargeId;
  const result = await processMoonpayWebhook({
    event: 'CREATED',
    webhookDeliveryIdempotencyKey: `provider-sync:${order.id}:${transactionId}`,
    transactionObject: {
      id: transactionId,
      meta: {
        transactionStatus: providerTransactionStatus,
        transactionSignature: providerCharge.providerTransactionSignature,
        customerDetails: {
          additionalJSON: JSON.stringify({
            billingOrderId: order.id,
            billingPlanKey: order.planKey,
            appUserId: order.userId,
          }),
        },
      },
    },
  });

  return {
    synced: Boolean(result?.order?.status === 'paid' || result?.duplicate),
    reason: result?.reason || null,
    order: await billingOrder.findByIdForUser(order.id, user.id),
    result,
  };
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
  syncOrderPaymentFromProvider,
  processMoonpayWebhook,
  __private: {
    buildOrderPricing,
    resolveTokenDiscountContext,
  },
};
