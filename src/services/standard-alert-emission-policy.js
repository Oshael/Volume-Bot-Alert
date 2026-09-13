const RETIRED_STANDARD_ALERT_RULE_KEYS = Object.freeze(new Set([
  'monitored-vol',
  'gmgn-vol-1m',
  'monitored-mcap',
  'monitored-fdv',
]));

function isStandardAlertEmissionRetired(ruleKey) {
  return RETIRED_STANDARD_ALERT_RULE_KEYS.has(
    String(ruleKey || '').trim().toLowerCase(),
  );
}

module.exports = {
  isStandardAlertEmissionRetired,
};
