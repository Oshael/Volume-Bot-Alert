import type { AlertEntry } from '../../state/app-state';

type ClaimFeeAlert = Pick<AlertEntry, 'claimFeeAmount' | 'claimFeeCurrency' | 'claimFeeUsd' | 'totalFeeUsd'>;

const STABLE_FEE_CURRENCIES = new Set(['USD', 'USDC', 'USDT']);

function toFiniteNumber(value?: number | null) {
  return value != null && Number.isFinite(value) ? value : null;
}

function formatMoney(value: number) {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(0)}`;
}

function formatTokenAmount(value: number) {
  const absValue = Math.abs(value);
  if (absValue >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (absValue >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (absValue >= 1) return value.toFixed(2);
  if (absValue >= 0.01) return value.toFixed(4);
  return value.toFixed(6);
}

export function formatClaimFee(alert: ClaimFeeAlert) {
  const currency = String(alert.claimFeeCurrency || '').trim().toUpperCase();
  const claimAmount = toFiniteNumber(alert.claimFeeAmount);
  if (claimAmount != null && currency) {
    return STABLE_FEE_CURRENCIES.has(currency)
      ? formatMoney(claimAmount)
      : `${formatTokenAmount(claimAmount)} ${currency}`;
  }

  const usdAmount = toFiniteNumber(alert.claimFeeUsd) ?? toFiniteNumber(alert.totalFeeUsd);
  return usdAmount != null ? formatMoney(usdAmount) : null;
}
