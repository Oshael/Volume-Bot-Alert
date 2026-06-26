# Multichain Data Sources — Helius Equivalents for BASE / BSC / ETH (and other EVM)

## Purpose
Mapping of where to source token/market/on-chain data for chains other than Solana, framed as "what is the equivalent of Helius" for EVM networks. Use this when planning the multichain expansion of the bot.

---

## Context: what the bot uses today (Solana) and the role of each piece

There are **3 data layers** the bot consumes. "Equivalent of Helius" means different things in each layer:

| Layer | Solana today | What it provides |
|---|---|---|
| **A. Market / DEX** | DexScreener (`src/services/dexscreener.js`) | price, volume, mcap, pairs, discovery |
| **B. Launchpad / new tokens** | PumpFun/PumpPortal WS (`pumpfun-ws.js`) + GMGN trending | new tokens before DEX, migrations |
| **C. On-chain enrichment / structural risk** | **Helius** (`helius.js` + `token-risk-enrichment-worker.js`) | holder count, top-holder concentration, mint authority, freeze authority |

The piece commonly called "Helius" is **Layer C**. In the code it is the only layer **hard-coded to Solana** — the worker calls `helius.getAsset`, `getTokenAccounts`, `getTokenSupply`, `getTokenLargestAccounts` directly.

Good news:
- **DexScreener is already multichain** — `dexscreener.js` already accepts `chain` as a parameter (just pinned to `'solana'` in the catalog flow). Enabling BASE/BSC/ETH there is almost just passing the `chainId`.
- **GMGN is also multichain** (Solana, Base, ETH, BSC, Tron) — `gmgn-client` could pull trending from those networks.
- What truly **does not exist** for EVM today is the Helius equivalent (Layer C) and the PumpFun equivalent (Layer B).

Important nuance: on Solana, "mint authority" and "freeze authority" are native token properties. In the EVM world **there is no native equivalent** — the equivalent is *contract analysis* (can the contract mint more? can it pause/blacklist transfers? does it have a proxy/upgrade? is it a honeypot?). So in Layer C, EVM splits into **two** sub-services: holder data **and** contract security.

---

## Equivalence map by layer (Helius → EVM)

What Helius does in a single call, in EVM you assemble with 2 provider types:

| Helius function (Solana) | EVM equivalent — holder data | EVM equivalent — security / authority |
|---|---|---|
| `getTokenAccounts` (holder count) | Moralis, Covalent/GoldRush, Bitquery, Alchemy | — |
| `getTokenLargestAccounts` (concentration) | Moralis, Covalent, Bitquery | — |
| `getTokenSupply` | any RPC (`totalSupply()`) | — |
| mint authority | — | GoPlus (`is_mintable`), QuickIntel |
| freeze authority | — | GoPlus (`transfer_pausable`, `is_blacklisted`, `can_take_back_ownership`) + honeypot check |

---

## Summary per blockchain

### BASE (Coinbase L2, OP Stack)

- **Market / DEX:** DexScreener (`chainId=base`). Main pairs on Aerodrome and Uniswap V3.
- **Launchpad / new tokens (PumpFun equivalent):** the most active "pump culture" ecosystem in EVM today:
  - **Clanker** (deploy via Farcaster) — has API
  - **Virtuals Protocol** (AI agents) — public API
  - **flaunch**, **ape.store**, **Zora** (coins)
  - No single canonical WS like PumpPortal; usually monitored via DEX discovery + indexer.
- **On-chain enrichment (Helius equivalent):**
  - RPC: **Alchemy** (native, mature Base support), QuickNode, Ankr, dRPC, Base PublicNode
  - Holders/concentration: **Moralis**, **Covalent (GoldRush)**, **Bitquery**
  - Contract security: **GoPlus Security** (covers Base), **Honeypot.is**, **De.Fi Scanner**
- **Explorer API:** Basescan (Etherscan family, same V2 multichain API key).

### BSC (BNB Smart Chain)

- **Market / DEX:** DexScreener (`chainId=bsc`). Pairs on PancakeSwap V2/V3.
- **Launchpad / new tokens:** **four.meme** is the "PumpFun of BSC" (dominant), plus PancakeSwap's own launchpad. four.meme has an observable feed/API.
- **On-chain enrichment:**
  - RPC: **QuickNode**, **Ankr**, **Chainstack**, **NodeReal/BNB48**, dRPC, BSC PublicNode (Alchemy historically had weaker BSC support — confirm before committing to it)
  - Holders/concentration: **Moralis**, **Covalent**, **Bitquery**
  - Contract security: **GoPlus** (BSC is where GoPlus is strongest — it was born there), **Honeypot.is**, **TokenSniffer** — critical here, BSC has a very high honeypot/scam rate.
- **Explorer API:** BscScan.

### Ethereum (L1)

- **Market / DEX:** DexScreener (`chainId=ethereum`). Uniswap V2/V3/V4.
- **Launchpad / new tokens:** smaller "pump" culture; new tokens appear directly via DEX (Uniswap) or platforms like Zora. Discovery here is more "via DexScreener boosts/profiles" than via launchpad WS.
- **On-chain enrichment:**
  - RPC: **Alchemy** (most mature), **Infura**, **QuickNode**, Ankr, dRPC — all have ready-made "Token API" (balances, holders, transfers), Helius DAS style.
  - Holders/concentration: **Moralis**, **Covalent**, **Bitquery**, **The Graph**
  - Security: **GoPlus**, **Honeypot.is**, **De.Fi**, **TokenSniffer**
- **Explorer API:** Etherscan.
- **Caveat:** L1 gas/latency are high; the rate of "new tokens" is lower — may not justify the same aggressive polling as the catalog-worker.

### "ETC" / other EVM (Arbitrum, Optimism, Polygon, Avalanche, etc.)

Everything below is **the same EVM stack** — once you support Base/BSC/ETH, adding these is swapping `chainId` + RPC endpoint:
- **Market:** DexScreener covers all (`arbitrum`, `optimism`, `polygon`, `avalanche`…).
- **RPC/holders:** Alchemy/QuickNode/Moralis/Covalent cover the whole set.
- **Security:** GoPlus covers ~20 EVM chains with the same API.

---

## Multichain "wildcard" providers (one integration, many networks)

Instead of integrating provider per chain, you can cover almost everything with a few:

| Provider | Covers | Maps in architecture to |
|---|---|---|
| **Moralis** | ETH, Base, BSC, Polygon, Arbitrum, Optimism, Avax (and Solana) | Helius (holders, balances, metadata, transfers) — the **closest thing to an "EVM Helius"** |
| **Covalent / GoldRush** | 100+ EVM chains | holders + concentration + history |
| **Bitquery** | multichain (EVM + Solana) GraphQL | discovery + trades + holders |
| **GoPlus Security** | ~20 EVM + Solana | the "authority/risk" part of enrichment (mint/freeze/honeypot/blacklist) |
| **Alchemy / QuickNode** | most EVM L1/L2 | RPC + Token API (base layer) |
| **DexScreener** | practically all | already your market layer |
| **GMGN** | Sol, Base, ETH, BSC, Tron | already your trending source |

**Minimum recommended combo to go multichain:** DexScreener (already have) + **Moralis** (EVM holders/concentration) + **GoPlus** (EVM security/authority). These last two together cover what Helius does today on Solana.

---

## What we would need to do in the code (concrete)

1. **Make `chainId` a first-class axis in the catalog.** Today `dexscreener.js` accepts `chain` but the flow pins `'solana'`. Needs: `chain` column in `token_catalog`, propagate chain through the catalog-worker and buckets, and the DexScreener batch already supports `/tokens/v1/{chainId}/{addresses}`.

2. **Abstract Layer C (enrichment) behind a per-chain interface.** Today `token-risk-enrichment-worker.js` calls `helius` directly. Ideal: a *provider registry*: `getEnrichmentProvider(chain)` → `helius` for `solana`, `moralis+goplus` for EVM. The reason codes (`mint authority`, `freeze authority`) become a generic "contract risk" model (mintable, pausable, blacklist, proxy, honeypot) in the EVM case.

3. **Address validation is already half-EVM-aware** — the frontend already accepts `0x` + 40 hex. But the GMGN auto-block/risk rules are heavily calibrated for Solana patterns (suffixes `pump`/`bags`/`brrr`, etc.) — would need a parallel rule set per chain.

4. **Launchpad (Layer B) is the biggest new work:** there is no universal PumpPortal. For Base/BSC it would mean integrating four.meme, Clanker, Virtuals individually — or simply **giving up pre-DEX discovery on EVM** and relying only on DexScreener discovery + GMGN trending (much lower-effort path for an MVP).

5. **Meteora (TVL) → EVM equivalent:** Uniswap V3 / Aerodrome / PancakeSwap V3 have concentrated liquidity with TVL via subgraph (The Graph) or DefiLlama. Only relevant if you want to keep the "Bid Zone"/TVL feature on the other chains.

---

## Quick reference: relevant code touch points

- `src/services/dexscreener.js` — already chain-parameterized (`isPairOnRequestedChain`, `getBestPair`, batch by `chainId`); flow pins `solana`.
- `src/services/token-risk-enrichment-worker.js` — hard-coded to `helius` (Solana-only). Primary refactor target for EVM enrichment.
- `src/services/helius.js` — the Solana on-chain provider abstraction (`getAsset`, `getTokenAccounts`, `getTokenSupply`, `getTokenLargestAccounts`).
- `src/services/gmgn-*` — GMGN trending; already multichain-capable upstream.
- `config/index.js` — `TOKEN_GATE_CHAIN`, `TOKEN_GATE_RPC_PROVIDER` (`helius`), `GMGN_CHAIN` defaults.
