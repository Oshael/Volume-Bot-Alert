export function rankingIsPartial(page: {
  coverage: string;
  rankingIsComplete: boolean;
  rankingListTruncated: boolean | null;
}) {
  return page.coverage !== 'complete'
    || !page.rankingIsComplete
    || page.rankingListTruncated === null;
}

export function formatRankingGain(value: string) {
  if (!value?.trim()) return 'Unavailable';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Unavailable';
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
  return `${sign}$${Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
}
