import { fetchExactToken, type GlobalSearchPayload } from '../services/api/search';
import { createClipboardTokenState, type ClipboardTokenState } from './app-state';

interface Options {
  state: ClipboardTokenState;
  isAuthenticated(): boolean;
  notify(): void;
  readClipboard?: () => Promise<string>;
  readPermission?: () => Promise<PermissionState | null>;
  request?: typeof fetchExactToken;
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function classifyClipboardTokenAddress(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 120) return null;
  if (EVM_ADDRESS.test(text)) return text.toLowerCase();
  return SOLANA_ADDRESS.test(text) ? text : null;
}

async function defaultReadPermission() {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return null;
  try {
    const descriptor = { name: 'clipboard-read' } as unknown as PermissionDescriptor;
    const result = await navigator.permissions.query(descriptor);
    return result.state;
  } catch {
    return null;
  }
}

async function defaultReadClipboard() {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
    const error = new Error('Clipboard reading is unavailable');
    error.name = 'NotSupportedError';
    throw error;
  }
  return navigator.clipboard.readText();
}

function isPermissionDenied(error: unknown) {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  return name === 'NotAllowedError' || name === 'SecurityError';
}

function getFailureStatus(error: unknown): ClipboardTokenState['status'] {
  if (isPermissionDenied(error)) return 'denied';
  return error && typeof error === 'object' && 'name' in error && error.name === 'NotSupportedError'
    ? 'unavailable' : 'error';
}

function getResolvedState(payload: GlobalSearchPayload): Partial<ClipboardTokenState> {
  const hit = payload.hits.find((item) => item.kind === 'token' && item.match === 'exact_address') || null;
  return { hit, status: hit ? 'ready' : payload.status === 'ready' ? 'idle' : payload.status, error: null };
}

export function createClipboardTokenController(options: Options) {
  const request = options.request || fetchExactToken;
  const readClipboard = options.readClipboard || defaultReadClipboard;
  const readPermission = options.readPermission || defaultReadPermission;
  let active: AbortController | null = null;
  let revision = 0;

  function owns(ownedRevision: number, controller?: AbortController) {
    return ownedRevision === revision && !controller?.signal.aborted;
  }

  function reset() {
    revision += 1;
    active?.abort();
    active = null;
    Object.assign(options.state, createClipboardTokenState());
    options.notify();
  }

  async function activate() {
    const ownedRevision = ++revision;
    active?.abort();
    active = null;
    Object.assign(options.state, { status: 'reading', hit: null, error: null });
    options.notify();
    if (!options.isAuthenticated()) return reset();

    try {
      if (await readPermission() === 'denied') {
        if (!owns(ownedRevision)) return;
        options.state.status = 'denied';
        options.notify();
        return;
      }
      const address = classifyClipboardTokenAddress(await readClipboard());
      if (!owns(ownedRevision)) return;
      if (!address) {
        options.state.status = 'idle';
        options.notify();
        return;
      }

      options.state.status = 'resolving';
      options.notify();
      active = new AbortController();
      const ownedController = active;
      const payload: GlobalSearchPayload = await request(address, null, ownedController.signal);
      if (!owns(ownedRevision, ownedController)) return;
      Object.assign(options.state, getResolvedState(payload));
    } catch (error) {
      if (!owns(ownedRevision)) return;
      options.state.hit = null;
      options.state.status = getFailureStatus(error);
      options.state.error = options.state.status === 'error'
        ? (error instanceof Error ? error.message : 'Clipboard token resolution failed') : null;
    } finally {
      if (ownedRevision === revision) {
        active = null;
        options.notify();
      }
    }
  }

  return Object.freeze({ activate, reset });
}
