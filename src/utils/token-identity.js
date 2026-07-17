const TOKEN_CHAINS = Object.freeze(['solana', 'ethereum', 'bsc', 'base', 'robinhood']);
const EVM_CHAINS = new Set(['ethereum', 'bsc', 'base', 'robinhood']);
const CHAIN_ALIASES = Object.freeze({ sol: 'solana', eth: 'ethereum' });
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function normalizeTokenChain(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const chain = CHAIN_ALIASES[raw] || raw;
  if (!chain) throw new Error('Token chain is required');
  if (!TOKEN_CHAINS.includes(chain)) throw new Error(`Unsupported token chain: ${raw}`);
  return chain;
}

function normalizeTokenAddress(chainValue, addressValue) {
  const chain = normalizeTokenChain(chainValue);
  const address = String(addressValue ?? '').trim();
  if (!address) throw new Error('Token address is required');
  if (EVM_CHAINS.has(chain)) {
    if (!EVM_ADDRESS_RE.test(address)) throw new Error(`Invalid ${chain} token address`);
    return address.toLowerCase();
  }
  if (!SOLANA_ADDRESS_RE.test(address)) throw new Error('Invalid solana token address');
  return address;
}

function createTokenIdentity(chainValue, addressValue) {
  const chain = normalizeTokenChain(chainValue);
  const address = normalizeTokenAddress(chain, addressValue);
  return Object.freeze({ chain, address, key: `${chain}:${address}` });
}

function tokenIdentityKey(chainValue, addressValue) {
  return createTokenIdentity(chainValue, addressValue).key;
}

function parseTokenIdentityKey(value) {
  const key = String(value ?? '').trim();
  const separator = key.indexOf(':');
  if (separator <= 0 || separator === key.length - 1) throw new Error('Invalid token identity key');
  return createTokenIdentity(key.slice(0, separator), key.slice(separator + 1));
}

module.exports = {
  EVM_CHAINS,
  TOKEN_CHAINS,
  createTokenIdentity,
  normalizeTokenAddress,
  normalizeTokenChain,
  parseTokenIdentityKey,
  tokenIdentityKey,
};
