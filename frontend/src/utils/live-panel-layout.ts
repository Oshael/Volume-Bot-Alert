import {
  isMonitoredViewId,
  type MonitoredViewId,
} from './monitored-view';

export const LIVE_PANEL_PRESET_IDS = [
  'discovery_alerts',
  'compare',
  'alerts_focus',
  'token_focus',
  'command_center',
] as const;

export const LIVE_PANEL_PANE_KEYS = ['primary', 'secondary', 'alerts'] as const;
export const LIVE_PANEL_DEFAULT_HEIGHT = 620;
export const LIVE_PANEL_MAX_HEIGHT = 100_000;
export const COMMAND_CENTER_MIN_VIEWPORT_PX = 1440;

export type LivePanelPresetId = typeof LIVE_PANEL_PRESET_IDS[number];
export type LivePanelPaneKey = typeof LIVE_PANEL_PANE_KEYS[number];

export interface LivePanelPresetRegion {
  pane: LivePanelPaneKey;
  span: 1 | 2;
  centered?: boolean;
}

export interface LivePanelPresetDefinition {
  id: LivePanelPresetId;
  label: string;
  columns: 2 | 3;
  regions: readonly LivePanelPresetRegion[];
  minViewportWidth: number | null;
}

export interface LivePanelLayoutPreference {
  preset: LivePanelPresetId;
  order: LivePanelPaneKey[];
  panes: {
    primaryView: MonitoredViewId;
    secondaryView: MonitoredViewId;
  };
  heights: {
    primary: number;
    secondary: number;
    alerts: number;
  };
}

export interface LivePanelLayoutNormalizationOptions {
  legacyMonitoredCollapsed?: boolean;
}

const DEFAULT_PANE_ORDER: readonly LivePanelPaneKey[] = ['primary', 'secondary', 'alerts'];

export const LIVE_PANEL_PRESETS: Readonly<Record<LivePanelPresetId, LivePanelPresetDefinition>> = {
  discovery_alerts: {
    id: 'discovery_alerts',
    label: 'Discovery + Alerts',
    columns: 3,
    regions: [{ pane: 'primary', span: 2 }, { pane: 'alerts', span: 1 }],
    minViewportWidth: null,
  },
  compare: {
    id: 'compare',
    label: 'Compare',
    columns: 2,
    regions: [{ pane: 'primary', span: 1 }, { pane: 'secondary', span: 1 }],
    minViewportWidth: null,
  },
  alerts_focus: {
    id: 'alerts_focus',
    label: 'Alerts Focus',
    columns: 3,
    regions: [{ pane: 'alerts', span: 2, centered: true }],
    minViewportWidth: null,
  },
  token_focus: {
    id: 'token_focus',
    label: 'Token Focus',
    columns: 3,
    regions: [{ pane: 'primary', span: 2, centered: true }],
    minViewportWidth: null,
  },
  command_center: {
    id: 'command_center',
    label: 'Command Center',
    columns: 3,
    regions: [
      { pane: 'primary', span: 1 },
      { pane: 'secondary', span: 1 },
      { pane: 'alerts', span: 1 },
    ],
    minViewportWidth: COMMAND_CENTER_MIN_VIEWPORT_PX,
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isLivePanelPresetId(value: unknown): value is LivePanelPresetId {
  return LIVE_PANEL_PRESET_IDS.includes(value as LivePanelPresetId);
}

function normalizePresetId(value: unknown): LivePanelPresetId {
  return isLivePanelPresetId(value) ? value : 'discovery_alerts';
}

function normalizePaneOrder(value: unknown, legacy = false): LivePanelPaneKey[] {
  const order: LivePanelPaneKey[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const pane = legacy && item === 'monitored' ? 'primary' : item;
    if (!LIVE_PANEL_PANE_KEYS.includes(pane as LivePanelPaneKey)) continue;
    if (!order.includes(pane as LivePanelPaneKey)) order.push(pane as LivePanelPaneKey);
  }
  for (const pane of DEFAULT_PANE_ORDER) {
    if (!order.includes(pane)) order.push(pane);
  }
  return order;
}

function normalizeHeight(value: unknown, fallback = LIVE_PANEL_DEFAULT_HEIGHT) {
  const height = Math.round(Number(value));
  return Number.isFinite(height)
    ? Math.min(LIVE_PANEL_MAX_HEIGHT, Math.max(1, height))
    : fallback;
}

function normalizePaneViews(value: unknown): LivePanelLayoutPreference['panes'] {
  const panes = asRecord(value);
  const primaryView = isMonitoredViewId(panes.primaryView) ? panes.primaryView : 'trending';
  const secondaryView = isMonitoredViewId(panes.secondaryView) ? panes.secondaryView : 'watchlist';
  return primaryView === secondaryView
    ? { primaryView: 'trending', secondaryView: 'watchlist' }
    : { primaryView, secondaryView };
}

function resolveLegacyPreset(
  source: Record<string, unknown>,
  options: LivePanelLayoutNormalizationOptions,
): LivePanelPresetId {
  const spans = asRecord(source.spans);
  return options.legacyMonitoredCollapsed === true && Number(spans.alerts) === 2
    ? 'alerts_focus'
    : 'discovery_alerts';
}

export function resolveLivePanelLayoutPreference(
  input: unknown,
  options: LivePanelLayoutNormalizationOptions = {},
): LivePanelLayoutPreference {
  const source = asRecord(input);
  const canonical = Object.hasOwn(source, 'preset') || Object.hasOwn(source, 'panes');
  const heights = asRecord(source.heights);

  if (!canonical) {
    const monitoredHeight = normalizeHeight(heights.monitored);
    return {
      preset: resolveLegacyPreset(source, options),
      order: normalizePaneOrder(source.order, true),
      panes: { primaryView: 'trending', secondaryView: 'watchlist' },
      heights: {
        primary: monitoredHeight,
        secondary: monitoredHeight,
        alerts: normalizeHeight(heights.alerts),
      },
    };
  }

  return {
    preset: normalizePresetId(source.preset),
    order: normalizePaneOrder(source.order),
    panes: normalizePaneViews(source.panes),
    heights: {
      primary: normalizeHeight(heights.primary),
      secondary: normalizeHeight(heights.secondary),
      alerts: normalizeHeight(heights.alerts),
    },
  };
}

export function getLivePanelPresetAvailability(
  preset: LivePanelPresetId,
  viewportWidth: number,
) {
  const minimum = LIVE_PANEL_PRESETS[preset].minViewportWidth;
  const available = minimum == null || viewportWidth >= minimum;
  return {
    available,
    reason: available || minimum == null
      ? null
      : `Requires a viewport at least ${minimum}px wide.`,
  };
}

export function getOrderedVisibleLivePanelRegions(
  layout: LivePanelLayoutPreference,
): LivePanelPresetRegion[] {
  const regions = LIVE_PANEL_PRESETS[layout.preset].regions;
  return layout.order.flatMap((pane) => {
    const region = regions.find((item) => item.pane === pane);
    return region ? [{ ...region }] : [];
  });
}

export function getLivePanelPaneSpan(
  layout: LivePanelLayoutPreference,
  pane: LivePanelPaneKey,
): 0 | 1 | 2 {
  return LIVE_PANEL_PRESETS[layout.preset].regions.find((item) => item.pane === pane)?.span ?? 0;
}

export function resolveMonitoredPaneSelection(
  layout: LivePanelLayoutPreference,
  pane: 'primary' | 'secondary',
  view: MonitoredViewId,
): LivePanelLayoutPreference['panes'] | null {
  const ownKey = pane === 'primary' ? 'primaryView' : 'secondaryView';
  const otherKey = pane === 'primary' ? 'secondaryView' : 'primaryView';
  if (layout.panes[ownKey] === view) return null;
  if (layout.panes[otherKey] !== view) return { ...layout.panes, [ownKey]: view };
  if (pane === 'secondary' || getLivePanelPaneSpan(layout, 'secondary') > 0) return null;
  return { primaryView: view, secondaryView: layout.panes.primaryView };
}
