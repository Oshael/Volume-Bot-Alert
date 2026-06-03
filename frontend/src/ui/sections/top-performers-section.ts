import type { AppController } from '../../state/app-controller';
import { getTopPerformerTokens, type AppState, type ManualTokenEntry } from '../../state/app-state';
import { bindCopyButtons, bindSparklineHover, bindTokenImagePreview, fmtAge, fmtMoney, fmtPct, renderSparklineFigure } from './shared';
import { escapeHtml, sanitizeOptionalHttpUrl } from './html-safety';

function renderTokenAvatar(token: ManualTokenEntry) {
  const symbol = String(token.symbol || token.label || token.address.slice(0, 4)).trim();
  const imageUrl = sanitizeOptionalHttpUrl(token.imageUrl);
  if (imageUrl) {
    return `<img class="top-performer-avatar" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(symbol)}" data-token-image-preview="true" data-token-image-preview-src="${escapeHtml(imageUrl)}" />`;
  }
  return `<span class="top-performer-avatar top-performer-avatar-placeholder">${escapeHtml(symbol.slice(0, 2).toUpperCase())}</span>`;
}

const TOP_PERFORMERS_MANUAL_PAUSE_MS = 4000;
const TOP_PERFORMERS_INITIAL_AUTO_SCROLL_MS = 1800;
const TOP_PERFORMERS_AUTO_SCROLL_PX_PER_SEC = 22;

let topPerformersManualPauseUntil = 0;
let topPerformersProgrammaticScrollUntil = 0;

type TopPerformersDebugEvent = {
  event: string;
  t: number;
  details: Record<string, unknown>;
};

type TopPerformersDebugWindow = Window & {
  __topPerformersDebugCopy?: () => Promise<string | undefined>;
  __topPerformersDebugDump?: () => TopPerformersDebugEvent[];
  __topPerformersDebugEvents?: TopPerformersDebugEvent[];
  __topPerformersDebugNoticeShown?: boolean;
  __topPerformersDebugText?: () => string;
};

export function isTopPerformersDebugEnabled() {
  try {
    return window.localStorage.getItem('topPerformersDebug') === '1'
      || new URLSearchParams(window.location.search).has('topDebug');
  } catch (_) {
    return false;
  }
}

export function logTopPerformersDebug(event: string, details: Record<string, unknown> = {}) {
  if (!isTopPerformersDebugEnabled()) return;
  const debugWindow = window as TopPerformersDebugWindow;
  const events = debugWindow.__topPerformersDebugEvents ?? [];
  const entry = {
    event,
    t: Math.round(performance.now()),
    details,
  };

  events.push(entry);
  if (events.length > 250) {
    events.splice(0, events.length - 250);
  }

  debugWindow.__topPerformersDebugEvents = events;
  debugWindow.__topPerformersDebugDump = () => [...events];
  debugWindow.__topPerformersDebugText = () => JSON.stringify(events, null, 2);
  debugWindow.__topPerformersDebugCopy = async () => {
    const text = debugWindow.__topPerformersDebugText?.() || '[]';
    try {
      await navigator.clipboard.writeText(text);
      console.info(`[top-performers] copied ${events.length} debug events`);
    } catch (err) {
      console.info('[top-performers] clipboard copy failed; returning debug text instead', err);
      console.log(text);
      return text;
    }
  };

  if (!debugWindow.__topPerformersDebugNoticeShown) {
    debugWindow.__topPerformersDebugNoticeShown = true;
    console.info('[top-performers] debug buffering enabled. Run await window.__topPerformersDebugCopy() or window.__topPerformersDebugText() after reproducing.');
  }

  if (window.localStorage.getItem('topPerformersDebugConsole') === '1') {
    console.debug('[top-performers]', event, entry);
  }
}

function renderTopPerformerCard(state: AppState, token: ManualTokenEntry, options: { duplicate?: boolean } = {}) {
  const address = token.address;
  const symbol = String(token.symbol || token.label || address.slice(0, 8)).trim();
  const rank = token.performanceRank ?? 0;
  const sparkline = state.data.sparklineByAddress[address] || null;
  const pairUrl = sanitizeOptionalHttpUrl(token.pairUrl);
  const duplicateAttrs = options.duplicate ? ' aria-hidden="true"' : '';
  const duplicateActionAttrs = options.duplicate ? ' tabindex="-1"' : '';
  const age = token.createdAt ? fmtAge(token.createdAt) : '-';

  return `
    <article class="top-performer-card${options.duplicate ? ' is-duplicate' : ''}" data-address="${escapeHtml(address)}"${duplicateAttrs}>
      <div class="top-performer-header">
        ${renderTokenAvatar(token)}
        <strong class="top-performer-symbol">${escapeHtml(symbol)}</strong>
        <span class="top-performer-rank">#${rank || '-'}</span>
      </div>
      <div class="top-performer-metrics">
        <div class="top-performer-change">${escapeHtml(fmtPct(token.priceChange24h))}<span class="top-performer-change-window">24h</span></div>
        <div class="top-performer-stats">
          <span class="top-performer-stat"><span class="top-performer-stat-label">MCAP</span><span class="top-performer-stat-value">${escapeHtml(fmtMoney(token.mcap))}</span></span>
          <span class="top-performer-stat"><span class="top-performer-stat-label">VOL 24H</span><span class="top-performer-stat-value">${escapeHtml(fmtMoney(token.volume24h))}</span></span>
          <span class="top-performer-stat"><span class="top-performer-stat-label">AGE</span><span class="top-performer-stat-value">${escapeHtml(age)}</span></span>
        </div>
      </div>
      <div class="top-performer-chart">
        ${renderSparklineFigure(sparkline, address, { areaFill: true, liveMcap: token.mcap })}
      </div>
      <div class="top-performer-actions">
        <button type="button" class="inline-icon copy-button" data-action="copy-address" data-address="${escapeHtml(address)}" title="Copy contract" aria-label="Copy ${escapeHtml(symbol)} contract"${duplicateActionAttrs}>⧉</button>
        ${pairUrl ? `<a class="inline-icon top-performer-open" href="${escapeHtml(pairUrl)}" target="_blank" rel="noreferrer" title="Open pair" aria-label="Open ${escapeHtml(symbol)} pair"${duplicateActionAttrs}>↗</a>` : ''}
      </div>
    </article>
  `;
}

function renderTopPerformerCards(state: AppState, tokens: ManualTokenEntry[], options: { duplicate?: boolean } = {}) {
  return tokens.map((token) => renderTopPerformerCard(state, token, options)).join('');
}

function bindTopPerformersAutoScroll(section: HTMLElement) {
  const viewport = section.querySelector<HTMLElement>('.top-performers-viewport');
  if (!viewport || viewport.dataset.autoScrollBound === 'true') return;
  viewport.dataset.autoScrollBound = 'true';

  const cards = viewport.querySelectorAll('.top-performer-card:not(.is-duplicate)');
  logTopPerformersDebug('bind', {
    cards: cards.length,
    scrollLeft: Math.round(viewport.scrollLeft),
    scrollWidth: Math.round(viewport.scrollWidth),
    clientWidth: Math.round(viewport.clientWidth),
  });
  if (cards.length <= 1) {
    logTopPerformersDebug('auto-scroll-disabled', { reason: 'not-enough-cards', cards: cards.length });
    return;
  }

  let initialTimeoutId = 0;
  let layoutRetryId = 0;
  let animationFrameId = 0;
  let resumeTimeoutId = 0;
  let lastFrameAt = 0;
  let lastLoggedScrollLeft = -1;

  const getLoopWidth = () => {
    const track = viewport.querySelector<HTMLElement>('.top-performers-track:not(.top-performers-track-clone)');
    if (!track) return 0;
    const gap = Number.parseFloat(getComputedStyle(viewport).columnGap || getComputedStyle(viewport).gap || '0') || 0;
    return track.offsetWidth + gap;
  };

  const pauseForManualInput = (reason: string) => {
    topPerformersManualPauseUntil = Date.now() + TOP_PERFORMERS_MANUAL_PAUSE_MS;
    logTopPerformersDebug('manual-pause', {
      reason,
      untilMs: TOP_PERFORMERS_MANUAL_PAUSE_MS,
      scrollLeft: Math.round(viewport.scrollLeft),
    });
  };

  const clearTimers = () => {
    window.clearTimeout(initialTimeoutId);
    window.clearTimeout(layoutRetryId);
    window.clearTimeout(resumeTimeoutId);
    if (animationFrameId) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = 0;
    }
  };

  const scheduleResume = (delayMs: number) => {
    window.clearTimeout(resumeTimeoutId);
    resumeTimeoutId = window.setTimeout(() => {
      lastFrameAt = 0;
      animationFrameId = window.requestAnimationFrame(tick);
    }, Math.max(120, delayMs));
  };

  const tick = (frameAt: number) => {
    if (!viewport.isConnected) {
      logTopPerformersDebug('auto-scroll-stop', { reason: 'viewport-disconnected' });
      clearTimers();
      return;
    }

    const now = Date.now();
    const loopWidth = getLoopWidth();
    const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
    if (maxScrollLeft <= 4 || loopWidth <= 4) {
      logTopPerformersDebug('auto-scroll-skip', {
        reason: 'no-overflow',
        remainingPauseMs: 0,
        scrollLeft: Math.round(viewport.scrollLeft),
        scrollWidth: Math.round(viewport.scrollWidth),
        clientWidth: Math.round(viewport.clientWidth),
      });
      scheduleResume(1000);
      return;
    }

    if (now < topPerformersManualPauseUntil) {
      logTopPerformersDebug('auto-scroll-skip', {
        reason: 'manual-pause-active',
        remainingPauseMs: Math.max(0, topPerformersManualPauseUntil - now),
        scrollLeft: Math.round(viewport.scrollLeft),
        scrollWidth: Math.round(viewport.scrollWidth),
        clientWidth: Math.round(viewport.clientWidth),
      });
      scheduleResume(topPerformersManualPauseUntil - now);
      return;
    }

    const deltaSeconds = lastFrameAt > 0 ? Math.min(0.08, (frameAt - lastFrameAt) / 1000) : 0;
    lastFrameAt = frameAt;
    if (deltaSeconds > 0) {
      const currentLeft = viewport.scrollLeft;
      let targetLeft = currentLeft + (TOP_PERFORMERS_AUTO_SCROLL_PX_PER_SEC * deltaSeconds);
      if (targetLeft >= loopWidth) {
        targetLeft -= loopWidth;
        logTopPerformersDebug('auto-scroll-wrap', {
          loopWidth: Math.round(loopWidth),
          maxScrollLeft: Math.round(maxScrollLeft),
        });
      }
      topPerformersProgrammaticScrollUntil = Date.now() + 120;
      viewport.scrollLeft = targetLeft;
    }

    animationFrameId = window.requestAnimationFrame(tick);
  };

  const startAutoScroll = (attempt = 0) => {
    if (!viewport.isConnected) {
      logTopPerformersDebug('auto-scroll-stop', { reason: 'viewport-disconnected-before-start' });
      return;
    }

    const hasOverflow = viewport.scrollWidth > viewport.clientWidth + 4;
    if (!hasOverflow && attempt < 20) {
      layoutRetryId = window.setTimeout(() => startAutoScroll(attempt + 1), 100);
      return;
    }

    logTopPerformersDebug('auto-scroll-start', {
      attempt,
      hasOverflow,
      loopWidth: Math.round(getLoopWidth()),
      scrollLeft: Math.round(viewport.scrollLeft),
      scrollWidth: Math.round(viewport.scrollWidth),
      clientWidth: Math.round(viewport.clientWidth),
    });

    initialTimeoutId = window.setTimeout(() => {
      lastFrameAt = 0;
      logTopPerformersDebug('auto-scroll-continuous-start', {
        speedPxPerSec: TOP_PERFORMERS_AUTO_SCROLL_PX_PER_SEC,
      });
      animationFrameId = window.requestAnimationFrame(tick);
    }, TOP_PERFORMERS_INITIAL_AUTO_SCROLL_MS);
  };

  window.requestAnimationFrame(() => startAutoScroll());

  viewport.addEventListener('focusin', () => {
    pauseForManualInput('focusin');
  });
  viewport.addEventListener('focusout', () => {
    topPerformersManualPauseUntil = Math.min(topPerformersManualPauseUntil, Date.now() + 1000);
  });
  viewport.addEventListener('pointerenter', () => {
    topPerformersManualPauseUntil = Number.POSITIVE_INFINITY;
    logTopPerformersDebug('manual-pause', {
      reason: 'pointerenter',
      untilMs: 'hover',
      scrollLeft: Math.round(viewport.scrollLeft),
    });
  });
  viewport.addEventListener('pointerleave', () => {
    topPerformersManualPauseUntil = Date.now() + 500;
    logTopPerformersDebug('manual-pause-end', {
      reason: 'pointerleave',
      resumeInMs: 500,
      scrollLeft: Math.round(viewport.scrollLeft),
    });
  });
  viewport.addEventListener('pointerdown', () => pauseForManualInput('pointerdown'));
  viewport.addEventListener('wheel', () => pauseForManualInput('wheel'), { passive: true });
  viewport.addEventListener('keydown', () => pauseForManualInput('keydown'));
  viewport.addEventListener('scroll', () => {
    if (Math.abs(viewport.scrollLeft - lastLoggedScrollLeft) >= 4) {
      const programmatic = Date.now() <= topPerformersProgrammaticScrollUntil;
      logTopPerformersDebug('scroll', {
        scrollLeft: Math.round(viewport.scrollLeft),
        programmatic,
        scrollWidth: Math.round(viewport.scrollWidth),
        clientWidth: Math.round(viewport.clientWidth),
      });
      lastLoggedScrollLeft = viewport.scrollLeft;
    }
  }, { passive: true });
}

export function renderTopPerformersSection(state: AppState, controller: AppController) {
  const section = document.createElement('section');
  section.id = 'top-performers-section';
  section.className = 'legacy-token-bar top-performers-bar';

  const tokens = getTopPerformerTokens(state)
    .slice()
    .sort((a, b) => (a.performanceRank ?? 999) - (b.performanceRank ?? 999));
  logTopPerformersDebug('render', {
    generatedAt: state.data.topPerformersGeneratedAt,
    tokens: tokens.map((token) => `${token.performanceRank ?? '-'}:${token.address.slice(0, 6)}`),
    sparklineCount: tokens.filter((token) => state.data.sparklineByAddress[token.address]).length,
  });

  section.innerHTML = `
    <div class="legacy-bar-head top-performers-head">
      <span class="legacy-bar-title top-performers">TOP 24H</span>
      <div class="top-performers-meta">
        <span>${tokens.length}/10</span>
        <span>${escapeHtml(state.data.topPerformersRanking || 'pchange x volume')}</span>
      </div>
    </div>
    ${
      tokens.length > 0
        ? `<div class="top-performers-viewport">
            <div class="top-performers-track">${renderTopPerformerCards(state, tokens)}</div>
            ${tokens.length > 1 ? `<div class="top-performers-track top-performers-track-clone">${renderTopPerformerCards(state, tokens, { duplicate: true })}</div>` : ''}
          </div>`
        : '<div class="top-performers-empty">Waiting for eligible performers...</div>'
    }
  `;

  bindCopyButtons(section);
  bindSparklineHover(section, state.data.sparklineByAddress, { controller });
  bindTokenImagePreview(section);
  bindTopPerformersAutoScroll(section);
  return section;
}
