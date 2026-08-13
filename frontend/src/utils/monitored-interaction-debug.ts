const DEFAULT_DIAGNOSIS_DURATION_MS = 15_000;
const MAX_DIAGNOSIS_DURATION_MS = 60_000;
const MAX_RECORDED_EVENTS = 120;
const MAX_RECORDED_HOVER_EVENTS = 240;
const DIAGNOSIS_STORAGE_KEY = 'trendscope:monitored-interaction-diagnosis';

type InteractionZone = 'liquidity' | 'sparkline-range' | 'terminal' | 'other';

type PointerSnapshot = {
  identity: string | null;
  zone: InteractionZone;
};

type InteractionMutationEvent = {
  atMs: number;
  movedRows: string[];
  replacedRows: string[];
  removedRows: string[];
  addedRows: string[];
  disconnected: {
    liquidity: number;
    sparklineRanges: number;
    terminals: number;
    pointerTarget: boolean;
  };
  pointer: PointerSnapshot;
};

type HoverTransitionEvent = {
  atMs: number;
  transition: 'enter' | 'leave';
  identity: string | null;
  zone: Exclude<InteractionZone, 'other'>;
  x: number;
  y: number;
  target: string;
  relatedTarget: string;
  hitTarget: string;
  rootHovered: boolean;
  popupVisible: boolean | null;
  rootRect: { left: number; top: number; right: number; bottom: number };
};

type HoverTransitionCounts = Record<Exclude<InteractionZone, 'other'>, {
  enters: number;
  leaves: number;
}>;

export type MonitoredInteractionDiagnosis = {
  generatedAt: string;
  durationMs: number;
  initialRows: number;
  finalRows: number;
  summary: {
    mutationBatches: number;
    orderChanges: number;
    rowMoves: number;
    rowReplacements: number;
    rowRemovals: number;
    rowAdditions: number;
    liquidityDisconnects: number;
    sparklineRangeDisconnects: number;
    terminalDisconnects: number;
    pointerTargetDisconnects: number;
  };
  events: InteractionMutationEvent[];
  hoverSummary: HoverTransitionCounts;
  hoverEvents: HoverTransitionEvent[];
};

type MonitoredInteractionDiagnosisRun = {
  startedAt: string;
  finishesAt: string;
  durationMs: number;
};

let activeDiagnosis: Promise<void> | null = null;
let activeDiagnosisRun: MonitoredInteractionDiagnosisRun | null = null;

declare global {
  interface Window {
    trendscopeInteractionDebug?: {
      diagnose: (options?: { durationMs?: number }) => Promise<MonitoredInteractionDiagnosis>;
      start: (options?: { durationMs?: number }) => MonitoredInteractionDiagnosisRun;
      dump: () => MonitoredInteractionDiagnosis | null;
      clear: () => void;
      isRunning: () => boolean;
    };
  }
}

function readStoredDiagnosis() {
  try {
    const raw = window.localStorage.getItem(DIAGNOSIS_STORAGE_KEY);
    return raw ? JSON.parse(raw) as MonitoredInteractionDiagnosis : null;
  } catch {
    return null;
  }
}

function storeDiagnosis(report: MonitoredInteractionDiagnosis) {
  try {
    window.localStorage.setItem(DIAGNOSIS_STORAGE_KEY, JSON.stringify(report));
  } catch {
    console.warn('[Monitored interaction diagnosis] Could not persist the report.');
  }
}

function clearStoredDiagnosis() {
  try {
    window.localStorage.removeItem(DIAGNOSIS_STORAGE_KEY);
  } catch {
    // Ignore local persistence failures.
  }
}

function findRows(node: Node) {
  if (!(node instanceof Element)) return [];
  const rows = [...node.querySelectorAll<HTMLElement>('.monitored-token-row')];
  if (node.matches('.monitored-token-row')) rows.unshift(node as HTMLElement);
  return rows;
}

function findElements(node: Node, selector: string) {
  if (!(node instanceof Element)) return [];
  const matches = [...node.querySelectorAll<HTMLElement>(selector)];
  if (node.matches(selector)) matches.unshift(node as HTMLElement);
  return matches;
}

function getRowIdentity(row: HTMLElement) {
  return row.dataset.identity || '(unknown)';
}

function getPointerZone(target: HTMLElement | null): InteractionZone {
  if (!target) return 'other';
  if (target.closest('.total-liq-tip-wrap')) return 'liquidity';
  if (target.closest('.monitored-mini-chart')) return 'sparkline-range';
  if (target.closest('[data-trade-wrap], .trade-btn-direct')) return 'terminal';
  return 'other';
}

function getInteractionRoot(target: HTMLElement | null, zone: InteractionZone) {
  if (!target || zone === 'other') return null;
  if (zone === 'liquidity') return target.closest<HTMLElement>('.total-liq-tip-wrap');
  if (zone === 'sparkline-range') return target.closest<HTMLElement>('.monitored-mini-chart');
  return target.closest<HTMLElement>('[data-trade-wrap], .trade-btn-direct');
}

function describeElement(element: HTMLElement | null) {
  if (!element) return '(none)';
  const action = element.dataset.action ? `[data-action="${element.dataset.action}"]` : '';
  const classes = [...element.classList].slice(0, 4).map((name) => `.${name}`).join('');
  return `${element.tagName.toLowerCase()}${action}${classes}`;
}

function isPopupVisible(root: HTMLElement, zone: Exclude<InteractionZone, 'other'>) {
  const selector = zone === 'liquidity'
    ? '.met-tip-dd'
    : zone === 'sparkline-range'
      ? '.monitored-sparkline-quick-ranges'
      : '.trade-dd';
  const popup = root.querySelector<HTMLElement>(selector);
  if (!popup) return null;
  const style = window.getComputedStyle(popup);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number(style.opacity || 1) > 0.01;
}

function getPointerSnapshot(target: HTMLElement | null): PointerSnapshot {
  return {
    identity: target?.closest<HTMLElement>('.monitored-token-row')?.dataset.identity || null,
    zone: getPointerZone(target),
  };
}

function normalizedDuration(value: unknown) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return DEFAULT_DIAGNOSIS_DURATION_MS;
  return Math.min(MAX_DIAGNOSIS_DURATION_MS, Math.max(1_000, Math.round(duration)));
}

function rowOrder(list: HTMLElement) {
  return [...list.querySelectorAll<HTMLElement>(':scope > .monitored-token-row')]
    .map(getRowIdentity)
    .join('|');
}

async function diagnoseMonitoredInteractions(
  options: { durationMs?: number } = {},
): Promise<MonitoredInteractionDiagnosis> {
  const list = document.querySelector<HTMLElement>('.monitored-list');
  if (!list) {
    throw new Error('Monitored list not found. Open the Monitored panel before running the diagnosis.');
  }

  const durationMs = normalizedDuration(options.durationMs);
  const initialRows = list.querySelectorAll(':scope > .monitored-token-row').length;
  const startedAt = performance.now();
  let pointerTarget: HTMLElement | null = null;
  let previousOrder = rowOrder(list);
  const events: InteractionMutationEvent[] = [];
  const hoverEvents: HoverTransitionEvent[] = [];
  const hoverSummary: HoverTransitionCounts = {
    liquidity: { enters: 0, leaves: 0 },
    'sparkline-range': { enters: 0, leaves: 0 },
    terminal: { enters: 0, leaves: 0 },
  };
  const summary = {
    mutationBatches: 0,
    orderChanges: 0,
    rowMoves: 0,
    rowReplacements: 0,
    rowRemovals: 0,
    rowAdditions: 0,
    liquidityDisconnects: 0,
    sparklineRangeDisconnects: 0,
    terminalDisconnects: 0,
    pointerTargetDisconnects: 0,
  };

  const onPointerMove = (event: PointerEvent) => {
    pointerTarget = event.target instanceof HTMLElement ? event.target : null;
  };
  const recordHoverTransition = (event: PointerEvent, transition: 'enter' | 'leave') => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const relatedTarget = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
    const zone = getPointerZone(target);
    if (zone === 'other') return;
    const root = getInteractionRoot(target, zone);
    const relatedRoot = getInteractionRoot(relatedTarget, getPointerZone(relatedTarget));
    if (!root || root === relatedRoot) return;

    hoverSummary[zone][transition === 'enter' ? 'enters' : 'leaves'] += 1;
    if (hoverEvents.length >= MAX_RECORDED_HOVER_EVENTS) return;
    const rect = root.getBoundingClientRect();
    const hitTarget = document.elementFromPoint(event.clientX, event.clientY);
    hoverEvents.push({
      atMs: Number((performance.now() - startedAt).toFixed(1)),
      transition,
      identity: root.closest<HTMLElement>('.monitored-token-row')?.dataset.identity || null,
      zone,
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      target: describeElement(target),
      relatedTarget: describeElement(relatedTarget),
      hitTarget: describeElement(hitTarget instanceof HTMLElement ? hitTarget : null),
      rootHovered: root.matches(':hover'),
      popupVisible: isPopupVisible(root, zone),
      rootRect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
      },
    });
  };
  const onPointerOver = (event: PointerEvent) => recordHoverTransition(event, 'enter');
  const onPointerOut = (event: PointerEvent) => recordHoverTransition(event, 'leave');
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  document.addEventListener('pointerover', onPointerOver, { capture: true, passive: true });
  document.addEventListener('pointerout', onPointerOut, { capture: true, passive: true });

  const observer = new MutationObserver((records) => {
    const removedRows = new Set<HTMLElement>();
    const addedRows = new Set<HTMLElement>();
    const removedLiquidity = new Set<HTMLElement>();
    const removedRanges = new Set<HTMLElement>();
    const removedTerminals = new Set<HTMLElement>();
    let pointerTargetDisconnected = false;

    for (const record of records) {
      if (record.type !== 'childList') continue;
      for (const node of record.removedNodes) {
        findRows(node).forEach((row) => removedRows.add(row));
        findElements(node, '.total-liq-tip-wrap').forEach((element) => removedLiquidity.add(element));
        findElements(node, '.monitored-sparkline-quick-ranges').forEach((element) => removedRanges.add(element));
        findElements(node, '[data-trade-wrap], .trade-btn-direct').forEach((element) => removedTerminals.add(element));
        if (pointerTarget && node instanceof Element && (node === pointerTarget || node.contains(pointerTarget))) {
          pointerTargetDisconnected = true;
        }
      }
      for (const node of record.addedNodes) {
        findRows(node).forEach((row) => addedRows.add(row));
      }
    }

    const movedRows = [...removedRows].filter((row) => addedRows.has(row));
    const removedByIdentity = new Map([...removedRows].map((row) => [getRowIdentity(row), row]));
    const replacedRows = [...addedRows].filter((row) => {
      const removed = removedByIdentity.get(getRowIdentity(row));
      return Boolean(removed && removed !== row);
    });
    const replacedIdentities = new Set(replacedRows.map(getRowIdentity));
    const onlyRemovedRows = [...removedRows].filter((row) => (
      !addedRows.has(row) && !replacedIdentities.has(getRowIdentity(row))
    ));
    const onlyAddedRows = [...addedRows].filter((row) => (
      !removedRows.has(row) && !replacedIdentities.has(getRowIdentity(row))
    ));
    const nextOrder = rowOrder(list);
    const orderChanged = nextOrder !== previousOrder;
    previousOrder = nextOrder;

    const hasRelevantMutation = removedRows.size > 0
      || addedRows.size > 0
      || removedLiquidity.size > 0
      || removedRanges.size > 0
      || removedTerminals.size > 0;
    if (!hasRelevantMutation) return;

    summary.mutationBatches += 1;
    summary.orderChanges += Number(orderChanged);
    summary.rowMoves += movedRows.length;
    summary.rowReplacements += replacedRows.length;
    summary.rowRemovals += onlyRemovedRows.length;
    summary.rowAdditions += onlyAddedRows.length;
    summary.liquidityDisconnects += removedLiquidity.size;
    summary.sparklineRangeDisconnects += removedRanges.size;
    summary.terminalDisconnects += removedTerminals.size;
    summary.pointerTargetDisconnects += Number(pointerTargetDisconnected);

    if (events.length < MAX_RECORDED_EVENTS) {
      events.push({
        atMs: Number((performance.now() - startedAt).toFixed(1)),
        movedRows: movedRows.map(getRowIdentity),
        replacedRows: replacedRows.map(getRowIdentity),
        removedRows: onlyRemovedRows.map(getRowIdentity),
        addedRows: onlyAddedRows.map(getRowIdentity),
        disconnected: {
          liquidity: removedLiquidity.size,
          sparklineRanges: removedRanges.size,
          terminals: removedTerminals.size,
          pointerTarget: pointerTargetDisconnected,
        },
        pointer: getPointerSnapshot(pointerTarget),
      });
    }
  });

  observer.observe(list, { childList: true, subtree: true });
  await new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
  observer.disconnect();
  document.removeEventListener('pointermove', onPointerMove, { capture: true });
  document.removeEventListener('pointerover', onPointerOver, { capture: true });
  document.removeEventListener('pointerout', onPointerOut, { capture: true });

  const report: MonitoredInteractionDiagnosis = {
    generatedAt: new Date().toISOString(),
    durationMs,
    initialRows,
    finalRows: list.querySelectorAll(':scope > .monitored-token-row').length,
    summary,
    events,
    hoverSummary,
    hoverEvents,
  };
  console.info('[Monitored interaction diagnosis]', report);
  return report;
}

function startMonitoredInteractionDiagnosis(
  options: { durationMs?: number } = {},
): MonitoredInteractionDiagnosisRun {
  if (activeDiagnosis) {
    throw new Error(`A Monitored interaction diagnosis is already running until ${activeDiagnosisRun?.finishesAt}.`);
  }
  if (!document.querySelector('.monitored-list')) {
    throw new Error('Monitored list not found. Open the Monitored panel before starting the diagnosis.');
  }

  const durationMs = normalizedDuration(options.durationMs);
  const startedAtMs = Date.now();
  const run = {
    startedAt: new Date(startedAtMs).toISOString(),
    finishesAt: new Date(startedAtMs + durationMs).toISOString(),
    durationMs,
  };
  activeDiagnosisRun = run;
  clearStoredDiagnosis();
  activeDiagnosis = diagnoseMonitoredInteractions({ durationMs })
    .then(storeDiagnosis)
    .catch((error: unknown) => {
      console.error('[Monitored interaction diagnosis] Failed.', error);
    })
    .finally(() => {
      activeDiagnosis = null;
      activeDiagnosisRun = null;
    });
  return run;
}

export function installMonitoredInteractionDebugConsole() {
  if (typeof window === 'undefined') return;
  window.trendscopeInteractionDebug = {
    diagnose: diagnoseMonitoredInteractions,
    start: startMonitoredInteractionDiagnosis,
    dump: readStoredDiagnosis,
    clear: clearStoredDiagnosis,
    isRunning: () => activeDiagnosis != null,
  };
}
