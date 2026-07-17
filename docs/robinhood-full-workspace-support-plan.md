# Robinhood Full Workspace Support Plan

Status: in progress (Blocks 1-6 complete)

Created: 2026-07-14

## Objective

Make the global chain selector truthful across the entire user workspace. When
Robinhood-only is selected, generic token surfaces must load Robinhood data and
must not leak Solana tokens. In combined mode, the same surfaces must preserve
chain identity and render both networks without address collisions.

This plan is intentionally separate from
`docs/robinhood-chain-onchain-monitoring-plan.md`. The on-chain plan establishes
ingestion, signal safety and publication. This document covers the missing
product/read-model layer required to use Robinhood throughout the bot.

In this document, **alert delivery** means turning an approved signal into a
user-visible event in the feed/socket/delivery channels. The existing code and
historical plan sometimes call that gate `publishable`; it does not mean
publishing code or making data public. Historical V2-only rollout notes remain
evidence of what was tested at that time, not the target alert semantics. This
plan supersedes them for the multiprotocol read and alert model.

## Fixed constraints

- Robinhood runner/writer changes require evidence that the ingestion boundary
  itself must change; they are allowed, but external metadata calls must remain
  outside the swap-processing critical path.
- Do not edit `.env.example`.
- Preserve the existing dirty worktree and review overlapping diffs before each
  patch.
- Aggregate volume, swaps and transactions by token across every accepted V2,
  V3 and V4 market; never evaluate or render protocol-isolated token totals.
- Evaluate and deliver at most one Robinhood volume signal per token/window,
  while preserving a per-protocol and per-market breakdown for observability.
- Until V3/V4 liquidity USD is implemented, liquidity coverage is explicitly
  partial and does not block an otherwise valid aggregate volume signal.
- Never substitute the V2 liquidity estimate for total token liquidity or
  convert the V3/V4 raw liquidity scalar into USD.
- Keep legacy accounts and stored preferences backward compatible.
- Every persisted or in-memory token identity must be `(chain, address)`, never
  address alone.
- Solana-native features must not be presented as Robinhood-compatible unless a
  real Robinhood implementation exists.

## Important points

1. The alert-delivery gate (`publishable` in the existing code) is not an
   environment flag. `ROBINHOOD_ALERTS_ENABLED=true` requests activation, while
   effective delivery is derived from live coverage, heartbeat, gaps and
   rollout gates.
2. A restart can temporarily make Robinhood non-publishable while the market
   cursor backfills. The UI needs an explicit syncing state instead of falling
   back to Solana data.
3. Raw Robinhood ingestion and dashboard visibility are different contracts.
   At the time of this inventory, raw tables contained thousands of Robinhood
   tokens, while `token_catalog` contained zero Robinhood rows because catalog
   staging was blocked during backfill.
4. The current signal repository emits one candidate per market and the matcher
   rejects every protocol except V2. That is incorrect for token-level volume:
   active tokens can concentrate nearly all activity in V3/V4.
5. Simply changing `WHERE chain = 'solana'` to a dynamic parameter would still
   be incorrect. Robinhood metrics live in dedicated observations/buckets and
   have different completeness and eligibility semantics.
6. Pump.fun, Meteora and GMGN are Solana-native. Full workspace support means
   hiding or clearly disabling those capabilities in Robinhood-only mode, not
   fabricating Robinhood URLs or data.
7. The existing trading-terminal list is Solana-specific. Robinhood links must
   use a verified EVM-compatible destination; unsupported terminals must be
   omitted per token.
8. Liquidity completeness and volume completeness are separate facts. Missing
   V3/V4 liquidity USD must be visible, but it must not discard their accepted
   volume, swaps, transactions, price or FDV.

## Current evidence

### Runtime snapshot after restart

- discovery stream: caught up;
- market stream: backfilling, with lag falling from 595 to 219 blocks during
  observation;
- unexplained gaps: zero;
- Robinhood catalog staging worker: healthy, but blocked with
  `rollout_not_publishable`;
- Robinhood `token_catalog` rows: zero at the observed time;
- raw accepted observations included V2, V3 and V4 activity.

### Multiprotocol token evidence

For CASHCAT (`0x020b...18b4`), a one-hour local snapshot on 2026-07-14
contained 3 V2 swaps, 2,604 V3 swaps and 1,971 V4 swaps. V2 represented only
USD 0.14 of roughly USD 2.60 million accepted volume. A V2-only token row or
alert would therefore be materially wrong even though ingestion was healthy.

This explains why the legacy V2-only staging/delivery path did not represent
the actual token market, but it does not explain away the UI problem: the
panels below are independently hardcoded to Solana.

### Product gaps confirmed in code

| Surface | Current contract | Required contract |
| --- | --- | --- |
| Alert Feed | Chain-aware and filters by `alertFeedChains` | Preserve; add readiness UX |
| Radar recent/old | Chain-aware request/filter foundation | Complete Robinhood history/read model |
| Monitored | Server queries and client collections are Solana-only | Chain-aware query, pagination, sorting and pins |
| Best Performance | Server ranking is Solana-only | Per-chain candidate source and combined ranking |
| Manual Tokens | Routes default to Solana and client stores addresses only | Chain-aware CRUD, folders, metadata and rendering |
| Starred | Model supports chain, config/client contract is legacy Solana | Chain-aware API and identity collections |
| Blocklist | Model supports chain, config/client contract is legacy Solana | Chain-aware API, filtering and actions |
| Monitored pins | Model supports chain, route/client payload loses chain | Chain-aware ordering and deletion |
| Custom alerts | Dashboard routes explicitly force Solana | Chain-aware rule creation and evaluation capability |
| Charts/history | Alert chart has chain fields; generic history remains mixed | Native Robinhood bucket history and identity-aware cache |
| Token actions | Several callbacks accept address only | Pass full token identity through every action |
| Trade/explorer links | Solana terminal URLs are unconditional | Per-chain capability matrix and verified EVM links |
| Mock trading | State and API group by address and quote amounts as SOL | Chain identity plus chain-specific quote/UX, or explicit disable |
| Pump/Meteora/GMGN | Solana-native | Hide/disable in Robinhood-only; preserve in Sol/combined |

## Target architecture

### Canonical identity

All public payloads and client collections that refer to a token must carry:

```json
{
  "chain": "robinhood",
  "address": "0x..."
}
```

Map keys, selections, dismissals and caches must use the existing canonical
identity key (`chain:address`). Address-only arrays may remain only as a legacy
input adapter for Solana; they must not remain the internal source of truth.

### Chain capability contract

The frontend must receive two separate concepts:

- `availableChains`: networks the user may select;
- per-chain readiness/capabilities: whether catalog, history, manual tracking,
  custom alerts, external links and mock trading are ready.

The chain selector must never infer operational readiness solely from
`ROBINHOOD_ALERTS_ENABLED`.

### Robinhood aggregate token read model

Create a read boundary that derives one token row from accepted V2/V3/V4
on-chain data, rather than reusing Solana catalog-worker assumptions. The same
aggregation contract must feed dashboard cards and volume-signal candidates:

- chain and token address;
- deterministic primary market identity and protocol;
- total volume, swaps and transactions summed across all accepted markets;
- per-protocol/per-market contribution breakdown;
- first/last observed timestamps and age;
- current USD price and FDV;
- maximum dashboard freshness of 15 minutes; older tokens are excluded rather
  than presented as current;
- 5m, 1h, 6h and 24h USD volume;
- 1h, 6h and 24h price change when enough baseline exists;
- liquidity value only when its source is approved, plus explicit coverage;
- metadata/social fields with explicit missing states;
- chart series from Robinhood buckets.

For dashboard rows, the primary market supplies current price and FDV and is
selected by highest volume in the 24 hourly ranking buckets, then freshest
observation and `market_key`. The 5m/1h/6h rolling totals are calculated from
1m buckets only after the bounded page is selected; 24h volume, swaps and
transactions use the same 24 aligned hourly buckets as ranking. Every window
still sums every accepted V2/V3/V4 market for the token.
For a volume alert, the primary market is selected by highest contribution in
the evaluated signal window, with the same deterministic tie-breakers. This
keeps the alert query bounded without changing its gates. Neither choice limits
token totals: 5m/1h/6h/24h volume and activity always sum V2+V3+V4.

### Robinhood aggregate volume signal

The alert evaluator consumes one candidate per `(chain, token, window)`:

- volume, swaps and transactions are totals across V2/V3/V4;
- protocol/market breakdown remains in the payload;
- price and FDV come from the deterministic primary market;
- liquidity is informational with `coverage=partial` while V3/V4 USD liquidity
  is unavailable, and is not a required gate during that period;
- blocklist, token eligibility, age, volume and transaction gates remain;
- HVNC accepts only tokens discovered in the last 5 minutes and applies each
  active user's `hvnc-min-vol` to the aggregate V2+V3+V4 five-minute volume;
- matcher, dedupe and delivery operate on token identity, not market identity.

## Execution blocks

Each block is expected to stay near 150-300 changed lines. If a block grows
beyond roughly 350 lines, split it before continuing.

### Block 1 - Truthful readiness and no cross-chain leakage

Completed: 2026-07-14

Implemented in three bounded cuts:

1. backend availability/readiness contract derived from rollout coverage and
   the shared Robinhood ingestion lease, with a short cache and a refresh
   endpoint;
2. master-chain filtering and explicit syncing/unavailable states for
   Monitored, Best Performance, Manual Tokens, Blocklist and the legacy Starred
   surface, including capability-aware mock trading;
3. selector smoke coverage proving that Solana rows disappear from Monitored,
   Best Performance, Manual Tokens and Blocklist in Robinhood-only mode.

At the end of Block 1, the Robinhood readiness contract deliberately kept
generic workspace capabilities disabled even when alert delivery was ready.
Block 5 now enables only Monitored and Best Performance when transport,
persistence and caught-up market coverage are ready. User-owned collections
remain unavailable until Block 6, independently of alert publication.

Validation completed:

- `npm run lint` (no errors; pre-existing complexity warnings remain);
- `npm --prefix frontend run build`;
- affected unit tests: 33 passing;
- config integration: 18 passing;
- `tests/smoke/chain-selector.spec.js`: 3 passing.

Goal: make the current selector safe before expanding data coverage.

- expose Robinhood readiness/capability state alongside availability;
- refresh readiness after restart/backfill;
- filter every generic client selector by enabled chains;
- in Robinhood-only, show syncing/unavailable states instead of Solana rows;
- keep Solana-native panels hidden or explicitly unavailable;
- correct the selector smoke so it asserts Monitored, Best Performance and
  Manual Tokens, not only Alert Feed/Radar.

Acceptance:

- Robinhood-only never displays a Solana token in a generic surface;
- backfill is visible to the user and does not silently fall back;
- Solana-only and combined mode remain backward compatible.

### Block 2 - Robinhood multiprotocol token repository and volume alerts

Completed: 2026-07-14

Goal: provide one bounded token-level source for dashboard cards and volume
alerts without losing activity distributed across protocols or markets.

- query accepted V2/V3/V4 registry, observations and 1m/1h buckets;
- sum 5m/1h/6h/24h volume, swaps and transactions across every market of the
  token, with per-protocol/per-market breakdown;
- select a deterministic primary market by 24h volume, observation freshness
  and `market_key`, only for current price/FDV and price-change baselines;
- return FDV and explicit liquidity value/status/coverage;
- replace per-market signal evaluation with one aggregate candidate per token;
- remove the V2-only matcher restriction and deliver one deduplicated alert per
  token/window;
- enforce the five-minute HVNC token-age ceiling and the per-user
  `hvnc-min-vol` threshold (default USD 300,000) against aggregate V2+V3+V4
  volume before creating each publication intent;
- keep liquidity informational while coverage is partial; do not apply the
  configured minimum-liquidity gate until USD coverage is complete;
- add the indexes only if query plans prove they are required;
- keep statement timeouts and bounded pagination;
- preselect tokens with accepted activity in the last 15 minutes before doing
  the 24h ranking work; do not aggregate the entire inactive registry per page.

Implementation cuts:

1. 2A: aggregate signal repository and bounded multiprotocol query plan;
2. 2B: token-level signal policy, matcher, payload and backward-compatible rule
   identity;
3. 2C: paginated dashboard repository, 5m/1h/6h/24h metrics and primary-market
   price baselines;
4. 2D: focused repository/signal/integration tests and operational validation.

Operational query evidence on 2026-07-14:

- the bounded dashboard query preselected 63 tokens with accepted activity in
  the last 15 minutes and returned a five-token page in approximately 4.7s
  under local database disk pressure, below its 10s statement timeout;
- CASHCAT was returned once with V3 as primary, 29 contributing markets and
  aggregate V2/V3/V4 totals;
- materially lower cold-query latency would require a maintained token/hour
  aggregate and therefore a writer/schema expansion. That was outside Block
  2's scope, but may be considered later with write-amplification evidence.

Acceptance:

- repository returns one live Robinhood row per token without using Solana
  tables;
- CASHCAT-like activity split across V2/V3/V4 produces the summed token volume;
- no protocol or market can create a duplicate alert for the same token/window;
- the default candidate bound is 1,000 (685 distinct active tokens were
  observed in a real 5m window), and approved intents are delivered
  sequentially in batches of at most 500;
- alert payload exposes total metrics and their protocol breakdown;
- partial liquidity is explicit and does not suppress the aggregate signal;
- stale/incomplete candidates are excluded with observable reasons;
- V3/V4 raw liquidity is never mislabeled as liquidity USD.

Validation completed:

- 106 affected unit tests passing, including aggregate math, cursor bounds,
  partial liquidity, V3/V4 alert matching, dedupe and 500-intent batching;
- Robinhood alert publication integration passing against PostgreSQL;
- runtime schema check passing and both Stage 70 indexes confirmed in
  `pg_indexes`;
- full repository lint with zero errors and no warning in files changed by
  this block (25 pre-existing complexity warnings remain elsewhere);
- real 5m aggregate query returned 684 candidates in approximately 1.0s under
  the new 1,000-candidate bound, without truncation.

No frontend file changed in Block 2, so the frontend build requirement was not
triggered again after the successful Block 1 build.

### Block 3 - Robinhood catalog and metadata projection

Goal: make dashboard metadata independent from an alert firing at that moment.

- separate dashboard projection eligibility from aggregate alert-delivery
  eligibility;
- reuse ERC-20/social metadata services in a projection worker; do not execute
  external metadata requests in the swap-processing critical path;
- project bounded active multiprotocol token identities to the shared
  catalog/read cache;
- preserve `robinhood-staged` semantics for alert candidates;
- define retention/demotion for inactive Robinhood dashboard rows.

Acceptance:

- active Robinhood dashboard tokens can have symbol/name/image without first
  emitting a user alert;
- metadata projection does not alter the aggregate signal gates from Block 2;
- projection is idempotent by `(chain, address)`.

Completed: 2026-07-14.

Implementation:

- added an independent catalog projection worker with its own lease, bounded
  10-second interval, concurrency, error backoff and administrative telemetry;
- selected active identities from the token-level V2/V3/V4 aggregate read
  model over the last 15 minutes, using the exact request instant for catalog
  discovery while retaining minute-aligned windows for alert evaluation;
- made the Robinhood read model, rather than `token_catalog` activation state,
  authoritative for dashboard entry and exit. A token enters after its accepted
  swap is committed and exits on the first read after 15 minutes without one;
- projected price, FDV, primary protocol and honest partial liquidity into
  `token_catalog`, always monitor-ineligible and keyed by `(chain, address)`;
- kept the alert-driven `robinhood-staged` state intact while allowing the
  dashboard projection to refresh or demote the same identity idempotently;
- excluded administratively blocked tokens before catalog writes and demoted
  inactive on-chain rows after the same 15-minute freshness boundary;
- reused the ERC-20 metadata reader for symbol/name, added the official
  Robinhood Blockscout as the primary image source and retained DexScreener as
  a low-priority fallback for missing images, website, Twitter and community;
- bounded Blockscout enrichment to 10 active tokens per 10-second cycle, in
  the volume order supplied by the aggregate read model;
- limited DexScreener fallback to one batch of at most five tokens per minute.
  Each batch prioritizes tokens whose Blockscout image is absent, then orders
  them by aggregate 15-minute volume descending and address deterministically;
- persisted positive and negative Blockscout/DexScreener check timestamps so
  unavailable metadata is not requested on every 10-second projection cycle;
- added `token_catalog.last_website_url`, keeping project websites separate
  from pair/trading URLs;
- moved ownership of optional social metadata work from ingestion startup to
  the projection worker. The ingestion runner is now started with that legacy
  queue disabled, so external metadata calls remain outside swap processing.

Real validation evidence:

- the lightweight full projection selected 956 active multiprotocol tokens in
  approximately 1.78 seconds, projected all 956 without truncation or write
  errors and demoted 21 stale rows;
- a bounded live ERC-20 sample resolved symbol/name for 100 of 100 tokens;
- the local catalog contained 1,007 Robinhood on-chain rows after validation,
  including 127 V2, 717 V3 and 163 V4 primary markets, while preserving 78
  alert-staged identities;
- live Blockscout validation returned full basic metadata and an image for
  CASHCAT. WOOD and IF returned name/symbol but no image, proving why the
  bounded DexScreener fallback remains necessary;
- the exact active-token read returned 848 tokens without truncation in
  approximately 1.81 seconds. A 50-token dashboard page took approximately
  6.36 seconds and included activity 18 seconds before its exact snapshot;
- 126 affected unit/contract tests and 59 administrative integration tests
  passed; the runtime schema check passed;
- full repository lint completed with zero errors and no warning in files
  changed by this block (25 pre-existing complexity warnings remain elsewhere).

Pontos importantes:

1. Block 3 makes Robinhood identities and metadata available to the shared
   catalog, but the Monitored and Best Performance APIs remain Solana-only
   until Block 4 wires their reads explicitly.
2. Projected Robinhood rows remain `eligible_for_monitoring=false` and
   `is_active_monitor_candidate=false`. This prevents the Solana catalog worker
   from treating projection as signal approval; Robinhood alerts continue to
   use the aggregate V2/V3/V4 path completed in Block 2.
3. The 15-minute freshness rule is evaluated from accepted swap time at read
   time, without waiting for the 10-second metadata cycle. `token_catalog`
   demotion remains maintenance state and is not the product activity source.
4. Symbol/name normally arrive within the next 10-second metadata cycle for a
   new token when there is no metadata backlog. Previously stored metadata is
   retained across inactivity. Images may arrive from Blockscout later;
   DexScreener links and fallback images can take longer because Robinhood is
   capped at five tokens per minute.
5. The projection worker starts only where the Robinhood ingestion runtime
   gate is allowed, but it has its own lease and failures do not stop or delay
   swap ingestion.
6. Robinhood and Solana still share the external DexScreener quota. The strict
   Robinhood budget, Blockscout-first policy and throttle pause reduce that
   competition; they do not make the external quota independent.
7. The exact dashboard query is currently correct but measured 6.36 seconds
   for 50 rows. Block 4 must preserve exact activity while optimizing the API
   path; it must not reintroduce minute rounding as a performance shortcut.

### Block 4 - Monitored and Best Performance APIs

Goal: make the two currently visible Solana-only panels truly chain-aware.

- accept validated `chains` on monitored/top-performer endpoints;
- route Solana to the existing catalog query and Robinhood to the new read
  repository;
- keep valuation filters explicit and independent: `minMcap` applies only to
  Solana market cap and `minFdv` applies only to Robinhood FDV; both default to
  USD 30,000, and Robinhood FDV must never be copied into the market-cap field;
- define combined pagination and deterministic sort ordering;
- include chain in cache keys and invalidate per chain;
- make pinned monitored rows chain-aware;
- prevent address-only deletion or reorder payloads.

Acceptance:

- Robinhood-only returns only Robinhood rows;
- combined mode can show both chains without collision;
- totals, pagination and sorting match the selected chain set.

Implemented backend contract:

1. `GET /api/dashboard/monitored` and
   `GET /api/dashboard/top-performers` accept a single chain, comma-separated
   chains, repeated query parameters or a JSON array. Missing `chains` remains
   the bounded legacy Solana default until the frontend migration in Block 5.
2. `minMcap` filters only Solana market cap and `minFdv` filters only Robinhood
   FDV. Both default to USD 30,000. Robinhood responses always expose
   `mcap: null`, `fdv: <value>` and `liquidityUsd: null`, including pinned rows.
3. Robinhood active membership and exact five-minute volume are read directly
   from the last 15 minutes of V2/V3/V4 buckets. The 1h/6h/24h windows and
   price changes use the projection updated about every ten seconds; this keeps
   entry/exit immediate without restoring the previous 6.36-second page read.
4. Combined monitored pagination loads the complete eligible Solana set and
   complete active Robinhood set, deduplicates by `(chain,address)`, sorts the
   union and only then slices the requested page. Stable tie-breakers are token
   age, chain-specific valuation, chain and address.
5. The existing `mcap` sort name is retained for frontend compatibility. Its
   value is explicitly chain-specific: market cap for Solana and FDV for
   Robinhood. This affects ordering only; the two minimum filters remain
   independent and response valuation types remain explicit. This shared
   numeric ordering was explicitly approved because monitored discovery is
   primarily volume-driven and the two network valuations are sufficiently
   comparable for this secondary/manual sort.
6. Top performers are ranked from the union candidate pool with global
   cumulative distributions. The implementation does not merge already-ranked
   per-chain top lists. Cache entries include the ordered chain set,
   `minMcap`, `minFdv`, volume floor and limit, and can be invalidated by chain.
7. Pins persist and query by `(chain,address)`. A legacy address-only payload is
   interpreted as Solana only; Robinhood create/delete/reorder operations must
   carry an explicit chain. Replacing one selected chain does not clear pins
   belonging to an unselected chain.

Validation snapshot on 2026-07-14:

- the active Robinhood read returned 321 rows above the USD 30,000 FDV floor in
  1.23 seconds, with zero non-null market-cap or liquidity fields;
- combined monitored pagination returned an exact total of 798, both chains in
  the first 30 rows and completed in 1.35 seconds;
- the combined top query completed in 0.72 seconds. Robinhood-only currently
  has no row passing both the existing USD 200,000 24h volume floor and positive
  24h price-change rule because a sufficient 24h baseline is not yet present;
  the rule was intentionally not weakened.

### Block 5 - Frontend canonical identity migration

Completed: 2026-07-14

Goal: remove address-only assumptions from generic workspace state.

- migrate manual, monitored, pinned, starred, blocklist and top-performer
  collections to token identities;
- pass chain through generic state lookup, request caches, search, panel counts
  and monitored-pin actions;
- keep manual/star/block/custom-alert/trading mutations unavailable on
  Robinhood until their owning blocks implement chain-aware persistence;
- reload affected panels when the master selector changes;
- maintain a bounded legacy Solana adapter for stored local state;
- prevent stale Solana results from winning a Robinhood request race.

Acceptance:

- the same textual address on different chains cannot collide;
- chain switching refetches and rerenders every affected surface;
- refresh preserves the selected chain and visible rows.

Implemented in four bounded cuts:

1. readiness now exposes Robinhood `monitored` and `topPerformers` only when
   transport and persistence are effective, market coverage is caught up and
   ingestion is not halted. This does not depend on the alert-publication gate;
   manual tokens, starred, blocklist, history, charts and mock trading remain
   disabled;
2. monitored, pinned, manual, top-performer and starred frontend collections
   now store canonical `chain:address` keys. Blocklist entries carry chain and
   all missing legacy chains are interpreted as Solana only. The tracked-token
   store, deduplication and blocked filtering use the same canonical identity;
3. Monitored and Best Performance requests send the ready selected chains plus
   both USD 30,000 valuation filters. Pins carry chain through capture,
   reorder, persist, delete and reset. Request keys and revisions prevent an
   older Solana/combined response or error from overwriting a newer
   Robinhood-only selection;
4. selector changes immediately refetch both market panels. Robinhood rows use
   FDV terminology and chain badges. Solana-only star/manual/block/mock-trading,
   Meteora and sparkline actions are not rendered for Robinhood rather than
   calling a Solana endpoint. Their Robinhood CRUD/chart implementations stay
   in Blocks 6-8.

The local-storage adapter accepts a canonical key, `{chain,address}` or a
legacy raw Solana address, drops corrupt entries and deduplicates the result.
It never guesses that an address is EVM solely from its text.

Validation completed:

- affected unit tests: 19 passing;
- `npm --prefix frontend run build`;
- `tests/smoke/chain-selector.spec.js`: 4 passing, including a delayed stale
  combined response racing a Robinhood-only refresh;
- full `npm run lint`: zero errors and 24 pre-existing complexity warnings;
- smoke assertions confirm `chains`, `minMcap=30000`, `minFdv=30000`, FDV
  rendering and preservation of the newest visible Robinhood rows.

### Block 6 - Manual Tokens, folders, starred and blocklist

Completed: 2026-07-15

Goal: support user-owned Robinhood collections end to end.

- add explicit chain to CRUD payloads and route validation;
- use existing chain columns in user tables;
- make folder items chain-aware in requests and responses;
- bootstrap Robinhood manual metadata through the approved EVM path;
- make starred/block actions identity-aware;
- keep per-user limits explicit (per chain or total) and documented.

Acceptance:

- an EVM token can be added, moved to a folder, starred, blocked and removed;
- operations do not mutate the same-address token on another chain;
- existing Solana collections migrate without data loss.

Implemented in four bounded cuts:

1. config reads now return Solana and Robinhood manual tokens, stars and
   blocklist entries with canonical `(chain,address)` identity. Incremental
   create/delete routes require an explicit chain for Robinhood. The legacy
   full-config replacement remains a Solana-only adapter so an old client
   cannot erase Robinhood collections;
2. manual folders persist and return the item chain. Removing a folder item or
   deleting a folder keeps the existing destructive contract and removes the
   corresponding manual token for that exact identity. Folder deletion also
   returns `removedTokenIdentities`, while preserving the legacy
   `removedTokens` response field;
3. a syntactically valid Robinhood address is saved to `user_tokens`
   immediately. A durable, non-monitor-eligible `token_catalog` identity is
   then ensured with `source=user-manual`; ERC-20, Blockscout and social
   metadata are populated asynchronously by the existing Robinhood projection
   worker, including manual tokens with no active market candidate;
4. frontend collections, forms and actions pass chain explicitly. Manual entry
   exposes a chain selector, stars use incremental mutations instead of a
   destructive full-config sync, block/removal operations target one canonical
   identity, and Solana metadata hydration is never called for a Robinhood
   token.

Limits are enforced independently per user and chain: 200 manual tokens, 500
starred tokens and 500 blocklist entries. User-owned collection capabilities
remain available while Robinhood market coverage is syncing; they are not
gated by alert publication or market backfill.

Validation completed:

- full `npm run lint`: zero errors and the existing 24 complexity warnings;
- `npm --prefix frontend run build`;
- affected unit suites: 43 passing;
- config route integration: 19 passing, including immediate Robinhood save,
  legacy-sync preservation and destructive folder deletion;
- Chromium smoke: 5 passing, including Robinhood manual/star/block payloads.

### Block 7 - History, charts and visible token metrics

Blocked/superseded dependency: implementation must not continue from the
15-minute membership assumptions in this block. Blocks 1–5 of
`docs/workspace-catalog-activity-views-architecture-plan.md` must land first;
its Blocks 7–8 then complete the realtime/history scope described here.

Goal: provide Robinhood-native visual history.

- serve chart series from Robinhood buckets;
- include chain in history routes, request keys and caches;
- handle insufficient history without fabricating zeroes;
- preserve FDV terminology where circulating market cap is unavailable;
- prevent Solana-specific Meteora/bid-zone requests for Robinhood tokens.

Acceptance:

- Robinhood token charts use only Robinhood observations;
- 5m/1h/6h/24h labels reflect available windows honestly;
- no Solana endpoint is called for a Robinhood card.

### Block 8 - Custom alerts, actions and capability-aware links

Goal: make every generic token interaction safe for Robinhood.

- make custom-alert rules carry chain through persistence and evaluation;
- confirm which Robinhood metrics can support each rule before enabling it;
- pass chain through copy, pin, remove, star, block and notification actions;
- add verified Robinhood explorer/market links;
- filter trading terminals by supported chain;
- either implement chain-aware mock trading or disable it for Robinhood with a
  clear explanation; do not label EVM notional as SOL.

Acceptance:

- no action on a Robinhood token targets a Solana identity or URL;
- unsupported features are visibly unavailable rather than broken;
- custom alerts cannot be created for an unsupported metric/window.

### Block 9 - Full smoke, rollout and documentation closure

Goal: prove the assembled behavior and roll it out safely.

- run route integration tests for both chains and combined mode;
- run frontend build and full repository lint;
- run Chromium smoke for Solana-only, Robinhood-only and combined mode;
- exercise add/remove/pin/star/block/manual-folder flows with Robinhood
  identities;
- verify restart/backfill syncing behavior;
- observe heartbeat, lag, gaps, 429s, projection and dashboard query latency;
- update the historical Robinhood plan only after this plan's acceptance gates
  pass.

Acceptance:

- no Solana leakage in Robinhood-only;
- no Robinhood leakage in Solana-only;
- combined mode is identity-safe;
- all supported actions survive reload;
- operational gates remain authoritative.

## Test strategy

Tests should protect contracts, not duplicate every field at every layer.

### Unit

- canonical token identity and legacy Solana adapters;
- capability/readiness normalization;
- Robinhood multiprotocol metric aggregation and primary-market selection;
- combined sorting and pagination tie-breakers;
- per-chain link capability selection.

### Integration

- monitored/top-performer routes for Solana, Robinhood and combined mode;
- manual/folder/star/block/pin persistence keyed by chain;
- custom-alert authorization and chain persistence;
- Robinhood history repository and query bounds;
- any schema/index change through runtime schema checks.

### Smoke/E2E

- selector changes every visible generic surface;
- Robinhood-only loads Robinhood cards and never shows Solana badges;
- combined mode shows both badges;
- one representative user action flow for a Robinhood token;
- restart/backfill renders syncing, then transitions to ready.

## Mandatory validation per implementation block

- run `npm run lint` after editing relevant files;
- run affected tests with `node --test ...`;
- run `npm --prefix frontend run build` for every frontend block;
- run `npm run db:schema-check` for schema/init changes;
- run `npm run test:smoke` for visible assembled flows;
- review `git diff` before proposing any commit;
- keep commits separated by block/scope.

## Completion definition

This plan is complete only when selecting Robinhood-only produces a coherent
Robinhood workspace across all generic token surfaces, user collections,
history and supported actions, while Solana-native capabilities are clearly
scoped and the rollout safety gates remain intact.
