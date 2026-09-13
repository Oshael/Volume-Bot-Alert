import { fetchGlobalSearch, type GlobalSearchPayload } from '../services/api/search';
import { createGlobalSearchState, type GlobalSearchState } from './app-state';

interface Options {
  state: GlobalSearchState;
  isAuthenticated(): boolean;
  notify(): void;
  debounceMs?: number;
  request?: typeof fetchGlobalSearch;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}

export function createGlobalSearchController(options: Options) {
  const request = options.request || fetchGlobalSearch;
  const schedule = options.schedule || setTimeout;
  const cancel = options.cancel || clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: AbortController | null = null;
  let revision = 0;

  function reset() {
    revision += 1;
    if (timer) cancel(timer);
    timer = null;
    active?.abort();
    active = null;
    Object.assign(options.state, createGlobalSearchState());
    options.notify();
  }

  async function run(query: string, ownedRevision: number) {
    if (ownedRevision !== revision || !options.isAuthenticated()) return;
    active = new AbortController();
    const ownedController = active;
    options.state.status = 'loading';
    options.notify();
    try {
      const payload: GlobalSearchPayload = await request(query, null, ownedController.signal);
      if (ownedRevision !== revision || ownedController.signal.aborted) return;
      options.state.hits = payload.hits;
      options.state.status = payload.hits.length > 0 ? 'ready'
        : payload.status === 'ready' ? 'empty' : payload.status;
      options.state.error = null;
    } catch (error) {
      if (ownedRevision !== revision || ownedController.signal.aborted) return;
      options.state.hits = [];
      options.state.status = 'error';
      options.state.error = error instanceof Error ? error.message : 'Global search failed';
    } finally {
      if (active === ownedController) active = null;
      if (ownedRevision === revision) options.notify();
    }
  }

  function setQuery(value: string) {
    revision += 1;
    if (timer) cancel(timer);
    timer = null;
    active?.abort();
    active = null;
    options.state.query = value;
    options.state.hits = [];
    options.state.error = null;
    const query = value.trim();
    if (query.length < 2) {
      options.state.status = 'idle';
      options.notify();
      return;
    }
    options.state.status = 'debouncing';
    options.notify();
    const ownedRevision = revision;
    timer = schedule(() => {
      timer = null;
      void run(query, ownedRevision);
    }, options.debounceMs ?? 250);
  }

  return Object.freeze({ setQuery, reset });
}
