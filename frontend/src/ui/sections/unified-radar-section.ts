import type { AppController } from '../../state/app-controller';
import { getUnifiedRadarTokens, type AppState, type BucketSortCriterion } from '../../state/app-state';
import { resolveUnifiedRadarAgeTone } from '../../utils/radar-unified';
import { bindCopyButtons, bindSparklineHover, bindSparklineRangeControls, bindTokenActions, bindTokenImagePreview, renderPagedAgeBucketList } from './shared';
import { bindRadarIdentityBadges } from './radar-identity-badges';
import { bindMonitoredTickerPeerPanelClose } from './monitored-section';
import { bindRobinhoodHolderHover } from '../robinhood-holder-hover';

const SORTS: Array<{ value: string; label: string; criterion: BucketSortCriterion }> = [
  { value: 'vol:1h', label: 'Volume 1H', criterion: { mode: 'vol', window: '1h' } },
  { value: 'vol:6h', label: 'Volume 6H', criterion: { mode: 'vol', window: '6h' } },
  { value: 'vol:24h', label: 'Volume 24H', criterion: { mode: 'vol', window: '24h' } },
  { value: 'mcap:highest', label: 'MCAP / FDV high', criterion: { mode: 'mcap', window: 'highest' } },
  { value: 'mcap:lowest', label: 'MCAP / FDV low', criterion: { mode: 'mcap', window: 'lowest' } },
  { value: 'pchange:1h', label: 'Change 1H', criterion: { mode: 'pchange', window: '1h' } },
  { value: 'pchange:6h', label: 'Change 6H', criterion: { mode: 'pchange', window: '6h' } },
  { value: 'pchange:24h', label: 'Change 24H', criterion: { mode: 'pchange', window: '24h' } },
  { value: 'age:newest', label: 'Newest', criterion: { mode: 'age', window: 'newest' } },
  { value: 'age:oldest', label: 'Oldest', criterion: { mode: 'age', window: 'oldest' } },
];

export function renderUnifiedRadarSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'legacy-token-bar unified-radar-bar';
  const radar = state.radar;
  const tokens = getUnifiedRadarTokens(state);
  const pages = Math.max(1, Math.ceil(radar.total / radar.perPage));
  const selectedSort = `${radar.sorts[0]?.mode}:${radar.sorts[0]?.window}`;
  section.innerHTML = `
    <div class="legacy-bar-head unified-radar-head">
      <span class="legacy-bar-title">TOKENS</span>
      <span class="count-pill">${radar.total}</span>
      <div class="unified-radar-controls">
        <input type="search" data-radar-search placeholder="ticker / ca" aria-label="Search tokens" />
        <button type="button" data-radar-starred aria-pressed="${radar.starredOnly}" title="Show only starred tokens">★</button>
        <label>AGE MIN <input type="number" min="0" data-radar-number="ageMinMinutes" value="${radar.ageMinMinutes}" /></label>
        <label>AGE MAX <input type="number" min="0" data-radar-number="ageMaxMinutes" value="${radar.ageMaxMinutes ?? ''}" placeholder="∞" /></label>
        <label>MCAP MIN <input type="number" min="0" data-radar-number="minMcap" value="${radar.minMcap}" /></label>
        <label>MCAP MAX <input type="number" min="0" data-radar-number="maxMcap" value="${radar.maxMcap}" /></label>
        <label>FDV MIN <input type="number" min="0" data-radar-number="minFdv" value="${radar.minFdv}" /></label>
        <label>FDV MAX <input type="number" min="0" data-radar-number="maxFdv" value="${radar.maxFdv}" /></label>
        <label>SORT <select data-radar-sort>${SORTS.map((sort) => `<option value="${sort.value}" ${sort.value === selectedSort ? 'selected' : ''}>${sort.label}</option>`).join('')}</select></label>
        <label>PER PAGE <input type="number" min="10" max="100" data-radar-per-page value="${radar.perPage}" /></label>
      </div>
    </div>
    ${radar.error ? '<p class="muted-block" role="alert">Radar temporarily unavailable.</p>' : ''}
    ${radar.loading ? '<p class="muted-block">Loading tokens…</p>' : ''}
    ${tokens.length || radar.total ? renderPagedAgeBucketList(
      tokens, state.ui.busy, 'recent', radar.page, radar.perPage,
      state.data.watchlistTokenIdentities, radar.sorts, state.data.meteoraByAddress,
      Number(state.data.configs['meteora-min-pool']) || 5000,
      state.session.role === 'admin', state.ui.enabledTradeTerminals,
      { enabledRobinhoodTradeTerminals: state.ui.enabledRobinhoodTradeTerminals,
        totalCount: radar.total, skipClientSort: true, showSparkline: true,
        sparklineByAddress: state.data.sparklineByAddress },
    ) : '<p class="muted-block">No Robinhood tokens match these filters.</p>'}
  `;
  const search = section.querySelector<HTMLInputElement>('[data-radar-search]');
  if (search) {
    search.value = radar.searchQuery;
    search.addEventListener('change', () => controller.setUnifiedRadarFilters({ searchQuery: search.value }));
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') search.blur();
    });
  }
  section.querySelector<HTMLButtonElement>('[data-radar-starred]')?.addEventListener('click', () => {
    controller.setUnifiedRadarFilters({ starredOnly: !radar.starredOnly });
  });
  section.querySelectorAll<HTMLInputElement>('[data-radar-number]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.radarNumber as 'ageMinMinutes' | 'ageMaxMinutes' | 'minMcap' | 'maxMcap' | 'minFdv' | 'maxFdv';
      const value = input.value === '' && key === 'ageMaxMinutes' ? null : Math.max(0, Number(input.value) || 0);
      controller.setUnifiedRadarFilters({ [key]: value });
    });
  });
  section.querySelector<HTMLSelectElement>('[data-radar-sort]')?.addEventListener('change', (event) => {
    const sort = SORTS.find((item) => item.value === (event.currentTarget as HTMLSelectElement).value);
    if (sort) controller.setUnifiedRadarFilters({ sorts: [sort.criterion] });
  });
  section.querySelector<HTMLInputElement>('[data-radar-per-page]')?.addEventListener('change', (event) => {
    controller.setUnifiedRadarFilters({ perPage: Number((event.currentTarget as HTMLInputElement).value) });
  });
  section.querySelector<HTMLInputElement>('[data-action="recent-page-jump"]')?.addEventListener('change', (event) => {
    controller.setUnifiedRadarFilters({ page: Number((event.currentTarget as HTMLInputElement).value) - 1 });
  });
  const pageJump = section.querySelector<HTMLInputElement>('[data-action="recent-page-jump"]');
  if (pageJump) pageJump.value = String(radar.page + 1);
  section.querySelector<HTMLButtonElement>('[data-action="recent-prev"]')?.addEventListener('click', () => {
    controller.setUnifiedRadarFilters({ page: radar.page - 1 });
  });
  section.querySelector<HTMLButtonElement>('[data-action="recent-next"]')?.addEventListener('click', () => {
    controller.setUnifiedRadarFilters({ page: Math.min(pages - 1, radar.page + 1) });
  });
  section.querySelector('.token-table')?.classList.replace('recent', 'unified');
  section.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((row, index) => {
    row.classList.add(`radar-age-${resolveUnifiedRadarAgeTone(tokens[index]?.createdAt, radar.asOf)}`);
  });
  bindRadarIdentityBadges(section, tokens);
  bindMonitoredTickerPeerPanelClose(section);
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  bindSparklineHover(section, state.data.sparklineByAddress, { controller });
  bindSparklineRangeControls(section, controller);
  bindTokenImagePreview(section);
  bindRobinhoodHolderHover(section, state.session.token);
  return section;
}
