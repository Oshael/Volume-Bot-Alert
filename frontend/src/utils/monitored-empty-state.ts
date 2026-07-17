export type MonitoredEmptyStateContent = Readonly<{
  icon: string;
  text: string;
  isError: boolean;
}>;

export function resolveMonitoredEmptyStateContent(input: {
  loadError: string | null;
  hasSearchQuery: boolean;
}): MonitoredEmptyStateContent {
  if (input.loadError) {
    return {
      icon: '!',
      text: 'Monitored tokens could not be loaded. Retrying automatically.',
      isError: true,
    };
  }
  if (input.hasSearchQuery) {
    return {
      icon: '?',
      text: 'No monitored tokens match the current search.',
      isError: false,
    };
  }
  return {
    icon: '?',
    text: 'No monitored tokens are available for the current filters.',
    isError: false,
  };
}
