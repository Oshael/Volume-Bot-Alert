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

  let rawText = '';
  try {
    rawText = await response.text();
  } catch (_) {
    rawText = '';
  }

  let body = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch (_) {
    body = null;
  }

  if (!response.ok) {
    const bodySummary = body && typeof body === 'object'
      ? JSON.stringify(body)
      : String(rawText || body || '').trim();
    const detail = body?.message
      || body?.error
      || body?.details
      || body?.detail
      || body?.title
      || bodySummary
      || `HTTP ${response.status}`;
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
    raw: body,
  };
}

module.exports = {
  createCharge,
  getChargeById,
};
