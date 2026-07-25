import type { ManualTokenEntry } from '../../state/app-state';
import { buildTokenIdentityKey, normalizeTokenChain } from '../../utils/token-chain';
import { buildTokenIdentityBadgeGroup } from '../token-chain-badge';
import { buildTickerPeerBadge } from './monitored-section';

/**
 * Hydrates the identity badge placeholders emitted by the radar token rows.
 * Rows are rendered as HTML strings, so the ticker peer panel — which is built
 * with DOM APIs and shared with the monitored list — is attached afterwards.
 */
export function bindRadarIdentityBadges(section: ParentNode, tokens: ManualTokenEntry[]) {
  const placeholders = section.querySelectorAll<HTMLElement>('[data-radar-identity-badges]');
  if (placeholders.length === 0) {
    return;
  }

  const tokensByIdentity = new Map(tokens.map((token) => [
    buildTokenIdentityKey(normalizeTokenChain(token.chain) || 'solana', token.address),
    token,
  ]));

  for (const placeholder of placeholders) {
    const address = placeholder.dataset.address;
    if (!address) {
      continue;
    }
    const chain = normalizeTokenChain(placeholder.dataset.chain) || 'solana';
    const token = tokensByIdentity.get(buildTokenIdentityKey(chain, address));
    placeholder.replaceChildren(
      buildTokenIdentityBadgeGroup(buildTickerPeerBadge(token?.tickerPeers, chain, address), chain, address),
    );
  }
}
