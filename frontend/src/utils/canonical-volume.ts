export type CanonicalVolumeCoverage = 'complete' | 'partial' | 'unavailable';

function finiteNonNegative(value: number | null | undefined) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function calculateCanonicalVolume5mDelta(
  currentValue: number | null | undefined,
  baselineValue: number | null | undefined,
  coverage: CanonicalVolumeCoverage | null | undefined,
) {
  if (coverage !== 'complete') return null;
  const current = finiteNonNegative(currentValue);
  const baseline = finiteNonNegative(baselineValue);
  if (current == null || baseline == null || baseline === 0) return null;
  return ((current - baseline) / baseline) * 100;
}
