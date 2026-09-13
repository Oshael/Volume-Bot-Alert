# Robinhood Monitored Views and Fixed Layout Architecture Plan

Status: approved for implementation planning

Created: 2026-09-12

## Objective

Replace the current Monitored controls and the separate Best Performance Coins and Manual Tokens surfaces with one
Monitored panel exposing four linear views:

1. `Trending`
2. `Migrated`
3. `Pre-bonded`
4. `Watchlist`

The first functional release is Robinhood Chain-only. Every new identity, read-model, API and UI contract remains keyed
by `(chain,address)` and uses chain adapters so Solana and other chains can be enabled later without adding chain branches
to shared modules.

Replace free horizontal panel resizing with fixed layout presets. Preserve vertical resizing and panel reordering where a
preset has multiple visible panels. Alerts Focus renders a live sparkline backed by the same canonical series as Monitored.

This document is the standalone implementation source of truth. Implementation must not depend on conversation context.

## Approved product decisions

1. Robinhood is the only enabled chain for this release. Solana remains unavailable until an accepted source replaces
   the current Dexscreener-based market-data dependency.
2. New contracts are multi-chain-ready even while only the Robinhood adapters are enabled.
3. Future multi-chain Trending uses one global candidate pool across enabled chains, without equal per-chain quotas or
   per-chain normalization. Tokens with stronger current comparable metrics win regardless of chain.
4. When the user selects one chain, percentiles and ranks use only that chain's candidate pool.
5. Trending returns at most 40 tokens.
6. Best Performance Coins is not a ranking contract to preserve. Its endpoint, cache and rendering infrastructure may be
   reused, but its current selection and score are replaced.
7. Trending score v1 uses 55% volume 24h percentile, 20% volume 5m acceleration percentile, 20% bounded price change 1h
   percentile and 5% bounded price change 6h percentile.
8. Only names meaning “tokens explicitly added by a user” change from Manual Tokens to Watchlist. Unrelated meanings such
   as manual access, manual review and manual refresh do not change.
9. The standalone Manual Tokens surface is removed. The initial Watchlist is a flat list: clicking a token star adds or
   removes that token, and no folder controls or starred-only filter render in this release.
10. Page, Per page and Filters controls are removed from Monitored. Search remains available.
11. Removing pagination controls does not authorize unbounded reads, DOM rendering or sparkline subscriptions.
12. Two simultaneous Monitored panes may not display the same view.
13. Horizontal drag-resize is removed and preset widths are authoritative. Bottom-edge vertical resizing remains for each
    visible Monitored or Alerts panel.
14. When multiple panels are visible, dragging may exchange their positions without changing preset widths.
15. The global workspace header gains one compact centered search field for token ticker, token contract or wallet address.
    It searches every search-capable chain regardless of the user's current workspace chain selection.
16. Search results always expose their chain and kind. Duplicate tickers produce separate choices and never select a token
    implicitly; an exact contract or wallet match ranks ahead of text matches.
17. A compact clipboard shortcut sits immediately left of global search. When a copied value resolves to a token contract,
    the shortcut expands to show the token image and ticker; activating it opens that token's expanded chart.
18. Clipboard access is gesture/permission-driven. The app may check on shortcut activation or an allowed focus/visibility
    transition, but it does not continuously poll, retain unrelated clipboard contents or upload text before local address
    classification.
19. A compact single-monitor SVG control sits left of the clipboard shortcut. It opens the fixed-layout preset picker with
    small schematic previews of each available layout. Hover may preview it, but keyboard focus and click/tap must expose
    the same choices.
20. Alerts and Monitor navigation controls move immediately right of global search. Brand remains on the left and workspace
    identity remains at the far right; all new boxes are materially more compact than the annotated concept image.

## Current repository evidence

### Existing Trending predecessor

`GET /api/dashboard/top-performers` currently returns at most 20 items. Solana SQL and the shared multi-chain merger use
seven volume picks plus price-change picks, an absolute 24h-volume floor, 24h price change and an 82/18 component blend.

This machinery is only a starting point. The old score, selection buckets, 15-item default, 20-item route maximum and Best
Performance presentation must not leak into the new Trending contract.

### Existing Robinhood metrics

Robinhood has canonical workspace windows for volume 5m, 1h, 6h and 24h and price change 1h, 6h and 24h. Values carry
`complete`, `partial` or `unavailable` coverage. Trending consumes these normalized read-model values rather than cached
provider fields.

### Existing launchpad evidence

Robinhood launchpad attribution recognizes Pons, Bankr/Doppler, LaunchHood, RobinPad, Robinhood stock tokens and a generic
Robinhood fallback. Direct creator adapters decode supported factory launch events. This proves origin for supported
factories; it does not prove a universal bonding state or migration transition.

Migrated and Pre-bonded may not infer lifecycle from `token_catalog.source`, DEX pair existence, silence, FDV or a generic
launchpad label.

### Existing Watchlist domain

Manual Tokens uses generic `user_tokens`, `user_token_folders` and `user_token_folder_items` tables. `user_tokens` remains
the canonical Watchlist membership source. The folder tables are preserved with their data and neutral routes for a later
folder design, but the initial Watchlist does not read or render them. Manual-specific names remain in TypeScript,
services, source values, UI copy, logs, tests and a catalog tracking route.

### Existing layout and sparkline behavior

The live layout models one `monitored` panel and one `alerts` panel with spans 1–3. Left, right and bottom resize zones
allow arbitrary horizontal and vertical resizing. Order and heights are persisted in UI preferences.

Alerts render sparklines cached by alert id. Realtime market buckets primarily update the workspace cache keyed by token
identity, while the Alerts refresh queue prioritizes missing series. There is not yet one canonical live series shared by
both surfaces.

## Non-goals

- Do not enable Solana or use Dexscreener as its canonical Trending source in this release.
- Do not create equal per-chain quotas in future multi-chain Trending.
- Do not preserve Best Performance ranking compatibility or reinterpret unrelated uses of `manual`.
- Do not rename neutral user-token and folder tables.
- Do not let view membership mutate alert eligibility, catalog identity, risk state or Watchlist membership.
- Do not infer lifecycle when an adapter cannot prove it.
- Do not poll to discover live changes already represented by an observed event.
- Do not make global search obey pane or workspace chain filters; availability and search capability are its only chain
  gates. In the initial Robinhood-only release this still yields Robinhood results until another chain has an accepted
  search adapter and canonical source.
- Do not continuously read or send the user's clipboard, and do not treat clipboard text as a command.
- Do not create a standalone VPS service. Extend existing Robinhood capture, persistence and publication boundaries. If a
  permanent service later becomes necessary, read `docs/new-worker-service-runbook.md` before proposing it.

## Vocabulary and shared contracts

### View and pane

```text
TokenViewId = trending | migrated | pre_bonded | watchlist

MonitoredPane {
  id: primary | secondary
  view: TokenViewId
  searchQuery: string
  scrollAnchor: opaque identity/cursor
}
```

Use `pre_bonded` in code and `Pre-bonded` in UI copy. Sparkline range stays workspace-level unless a later product decision
makes it pane-local.

### Chain adapter

```text
TokenViewAdapter {
  chain
  capabilities: { trending, migrated, preBonded, watchlist }
  listTrending(query)
  listMigrated(query)
  listPreBonded(query)
  listWatchlist(query)
}
```

Shared routes aggregate adapters. Shared modules must not implement domain rules with `chain === 'robinhood'` branches.
Every token returns identity `{ chain, address, key }`, typed valuation (`fdv` for Robinhood), metrics with coverage and
observation time, last activity/freshness and view-specific evidence or score data.

## Trending score v1

### Candidate eligibility

A candidate must be visible under existing admin/risk rules, have valid identity and valuation type, have a fresh accepted
market observation, usable volume coverage, sufficient coverage for all non-zero score components and satisfy the safe
Robinhood FDV ceiling. Watchlist membership alone never admits a candidate. Usable 24h coverage means the complete 24h
window, or complete coverage since creation for a token younger than 24h; raw accumulated volume is not age-annualized.

Initial minimum FDV, liquidity, freshness and meaningful-volume gates are explicit scorer policy constants with unit
tests, not user-facing Monitored filters.

### Components

Use current 5m volume relative to expected 5m pace:

```text
expected5m = max(volume1h / 12, volume24h / 288, denominatorFloor)
acceleration5m = clamp(volume5m / expected5m, 0, accelerationCap)

boundedChange1h = clamp(priceChange1h, 0, change1hCap)
boundedChange6h = clamp(priceChange6h, 0, change6hCap)
```

The floor and caps prevent almost-empty history or extreme percentages from dominating. Partial/unavailable windows do not
become zeroes. Initial tuning hypotheses are `change1hCap = 150%`, `change6hCap = 300%` and `accelerationCap = 12x`; they
must be evaluated against captured Robinhood snapshots before acceptance.

For default multi-chain mode, calculate component percentiles across one combined candidate pool after adapters return
comparable USD metrics. Do not apply chain quotas or per-chain normalization. For a single-chain filter, calculate the same
percentiles only over that chain.

```text
score =
  0.55 * percentile(log1p(volume24h)) +
  0.20 * percentile(log1p(acceleration5m)) +
  0.20 * percentile(boundedChange1h) +
  0.05 * percentile(boundedChange6h)
```

Return at most 40 tokens ordered by score, volume 24h, volume 5m and latest accepted observation descending, then chain
and address ascending.

Every result exposes diagnostics:

```text
scoreVersion: trending-v1
score
components: {
  volume24hPercentile
  acceleration5mPercentile
  priceChange1hPercentile
  priceChange6hPercentile
}
```

Diagnostics may stay out of normal card markup but remain in the API and gated frontend debug path.

### Evaluation

Before Trending becomes default, replay deterministic captured Robinhood read-model snapshots; compare output with raw
volume and price-change leaders; measure low-volume breakout penetration, stale/incomplete candidates and adjacent-snapshot
rank turnover; inspect high-volume, moderate-pump and high-pump cases; and tune constants/weights without hand-picking token
identities.

Accept the score when high-volume tokens remain strongly represented, meaningful current pumps enter, low-volume extreme
percentages do not dominate and identical input produces identical order.

## Migrated and Pre-bonded lifecycle

### Durable state

Add a chain-neutral lifecycle read model, provisionally:

```text
token_launchpad_lifecycle {
  chain
  token_address
  launchpad_id
  status: unknown | pre_bonded | migrated
  bond_progress_bps nullable
  created_at nullable
  migrated_at nullable
  last_event_at
  evidence_source
  evidence_block_number nullable
  evidence_block_hash nullable
  evidence_transaction_hash nullable
  evidence_log_index nullable
  version
  updated_at
}
```

Primary identity is `(chain,token_address,launchpad_id)`. Evidence identity supports idempotency and reorg rollback.

### Evidence gate

For each Robinhood launchpad, first identify creation and curve contracts, an authoritative migration/graduation event or
state transition, a reproducible bond-progress calculation, token/pool linkage and reorg reversal. Add canonical log/receipt
fixtures and enable the adapter only after contract tests pass.

Unsupported launchpads stay `unknown` and do not appear in either lifecycle view. Generic DEX pool discovery alone is not
sufficient evidence.

The Robinhood audit enables only Pons V2 (`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`). Its official contracts expose a
constant-product curve, an exact quote-reserve threshold, the token/curve link and distinct swept, pool-created and rescued
events. Pons V1 and NOXA launch directly into DEX pools; the repository has no authoritative lifecycle ABI for LaunchHood,
RobinPad, Bankr/Doppler or Stock. Those sources therefore remain `unknown` until separately proven.

Persist append-only evidence keyed by canonical event identity. Derive current state by joining the block journal with
`canonical=true`: curve trades update progress, `PoolGraduated` alone yields `migrated`, and swept/rescued states are
ineligible for both lists. This avoids a mutable snapshot requiring a second reorg rollback path.

### Live consumption

The existing Robinhood event capture remains the source. Write lifecycle state in the durable processing boundary, or via
a durable outbox, before publishing UI invalidation. Consumers tolerate duplicates, out-of-order delivery, replay and
reorgs.

Polling is allowed only for bounded reconciliation/recovery and must define cursor, batch, cadence, backoff, idempotency
and precedence behind the event-driven writer.

### View ordering

Migrated returns at most 40 supported identities ordered by migration time, volume 5m and volume 1h descending, then chain
and address. Lifecycle evidence and market freshness remain separate; unavailable volume is never fabricated.

Pre-bonded returns at most 40 identities with `status = pre_bonded` and fresh supported curve evidence, ordered by bond
progress, 5m acceleration, volume 5m and latest curve event descending, then chain and address. A committed migrated event
atomically removes Pre-bonded eligibility and enables Migrated eligibility.

## Watchlist canonical rename

Rename only the domain meaning user-added tokens. Examples:

- `ManualTokenEntry` -> `WatchlistTokenEntry`;
- `manualTokenIdentities` -> `watchlistTokenIdentities`;
- `manual-token-bootstrap` -> `watchlist-token-bootstrap`;
- catalog source `user-manual` -> `user-watchlist`;
- `/api/catalog/manual-track` -> `/api/catalog/watchlist-track`;
- user-facing Manual Tokens copy -> Watchlist.

Keep neutral `/api/config/tokens`, `/api/config/token-folders` and database table names.

Preference compatibility reads `collapsed.watchlist` and `watchlistSorts` first, falls back to their old Manual Tokens
keys only when absent, and emits and persists only the new keys. Obsolete folder and starred-only preferences are accepted
temporarily from an old client but are not emitted. Remove legacy readers only after deployed preferences are observed
migrated. The old catalog route may remain as a temporary server alias for one deployment window; new frontend code calls
only the Watchlist route. Tests must distinguish legacy input parsing from canonical output.

The star is the Watchlist membership control in every token surface. It writes `user_tokens`; it is not a second favorite
flag layered on top of Watchlist membership. Existing folder records and routes remain untouched and dormant until a
separate product decision defines how folders return.

## Monitored UI

The expanded header order is:

```text
MONITORED TOKENS | Trending | Migrated | Pre-bonded | Watchlist | Search | Chart range | Count
```

Controls may wrap responsively but logical order remains stable. Filters, Page, Per page, Prev and Next are absent.
System-generated views render at most 40 rows per pane. Watchlist retains up to 200 tokens per user and chain and uses
bounded rendering/incremental scroll rather than visible pagination.

Watchlist owns star-driven add/remove, search, token actions and expanded charts. Other views own search and token actions
without the removed valuation filter panel. The star in Trending, Migrated or Pre-bonded directly toggles Watchlist
membership. Folders, folder deletion warnings, folder selection and starred-only selection are deferred.

One-pane presets persist the primary selection. Two-pane presets persist primary and secondary selections. A view active
in one pane is disabled in the other; corrupted duplicates normalize to `Trending + Watchlist`; returning to one pane
preserves the secondary choice; and each pane preserves scroll independently.

## Global discovery header

The workspace header is a discovery surface, not a filter for the current panel. Its desktop logical order is:

```text
Brand | Layout preset SVG | Clipboard token shortcut | Global search | Alerts | Monitor | Workspace identity
```

Global search remains visually centered. The left and right control clusters must not displace it when their contents
change; use a centered grid/overlay contract with responsive collision rules rather than balancing arbitrary widths. The
field and adjacent controls use compact heights, gaps and result cards. On narrower screens they may collapse into an
explicit search affordance or a second header row without changing search scope.

### Cross-chain search contract

The accepted inputs are ticker/name text, an exact token contract or an exact wallet address. Search runs across all chains
whose adapters declare the relevant capability, independently from `enabledChains`, Radar filters or the active Monitored
view. Robinhood is the only search adapter enabled in the first release; adding Solana or another chain still requires its
accepted canonical source.

```text
GlobalSearchQuery {
  query
  kinds: token | wallet
  chains: all search-capable chains
  limit
}

GlobalSearchHit {
  kind: token | wallet
  chain
  address
  symbol? | displayLabel?
  name?
  imageUrl?
  destination
  match: exact_address | exact_ticker | prefix | text
}
```

Normalize and classify the query locally before dispatch. Exact address matches rank before ticker/name matches, then
stable comparable relevance and `(chain,address)` break ties. Token results open the canonical expanded chart. Wallet
results open a canonical wallet detail destination; wallet search must remain disabled with an explicit unavailable state
until that destination and a bounded wallet index/read model exist. Debounce text input, cancel stale requests, cap result
count and never scan live tables or call providers once per keystroke.

### Clipboard token shortcut

The closed state is a clipboard/paste identifier. After an allowed clipboard read, locally reject empty, oversized or
non-address text before any request. A valid address uses the same exact-address resolver as global search. Only a resolved
token expands the shortcut, showing its sanitized image, ticker and chain label; unresolved addresses remain a compact
neutral state. The resolved state is ephemeral, clears when clipboard content changes or the session ends and never adds
the token to Watchlist. Click, Enter or Space opens the expanded chart.

### Layout preset picker

The trigger is an authored single-monitor SVG that inherits the UI theme; do not use a bitmap asset. Its popover lists only
currently enabled presets. Each option includes its name and a small schematic SVG preview with blocks representing primary
Monitored, secondary Monitored and Alerts proportions. The current preset is selected, unavailable responsive presets are
disabled with a reason, and choosing one uses the same preference mutation defined below. The popover supports hover
preview, click/tap selection, arrow-key navigation, Escape dismissal and focus return to the trigger.

## Fixed layout presets

### 1. Discovery + Alerts

Monitored uses 2/3, Alerts uses 1/3, drag swaps left/right positions and both retain independent vertical height.

### 2. Compare

Primary and secondary Monitored each use 1/2, Alerts is hidden, views differ and drag swaps the panes. This requires a true
two-column layout rather than approximating halves in the current three-column grid.

### 3. Alerts Focus

Alerts only, with 2/3 visual content centered. The outer panel may fill the grid so an empty third does not look like a
missing panel. Wide cards expose the larger live sparkline and additional metrics.

### 4. Token Focus

One Monitored pane only, with 2/3 visual content centered. This supports Watchlist investigation and medium-width displays.

### 5. Command Center

Primary Monitored, secondary Monitored and Alerts each use 1/3. Enable only above a tested viewport width and use compact
card/table variants. If only four presets ship initially, defer Command Center; Token Focus has broader immediate value.

### Preference migration

```text
livePanelLayout {
  preset
  order
  panes: { primaryView, secondaryView }
  heights: { primary, secondary, alerts }
}
```

Map old monitored span 2 plus alerts span 1 to Discovery + Alerts; map alerts span 2 with Monitored absent/collapsed to
Alerts Focus; map everything else to Discovery + Alerts. Ignore old hidden `pumpfun` entries and do not emit them. Remove
left/right resize zones and horizontal resize state; retain bottom resize, height snapping and minimum heights.

## Canonical Alerts sparkline

Store compact series by `(chain,address)`, not alert id. Alerts keep only alert-specific presentation state.

1. Fetch bounded history for visible identities.
2. Merge committed live market buckets into the identity series.
3. Render the same series revision in Monitored and Alerts.
4. Use bounded periodic reconciliation for missed events.
5. Reduce priority for hidden/off-screen identities.
6. Prioritize the visible Alerts identity set when entering Alerts Focus.

Two alerts for one token must not duplicate fetches, subscriptions or series memory. Realtime updates respect accepted
sequence/block ordering and never overwrite a newer candle with an older one.

## API direction

Prefer one chain-aware read boundary:

```text
GET /api/dashboard/token-views/:view?chains=robinhood&limit=40
GET /api/search/global?q=...&kinds=token,wallet&limit=...
```

System views are `trending`, `migrated` and `pre-bonded`. Watchlist keeps authenticated user configuration as membership
source but may reuse the hydrated row mapper.

The parser rejects unavailable chains, defaults to enabled chains, caps system views at 40, captures one normalized `asOf`
for all adapters, returns per-chain capability/readiness, deduplicates by identity and keys caches by view, chains, limit,
score version and policy version.

Global search does not accept the workspace's selected chains as an implicit scope. The server resolves all registered
search-capable adapters, returns explicit per-chain/kind availability and enforces bounded query length, result limit,
timeout and cancellation. Exact token-contract lookup and clipboard resolution share this endpoint and normalization. Do
not enable wallet hits until a bounded canonical wallet read model and destination exist.

The response distinguishes `ready with zero results`, `unsupported` and `syncing`; it never reports an unsupported lifecycle
view as an ordinary empty result.

## Architecture checkpoint

This cross-cutting work is expected to touch more than 12 production files. New focused owners are required for the
token-view adapter/aggregator, pure Trending scorer/policy, launchpad lifecycle evidence/read model, pane state and duplicate
normalization, fixed preset resolver and shared identity-keyed sparkline cache.

`frontend/src/state/app-controller.ts`, `frontend/src/ui/app-shell.ts`,
`frontend/src/ui/sections/monitored-section.ts` and `src/routes/dashboard.js` remain wiring/composition hubs; do not add new
business logic to them.

## Implementation slices

Each slice stays at or below 500 changed non-operational-documentation lines, runs proportional validation, reviews its
complete diff and ends with a scoped commit before the next slice.

### Slice 1: contracts and Trending scorer

Add view contracts, pure score policy and a Robinhood candidate adapter using canonical metrics. Add the new endpoint with
a 40-token cap and deterministic score/coverage tests. Do not change visible UI.

### Slice 2: Robinhood launchpad lifecycle evidence

Audit supported contracts/fixtures, add additive lifecycle schema/model, persist supported transitions with reorg identity
and add schema/integration tests. If no current launchpad can prove transition or curve progress, stop after the audit,
record the blocker here and do not add heuristics.

### Slice 3: lifecycle read adapters

Add Migrated/Pre-bonded queries, readiness states, deterministic aggregation and coverage for transition, duplicate, stale,
unsupported and reorg cases.

Keep reads dark behind `ROBINHOOD_LIFECYCLE_READ_ENABLED` until the bounded historical replay completes. The live writer is
independent from this read gate; enabling it changes only readiness and API visibility.

### Slice 4: Watchlist rename

This product slice is split into bounded implementation cuts:

- **4A — backend contract and compatibility:** add the new tracking route plus temporary alias, make `user-watchlist` the
  canonical writer value, migrate `user-manual`, recognize both values during rollout and add canonical preference output
  with legacy input fallback.
- **4B — frontend state and actions:** rename Watchlist state/API/controller symbols and make the existing star action
  toggle `user_tokens` membership. New frontend code calls only canonical Watchlist routes and preference keys.
- **4C1 — flat surface:** render Watchlist as a flat list, remove folder, direct-add and starred-only controls, make the star
  the only membership control and update the primary component/copy.
- **4C2a — dead folder presentation:** delete the unreachable Watchlist folder/modal bindings and detached row-action
  builders while preserving folder data and neutral backend routes.
- **4C2b — dead add controls:** delete the remaining unreachable direct-add/quick-add helpers and their standalone CSS
  after verifying that no live surface still emits their selectors.
- **4C2c — residual folder styling:** delete the folder-scoped CSS left unreachable by 4C2a and confirm that neutral
  folder data/routes remain untouched.
- **4C3a — frontend token type:** remove the deprecated `ManualTokenEntry` alias and use `WatchlistTokenEntry` directly.
- **4C3b1 — frontend token markers:** rename the internal user-added-token flags to Watchlist vocabulary while retaining
  legacy input compatibility only at payload boundaries.
- **4C3b2a — frontend state vocabulary:** rename user-added-token counters, variables and local helper symbols.
- **4C3b2b — frontend capability boundary:** expose `watchlist` internally and normalize legacy `manualTokens` capability
  input at the API boundary during rollout. This is a frontend contract normalization only: WebSocket/realtime ingestion,
  subscriptions, transport cadence and upstream data sources remain unchanged.
- **4C3b3 — frontend copy and logs:** replace remaining user-facing and diagnostic Manual Tokens vocabulary while keeping
  neutral folder naming and explicit persisted compatibility keys intact.
- **4C3c — backend runtime vocabulary:** rename user-added-token model/catalog symbols, comments and logs without changing
  neutral tables, folder routes or legacy source recognition.
- **4C3d — canonical verification:** update affected tests and run a final scoped search proving that unrelated meanings of
  `manual` and the dormant neutral folder contracts were not changed.

Preserve neutral tables and config/folder routes. Folder data stays dormant and is not migrated or deleted.

### Slice 5: Monitored multi-view UI

Remove standalone Best Performance/Manual Tokens rendering; add four view buttons and pane-local selection/search/scroll;
remove pagination/filter controls; and keep reads and DOM work bounded.

- **5A — frontend read boundary:** add the canonical four-view IDs plus a typed, bounded client for the existing Trending,
  Migrated and Pre-bonded endpoint. Keep it dark; Watchlist continues to use authenticated local membership data.
- **5B — pane view state:** add primary-pane selection and isolated request/readiness state, load only the active system view
  and preserve the existing live token merge path without changing ingestion or subscriptions.
- **5C — unified Monitored surface:** render the four linear view buttons and make Monitored own the selected view, search,
  chart range, count and bounded rows. Remove Filters and visible pagination controls from this surface.
- **5D — legacy surface retirement:** remove standalone Best Performance and Watchlist render slots plus their now-dead
  presentation/controller code after the unified surface smoke coverage passes; preserve dormant folder storage and routes.
  Because the complete retirement exceeds the 500-line slice limit, execute it through these bounded cuts:
  - **5D1 — visible slot detachment:** remove both standalone render slots and their App Shell patch/render-key ownership;
    update smoke coverage so the unified Monitored surface is the only visible owner.
  - **5D2 — standalone Watchlist presentation owner:** delete the unreachable Watchlist section renderer and presentation-only
    bindings while preserving membership, star actions, neutral folder storage and folder routes.
  - **5D3 — Best Performance presentation owner:** delete the unreachable Best Performance renderer and its local
    auto-scroll/debug presentation helpers.
  - **5D4a — legacy render regions:** remove obsolete `manual` and `top-performers` render-region emissions and invalidation
    wiring without changing canonical Watchlist or Monitored refreshes.
  - **5D4b — legacy controller/state reads:** retire standalone Top Performance polling/snapshot state and Watchlist-only UI
    preferences that no longer have a consumer; keep any endpoint or compatibility contract still used outside this UI.
  - **5D5a — Best Performance styles:** remove the now-unreachable card, carousel and responsive CSS in a bounded pass.
  - **5D5b — standalone Watchlist styles:** remove the now-unreachable table/control CSS without touching shared Monitored,
    Radar or dormant folder persistence contracts.
  - **5D6 — residual verification:** run scoped dead-code/style searches, consolidate stale smoke expectations and prove that
    the unified four-view surface, star-based Watchlist membership, neutral folder storage and routes remain intact.

### Slice 6: fixed layouts

Add presets and two pane slots, prevent duplicate views, remove horizontal resize, preserve bottom resize and drag exchange,
and add Command Center's responsive guard.

Include the compact authored monitor SVG and accessible preset popover here. Its schematic SVG previews are pure layout
diagrams and call the same preset resolver used by persisted preferences; they do not maintain a second layout state.

- **6A — preset domain:** define and unit-test the five preset geometries, canonical preference normalization, legacy layout
  migration, pane-order normalization, duplicate-view repair and Command Center's minimum-width availability rule.
- **6B — state and preferences:** adopt primary/secondary pane state and the canonical persisted preset contract, preserving
  both selections and scroll positions across one-pane and two-pane transitions.
- **6C — pane renderer:** make the unified Monitored renderer pane-aware without duplicating view-fetching or token-action
  logic.
- **6D — shell composition:** add primary and secondary Monitored slots and compose visible regions exclusively from the
  fixed preset resolver.
- **6E1 — allowed resize:** remove horizontal resize state/zones and its free-span controller contract; preserve independent
  bottom-edge resize for `primary`, `secondary` and `alerts`. Validate with repository lint at the 14-warning baseline,
  frontend build and a focused vertical-resize smoke test.
- **6E2 — canonical drag exchange:** allow drag exchange only among panes visible in the active preset and remove the legacy
  free-placement/reorder machinery. Persist canonical pane order without changing preset geometry. Validate with repository
  lint at the 14-warning baseline, frontend build and a focused drag-exchange smoke test.
- **6F — preset picker:** add the compact authored monitor SVG and accessible popover whose schematic previews call the
  canonical preset mutation.
- **6G — responsive completion:** enforce Command Center's viewport guard, add compact responsive variants, consolidate
  obsolete span styling and cover preset selection, duplicate prevention, vertical resize and drag exchange in smoke tests.
  When a live resize crosses below Command Center's supported width, persist `discovery_alerts` as the deterministic fallback
  while retaining pane selections, order and heights for later choices.

### Alert retirement prerequisite

Before continuing the Alerts sparkline work, retire the standard threshold alerts **Volume 5m**, **GMGN Volume 1m**,
**MCap 5m** and **FDV 5m** from both Solana and Robinhood. Preserve the remaining alert families, including Price Surge,
Surge Continuation, HVNC, Meteora-specific alerts where applicable and Custom alerts. Existing persisted alerts and history
remain readable during the transition; this work stops new creation without destructively deleting historical records.

Execute the retirement through these bounded cuts:

- **R1 — backend emission retirement:** stop Solana and Robinhood matchers/planners from producing new Volume 5m, GMGN
  Volume 1m, MCap 5m or FDV 5m alerts, with focused regression coverage proving the remaining alert families still emit.
  **Completed:** both planners reject the retired rule keys through one shared policy; legacy state compatibility remains
  for later retirement cuts.
- **R2 — frontend local emission retirement:** remove local evaluation, notification and sound paths for the four retired
  alert types without changing realtime ingestion, WebSocket subscriptions or live token updates.
  **Completed:** local Volume/MCap evaluation is removed and historical events for all four retired types are rejected
  before browser notification or audio side effects; realtime ingestion and historical rendering remain intact.
- **R3 — active configuration surfaces:** remove the retired types from active profiles, Telegram menus and Bot Settings so
  users cannot create or enable them through supported configuration flows.
  **Completed:** dashboard profiles force the retired rules off, Bot Settings no longer renders their thresholds, toggles
  or sound controls, and Telegram creates and exposes only active rule defaults while safely ignoring compatible legacy
  rows during evaluation.
- **R4 — dead runtime contracts:** remove reset/publication/state branches that no longer have active consumers, while
  retaining only compatibility code required to read historical alerts or legacy persisted settings safely.
  Execute this cleanup through three sub-cuts so each implementation remains below the repository's 500-line slice limit:

  - **R4a — Robinhood runtime cleanup:** stop constructing the retired Volume 5m and FDV 5m candidates, exclude their keys
    from active state preparation and remove their anchored-repeat publication branches. Keep database constraints, stored
    rows and historical feed/formatter contracts intact. Validate the matcher, publication and derived standard-alert sink,
    then run repository lint. Estimated change: 250–350 lines.
    **Completed:** the Robinhood matcher constructs and prepares state only for active surge rules, publication loads only
    those active state keys and the retired anchored-repeat payload rewrite is gone. The legacy rule catalog remains readable
    for persisted rows and historical delivery contracts.
  - **R4b — Solana runtime cleanup:** remove retired Volume 5m, GMGN Volume 1m and MCap 5m candidate construction, their
    dedicated baseline loads, cold-reset/rearm work and anchored-repeat payload handling. Preserve Price Surge, Surge
    Continuation, HVNC, Meteora, Custom alerts and the active Telegram destination. Validate the matcher, profile evaluator,
    Telegram planner/destination and repository lint. Estimated change: 400–500 lines.
    **Completed:** the Solana matcher no longer constructs or rearms the retired rules, reads no dedicated volume or market-cap
    baseline for them and has no anchored-repeat payload branch. Active alert priority and the Telegram planning/destination
    path remain unchanged; legacy contracts and historical records stay readable.
  - **R4c — shared runtime residue:** remove the temporary emission-retirement shim and test-only private exports only after
    R4a/R4b leave them without runtime consumers, consolidate obsolete negative-path tests and run scoped dead-reference
    searches. Historical feed, replay, chart-marker, formatter, schema and persisted-configuration compatibility remains for
    R5. Validate the surviving alert families plus repository lint. Estimated change: 100–180 lines.
    **Completed:** the unreferenced retirement shim and monitored-volume cold-reset helpers are removed, and redundant GMGN
    feature-flag tests are consolidated. Active surge reset logic remains shared, while historical and persisted contracts
    are unchanged.
- **R5 — compatibility and final verification:** verify historical rendering, normalize legacy inputs to disabled state,
  update operational documentation and run scoped dead-reference searches plus the applicable test/build/lint matrix.

### Slice 7: Alerts sparkline convergence

Move compact cache ownership to token identity, share fetch deduplication/live merges, prioritize visible Alerts Focus
identities and remove redundant per-alert series ownership after compatibility is proven.

### Slice 8: global discovery header

Split this cross-cutting surface into bounded cuts: first add the chain-adapter search contract and exact-address resolver;
then add the centered compact header search and result navigation; then add the permission-safe clipboard token shortcut.
Keep Alerts/Monitor controls immediately right of search and validate desktop centering plus narrow collision behavior.
Token search ships for Robinhood first. Wallet results stay explicitly unavailable until their canonical read model and
detail destination are implemented and tested.

### Slice 9: rollout and cleanup

Enable behind a reversible gate, run score/UI validation, remove old surfaces and dead resize code, remove compatibility
only after telemetry confirms migration, and consolidate `docs/bot-reference.md` with the final operational state.

## Validation matrix

### Unit

- score components, caps, percentiles, deterministic ties and acceleration denominator protection;
- global multi-chain pool versus one-chain filtering;
- missing/partial coverage exclusion;
- pane duplicate normalization and preset resolution;
- global-search classification, deterministic ranking, bounds and independence from workspace chain filters;
- clipboard local rejection, permission states and stale-resolution cancellation;
- Watchlist legacy preference normalization.

### Integration

- lifecycle persistence, idempotency and reorg rollback;
- Pre-bonded to Migrated transition;
- endpoint ready/unsupported/syncing states;
- flat Watchlist star-driven add/remove;
- UI preference migration;
- shared sparkline identity and duplicate-alert deduplication.
- global exact-address resolution, duplicate-ticker disambiguation and per-chain/kind availability.

### Frontend build and smoke

- four view buttons, active state and at most 40 Trending rows;
- no Page, Per page or Filters controls;
- two different Monitored views and duplicate prevention;
- fixed presets at supported viewport widths;
- no horizontal resize, with vertical resize and drag exchange retained;
- Alerts Focus sparkline advances after a live bucket;
- Watchlist star-driven add/remove and search behavior remains intact; dormant folder data remains unchanged.
- global search stays centered, searches all search-capable chains despite the active filter and navigates token hits to the
  expanded chart;
- preset SVG/popover supports pointer and keyboard use, and clipboard denial leaves the header usable without repeated
  prompts or background polling.

### Commands by affected slice

- Any code: `npm run lint`.
- Frontend: `npm --prefix frontend run build`, smallest affected test and `npm run test:smoke` for assembled visible flows.
- Backend: smallest owning `node --test ...` target.
- Schema: `npm run db:schema-check` plus lifecycle integration coverage.
- Documentation-only: rendered text and complete diff review; runtime lint/tests are unnecessary.

## Rollout and rollback

1. Deploy additive lifecycle schema when evidence supports it.
2. Deploy lifecycle writer/read models dark and verify freshness, duplicates and reorg behavior.
3. Deploy the view endpoint and Trending score in shadow.
4. Capture and review representative 40-token Robinhood snapshots.
5. Deploy Watchlist compatibility readers and canonical writers.
6. Deploy fixed-layout multi-view frontend behind a reversible gate.
7. Deploy the global search contract and header behind its own reversible gate, enabling only adapters with canonical
   sources and destinations.
8. Enable internally, expand, then remove old UI/compatibility only after telemetry confirms no dependency.

Rollback disables the frontend gate and restores prior presentation. It never deletes lifecycle evidence, Watchlist
membership, folders or migrated preferences. Additive schema remains until separately approved cleanup.

## Completion criteria

- Robinhood is the only active adapter and unavailable chains fail explicitly.
- Trending returns at most 40 explainable deterministic tokens using `trending-v1`.
- High-volume tokens remain represented while current pumps enter without low-volume percentage outliers dominating.
- Migrated and Pre-bonded contain only supported on-chain lifecycle evidence.
- User-added tokens are Watchlist throughout product/domain paths; unrelated manual concepts remain untouched.
- Separate Best Performance and Manual Tokens surfaces no longer render.
- Five presets work as specified, or Command Center is explicitly deferred while the other four ship.
- Horizontal resize is absent; vertical resize and allowed drag exchange remain.
- Alerts Focus uses the same advancing series as Monitored.
- The compact global header contains the accessible SVG preset picker, permission-safe clipboard token shortcut, centered
  cross-chain search and Alerts/Monitor controls in the approved order.
- Global search ignores the current workspace chain filter, disambiguates duplicate tickers and never advertises wallet
  navigation before a canonical wallet result destination exists.
- Operational docs, schema checks, targeted tests, frontend build and relevant smoke tests pass.
