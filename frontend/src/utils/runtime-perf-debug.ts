const PERF_DEBUG_ENABLED_KEY = 'trendscope-runtime-perf-debug-enabled';
const PERF_DEBUG_LOG_KEY = 'trendscope-runtime-perf-debug-log';
const PERF_DEBUG_ARCHIVES_KEY = 'trendscope-runtime-perf-debug-archives';
const PERF_DEBUG_MAX_ENTRIES = 240;
const PERF_DEBUG_RETAIN_ENTRIES_AFTER_ARCHIVE = 120;
const PERF_DEBUG_MAX_ARCHIVES = 120;

type RuntimePerfDebugKind = 'measure' | 'sample' | 'longtask';

export interface RuntimePerfDebugEntry {
  ts: number;
  kind: RuntimePerfDebugKind;
  label: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
  memory?: RuntimePerfMemorySnapshot | null;
}

export interface RuntimePerfMemorySnapshot {
  usedHeapMb: number | null;
  totalHeapMb: number | null;
  heapLimitMb: number | null;
}

export interface RuntimePerfDebugArchive {
  id: string;
  createdAt: number;
  entries: RuntimePerfDebugEntry[];
}

declare global {
  interface Window {
    trendscopePerfDebug?: {
      enable: () => void;
      disable: () => void;
      clear: () => void;
      dump: () => RuntimePerfDebugEntry[];
      dumpArchives: () => RuntimePerfDebugArchive[];
      dumpAll: () => { active: RuntimePerfDebugEntry[]; archives: RuntimePerfDebugArchive[] };
      isEnabled: () => boolean;
    };
  }
}

function getStorage() {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage;
}

function roundMs(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(1)) : 0;
}

function toMb(value: unknown) {
  const bytes = Number(value);
  return Number.isFinite(bytes) ? Number((bytes / 1024 / 1024).toFixed(1)) : null;
}

export function isRuntimePerfDebugEnabled() {
  try {
    return getStorage()?.getItem(PERF_DEBUG_ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setRuntimePerfDebugEnabled(enabled: boolean) {
  try {
    const storage = getStorage();
    if (!storage) {
      return;
    }
    if (enabled) {
      storage.setItem(PERF_DEBUG_ENABLED_KEY, '1');
    } else {
      storage.removeItem(PERF_DEBUG_ENABLED_KEY);
    }
  } catch {
    // Ignore local persistence failures.
  }
}

export function clearRuntimePerfDebugLog() {
  try {
    const storage = getStorage();
    storage?.removeItem(PERF_DEBUG_LOG_KEY);
    storage?.removeItem(PERF_DEBUG_ARCHIVES_KEY);
  } catch {
    // Ignore local persistence failures.
  }
}

export function getRuntimePerfDebugLog(): RuntimePerfDebugEntry[] {
  try {
    const raw = getStorage()?.getItem(PERF_DEBUG_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getRuntimePerfDebugArchives(): RuntimePerfDebugArchive[] {
  try {
    const raw = getStorage()?.getItem(PERF_DEBUG_ARCHIVES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is RuntimePerfDebugArchive => (
      Boolean(item)
      && typeof item === 'object'
      && typeof item.id === 'string'
      && Number.isFinite(Number(item.createdAt))
      && Array.isArray(item.entries)
    ));
  } catch {
    return [];
  }
}

function persistRuntimePerfDebugLog(entries: RuntimePerfDebugEntry[]) {
  getStorage()?.setItem(PERF_DEBUG_LOG_KEY, JSON.stringify(entries));
}

function persistRuntimePerfDebugArchives(archives: RuntimePerfDebugArchive[]) {
  getStorage()?.setItem(PERF_DEBUG_ARCHIVES_KEY, JSON.stringify(archives));
}

function archiveRuntimePerfDebugEntries(entries: RuntimePerfDebugEntry[]) {
  if (entries.length === 0) {
    return [];
  }

  const archive: RuntimePerfDebugArchive = {
    id: `perf-${Date.now()}`,
    createdAt: Date.now(),
    entries,
  };
  const archives = [archive, ...getRuntimePerfDebugArchives()].slice(0, PERF_DEBUG_MAX_ARCHIVES);
  persistRuntimePerfDebugArchives(archives);
  return archives;
}

function splitRuntimePerfDebugEntries(entries: RuntimePerfDebugEntry[]) {
  if (entries.length <= PERF_DEBUG_MAX_ENTRIES) {
    return entries;
  }

  const archiveEntries = entries.slice(PERF_DEBUG_RETAIN_ENTRIES_AFTER_ARCHIVE);
  const activeEntries = entries.slice(0, PERF_DEBUG_RETAIN_ENTRIES_AFTER_ARCHIVE);
  archiveRuntimePerfDebugEntries(archiveEntries);
  return activeEntries;
}

export function readRuntimePerfMemory(): RuntimePerfMemorySnapshot | null {
  if (typeof performance === 'undefined') {
    return null;
  }

  const memory = (performance as Performance & {
    memory?: {
      usedJSHeapSize?: number;
      totalJSHeapSize?: number;
      jsHeapSizeLimit?: number;
    };
  }).memory;
  if (!memory) {
    return null;
  }

  return {
    usedHeapMb: toMb(memory.usedJSHeapSize),
    totalHeapMb: toMb(memory.totalJSHeapSize),
    heapLimitMb: toMb(memory.jsHeapSizeLimit),
  };
}

export function recordRuntimePerfDebugEntry(entry: RuntimePerfDebugEntry, active = isRuntimePerfDebugEnabled()) {
  if (!active) {
    return;
  }

  try {
    const nextEntry = {
      ...entry,
      durationMs: entry.durationMs == null ? undefined : roundMs(entry.durationMs),
    };
    const entries = splitRuntimePerfDebugEntries([nextEntry, ...getRuntimePerfDebugLog()])
      .slice(0, PERF_DEBUG_MAX_ENTRIES);
    persistRuntimePerfDebugLog(entries);
    if (entry.kind === 'longtask' || Number(entry.durationMs || 0) >= 50) {
      console.debug('[Perf][Frontend]', nextEntry);
    }
  } catch {
    // Debug collection must never affect runtime behavior.
  }
}

export function measureRuntimePerf<T>(
  label: string,
  active: boolean,
  meta: Record<string, unknown>,
  run: () => T,
): T {
  if (!active || typeof performance === 'undefined') {
    return run();
  }

  const startedAt = performance.now();
  try {
    return run();
  } finally {
    recordRuntimePerfDebugEntry({
      ts: Date.now(),
      kind: 'measure',
      label,
      durationMs: performance.now() - startedAt,
      meta,
      memory: readRuntimePerfMemory(),
    }, active);
  }
}

export async function measureRuntimePerfAsync<T>(
  label: string,
  active: boolean,
  meta: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  if (!active || typeof performance === 'undefined') {
    return run();
  }

  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    recordRuntimePerfDebugEntry({
      ts: Date.now(),
      kind: 'measure',
      label,
      durationMs: performance.now() - startedAt,
      meta,
      memory: readRuntimePerfMemory(),
    }, active);
  }
}

export function installRuntimePerfDebugConsole() {
  if (typeof window === 'undefined') {
    return;
  }

  window.trendscopePerfDebug = {
    enable: () => setRuntimePerfDebugEnabled(true),
    disable: () => setRuntimePerfDebugEnabled(false),
    clear: clearRuntimePerfDebugLog,
    dump: getRuntimePerfDebugLog,
    dumpArchives: getRuntimePerfDebugArchives,
    dumpAll: () => ({
      active: getRuntimePerfDebugLog(),
      archives: getRuntimePerfDebugArchives(),
    }),
    isEnabled: isRuntimePerfDebugEnabled,
  };
}

export function observeRuntimeLongTasks(isActive: () => boolean) {
  if (typeof PerformanceObserver === 'undefined') {
    return;
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordRuntimePerfDebugEntry({
          ts: Date.now(),
          kind: 'longtask',
          label: 'browser.longtask',
          durationMs: entry.duration,
          meta: {
            name: entry.name,
            startTime: roundMs(entry.startTime),
          },
          memory: readRuntimePerfMemory(),
        }, isActive());
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // Long task observer support varies by browser.
  }
}
