const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const billingCatalog = require('../src/services/billing-catalog');
const billingService = require('../src/services/billing-service');

describe('billing token discount pricing', () => {
  it('calculates discounted minor-unit amounts', () => {
    assert.equal(billingCatalog.applyDiscountToAmount(4900, 50), 2450);
    assert.equal(billingCatalog.applyDiscountToAmount(4901, 50), 2451);
    assert.equal(billingCatalog.applyDiscountToAmount(4900, 0), 4900);
  });

  it('uses the discounted paylink when the plan supports token discounts', () => {
    const pricing = billingService.__private.buildOrderPricing({
      amountMinor: 4900,
      providerPaylinkId: 'paylink_full',
      discountProviderPaylinkId: 'paylink_half',
    }, {
      discountPercent: 50,
      tokenTier: 'discount_50',
      tokenSnapshotId: 99,
      tokenBalanceRaw: '1000000000000',
    });

    assert.equal(pricing.finalAmountMinor, 2450);
    assert.equal(pricing.discountAmountMinor, 2450);
    assert.equal(pricing.discountPercent, 50);
    assert.equal(pricing.providerPaylinkId, 'paylink_half');
    assert.equal(pricing.discountApplied, true);
  });

  it('keeps full price when the discount paylink is missing', () => {
    const pricing = billingService.__private.buildOrderPricing({
      amountMinor: 4900,
      providerPaylinkId: 'paylink_full',
      discountProviderPaylinkId: '',
    }, {
      discountPercent: 50,
      tokenTier: 'discount_50',
    }, {
      discountWithoutPaylinkAllowed: false,
    });

    assert.equal(pricing.finalAmountMinor, 4900);
    assert.equal(pricing.discountPercent, 0);
    assert.equal(pricing.providerPaylinkId, 'paylink_full');
    assert.equal(pricing.discountApplied, false);
    assert.equal(pricing.discountNotAppliedReason, 'discount_paylink_missing');
  });

  it('uses one dynamic paylink with provider request amount for discounted pricing', () => {
    const pricing = billingService.__private.buildOrderPricing({
      amountMinor: 4900,
      providerPaylinkId: 'paylink_dynamic',
      providerPaylinkDynamic: true,
      discountProviderPaylinkId: '',
    }, {
      discountPercent: 50,
      tokenTier: 'discount_50',
    }, {
      discountWithoutPaylinkAllowed: false,
    });

    assert.equal(pricing.finalAmountMinor, 2450);
    assert.equal(pricing.discountAmountMinor, 2450);
    assert.equal(pricing.discountPercent, 50);
    assert.equal(pricing.providerPaylinkId, 'paylink_dynamic');
    assert.equal(pricing.providerPaylinkDynamic, true);
    assert.equal(pricing.providerRequestAmount, '24.5');
    assert.equal(pricing.discountApplied, true);
    assert.equal(pricing.discountNotAppliedReason, null);
  });

  it('uses the normal paylink with discounted pricing when missing discount paylinks are explicitly allowed', () => {
    const pricing = billingService.__private.buildOrderPricing({
      amountMinor: 4900,
      providerPaylinkId: 'paylink_full',
      discountProviderPaylinkId: '',
    }, {
      discountPercent: 50,
      tokenTier: 'discount_50',
    }, {
      discountWithoutPaylinkAllowed: true,
    });

    assert.equal(pricing.finalAmountMinor, 2450);
    assert.equal(pricing.discountAmountMinor, 2450);
    assert.equal(pricing.discountPercent, 50);
    assert.equal(pricing.providerPaylinkId, 'paylink_full');
    assert.equal(pricing.discountApplied, true);
    assert.equal(pricing.discountNotAppliedReason, null);
  });
});
