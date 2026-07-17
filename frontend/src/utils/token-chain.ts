export const TOKEN_CHAINS = ['solana', 'ethereum', 'bsc', 'base', 'robinhood'] as const;

export type TokenChain = typeof TOKEN_CHAINS[number];

export interface TokenIdentity {
  readonly chain: TokenChain;
  readonly address: string;
  readonly key: string;
}

export interface ChainFilterPreferences {
  enabledChains: TokenChain[];
  radarChains: TokenChain[];
  alertFeedChains: TokenChain[];
  browserNotificationChains: TokenChain[];
}

export type WorkspaceChainCapability =
  | 'alertFeed'
  | 'radar'
  | 'monitored'
  | 'topPerformers'
  | 'manualTokens'
  | 'starred'
  | 'blocklist'
  | 'history'
  | 'customAlerts'
  | 'charts'
  | 'explorerLinks'
  | 'tradeLinks'
  | 'mockTrading'
  | 'solanaNative';

export interface WorkspaceChainReadiness {
  chain: TokenChain;
  status: 'ready' | 'syncing' | 'unavailable';
  phase: string;
  publicationReady: boolean;
  workspaceReady: boolean;
  checkedAt: string | null;
  blockers: string[];
  message: string;
  capabilities: Record<WorkspaceChainCapability, boolean>;
}

export type WorkspaceChainReadinessMap = Partial<Record<TokenChain, WorkspaceChainReadiness>>;

export type ChainFilterSurface = Exclude<keyof ChainFilterPreferences, 'enabledChains'>;

const TOKEN_CHAIN_ALIASES: Readonly<Record<string, TokenChain>> = Object.freeze({
  sol: 'solana',
  eth: 'ethereum',
});
const EVM_TOKEN_CHAINS = new Set<TokenChain>(['ethereum', 'bsc', 'base', 'robinhood']);
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const SOLANA_MARKET_URL_POLICIES = Object.freeze([
  { origin: 'https://dexscreener.com', pathname: /^\/solana\/[A-Za-z0-9_-]+\/?$/ },
  { origin: 'https://gmgn.ai', pathname: /^\/sol\/token\/[A-Za-z0-9_-]+\/?$/ },
]);

export function normalizeTokenChain(value: unknown): TokenChain | null {
  const normalized = String(value || '').trim().toLowerCase();
  const aliased = TOKEN_CHAIN_ALIASES[normalized] || normalized;
  return TOKEN_CHAINS.find((chain) => chain === aliased) ?? null;
}

export function normalizeAvailableTokenChains(value: unknown): TokenChain[] {
  const normalized = new Set<TokenChain>();
  if (Array.isArray(value)) {
    for (const item of value) {
      const chain = normalizeTokenChain(item);
      if (chain) {
        normalized.add(chain);
      }
    }
  }
  return normalized.size > 0 ? [...normalized] : ['solana'];
}

function normalizeChainSelection(value: unknown, allowedChains: Set<TokenChain>, fallback: TokenChain[]) {
  const next: TokenChain[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    const chain = normalizeTokenChain(item);
    if (chain && allowedChains.has(chain) && !next.includes(chain)) {
      next.push(chain);
    }
  }
  return next.length > 0 ? next : [...fallback];
}

export function normalizeChainFilterPreferences(
  value: unknown,
  availableValue: unknown,
): ChainFilterPreferences {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<ChainFilterPreferences>
    : {};
  const availableChains = normalizeAvailableTokenChains(availableValue);
  const available = new Set(availableChains);
  const defaultEnabled = available.has('solana') ? ['solana'] as TokenChain[] : [availableChains[0]];
  const enabledChains = normalizeChainSelection(source.enabledChains, available, defaultEnabled);
  const enabled = new Set(enabledChains);
  return {
    enabledChains,
    radarChains: normalizeChainSelection(source.radarChains, enabled, enabledChains),
    alertFeedChains: normalizeChainSelection(source.alertFeedChains, enabled, enabledChains),
    browserNotificationChains: normalizeChainSelection(
      source.browserNotificationChains,
      enabled,
      enabledChains,
    ),
  };
}

export function toggleEnabledTokenChain(
  preferencesValue: unknown,
  availableValue: unknown,
  chainValue: unknown,
): ChainFilterPreferences {
  const availableChains = normalizeAvailableTokenChains(availableValue);
  const preferences = normalizeChainFilterPreferences(preferencesValue, availableChains);
  const chain = normalizeTokenChain(chainValue);
  if (!chain || !availableChains.includes(chain)) {
    return preferences;
  }

  const isEnabled = preferences.enabledChains.includes(chain);
  if (isEnabled && preferences.enabledChains.length === 1) {
    return preferences;
  }

  const enabledChains = isEnabled
    ? preferences.enabledChains.filter((item) => item !== chain)
    : [...preferences.enabledChains, chain];
  return normalizeChainFilterPreferences({
    ...preferences,
    enabledChains,
  }, availableChains);
}

export function toggleTokenChainForSurface(
  preferencesValue: unknown,
  availableValue: unknown,
  surface: ChainFilterSurface,
  chainValue: unknown,
): ChainFilterPreferences {
  const availableChains = normalizeAvailableTokenChains(availableValue);
  const preferences = normalizeChainFilterPreferences(preferencesValue, availableChains);
  const chain = normalizeTokenChain(chainValue);
  if (!chain || !preferences.enabledChains.includes(chain)) {
    return preferences;
  }

  const selection = preferences[surface];
  const isSelected = selection.includes(chain);
  if (isSelected && selection.length === 1) {
    return preferences;
  }

  return normalizeChainFilterPreferences({
    ...preferences,
    [surface]: isSelected
      ? selection.filter((item) => item !== chain)
      : [...selection, chain],
  }, availableChains);
}

export function isTokenChainSelectedForSurface(
  preferences: ChainFilterPreferences,
  surface: ChainFilterSurface,
  chainValue: unknown,
) {
  const chain = normalizeTokenChain(chainValue);
  return Boolean(
    chain
    && preferences.enabledChains.includes(chain)
    && preferences[surface].includes(chain),
  );
}

export function filterItemsByChainSelection<T extends { chain?: unknown }>(
  items: readonly T[],
  preferences: ChainFilterPreferences,
  surface: ChainFilterSurface,
) {
  return items.filter((item) => (
    isTokenChainSelectedForSurface(preferences, surface, item.chain)
  ));
}

export function filterItemsByEnabledChains<T extends { chain?: unknown }>(
  items: readonly T[],
  preferences: ChainFilterPreferences,
) {
  return items.filter((item) => {
    const chain = normalizeTokenChain(item.chain) ?? 'solana';
    return preferences.enabledChains.includes(chain);
  });
}

export function hasEnabledChainCapability(
  preferences: ChainFilterPreferences,
  readiness: WorkspaceChainReadinessMap,
  capability: WorkspaceChainCapability,
) {
  return preferences.enabledChains.some((chain) => readiness[chain]?.capabilities[capability] === true);
}

export function getUnavailableChainCapabilityNotice(
  preferences: ChainFilterPreferences,
  readiness: WorkspaceChainReadinessMap,
  capability: WorkspaceChainCapability,
) {
  if (hasEnabledChainCapability(preferences, readiness, capability)) {
    return null;
  }
  const selected = preferences.enabledChains
    .map((chain) => readiness[chain])
    .filter((item): item is WorkspaceChainReadiness => Boolean(item));
  const syncing = selected.find((item) => item.status === 'syncing');
  return syncing?.message
    || selected[0]?.message
    || 'Data for the selected blockchain is unavailable.';
}

export function requireTokenChain(value: unknown): TokenChain {
  const raw = String(value || '').trim();
  const chain = normalizeTokenChain(value);
  if (!chain) {
    if (!raw) {
      throw new Error('Token chain is required');
    }
    throw new Error(`Unsupported token chain: ${raw}`);
  }
  return chain;
}

export function normalizeTokenAddress(chainValue: unknown, addressValue: unknown) {
  const chain = requireTokenChain(chainValue);
  const rawAddress = String(addressValue || '').trim();
  if (!rawAddress) {
    throw new Error('Token address is required');
  }

  if (EVM_TOKEN_CHAINS.has(chain)) {
    if (!EVM_ADDRESS_RE.test(rawAddress)) {
      throw new Error(`Invalid ${chain} token address`);
    }
    return rawAddress.toLowerCase();
  }
  if (!SOLANA_ADDRESS_RE.test(rawAddress)) {
    throw new Error('Invalid solana token address');
  }
  return rawAddress;
}

export function createTokenIdentity(chainValue: unknown, addressValue: unknown): TokenIdentity {
  const chain = requireTokenChain(chainValue);
  const address = normalizeTokenAddress(chain, addressValue);
  return Object.freeze({ chain, address, key: `${chain}:${address}` });
}

export function createLegacyCompatibleTokenIdentity(
  chainValue: unknown,
  addressValue: unknown,
): TokenIdentity {
  const chain = String(chainValue || '').trim() ? requireTokenChain(chainValue) : 'solana';
  return createTokenIdentity(chain, addressValue);
}

export function buildTokenIdentityKey(chainValue: unknown, addressValue: unknown) {
  return createTokenIdentity(chainValue, addressValue).key;
}

export function parseTokenIdentityKey(value: unknown): TokenIdentity {
  const key = String(value || '').trim();
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error('Invalid token identity key');
  }
  return createTokenIdentity(key.slice(0, separator), key.slice(separator + 1));
}

export function normalizeStoredTokenIdentityKeys(
  value: unknown,
  legacyChainValue: unknown = 'solana',
) {
  if (!Array.isArray(value)) return [];
  const legacyChain = requireTokenChain(legacyChainValue);
  const keys = new Set<string>();
  for (const item of value) {
    try {
      let identity: TokenIdentity;
      if (typeof item === 'string') {
        identity = item.includes(':')
          ? parseTokenIdentityKey(item)
          : createTokenIdentity(legacyChain, item);
      } else if (item && typeof item === 'object') {
        const stored = item as { key?: unknown; chain?: unknown; address?: unknown };
        identity = typeof stored.key === 'string' && stored.key.includes(':')
          ? parseTokenIdentityKey(stored.key)
          : createLegacyCompatibleTokenIdentity(stored.chain ?? legacyChain, stored.address);
      } else {
        continue;
      }
      keys.add(identity.key);
    } catch (_) {
      // Ignore corrupt persisted entries without weakening canonical runtime identity.
    }
  }
  return [...keys];
}

export function buildTokenExplorerUrl(chainValue: unknown, addressValue: unknown): string | null {
  const chain = normalizeTokenChain(chainValue);
  if (!chain) {
    return null;
  }
  let address: string;
  try {
    address = normalizeTokenAddress(chain, addressValue);
  } catch (_) {
    return null;
  }

  if (chain === 'solana') {
    return `https://solscan.io/token/${encodeURIComponent(address)}`;
  }
  if (chain === 'robinhood') {
    return `https://robinhoodchain.blockscout.com/address/${encodeURIComponent(address.toLowerCase())}`;
  }
  return null;
}

function getApprovedTokenMarketUrl(chain: TokenChain, value: unknown) {
  if (chain !== 'solana') return null;
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
      return null;
    }
    const approved = SOLANA_MARKET_URL_POLICIES.some((policy) => (
      url.origin === policy.origin && policy.pathname.test(url.pathname)
    ));
    return approved ? url.href : null;
  } catch (_) {
    return null;
  }
}

export function buildTokenMarketUrl(
  chainValue: unknown,
  addressValue: unknown,
  pairUrlValue?: unknown,
): string | null {
  const chain = normalizeTokenChain(chainValue);
  if (!chain) return null;
  const approvedPairUrl = getApprovedTokenMarketUrl(chain, pairUrlValue);
  if (approvedPairUrl) return approvedPairUrl;
  try {
    const address = normalizeTokenAddress(chain, addressValue);
    return chain === 'solana'
      ? `https://dexscreener.com/solana/${encodeURIComponent(address)}`
      : null;
  } catch (_) {
    return null;
  }
}

export function supportsConfiguredTradeTerminals(chainValue: unknown) {
  return normalizeTokenChain(chainValue) === 'solana';
}
