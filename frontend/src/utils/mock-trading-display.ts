export const MOCK_SOL_USDC_RATE_CONFIG_KEY = 'mock-sol-usdc-rate';
export const DEFAULT_MOCK_SOL_USDC_RATE = 88;

export interface MockSolRateSource {
  priceUsd?: number | string | null;
  stale?: boolean | null;
  [MOCK_SOL_USDC_RATE_CONFIG_KEY]?: string | number | null;
}

export function resolveMockSolUsdcRate(source?: MockSolRateSource | Record<string, string | number> | null) {
  const rawValue = (source as MockSolRateSource | null | undefined)?.priceUsd
    ?? source?.[MOCK_SOL_USDC_RATE_CONFIG_KEY];
  const rate = Number(rawValue ?? DEFAULT_MOCK_SOL_USDC_RATE);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_MOCK_SOL_USDC_RATE;
}

export function resolveLiveMockSolUsdcRate(
  summary?: { solUsdPrice?: MockSolRateSource | null } | null,
  fallbackConfigs?: Record<string, string | number> | null,
) {
  return resolveMockSolUsdcRate(summary?.solUsdPrice ?? fallbackConfigs);
}

export function hasFreshMockSolRate(summary?: { solUsdPrice?: MockSolRateSource | null } | null) {
  const rate = Number(summary?.solUsdPrice?.priceUsd);
  return Number.isFinite(rate) && rate > 0 && summary?.solUsdPrice?.stale !== true;
}

export function mockSolToUsd(value: number, usdcRate = DEFAULT_MOCK_SOL_USDC_RATE) {
  return value * usdcRate;
}

export function resolveMockTradeSolUsdcRate(trade?: { mockSolUsdcRate?: number | null; metadata?: { mockSolUsdcRate?: unknown } | null } | null) {
  const rawValue = trade?.mockSolUsdcRate ?? trade?.metadata?.mockSolUsdcRate;
  const rate = Number(rawValue ?? DEFAULT_MOCK_SOL_USDC_RATE);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_MOCK_SOL_USDC_RATE;
}

export function fmtMockSolAmount(value?: number | null, options: { signed?: boolean } = {}) {
  if (value == null || !Number.isFinite(value)) {
    return '-';
  }
  const abs = Math.abs(value);
  const fractionDigits = abs >= 100 ? 2 : 4;
  const sign = options.signed && value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${abs.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })} SOL`;
}

export function fmtMockSol(value?: number | null, options: { signed?: boolean; usdcRate?: number } = {}) {
  if (value == null || !Number.isFinite(value)) {
    return '-';
  }
  const usdcRate = Number.isFinite(options.usdcRate) && Number(options.usdcRate) > 0
    ? Number(options.usdcRate)
    : DEFAULT_MOCK_SOL_USDC_RATE;
  return fmtMockSolAmount(value / usdcRate, options);
}
