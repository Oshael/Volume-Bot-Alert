const userCustomAlertRule = require('../models/user-custom-alert-rule');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { evaluateCustomAlertRule } = require('./custom-alert-rule-evaluator');

const CHAIN = 'robinhood';
const RULE_KEY = 'custom-alert';
const BASELINE_KEYS = Object.freeze({ price: 'baselinePrice', fdv: 'baselineFdv' });

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateObservation(candidate, address) {
  return {
    chain: CHAIN,
    address,
    observedAt: candidate.lastObservedAt,
    values: { price: candidate.lastPriceUsd, fdv: candidate.lastFdvUsd },
  };
}

function baselineObservation(rule, address) {
  const baseline = rule.metadata?.[BASELINE_KEYS[rule.metric]];
  if (baseline == null || !rule.metadata?.baselineAt) return null;
  return {
    chain: CHAIN,
    address,
    observedAt: rule.metadata.baselineAt,
    values: { [rule.metric]: baseline },
  };
}

function buildPayload(rule, candidate, evaluation) {
  const fdv = numberOrNull(candidate.lastFdvUsd);
  return Object.freeze({
    source: 'robinhood-onchain',
    aggregation: 'token-multiprotocol',
    protocol: candidate.protocol,
    protocols: Object.keys(candidate.protocolBreakdown || {}).sort(),
    marketKey: candidate.marketKey,
    address: evaluation.address,
    label: 'CUSTOM',
    pct: null,
    customRuleId: rule.id,
    customColorHex: rule.colorHex,
    customTitle: rule.title,
    customMetric: rule.metric === 'fdv' ? 'FDV' : 'Price',
    customOperator: 'hits',
    customTarget: evaluation.targetValue,
    customRepeatMode: 'trigger once',
    customExpires: rule.expiresAt || 'never',
    customFilters: 'none',
    customSoundName: rule.soundName,
    customSoundDataUrl: rule.soundDataUrl,
    customCurrentValue: evaluation.currentValue,
    customPreviousValue: evaluation.previousValue,
    priceUsd: numberOrNull(candidate.lastPriceUsd),
    mcap: null,
    fdv,
    valuationType: fdv == null ? null : 'fdv',
  });
}

function buildIntent(rule, candidate, evaluation) {
  return Object.freeze({
    userId: evaluation.userId,
    chain: CHAIN,
    ruleKey: RULE_KEY,
    kind: RULE_KEY,
    customRuleId: evaluation.ruleId,
    tokenAddress: evaluation.address,
    dedupeKey: `${evaluation.userId}:${RULE_KEY}:${evaluation.ruleId}:triggered`,
    triggeredAt: new Date(evaluation.observedAt),
    payload: buildPayload(rule, candidate, evaluation),
  });
}

function createRobinhoodCustomAlertAdapter(options = {}) {
  const ruleRepository = options.userCustomAlertRule || userCustomAlertRule;

  async function evaluate(candidates = []) {
    const candidateByAddress = new Map();
    for (const candidate of candidates) {
      if (candidate?.chain !== CHAIN || candidate.adminBlocked === true) continue;
      const address = normalizeTokenAddress(CHAIN, candidate.tokenAddress);
      candidateByAddress.set(address, candidate);
    }
    const identities = [...candidateByAddress.keys()].map((address) => ({ chain: CHAIN, address }));
    const rules = await ruleRepository.listActiveByTokenIdentities(identities);
    const intents = [];
    for (const rule of rules) {
      const address = normalizeTokenAddress(CHAIN, rule.tokenAddress);
      const candidate = candidateByAddress.get(address);
      if (!candidate) continue;
      const decision = evaluateCustomAlertRule(
        rule,
        candidateObservation(candidate, address),
        baselineObservation(rule, address),
      );
      if (decision.matched) intents.push(buildIntent(rule, candidate, decision.intent));
    }
    return Object.freeze({
      evaluatedRules: rules.length,
      matchedRules: intents.length,
      intents: Object.freeze(intents),
    });
  }

  return Object.freeze({ evaluate });
}

module.exports = {
  CHAIN,
  RULE_KEY,
  createRobinhoodCustomAlertAdapter,
  __private: { baselineObservation, buildIntent, buildPayload, candidateObservation },
};
