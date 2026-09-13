import { fetchExactToken, type GlobalSearchPayload } from '../services/api/search';
import { createClipboardTokenState, type ClipboardTokenState } from './app-state';

interface Options {
  state: ClipboardTokenState;
  isAuthenticated(): boolean;
  notify(): void;
  isSupported?: () => boolean;
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
  const isSupported = options.isSupported || (() => (
    Boolean(options.readClipboard)
    || (typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText))
  ));
  let active: AbortController | null = null;
  let reading = false;
  let revision = 0;
  let lastAddress: string | null = null;

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

  function dismissPrompt() {
    if (options.state.promptDismissed) return;
    options.state.promptDismissed = true;
    options.notify();
  }

  async function initialize() {
    if (!options.isAuthenticated()) return;
    if (!isSupported()) {
      Object.assign(options.state, { accessStatus: 'unavailable', status: 'unavailable' });
      options.notify();
      return;
    }
    const permission = await readPermission();
    const accessStatus = permission === 'granted' || permission === 'denied' ? permission : 'prompt';
    Object.assign(options.state, {
      accessStatus,
      status: accessStatus === 'denied' ? 'denied' : 'idle',
    });
    options.notify();
  }

  async function canRead(allowPermissionPrompt: boolean) {
    if (reading || !options.isAuthenticated()) return;
    if (options.state.accessStatus === 'checking') await initialize();
    if (options.state.accessStatus === 'denied' || options.state.accessStatus === 'unavailable') return;
    return allowPermissionPrompt || options.state.accessStatus === 'granted';
  }

  async function applyAddress(address: string | null, accessChanged: boolean, ownedRevision: number) {
    if (!address) {
      const changed = accessChanged || Boolean(options.state.hit) || options.state.status !== 'idle';
      lastAddress = null;
      Object.assign(options.state, { hit: null, status: 'idle' });
      return changed;
    }
    if (address === lastAddress && options.state.hit?.address === address) {
      return accessChanged;
    }

    lastAddress = address;
    options.state.status = 'resolving';
    options.notify();
    active = new AbortController();
    const ownedController = active;
    const payload: GlobalSearchPayload = await request(address, null, ownedController.signal);
    if (!owns(ownedRevision, ownedController)) return false;
    Object.assign(options.state, getResolvedState(payload));
    return true;
  }

  function applyFailure(error: unknown) {
    options.state.hit = null;
    options.state.status = getFailureStatus(error);
    if (options.state.status === 'denied' || options.state.status === 'unavailable') {
      options.state.accessStatus = options.state.status;
    }
    options.state.error = options.state.status === 'error'
      ? (error instanceof Error ? error.message : 'Clipboard token resolution failed') : null;
  }

  async function readAndResolve(allowPermissionPrompt: boolean) {
    if (!await canRead(allowPermissionPrompt)) return null;

    reading = true;
    let notifyOnFinish = false;
    let address: string | null = null;
    const ownedRevision = ++revision;
    active?.abort();
    active = null;
    if (allowPermissionPrompt && !options.state.hit) {
      Object.assign(options.state, { status: 'reading', error: null });
      options.notify();
    }

    try {
      address = classifyClipboardTokenAddress(await readClipboard());
      if (!owns(ownedRevision)) return null;
      const accessChanged = options.state.accessStatus !== 'granted' || !options.state.promptDismissed;
      Object.assign(options.state, { accessStatus: 'granted', promptDismissed: true, error: null });
      notifyOnFinish = await applyAddress(address, accessChanged, ownedRevision);
      if (!owns(ownedRevision)) return null;
    } catch (error) {
      if (!owns(ownedRevision)) return null;
      notifyOnFinish = true;
      applyFailure(error);
    } finally {
      reading = false;
      if (ownedRevision === revision) {
        active = null;
        if (notifyOnFinish) options.notify();
      }
    }
    return address;
  }

  async function requestAccess() {
    return readAndResolve(true);
  }

  async function inspect() {
    await readAndResolve(false);
  }

  return Object.freeze({ dismissPrompt, initialize, inspect, requestAccess, reset });
}
