export type MonitoredEmptyStateContent = Readonly<{
  icon: string;
  text: string;
  isError: boolean;
}>;

export function resolveMonitoredEmptyStateContent(input: {
  loadError: string | null;
  hasSearchQuery: boolean;
  status?: 'idle' | 'loading' | 'ready' | 'syncing' | 'unavailable' | 'unsupported' | 'error';
  viewLabel?: string;
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
  if (input.status === 'idle' || input.status === 'loading') {
    return {
      icon: '…',
      text: `Loading ${input.viewLabel || 'Monitored'} tokens...`,
      isError: false,
    };
  }
  if (input.status === 'syncing') {
    return {
      icon: '↻',
      text: `${input.viewLabel || 'Monitored'} data is syncing.`,
      isError: false,
    };
  }
  if (input.status === 'unavailable' || input.status === 'unsupported') {
    return {
      icon: '–',
      text: `${input.viewLabel || 'Monitored'} is not available for the current release.`,
      isError: false,
    };
  }
  return {
    icon: '?',
    text: `No tokens are available in ${input.viewLabel || 'Monitored'}.`,
    isError: false,
  };
}
