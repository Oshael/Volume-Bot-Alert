const CHAIN = 'robinhood';
const VALUATION_TYPE = 'fdv';
const MONITORED_FDV_RULE_KEY = 'monitored-fdv';
const STANDARD_RULE_KEYS = Object.freeze([
  'monitored-vol',
  MONITORED_FDV_RULE_KEY,
  'recent-surge-1h',
  'recent-surge-6h',
  'old-week-surge-1h',
  'old-week-surge-6h',
]);
const STANDARD_RULE_KINDS = Object.freeze({
  'monitored-vol': 'monitored-vol',
  [MONITORED_FDV_RULE_KEY]: MONITORED_FDV_RULE_KEY,
  'recent-surge-1h': 'old-surge',
  'recent-surge-6h': 'old-surge',
  'old-week-surge-1h': 'old-surge',
  'old-week-surge-6h': 'old-surge',
});

function isRobinhoodStandardRule(ruleKey, kind) {
  const normalizedRule = String(ruleKey || '').trim().toLowerCase();
  const expectedKind = STANDARD_RULE_KINDS[normalizedRule];
  return expectedKind != null
    && (kind == null || String(kind).trim().toLowerCase() === expectedKind);
}

module.exports = {
  CHAIN,
  MONITORED_FDV_RULE_KEY,
  STANDARD_RULE_KEYS,
  STANDARD_RULE_KINDS,
  VALUATION_TYPE,
  isRobinhoodStandardRule,
};
