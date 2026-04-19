import type { AppController } from '../../state/app-controller';
import { getOldWeekTokens, getRecentTokens, type AppState } from '../../state/app-state';
import { bindBucketSortControls, bindCompactSearch, bindCopyButtons, bindPagedBucketControls, bindTokenActions, fmtConfig, renderPagedAgeBucketList } from './shared';

const RECENT_MAX_AGE_MINUTES = 7 * 24 * 60;
const OLD_WEEK_MIN_AGE_MINUTES = RECENT_MAX_AGE_MINUTES;
const OPEN_ENDED_AGE_MAX_MINUTES = 100 * 365 * 24 * 60;

function normalizeRecentAgeMinutes(value: unknown, fallbackMinutes: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallbackMinutes;
  }

  return Math.max(0, Math.min(RECENT_MAX_AGE_MINUTES, Math.round(parsed)));
}

function formatAgeInput(minutes: number) {
  const normalized = Math.max(0, Math.round(minutes));
  if (normalized > 0 && normalized % (24 * 60) === 0) {
    return `${normalized / (24 * 60)}d`;
  }
  if (normalized > 0 && normalized % 60 === 0) {
    return `${normalized / 60}h`;
  }

  return `${normalized}m`;
}

function formatRecentAgeInput(minutes: number) {
  return formatAgeInput(normalizeRecentAgeMinutes(minutes, 0));
}

function parseRecentAgeInput(value: string, fallbackMinutes: number) {
  const normalizedValue = String(value || '').trim().toLowerCase();
  if (!normalizedValue) {
    return { ok: true as const, minutes: fallbackMinutes };
  }

  const match = normalizedValue.match(/^(\d+)\s*([mhd]?)$/);
  if (!match) {
    return {
      ok: false as const,
      message: 'Use minutos, horas ou dias. Ex.: 30m, 2h, 1d.',
    };
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || 'm';
  if (!Number.isFinite(amount)) {
    return {
      ok: false as const,
      message: 'Idade invalida.',
    };
  }

  const multiplier = unit === 'd' ? 24 * 60 : unit === 'h' ? 60 : 1;
  return {
    ok: true as const,
    minutes: normalizeRecentAgeMinutes(amount * multiplier, fallbackMinutes),
  };
}

function normalizeOldWeekAgeMinMinutes(value: unknown, fallbackMinutes: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallbackMinutes;
  }

  return Math.max(OLD_WEEK_MIN_AGE_MINUTES, Math.min(OPEN_ENDED_AGE_MAX_MINUTES, Math.round(parsed)));
}

function normalizeOldWeekAgeMaxMinutes(value: unknown, fallbackMinutes: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallbackMinutes;
  }
  if (parsed <= 0) {
    return 0;
  }

  return Math.max(OLD_WEEK_MIN_AGE_MINUTES, Math.min(OPEN_ENDED_AGE_MAX_MINUTES, Math.round(parsed)));
}

function parseOldWeekAgeInput(value: string, fallbackMinutes: number, options: { allowBlank?: boolean } = {}) {
  const normalizedValue = String(value || '').trim().toLowerCase();
  if (!normalizedValue) {
    return {
      ok: true as const,
      minutes: options.allowBlank ? 0 : fallbackMinutes,
    };
  }

  const match = normalizedValue.match(/^(\d+)\s*([mhd]?)$/);
  if (!match) {
    return {
      ok: false as const,
      message: 'Use minutos, horas ou dias. Ex.: 7d, 14d, 30d.',
    };
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] || 'm';
  if (!Number.isFinite(amount)) {
    return {
      ok: false as const,
      message: 'Idade invalida.',
    };
  }

  const multiplier = unit === 'd' ? 24 * 60 : unit === 'h' ? 60 : 1;
  const minutes = amount * multiplier;
  return {
    ok: true as const,
    minutes: options.allowBlank
      ? normalizeOldWeekAgeMaxMinutes(minutes, fallbackMinutes)
      : normalizeOldWeekAgeMinMinutes(minutes, fallbackMinutes),
  };
}

function formatOldWeekAgeMaxInput(minutes: number) {
  return minutes > 0 ? formatAgeInput(minutes) : '';
}

function bindCommittedInputs(
  inputs: Array<HTMLInputElement | null | undefined>,
  onCommit: () => void,
) {
  const liveInputs = inputs.filter((input): input is HTMLInputElement => Boolean(input));
  for (const input of liveInputs) {
    input.addEventListener('change', onCommit);
    input.addEventListener('blur', onCommit);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') {
        return;
      }
      event.preventDefault();
      input.blur();
    });
  }
}

export function renderRecentSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'legacy-token-bar recent-bar';
  const isCollapsed = state.ui.collapsed.recent;
  const usesServerSlice = state.ui.workspace === 'history';
  const min = fmtConfig(state, 'old-mcap-min', 120000);
  const max = fmtConfig(state, 'old-mcap-max', 100000000);
  const recentAgeMinMinutes = normalizeRecentAgeMinutes(state.data.configs['recent-age-min'], 0);
  const recentAgeMaxMinutes = Math.max(
    recentAgeMinMinutes,
    normalizeRecentAgeMinutes(state.data.configs['recent-age-max'], RECENT_MAX_AGE_MINUTES)
  );
  const recentSorts = state.ui.recentSorts;
  const hasRecentMode = (mode: string) => recentSorts.some((item) => item.mode === mode);
  const hasRecentCriterion = (mode: string, window: string) => recentSorts.some((item) => item.mode === mode && item.window === window);
  const recentVolActive = hasRecentMode('vol') ? 'active' : '';
  const recentMcapActive = hasRecentMode('mcap') ? 'active' : '';
  const recentPchangeActive = hasRecentMode('pchange') ? 'active' : '';
  const recentAgeActive = hasRecentMode('age') ? 'active' : '';
  const recentVol1h = hasRecentCriterion('vol', '1h') ? 'active' : '';
  const recentVol6h = hasRecentCriterion('vol', '6h') ? 'active' : '';
  const recentVol24h = hasRecentCriterion('vol', '24h') ? 'active' : '';
  const recentMcapHighest = hasRecentCriterion('mcap', 'highest') ? 'active' : '';
  const recentMcapLowest = hasRecentCriterion('mcap', 'lowest') ? 'active' : '';
  const recentPchange1h = hasRecentCriterion('pchange', '1h') ? 'active' : '';
  const recentPchange6h = hasRecentCriterion('pchange', '6h') ? 'active' : '';
  const recentPchange24h = hasRecentCriterion('pchange', '24h') ? 'active' : '';
  const recentAgeNewest = hasRecentCriterion('age', 'newest') ? 'active' : '';
  const recentAgeOldest = hasRecentCriterion('age', 'oldest') ? 'active' : '';
  const recentSearchQuery = String(state.ui.recentSearchQuery || '').trim().toLowerCase();
  const filteredRecentTokens = getRecentTokens(state).filter((item) => {
    if (state.ui.recentStarredOnly && !state.data.starredTokens.includes(item.address)) {
      return false;
    }
    if (!recentSearchQuery) {
      return true;
    }
      const symbol = String(item.symbol || item.label || '').toLowerCase();
      const name = String(item.name || '').toLowerCase();
      const address = String(item.address || '').toLowerCase();
      return symbol.includes(recentSearchQuery) || name.includes(recentSearchQuery) || address.includes(recentSearchQuery);
    });
  if (isCollapsed) {
    section.innerHTML = `
      <div class="legacy-bar-head legacy-bar-head-collapsed">
        <div class="legacy-bar-title-wrap">
          <span class="legacy-bar-title recent"><span class="recent-live-emoji ${state.runtime.mode === 'active' ? 'live' : ''}">\u{1F7E2}</span> RECENT TOKENS</span>
        </div>
        <div class="legacy-bar-controls legacy-bar-collapse-controls">
          <span class="count-pill">${state.bars.recent}</span>
          <button type="button" class="compact-icon-toggle section-collapse-toggle" data-action="toggle-section-collapse" data-section="recent" aria-label="Expand recent tokens"><span class="compact-icon-glyph">+</span></button>
        </div>
      </div>
    `;
    section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
      controller.toggleSectionCollapsed('recent');
    });
    return section;
  }
  const safeRecentPerPage = Math.max(10, Math.floor(state.ui.recentPerPage) || 15);
  const recentTotalCount = usesServerSlice
    ? Math.max(filteredRecentTokens.length, state.bars.recent)
    : filteredRecentTokens.length;
  const recentTotalPages = Math.max(1, Math.ceil(recentTotalCount / safeRecentPerPage));
  const safeRecentPage = Math.min(Math.max(0, Math.floor(state.ui.recentPage) || 0), recentTotalPages - 1);
  section.innerHTML = `
    <div class="legacy-bar-head">
      <div class="legacy-bar-title-wrap">
        <span class="legacy-bar-title recent"><span class="recent-live-emoji ${state.runtime.mode === 'active' ? 'live' : ''}">\u{1F7E2}</span> RECENT TOKENS</span>
      </div>
      <div class="legacy-bar-controls recent-bar-controls">
        <div class="recent-ctrl-icons">
          <button type="button" class="compact-icon-toggle section-collapse-toggle" data-action="toggle-section-collapse" data-section="recent" aria-label="Collapse recent tokens"><span class="compact-icon-glyph">−</span></button>
          <div class="compact-search ${recentSearchQuery ? 'has-query open' : ''}">
            <button type="button" class="compact-search-toggle" data-action="recent-search-focus" aria-label="Search recent tokens">&#128269;</button>
            <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="recent-search" data-search-input="recent">
          </div>
          <button type="button" class="compact-icon-toggle ${state.ui.recentStarredOnly ? 'active' : ''}" data-action="recent-starred-only" aria-label="Show only starred recent tokens"><span class="compact-icon-glyph">&#9733;</span></button>
        </div>
        <div class="recent-ctrl-filters">
        <div class="recent-ctrl-cluster recent-ctrl-cluster-range">
          <span class="recent-ctrl-cluster-label">AGE</span>
          <input type="text" name="recent-age-min" inputmode="numeric" placeholder="30m / 1d" aria-label="Age min">
          <span class="recent-ctrl-range-sep">–</span>
          <input type="text" name="recent-age-max" inputmode="numeric" placeholder="2h / 7d" aria-label="Age max">
        </div>
        <div class="recent-ctrl-cluster recent-ctrl-cluster-range">
          <span class="recent-ctrl-cluster-label">MCAP</span>
          <input type="number" name="old-mcap-min" aria-label="Mcap min">
          <span class="recent-ctrl-range-sep">–</span>
          <input type="number" name="old-mcap-max" aria-label="Mcap max">
        </div>
        <div class="recent-ctrl-cluster">
          <span class="recent-ctrl-cluster-label">PER PAGE</span>
          <input type="number" min="10" step="1" data-action="recent-per-page" aria-label="Per page">
        </div>
        <div class="sort-pill-group recent-ctrl-cluster recent-ctrl-cluster-sort">
          <span class="filter-label recent-ctrl-cluster-label">SORT</span>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${recentVolActive}" data-sort-toggle="vol">VOL</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${recentVol1h}" data-sort-mode="vol" data-sort-window="1h">1H</button>
              <button type="button" class="sort-menu-item ${recentVol6h}" data-sort-mode="vol" data-sort-window="6h">6H</button>
              <button type="button" class="sort-menu-item ${recentVol24h}" data-sort-mode="vol" data-sort-window="24h">24H</button>
            </div>
          </div>
          <div class="sort-menu-wrap" data-sort-wrap>
            <button type="button" class="old-filter-btn ${recentMcapActive}" data-sort-toggle="mcap">MCAP</button>
            <div class="sort-menu-dropdown">
              <button type="button" class="sort-menu-item ${recentMcapHighest}" data-sort-mode="mcap" data-sort-window="highest">HIGHEST</button>
              <button type="button" class="sort-menu-item ${recentMcapLowest}" data-sort-mode="mcap" data-sort-window="lowest">LOWEST</button>
            </div>
          </div>
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
        </div>
      </div>
    </div>
    ${renderPagedAgeBucketList(
      filteredRecentTokens,
      state.ui.busy,
      'recent',
      state.ui.recentPage,
      state.ui.recentPerPage,
      state.data.starredTokens,
      state.ui.recentSorts,
      state.data.meteoraByAddress,
      Number(state.data.configs['meteora-min-pool']) || 5000,
      state.session.role === 'admin',
      state.ui.enabledTradeTerminals,
      {
        totalCount: recentTotalCount,
        skipClientSort: usesServerSlice,
      },
    )}
  `;
  const recentSearchInput = section.querySelector<HTMLInputElement>('[data-action="recent-search"]');
  if (recentSearchInput) {
    recentSearchInput.value = state.ui.recentSearchQuery || '';
  }
  bindCompactSearch(section, {
    toggleAction: 'recent-search-focus',
    inputAction: 'recent-search',
  });
  const recentMinInput = section.querySelector<HTMLInputElement>('input[name="old-mcap-min"]');
  if (recentMinInput) {
    recentMinInput.value = String(min);
  }
  const recentMaxInput = section.querySelector<HTMLInputElement>('input[name="old-mcap-max"]');
  if (recentMaxInput) {
    recentMaxInput.value = String(max);
  }
  const recentAgeMinInput = section.querySelector<HTMLInputElement>('input[name="recent-age-min"]');
  if (recentAgeMinInput) {
    recentAgeMinInput.value = formatRecentAgeInput(recentAgeMinMinutes);
  }
  const recentAgeMaxInput = section.querySelector<HTMLInputElement>('input[name="recent-age-max"]');
  if (recentAgeMaxInput) {
    recentAgeMaxInput.value = formatRecentAgeInput(recentAgeMaxMinutes);
  }
  const recentPerPageInput = section.querySelector<HTMLInputElement>('[data-action="recent-per-page"]');
  if (recentPerPageInput) {
    recentPerPageInput.value = String(safeRecentPerPage);
  }
  const recentPageJumpInput = section.querySelector<HTMLInputElement>('[data-action="recent-page-jump"]');
  if (recentPageJumpInput) {
    recentPageJumpInput.value = String(safeRecentPage + 1);
  }
  recentSearchInput?.addEventListener('input', (event) => {
    controller.setRecentSearchQuery((event.currentTarget as HTMLInputElement).value);
  });
  section.querySelector<HTMLButtonElement>('[data-action="recent-starred-only"]')?.addEventListener('click', () => {
    controller.setRecentStarredOnly(!state.ui.recentStarredOnly);
  });
  section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
    controller.toggleSectionCollapsed('recent');
  });
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
        'old-mcap-max': Number(maxInput?.value || 100000000),
      });
    });
  });
  bindCommittedInputs([recentAgeMinInput, recentAgeMaxInput], () => {
    const minInput = section.querySelector<HTMLInputElement>('input[name="recent-age-min"]');
    const maxInput = section.querySelector<HTMLInputElement>('input[name="recent-age-max"]');
    const parsedMin = parseRecentAgeInput(minInput?.value || '', recentAgeMinMinutes);
    if (!parsedMin.ok) {
      if (minInput) {
        minInput.setCustomValidity(parsedMin.message);
        minInput.reportValidity();
      }
      return;
    }

    const parsedMax = parseRecentAgeInput(maxInput?.value || '', recentAgeMaxMinutes);
    if (!parsedMax.ok) {
      if (maxInput) {
        maxInput.setCustomValidity(parsedMax.message);
        maxInput.reportValidity();
      }
      return;
    }

    if (minInput) {
      minInput.setCustomValidity('');
    }
    if (maxInput) {
      maxInput.setCustomValidity('');
    }

    const normalizedMinMinutes = parsedMin.minutes;
    const normalizedMaxMinutes = Math.max(normalizedMinMinutes, parsedMax.minutes);
    if (minInput) {
      minInput.value = formatRecentAgeInput(normalizedMinMinutes);
    }
    if (maxInput) {
      maxInput.value = formatRecentAgeInput(normalizedMaxMinutes);
    }

    void controller.saveMonitoringConfig({
      'recent-age-min': normalizedMinMinutes,
      'recent-age-max': normalizedMaxMinutes,
    });
  });
  return section;
}

export function renderOldWeekSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.className = 'legacy-token-bar old-week-bar';
  const isCollapsed = state.ui.collapsed.oldWeek;
  const usesServerSlice = state.ui.workspace === 'history';
  const min = fmtConfig(state, 'old-week-mcap-min', 120000);
  const max = fmtConfig(state, 'old-week-mcap-max', 100000000);
  const oldWeekAgeMinMinutes = normalizeOldWeekAgeMinMinutes(state.data.configs['old-week-age-min'], OLD_WEEK_MIN_AGE_MINUTES);
  const rawOldWeekAgeMaxMinutes = normalizeOldWeekAgeMaxMinutes(state.data.configs['old-week-age-max'], 0);
  const oldWeekAgeMaxMinutes = rawOldWeekAgeMaxMinutes > 0
    ? Math.max(oldWeekAgeMinMinutes, rawOldWeekAgeMaxMinutes)
    : 0;
  const oldWeekSorts = state.ui.oldWeekSorts;
  const hasOldWeekMode = (mode: string) => oldWeekSorts.some((item) => item.mode === mode);
  const hasOldWeekCriterion = (mode: string, window: string) => oldWeekSorts.some((item) => item.mode === mode && item.window === window);
  const oldWeekVolActive = hasOldWeekMode('vol') ? 'active' : '';
  const oldWeekMcapActive = hasOldWeekMode('mcap') ? 'active' : '';
  const oldWeekPchangeActive = hasOldWeekMode('pchange') ? 'active' : '';
  const oldWeekAgeActive = hasOldWeekMode('age') ? 'active' : '';
  const oldWeekVol1h = hasOldWeekCriterion('vol', '1h') ? 'active' : '';
  const oldWeekVol6h = hasOldWeekCriterion('vol', '6h') ? 'active' : '';
  const oldWeekVol24h = hasOldWeekCriterion('vol', '24h') ? 'active' : '';
  const oldWeekMcapHighest = hasOldWeekCriterion('mcap', 'highest') ? 'active' : '';
  const oldWeekMcapLowest = hasOldWeekCriterion('mcap', 'lowest') ? 'active' : '';
  const oldWeekPchange1h = hasOldWeekCriterion('pchange', '1h') ? 'active' : '';
  const oldWeekPchange6h = hasOldWeekCriterion('pchange', '6h') ? 'active' : '';
  const oldWeekPchange24h = hasOldWeekCriterion('pchange', '24h') ? 'active' : '';
  const oldWeekAgeNewest = hasOldWeekCriterion('age', 'newest') ? 'active' : '';
  const oldWeekAgeOldest = hasOldWeekCriterion('age', 'oldest') ? 'active' : '';
  const oldWeekSearchQuery = String(state.ui.oldWeekSearchQuery || '').trim().toLowerCase();
  const filteredOldWeekTokens = getOldWeekTokens(state).filter((item) => {
    if (state.ui.oldWeekStarredOnly && !state.data.starredTokens.includes(item.address)) {
      return false;
    }
    if (!oldWeekSearchQuery) {
      return true;
    }
      const symbol = String(item.symbol || item.label || '').toLowerCase();
      const name = String(item.name || '').toLowerCase();
      const address = String(item.address || '').toLowerCase();
      return symbol.includes(oldWeekSearchQuery) || name.includes(oldWeekSearchQuery) || address.includes(oldWeekSearchQuery);
    });
  if (isCollapsed) {
    section.innerHTML = `
      <div class="legacy-bar-head legacy-bar-head-collapsed">
        <div class="legacy-bar-title-wrap">
          <span class="legacy-bar-title old-week">\u{1F4C5} OLD TOKENS 1 WEEK+</span>
        </div>
        <div class="legacy-bar-controls legacy-bar-collapse-controls">
          <span class="count-pill">${state.bars.oldWeek}</span>
          <button type="button" class="compact-icon-toggle section-collapse-toggle" data-action="toggle-section-collapse" data-section="oldWeek" aria-label="Expand old tokens"><span class="compact-icon-glyph">+</span></button>
        </div>
      </div>
    `;
    section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
      controller.toggleSectionCollapsed('oldWeek');
    });
    return section;
  }
  const safeOldWeekPerPage = Math.max(10, Math.floor(state.ui.oldWeekPerPage) || 15);
  const oldWeekTotalCount = usesServerSlice
    ? Math.max(filteredOldWeekTokens.length, state.bars.oldWeek)
    : filteredOldWeekTokens.length;
  const oldWeekTotalPages = Math.max(1, Math.ceil(oldWeekTotalCount / safeOldWeekPerPage));
  const safeOldWeekPage = Math.min(Math.max(0, Math.floor(state.ui.oldWeekPage) || 0), oldWeekTotalPages - 1);
  section.innerHTML = `
    <div class="legacy-bar-head">
      <div class="legacy-bar-title-wrap">
        <span class="legacy-bar-title old-week">\u{1F4C5} OLD TOKENS 1 WEEK+</span>
      </div>
      <div class="legacy-bar-controls recent-bar-controls">
        <div class="recent-ctrl-icons">
          <button type="button" class="compact-icon-toggle section-collapse-toggle" data-action="toggle-section-collapse" data-section="oldWeek" aria-label="Collapse old tokens"><span class="compact-icon-glyph">−</span></button>
          <div class="compact-search ${oldWeekSearchQuery ? 'has-query open' : ''}">
            <button type="button" class="compact-search-toggle" data-action="old-week-search-focus" aria-label="Search old tokens">&#128269;</button>
            <input class="compact-search-input" type="text" placeholder="ticker / ca" data-action="old-week-search" data-search-input="old-week">
          </div>
          <button type="button" class="compact-icon-toggle ${state.ui.oldWeekStarredOnly ? 'active' : ''}" data-action="old-week-starred-only" aria-label="Show only starred old tokens"><span class="compact-icon-glyph">&#9733;</span></button>
        </div>
        <div class="recent-ctrl-filters">
          <div class="recent-ctrl-cluster recent-ctrl-cluster-range">
            <span class="recent-ctrl-cluster-label">AGE</span>
            <input type="text" name="old-week-age-min" inputmode="numeric" placeholder="7d / 30d" aria-label="Age min">
            <span class="recent-ctrl-range-sep">–</span>
            <input type="text" name="old-week-age-max" inputmode="numeric" placeholder="∞" title="Deixe em branco para não limitar a idade máxima (∞)" aria-label="Age max">
          </div>
          <div class="recent-ctrl-cluster recent-ctrl-cluster-range">
            <span class="recent-ctrl-cluster-label">MCAP</span>
            <input type="number" name="old-week-mcap-min" aria-label="Mcap min">
            <span class="recent-ctrl-range-sep">–</span>
            <input type="number" name="old-week-mcap-max" aria-label="Mcap max">
          </div>
          <div class="recent-ctrl-cluster">
            <span class="recent-ctrl-cluster-label">PER PAGE</span>
            <input type="number" min="10" step="1" data-action="old-week-per-page" aria-label="Per page">
          </div>
          <div class="sort-pill-group recent-ctrl-cluster recent-ctrl-cluster-sort">
            <span class="filter-label recent-ctrl-cluster-label">SORT</span>
            <div class="sort-menu-wrap" data-sort-wrap>
              <button type="button" class="old-filter-btn ${oldWeekVolActive}" data-sort-toggle="vol">VOL</button>
              <div class="sort-menu-dropdown">
                <button type="button" class="sort-menu-item ${oldWeekVol1h}" data-sort-mode="vol" data-sort-window="1h">1H</button>
                <button type="button" class="sort-menu-item ${oldWeekVol6h}" data-sort-mode="vol" data-sort-window="6h">6H</button>
                <button type="button" class="sort-menu-item ${oldWeekVol24h}" data-sort-mode="vol" data-sort-window="24h">24H</button>
              </div>
            </div>
            <div class="sort-menu-wrap" data-sort-wrap>
              <button type="button" class="old-filter-btn ${oldWeekMcapActive}" data-sort-toggle="mcap">MCAP</button>
              <div class="sort-menu-dropdown">
                <button type="button" class="sort-menu-item ${oldWeekMcapHighest}" data-sort-mode="mcap" data-sort-window="highest">HIGHEST</button>
                <button type="button" class="sort-menu-item ${oldWeekMcapLowest}" data-sort-mode="mcap" data-sort-window="lowest">LOWEST</button>
              </div>
            </div>
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
        </div>
      </div>
    </div>
    ${renderPagedAgeBucketList(
      filteredOldWeekTokens,
      state.ui.busy,
      'old-week',
      state.ui.oldWeekPage,
      state.ui.oldWeekPerPage,
      state.data.starredTokens,
      state.ui.oldWeekSorts,
      state.data.meteoraByAddress,
      Number(state.data.configs['meteora-min-pool']) || 5000,
      state.session.role === 'admin',
      state.ui.enabledTradeTerminals,
      {
        totalCount: oldWeekTotalCount,
        skipClientSort: usesServerSlice,
      },
    )}
  `;
  const oldWeekSearchInput = section.querySelector<HTMLInputElement>('[data-action="old-week-search"]');
  if (oldWeekSearchInput) {
    oldWeekSearchInput.value = state.ui.oldWeekSearchQuery || '';
  }
  bindCompactSearch(section, {
    toggleAction: 'old-week-search-focus',
    inputAction: 'old-week-search',
  });
  const oldWeekMinInput = section.querySelector<HTMLInputElement>('input[name="old-week-mcap-min"]');
  if (oldWeekMinInput) {
    oldWeekMinInput.value = String(min);
  }
  const oldWeekMaxInput = section.querySelector<HTMLInputElement>('input[name="old-week-mcap-max"]');
  if (oldWeekMaxInput) {
    oldWeekMaxInput.value = String(max);
  }
  const oldWeekAgeMinInput = section.querySelector<HTMLInputElement>('input[name="old-week-age-min"]');
  if (oldWeekAgeMinInput) {
    oldWeekAgeMinInput.value = formatAgeInput(oldWeekAgeMinMinutes);
  }
  const oldWeekAgeMaxInput = section.querySelector<HTMLInputElement>('input[name="old-week-age-max"]');
  if (oldWeekAgeMaxInput) {
    oldWeekAgeMaxInput.value = formatOldWeekAgeMaxInput(oldWeekAgeMaxMinutes);
  }
  const oldWeekPerPageInput = section.querySelector<HTMLInputElement>('[data-action="old-week-per-page"]');
  if (oldWeekPerPageInput) {
    oldWeekPerPageInput.value = String(safeOldWeekPerPage);
  }
  const oldWeekPageJumpInput = section.querySelector<HTMLInputElement>('[data-action="old-week-page-jump"]');
  if (oldWeekPageJumpInput) {
    oldWeekPageJumpInput.value = String(safeOldWeekPage + 1);
  }
  oldWeekSearchInput?.addEventListener('input', (event) => {
    controller.setOldWeekSearchQuery((event.currentTarget as HTMLInputElement).value);
  });
  section.querySelector<HTMLButtonElement>('[data-action="old-week-starred-only"]')?.addEventListener('click', () => {
    controller.setOldWeekStarredOnly(!state.ui.oldWeekStarredOnly);
  });
  section.querySelector<HTMLButtonElement>('[data-action="toggle-section-collapse"]')?.addEventListener('click', () => {
    controller.toggleSectionCollapsed('oldWeek');
  });
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
        'old-week-mcap-max': Number(maxInput?.value || 100000000),
      });
    });
  });
  bindCommittedInputs([oldWeekAgeMinInput, oldWeekAgeMaxInput], () => {
    const minInput = section.querySelector<HTMLInputElement>('input[name="old-week-age-min"]');
    const maxInput = section.querySelector<HTMLInputElement>('input[name="old-week-age-max"]');
    const parsedMin = parseOldWeekAgeInput(minInput?.value || '', oldWeekAgeMinMinutes);
    if (!parsedMin.ok) {
      if (minInput) {
        minInput.setCustomValidity(parsedMin.message);
        minInput.reportValidity();
      }
      return;
    }

    const parsedMax = parseOldWeekAgeInput(maxInput?.value || '', oldWeekAgeMaxMinutes, { allowBlank: true });
    if (!parsedMax.ok) {
      if (maxInput) {
        maxInput.setCustomValidity(parsedMax.message);
        maxInput.reportValidity();
      }
      return;
    }

    if (minInput) {
      minInput.setCustomValidity('');
    }
    if (maxInput) {
      maxInput.setCustomValidity('');
    }

    const normalizedMinMinutes = parsedMin.minutes;
    const normalizedMaxMinutes = parsedMax.minutes > 0
      ? Math.max(normalizedMinMinutes, parsedMax.minutes)
      : 0;
    if (minInput) {
      minInput.value = formatAgeInput(normalizedMinMinutes);
    }
    if (maxInput) {
      maxInput.value = formatOldWeekAgeMaxInput(normalizedMaxMinutes);
    }

    void controller.saveMonitoringConfig({
      'old-week-age-min': normalizedMinMinutes,
      'old-week-age-max': normalizedMaxMinutes,
    });
  });
  return section;
}
