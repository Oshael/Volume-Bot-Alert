import type { AlertEntry } from '../../state/app-state';

const RETIRED_STANDARD_ALERT_KINDS = new Set<AlertEntry['kind']>([
  'monitored-vol',
  'monitored-mcap',
  'monitored-fdv',
]);

const RETIRED_STANDARD_ALERT_RULE_KEYS = new Set([
  'monitored-vol',
  'gmgn-vol-1m',
  'monitored-mcap',
  'monitored-fdv',
]);

export function isRetiredStandardAlert(
  alert: Pick<AlertEntry, 'kind' | 'ruleKey'>,
) {
  const ruleKey = String(alert.ruleKey || '').trim().toLowerCase();
  return RETIRED_STANDARD_ALERT_KINDS.has(alert.kind)
    || RETIRED_STANDARD_ALERT_RULE_KEYS.has(ruleKey);
}
