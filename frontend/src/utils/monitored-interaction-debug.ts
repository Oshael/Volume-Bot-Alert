const DEFAULT_DIAGNOSIS_DURATION_MS = 15_000;
const MAX_DIAGNOSIS_DURATION_MS = 60_000;
const MAX_RECORDED_EVENTS = 120;

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
};

declare global {
  interface Window {
    trendscopeInteractionDebug?: {
      diagnose: (options?: { durationMs?: number }) => Promise<MonitoredInteractionDiagnosis>;
    };
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
  if (target.closest('.monitored-sparkline-quick-ranges')) return 'sparkline-range';
  if (target.closest('[data-trade-wrap], .trade-btn-direct')) return 'terminal';
  return 'other';
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
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });

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

  const report: MonitoredInteractionDiagnosis = {
    generatedAt: new Date().toISOString(),
    durationMs,
    initialRows,
    finalRows: list.querySelectorAll(':scope > .monitored-token-row').length,
    summary,
    events,
  };
  console.info('[Monitored interaction diagnosis]', report);
  return report;
}

export function installMonitoredInteractionDebugConsole() {
  if (typeof window === 'undefined') return;
  window.trendscopeInteractionDebug = {
    diagnose: diagnoseMonitoredInteractions,
  };
}
