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

function applyDiscountToAmount(amountMinor, discountPercent) {
  const amount = Number(amountMinor);
  const percent = Math.max(0, Math.min(Number(discountPercent) || 0, 100));
  if (!Number.isFinite(amount) || amount <= 0 || percent <= 0) {
    return Math.round(amount);
  }
  return Math.max(1, Math.round((amount * (100 - percent)) / 100));
}

function isMoonpayMockMode() {
  return Boolean(config.billing.enabled && config.billing.moonpay.mockMode);
}

function isDiscountWithoutPaylinkAllowed() {
  return isMoonpayMockMode();
}

function isDynamicPaylinkPlan(plan) {
  return Boolean(plan?.providerPaylinkDynamic);
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

function getPublicPlans(options = {}) {
  const providerReady = isMoonpayProviderReady();
  const tokenDiscountPercent = Math.max(0, Math.min(Number(options.discountPercent) || 0, 100));
  const discountWithoutPaylinkAllowed = isDiscountWithoutPaylinkAllowed();
  return config.billing.plans.map((plan) => {
    const discountedAmountMinor = applyDiscountToAmount(plan.amountMinor, tokenDiscountPercent);
    const discountAvailable = tokenDiscountPercent > 0;
    const discountCheckoutAvailable = !discountAvailable
      || discountWithoutPaylinkAllowed
      || isDynamicPaylinkPlan(plan)
      || Boolean(plan.discountProviderPaylinkId);
    const available = providerReady && Boolean(plan.providerPaylinkId) && discountCheckoutAvailable;
    const availabilityReason = available
      ? null
      : !discountCheckoutAvailable
        ? 'Discount checkout paylink is missing for this plan'
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
      discountedAmountMinor: discountAvailable ? discountedAmountMinor : null,
      discountedPriceDisplay: discountAvailable
        ? formatPriceDisplay(plan.currencyCode, discountedAmountMinor)
        : null,
      discountPercent: discountAvailable ? tokenDiscountPercent : 0,
      discountAvailable,
      featured: Boolean(plan.featured),
      provider: PROVIDER,
      providerPaylinkDynamic: isDynamicPaylinkPlan(plan),
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
  applyDiscountToAmount,
  formatPriceDisplay,
  getPublicPlans,
  getPlanByKey,
  isDiscountWithoutPaylinkAllowed,
  isDynamicPaylinkPlan,
  isMoonpayMockMode,
  isMoonpayProviderReady,
};
