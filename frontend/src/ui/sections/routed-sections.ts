import type { AppController } from '../../state/app-controller';
import type { AppState } from '../../state/app-state';
import { bindBucketSortControls, bindCopyButtons, bindPagedBucketControls, bindTokenActions, fmtConfig, renderLogSummary, renderPagedAgeBucketList } from './shared';

export function renderRecentSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'legacy-token-bar recent-bar';
  const min = fmtConfig(state, 'old-mcap-min', 120000);
  const max = fmtConfig(state, 'old-mcap-max', 1000000);
  const recentVolActive = state.ui.recentSort === 'vol' ? 'active' : '';
  const recentMcapActive = state.ui.recentSort === 'mcap' ? 'active' : '';
  const recentPchangeActive = state.ui.recentSort === 'pchange' ? 'active' : '';
  const recentAgeActive = state.ui.recentSort === 'age' ? 'active' : '';
  const recentVol1h = state.ui.recentSort === 'vol' && state.ui.recentSortWindow === '1h' ? 'active' : '';
  const recentVol6h = state.ui.recentSort === 'vol' && state.ui.recentSortWindow === '6h' ? 'active' : '';
  const recentVol24h = state.ui.recentSort === 'vol' && state.ui.recentSortWindow === '24h' ? 'active' : '';
  const recentPchange1h = state.ui.recentSort === 'pchange' && state.ui.recentSortWindow === '1h' ? 'active' : '';
  const recentPchange6h = state.ui.recentSort === 'pchange' && state.ui.recentSortWindow === '6h' ? 'active' : '';
  const recentPchange24h = state.ui.recentSort === 'pchange' && state.ui.recentSortWindow === '24h' ? 'active' : '';
  const recentAgeNewest = state.ui.recentSort === 'age' && state.ui.recentSortWindow === 'newest' ? 'active' : '';
  const recentAgeOldest = state.ui.recentSort === 'age' && state.ui.recentSortWindow === 'oldest' ? 'active' : '';
  section.innerHTML = `
    <div class="legacy-bar-head">
      <div class="legacy-bar-title-wrap">
        <span class="legacy-bar-title recent">\u{1F7E2} RECENT TOKENS</span>
        ${renderLogSummary('Recent Removal Log', state.data.recentRemovalLog, 'clear-recent-log', 'recent')}
      </div>
      <div class="legacy-bar-controls">
        <label class="legacy-mini-field">MCAP MIN <input type="number" name="old-mcap-min" value="${min}"></label>
        <label class="legacy-mini-field">MCAP MAX <input type="number" name="old-mcap-max" value="${max}"></label>
        <label class="legacy-mini-field">PER PAGE <input type="number" min="10" step="1" data-action="recent-per-page" value="${state.ui.recentPerPage}" /></label>
        <div class="sort-pill-group">
          <span class="filter-label">SORT</span>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${recentVolActive}" data-sort-toggle="vol">VOL</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${recentVol1h}" data-sort-mode="vol" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${recentVol6h}" data-sort-mode="vol" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${recentVol24h}" data-sort-mode="vol" data-sort-window="24h">24H</button>
            </div>
          </div>
          <button type="button" class="old-filter-btn ${recentMcapActive}" data-sort-mode="mcap">MCAP</button>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${recentPchangeActive}" data-sort-toggle="pchange">PCHANGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${recentPchange1h}" data-sort-mode="pchange" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${recentPchange6h}" data-sort-mode="pchange" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${recentPchange24h}" data-sort-mode="pchange" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${recentAgeActive}" data-sort-toggle="age">AGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${recentAgeNewest}" data-sort-mode="age" data-sort-window="newest">NEWEST</button>
              <button type="button" class="sort-menu-item ${recentAgeOldest}" data-sort-mode="age" data-sort-window="oldest">OLDEST</button>
            </div>
          </div>
        </div>
        <span class="legacy-bar-note">1d - 7d &middot; recent</span>
      </div>
    </div>
    ${renderPagedAgeBucketList(
      state.data.recentTokens,
      state.ui.busy,
      'recent',
      state.ui.recentPage,
      state.ui.recentPerPage,
      state.data.starredTokens,
      state.ui.recentSort,
      state.ui.recentSortWindow,
      state.data.meteoraByAddress,
      Number(state.data.configs['meteora-min-pool']) || 5000,
    )}
  `;
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  bindPagedBucketControls(section, controller, 'recent');
  bindBucketSortControls(section, controller, 'recent');
  section.querySelectorAll<HTMLInputElement>('input[name="old-mcap-min"], input[name="old-mcap-max"]').forEach((input) => {
    input.addEventListener('change', () => {
      const minInput = section.querySelector<HTMLInputElement>('input[name="old-mcap-min"]');
      const maxInput = section.querySelector<HTMLInputElement>('input[name="old-mcap-max"]');
      void controller.saveMonitoringConfig({
        'old-mcap-min': Number(minInput?.value || 120000),
        'old-mcap-max': Number(maxInput?.value || 1000000),
      });
    });
  });
  section.querySelector<HTMLButtonElement>('[data-action="clear-recent-log"]')?.addEventListener('click', () => controller.clearRecentRemovalLog());
  return section;
}

export function renderOldWeekSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'legacy-token-bar old-week-bar';
  const min = fmtConfig(state, 'old-week-mcap-min', 120000);
  const max = fmtConfig(state, 'old-week-mcap-max', 5000000);
  const oldWeekVolActive = state.ui.oldWeekSort === 'vol' ? 'active' : '';
  const oldWeekMcapActive = state.ui.oldWeekSort === 'mcap' ? 'active' : '';
  const oldWeekPchangeActive = state.ui.oldWeekSort === 'pchange' ? 'active' : '';
  const oldWeekAgeActive = state.ui.oldWeekSort === 'age' ? 'active' : '';
  const oldWeekVol1h = state.ui.oldWeekSort === 'vol' && state.ui.oldWeekSortWindow === '1h' ? 'active' : '';
  const oldWeekVol6h = state.ui.oldWeekSort === 'vol' && state.ui.oldWeekSortWindow === '6h' ? 'active' : '';
  const oldWeekVol24h = state.ui.oldWeekSort === 'vol' && state.ui.oldWeekSortWindow === '24h' ? 'active' : '';
  const oldWeekPchange1h = state.ui.oldWeekSort === 'pchange' && state.ui.oldWeekSortWindow === '1h' ? 'active' : '';
  const oldWeekPchange6h = state.ui.oldWeekSort === 'pchange' && state.ui.oldWeekSortWindow === '6h' ? 'active' : '';
  const oldWeekPchange24h = state.ui.oldWeekSort === 'pchange' && state.ui.oldWeekSortWindow === '24h' ? 'active' : '';
  const oldWeekAgeNewest = state.ui.oldWeekSort === 'age' && state.ui.oldWeekSortWindow === 'newest' ? 'active' : '';
  const oldWeekAgeOldest = state.ui.oldWeekSort === 'age' && state.ui.oldWeekSortWindow === 'oldest' ? 'active' : '';
  section.innerHTML = `
    <div class="legacy-bar-head">
      <div class="legacy-bar-title-wrap">
        <span class="legacy-bar-title old-week">\u{1F4C5} OLD TOKENS 1 WEEK+</span>
        ${renderLogSummary('Old Week Removal Log', state.data.oldWeekRemovalLog, 'clear-old-week-log', 'old-week')}
      </div>
      <div class="legacy-bar-controls">
        <label class="legacy-mini-field">MCAP MIN <input type="number" name="old-week-mcap-min" value="${min}"></label>
        <label class="legacy-mini-field">MCAP MAX <input type="number" name="old-week-mcap-max" value="${max}"></label>
        <label class="legacy-mini-field">PER PAGE <input type="number" min="10" step="1" data-action="old-week-per-page" value="${state.ui.oldWeekPerPage}" /></label>
        <div class="sort-pill-group">
          <span class="filter-label">SORT</span>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${oldWeekVolActive}" data-sort-toggle="vol">VOL</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${oldWeekVol1h}" data-sort-mode="vol" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${oldWeekVol6h}" data-sort-mode="vol" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${oldWeekVol24h}" data-sort-mode="vol" data-sort-window="24h">24H</button>
            </div>
          </div>
          <button type="button" class="old-filter-btn ${oldWeekMcapActive}" data-sort-mode="mcap">MCAP</button>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${oldWeekPchangeActive}" data-sort-toggle="pchange">PCHANGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${oldWeekPchange1h}" data-sort-mode="pchange" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${oldWeekPchange6h}" data-sort-mode="pchange" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${oldWeekPchange24h}" data-sort-mode="pchange" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${oldWeekAgeActive}" data-sort-toggle="age">AGE</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${oldWeekAgeNewest}" data-sort-mode="age" data-sort-window="newest">NEWEST</button>
              <button type="button" class="sort-menu-item ${oldWeekAgeOldest}" data-sort-mode="age" data-sort-window="oldest">OLDEST</button>
            </div>
          </div>
        </div>
        <span class="legacy-bar-note">7d+ &middot; no max age</span>
      </div>
    </div>
    ${renderPagedAgeBucketList(
      state.data.oldWeekTokens,
      state.ui.busy,
      'old-week',
      state.ui.oldWeekPage,
      state.ui.oldWeekPerPage,
      state.data.starredTokens,
      state.ui.oldWeekSort,
      state.ui.oldWeekSortWindow,
      state.data.meteoraByAddress,
      Number(state.data.configs['meteora-min-pool']) || 5000,
    )}
  `;
  bindTokenActions(section, controller);
  bindCopyButtons(section);
  bindPagedBucketControls(section, controller, 'old-week');
  bindBucketSortControls(section, controller, 'old-week');
  section.querySelectorAll<HTMLInputElement>('input[name="old-week-mcap-min"], input[name="old-week-mcap-max"]').forEach((input) => {
    input.addEventListener('change', () => {
      const minInput = section.querySelector<HTMLInputElement>('input[name="old-week-mcap-min"]');
      const maxInput = section.querySelector<HTMLInputElement>('input[name="old-week-mcap-max"]');
      void controller.saveMonitoringConfig({
        'old-week-mcap-min': Number(minInput?.value || 120000),
        'old-week-mcap-max': Number(maxInput?.value || 5000000),
      });
    });
  });
  section.querySelector<HTMLButtonElement>('[data-action="clear-old-week-log"]')?.addEventListener('click', () => controller.clearOldWeekRemovalLog());
  return section;
}
