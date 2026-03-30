const config = require('../../config');

const PROVIDER = 'moonpay_commerce';

function formatPriceDisplay(currencyCode, amountMinor) {
  const normalizedCurrency = String(currencyCode || '').trim().toUpperCase();
  const amount = Number(amountMinor);
  if (!normalizedCurrency || !Number.isFinite(amount)) {
    return null;
  }

  const major = amount / 100;
  return `${normalizedCurrency} ${major.toFixed(2)}`;
}

function isMoonpayMockMode() {
  return Boolean(config.billing.enabled && config.billing.moonpay.mockMode);
}

function isMoonpayProviderReady() {
  return Boolean(
    config.billing.enabled
    && config.billing.moonpay.apiBaseUrl
    && (
      isMoonpayMockMode()
      || (config.billing.moonpay.apiKey && config.billing.moonpay.bearerToken)
    )
  );
}

function getPublicPlans() {
  const providerReady = isMoonpayProviderReady();
  return config.billing.plans.map((plan) => {
    const available = providerReady && Boolean(plan.providerPaylinkId);
    const availabilityReason = available
      ? null
      : !config.billing.enabled
        ? 'Billing is disabled'
        : !providerReady
          ? 'MoonPay Commerce credentials are not configured'
          : 'MoonPay Commerce paylink is missing for this plan';

    return {
      key: plan.key,
      label: plan.label,
      description: plan.description,
      accessDays: plan.accessDays,
      currencyCode: plan.currencyCode,
      amountMinor: plan.amountMinor,
      priceDisplay: formatPriceDisplay(plan.currencyCode, plan.amountMinor),
      featured: Boolean(plan.featured),
      provider: PROVIDER,
      available,
      availabilityReason,
    };
  });
}

function getPlanByKey(planKey) {
  const key = String(planKey || '').trim();
  if (!key) {
    return null;
  }
  return config.billing.plans.find((plan) => plan.key === key) || null;
}

module.exports = {
  PROVIDER,
  formatPriceDisplay,
  getPublicPlans,
  getPlanByKey,
  isMoonpayMockMode,
  isMoonpayProviderReady,
};
