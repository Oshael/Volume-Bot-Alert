const config = require('../../config');

function isMockMode() {
  return Boolean(config.billing.enabled && config.billing.moonpay.mockMode);
}

function getAuthHeaders() {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (config.billing.moonpay.bearerToken) {
    headers.Authorization = `Bearer ${config.billing.moonpay.bearerToken}`;
  }

  return headers;
}

function buildUrl(path) {
  const url = new URL(path.replace(/^\//, ''), `${config.billing.moonpay.apiBaseUrl}/`);
  if (config.billing.moonpay.apiKey) {
    url.searchParams.set('apiKey', config.billing.moonpay.apiKey);
  }
  return url.toString();
}

function buildMockCheckoutUrl(orderId, providerChargeId) {
  return `http://localhost:${config.port}/api/billing/mock-checkout/${encodeURIComponent(orderId)}?charge=${encodeURIComponent(providerChargeId)}`;
}

async function readMoonpayResponseText(response) {
  try {
    return await response.text();
  } catch (_) {
    return '';
  }
}

function parseMoonpayResponseBody(rawText) {
  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch (_) {
    return null;
  }
}

function getMoonpayErrorDetail(response, body, rawText) {
  const bodySummary = body && typeof body === 'object'
    ? JSON.stringify(body)
    : String(rawText || body || '').trim();

  return body?.message
    || body?.error
    || body?.details
    || body?.detail
    || body?.title
    || bodySummary
    || `HTTP ${response.status}`;
}

async function requestMoonpay(path, init) {
  const method = String(init?.method || 'GET').toUpperCase();
  const requestUrl = buildUrl(path);
  let response;
  try {
    response = await fetch(requestUrl, {
      ...init,
      headers: {
        ...getAuthHeaders(),
        ...(init?.headers || {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown network error';
    throw new Error(`MoonPay Commerce request failed: ${message}`);
  }

  const rawText = await readMoonpayResponseText(response);
  const body = parseMoonpayResponseBody(rawText);

  if (!response.ok) {
    const detail = getMoonpayErrorDetail(response, body, rawText);
    throw new Error(`MoonPay Commerce request failed (${method} ${path} -> ${response.status}): ${detail}`);
  }

  return body;
}

function extractCheckoutUrl(body) {
  return body?.pageUrl
    || body?.url
    || body?.chargeUrl
    || body?.hostedUrl
    || body?.checkoutUrl
    || body?.paymentUrl
    || null;
}

function extractChargeId(body) {
  return body?.id
    || body?.chargeId
    || body?.charge?.id
    || null;
}

function extractChargeToken(body, checkoutUrl) {
  if (body?.chargeToken) {
    return body.chargeToken;
  }

  if (!checkoutUrl) {
    return null;
  }

  try {
    const parsed = new URL(checkoutUrl);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || null;
  } catch (_) {
    return null;
  }
}

function extractStatus(body) {
  return body?.status || body?.chargeStatus || body?.transactionStatus || null;
}

function extractChargePaylinkId(body) {
  return body?.paylink?.id
    || body?.paymentRequestId
    || null;
}

function extractChargeRequestAmount(body) {
  return body?.requestAmount
    || body?.prepareRequestBody?.amount
    || body?.paylink?.normalizedPrice
    || body?.paylink?.price
    || null;
}

function extractChargeCurrencySymbol(body) {
  const candidates = [
    body?.currencySymbol,
    body?.prepareRequestBody?.currency,
    body?.paylink?.pricingCurrency?.symbol,
    body?.paylink?.currency?.symbol,
    body?.paylinkTx?.meta?.currency?.symbol,
  ];
  return candidates.find(Boolean) || null;
}

function extractChargePaymentTransaction(body) {
  return body?.paylinkTx || null;
}

function extractChargePaymentTransactionId(body) {
  return extractChargePaymentTransaction(body)?.id || null;
}

function extractChargePaymentTransactionSignature(body) {
  return extractChargePaymentTransaction(body)?.meta?.transactionSignature || null;
}

function extractChargePaymentTransactionStatus(body) {
  return extractChargePaymentTransaction(body)?.meta?.transactionStatus
    || extractStatus(body)
    || null;
}

function buildChargePayload(input) {
  const additionalJson = {
    billingOrderId: input.orderId,
    billingPlanKey: input.planKey,
    appUserId: input.userId,
  };

  const payload = {
    paymentRequestId: input.providerPaylinkId,
    prepareRequestBody: {
      customerDetails: {
        additionalJSON: JSON.stringify(additionalJson),
      },
    },
  };

  if (input.successRedirectUrl) {
    payload.successRedirectUrl = input.successRedirectUrl;
  }

  return payload;
}

async function createCharge(input) {
  if (isMockMode()) {
    const providerChargeId = `mock_charge_${input.orderId}_${Date.now()}`;
    const providerCheckoutUrl = buildMockCheckoutUrl(input.orderId, providerChargeId);
    return {
      providerChargeId,
      providerChargeToken: providerChargeId,
      providerCheckoutUrl,
      providerStatus: 'pending',
      raw: {
        id: providerChargeId,
        url: providerCheckoutUrl,
        status: 'pending',
        mockMode: true,
      },
    };
  }

  const payload = buildChargePayload(input);
  let body;
  try {
    body = await requestMoonpay('/charge/api-key', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown MoonPay Commerce error';
    throw new Error(`${detail} [network=${config.billing.moonpay.network} apiBaseUrl=${config.billing.moonpay.apiBaseUrl} paylinkId=${String(input.providerPaylinkId || '')} redirect=${String(input.successRedirectUrl || '')}]`);
  }

  const providerCheckoutUrl = extractCheckoutUrl(body);
  return {
    providerChargeId: extractChargeId(body),
    providerChargeToken: extractChargeToken(body, providerCheckoutUrl),
    providerCheckoutUrl,
    providerStatus: extractStatus(body),
    raw: body,
  };
}

async function getChargeById(chargeId) {
  if (isMockMode()) {
    const providerCheckoutUrl = buildMockCheckoutUrl('lookup', chargeId);
    return {
      providerChargeId: chargeId,
      providerChargeToken: chargeId,
      providerCheckoutUrl,
      providerStatus: 'pending',
      providerPaylinkId: null,
      providerRequestAmount: null,
      providerCurrencySymbol: null,
      providerTransactionId: null,
      providerTransactionSignature: null,
      providerTransactionStatus: null,
      raw: {
        id: chargeId,
        url: providerCheckoutUrl,
        status: 'pending',
        mockMode: true,
      },
    };
  }

  const body = await requestMoonpay(`/charge/${encodeURIComponent(chargeId)}`, {
    method: 'GET',
  });
  return {
    providerChargeId: extractChargeId(body),
    providerChargeToken: extractChargeToken(body, extractCheckoutUrl(body)),
    providerCheckoutUrl: extractCheckoutUrl(body),
    providerStatus: extractStatus(body),
    providerPaylinkId: extractChargePaylinkId(body),
    providerRequestAmount: extractChargeRequestAmount(body),
    providerCurrencySymbol: extractChargeCurrencySymbol(body),
    providerTransactionId: extractChargePaymentTransactionId(body),
    providerTransactionSignature: extractChargePaymentTransactionSignature(body),
    providerTransactionStatus: extractChargePaymentTransactionStatus(body),
    raw: body,
  };
}

module.exports = {
  createCharge,
  getChargeById,
};
