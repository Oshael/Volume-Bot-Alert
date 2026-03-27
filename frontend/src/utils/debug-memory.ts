import type { AppState } from '../state/app-state';

const SAMPLE_INTERVAL_MS = 30_000;
const STORAGE_KEY = 'volume-bot-debug-memory';
const SEARCH_KEYS = ['debugMemory', 'debug-memory'];

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };
};

export type DebugAppMetrics = {
  sessionStatus: AppState['session']['status'];
  runtimeMode: AppState['runtime']['mode'];
  trackedTokens: number;
  monitoredTokenAddresses: number;
  manualTokenAddresses: number;
  pumpTokens: number;
  recentPumpMigrations: number;
  alerts: number;
  recentAlertFingerprints: number;
  desiredPumpSubscriptions: number;
  emitCount: number;
};

type DebugSample = DebugAppMetrics & {
  ts: string;
  elapsedMs: number;
  visibilityState: DocumentVisibilityState;
  domNodes: number;
  jsHeapUsedBytes: number | null;
  jsHeapTotalBytes: number | null;
  jsHeapLimitBytes: number | null;
  renderCountTotal: number;
  renderCountDelta: number;
  emitCountDelta: number;
  avgRenderMs: number;
  maxRenderMs: number;
};

declare global {
  interface Window {
    __botMemoryCollector?: {
      isEnabled: () => boolean;
      getSamples: () => DebugSample[];
      exportSamples: () => void;
      clearSamples: () => void;
      showPanel: () => void;
      hidePanel: () => void;
    };
  }
}

function isEnabled() {
  if (typeof window === 'undefined') {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  for (const key of SEARCH_KEYS) {
    const raw = params.get(key);
    if (raw === '1' || raw === 'true' || raw === 'on') {
      try {
        window.localStorage.setItem(STORAGE_KEY, '1');
      } catch {
        // Ignore localStorage failures in private contexts.
      }
      return true;
    }
  }

  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function formatBytes(value: number | null) {
  if (!Number.isFinite(value) || value == null || value < 0) {
    return '-';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let current = value;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${current.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatMs(value: number) {
  if (!Number.isFinite(value) || value < 0) {
    return '-';
  }
  return `${value.toFixed(1)} ms`;
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

export function createDebugMemoryCollector() {
  const enabled = isEnabled();
  let latestMetrics: DebugAppMetrics | null = null;
  const startedAt = Date.now();
  const samples: DebugSample[] = [];
  let sampleTimer: ReturnType<typeof setInterval> | null = null;
  let panel: HTMLDivElement | null = null;
  let totalRenderCount = 0;
  let renderCountSinceLastSample = 0;
  let renderDurationSumSinceLastSample = 0;
  let renderDurationMaxSinceLastSample = 0;
  let lastSampledEmitCount = 0;

  function ensurePanel() {
    if (!enabled || panel || typeof document === 'undefined') {
      return;
    }

    panel = document.createElement('div');
    panel.dataset.debugMemoryPanel = 'true';
    Object.assign(panel.style, {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      zIndex: '99999',
      width: '320px',
      maxWidth: 'calc(100vw - 24px)',
      padding: '12px',
      borderRadius: '12px',
      background: 'rgba(12, 14, 21, 0.94)',
      color: '#f5f7ff',
      border: '1px solid rgba(255,255,255,0.12)',
      boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '12px',
      lineHeight: '1.4',
      whiteSpace: 'pre-wrap',
    });

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.gap = '8px';
    controls.style.marginBottom = '8px';

    const status = document.createElement('div');
    status.dataset.debugMemoryStatus = 'true';

    const sampleInfo = document.createElement('div');
    sampleInfo.dataset.debugMemorySamples = 'true';
    sampleInfo.style.marginTop = '8px';

    const makeButton = (label: string, onClick: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      Object.assign(button.style, {
        border: '1px solid rgba(255,255,255,0.18)',
        background: 'rgba(255,255,255,0.06)',
        color: 'inherit',
        borderRadius: '8px',
        padding: '6px 8px',
        cursor: 'pointer',
      });
      button.addEventListener('click', onClick);
      return button;
    };

    controls.append(
      makeButton('Export JSON', () => exportSamples()),
      makeButton('Clear', () => clearSamples()),
      makeButton('Hide', () => hidePanel()),
    );

    panel.append(controls, status, sampleInfo);
    document.body.append(panel);
    updatePanel();
  }

  function updatePanel() {
    if (!panel) {
      return;
    }

    const status = panel.querySelector<HTMLElement>('[data-debug-memory-status="true"]');
    const sampleInfo = panel.querySelector<HTMLElement>('[data-debug-memory-samples="true"]');
    const last = samples[samples.length - 1];
    if (status) {
      status.textContent = last
        ? [
          `heap: ${formatBytes(last.jsHeapUsedBytes)} / ${formatBytes(last.jsHeapTotalBytes)}`,
          `dom: ${last.domNodes}`,
          `renders: +${last.renderCountDelta} (${formatMs(last.avgRenderMs)} avg / ${formatMs(last.maxRenderMs)} max)`,
          `tracked: ${last.trackedTokens} | pump: ${last.pumpTokens} | alerts: ${last.alerts}`,
          `subs: ${last.desiredPumpSubscriptions} | dedupe: ${last.recentAlertFingerprints}`,
          `emitΔ: ${last.emitCountDelta}`,
          `vis: ${last.visibilityState} | mode: ${last.runtimeMode}`,
        ].join('\n')
        : 'Waiting for first sample...';
    }

    if (sampleInfo) {
      sampleInfo.textContent = `samples: ${samples.length}\nelapsed: ${Math.round((Date.now() - startedAt) / 1000)}s`;
    }
  }

  function captureSample() {
    if (!enabled || !latestMetrics) {
      return;
    }

    const perf = performance as PerformanceWithMemory;
    const memory = perf.memory;
    const previousEmitCount = lastSampledEmitCount;
    const next: DebugSample = {
      ...latestMetrics,
      ts: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      visibilityState: document.visibilityState,
      domNodes: document.getElementsByTagName('*').length,
      jsHeapUsedBytes: typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null,
      jsHeapTotalBytes: typeof memory?.totalJSHeapSize === 'number' ? memory.totalJSHeapSize : null,
      jsHeapLimitBytes: typeof memory?.jsHeapSizeLimit === 'number' ? memory.jsHeapSizeLimit : null,
      renderCountTotal: totalRenderCount,
      renderCountDelta: renderCountSinceLastSample,
      emitCountDelta: latestMetrics.emitCount - previousEmitCount,
      avgRenderMs: renderCountSinceLastSample > 0 ? renderDurationSumSinceLastSample / renderCountSinceLastSample : 0,
      maxRenderMs: renderDurationMaxSinceLastSample,
    };

    samples.push(next);
    lastSampledEmitCount = latestMetrics.emitCount;
    renderCountSinceLastSample = 0;
    renderDurationSumSinceLastSample = 0;
    renderDurationMaxSinceLastSample = 0;
    updatePanel();
  }

  function exportSamples() {
    if (!enabled) {
      return;
    }
    downloadJson(`memory-profile-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, {
      startedAt: new Date(startedAt).toISOString(),
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      samples,
    });
  }

  function clearSamples() {
    samples.length = 0;
    totalRenderCount = 0;
    renderCountSinceLastSample = 0;
    renderDurationSumSinceLastSample = 0;
    renderDurationMaxSinceLastSample = 0;
    lastSampledEmitCount = latestMetrics?.emitCount || 0;
    updatePanel();
  }

  function showPanel() {
    ensurePanel();
    if (panel) {
      panel.style.display = 'block';
    }
  }

  function hidePanel() {
    if (panel) {
      panel.style.display = 'none';
    }
  }

  if (enabled) {
    ensurePanel();
    sampleTimer = window.setInterval(captureSample, SAMPLE_INTERVAL_MS);
    window.setTimeout(captureSample, 1000);
  }

  window.__botMemoryCollector = {
    isEnabled: () => enabled,
    getSamples: () => samples.slice(),
    exportSamples,
    clearSamples,
    showPanel,
    hidePanel,
  };

  return {
    isEnabled() {
      return enabled;
    },
    updateMetrics(metrics: DebugAppMetrics) {
      if (!enabled) {
        return;
      }
      latestMetrics = metrics;
    },
    noteRender(durationMs: number) {
      if (!enabled) {
        return;
      }
      totalRenderCount += 1;
      renderCountSinceLastSample += 1;
      renderDurationSumSinceLastSample += durationMs;
      if (durationMs > renderDurationMaxSinceLastSample) {
        renderDurationMaxSinceLastSample = durationMs;
      }
    },
    stop() {
      if (sampleTimer) {
        clearInterval(sampleTimer);
        sampleTimer = null;
      }
    },
  };
}
