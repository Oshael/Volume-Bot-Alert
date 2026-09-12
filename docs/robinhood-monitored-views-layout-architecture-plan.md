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
9. The standalone Manual Tokens surface is removed. Its management, folders, search and starred behavior move into the
   Watchlist view.
10. Page, Per page and Filters controls are removed from Monitored. Search remains available.
11. Removing pagination controls does not authorize unbounded reads, DOM rendering or sparkline subscriptions.
12. Two simultaneous Monitored panes may not display the same view.
13. Horizontal drag-resize is removed and preset widths are authoritative. Bottom-edge vertical resizing remains for each
    visible Monitored or Alerts panel.
14. When multiple panels are visible, dragging may exchange their positions without changing preset widths.

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

Manual Tokens uses generic `user_tokens`, `user_token_folders` and `user_token_folder_items` tables. Those names are
already neutral and do not need schema renames. Manual-specific names remain in TypeScript, services, source values, UI
copy, logs, tests and a catalog tracking route.

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
- `manualTokenFolders` -> `watchlistFolders`;
- `manualStarredOnly` -> `watchlistStarredOnly`;
- `manual-token-bootstrap` -> `watchlist-token-bootstrap`;
- catalog source `user-manual` -> `user-watchlist`;
- `/api/catalog/manual-track` -> `/api/catalog/watchlist-track`;
- user-facing Manual Tokens copy -> Watchlist.

Keep neutral `/api/config/tokens`, `/api/config/token-folders` and database table names.

Preference compatibility reads the new key first, falls back to an old Manual Tokens key only when absent, and emits and
persists only the new key. Remove the reader only after deployed preferences are observed migrated. The old catalog route
may remain as a temporary server alias for one deployment window; new frontend code calls only the Watchlist route. Tests
must distinguish legacy input parsing from canonical output.

Deleting a Watchlist folder preserves the current confirmed destructive behavior for linked user-added tokens.

## Monitored UI

The expanded header order is:

```text
MONITORED TOKENS | Trending | Migrated | Pre-bonded | Watchlist | Search | Chart range | Count
```

Controls may wrap responsively but logical order remains stable. Filters, Page, Per page, Prev and Next are absent.
System-generated views render at most 40 rows per pane. Watchlist retains up to 200 tokens per user and chain and uses
bounded rendering/incremental scroll rather than visible pagination.

Watchlist owns add/remove, folders and deletion warning, folder selection, starred-only selection, search, token actions
and expanded charts. Other views own search and token actions without the removed valuation filter panel. Adding a token
from Trending, Migrated or Pre-bonded targets Watchlist.

One-pane presets persist the primary selection. Two-pane presets persist primary and secondary selections. A view active
in one pane is disabled in the other; corrupted duplicates normalize to `Trending + Watchlist`; returning to one pane
preserves the secondary choice; and each pane preserves scroll independently.

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
```

System views are `trending`, `migrated` and `pre-bonded`. Watchlist keeps authenticated user configuration as membership
source but may reuse the hydrated row mapper.

The parser rejects unavailable chains, defaults to enabled chains, caps system views at 40, captures one normalized `asOf`
for all adapters, returns per-chain capability/readiness, deduplicates by identity and keys caches by view, chains, limit,
score version and policy version.

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

### Slice 4: Watchlist rename

Rename domain-specific symbols/copy/logs/tests, add the new tracking route plus temporary alias, migrate `user-manual` source
values and add preference compatibility. Preserve neutral tables and config routes.

### Slice 5: Monitored multi-view UI

Remove standalone Best Performance/Manual Tokens rendering; add four view buttons and pane-local selection/search/scroll;
remove pagination/filter controls; and keep reads and DOM work bounded.

### Slice 6: fixed layouts

Add presets and two pane slots, prevent duplicate views, remove horizontal resize, preserve bottom resize and drag exchange,
and add Command Center's responsive guard.

### Slice 7: Alerts sparkline convergence

Move compact cache ownership to token identity, share fetch deduplication/live merges, prioritize visible Alerts Focus
identities and remove redundant per-alert series ownership after compatibility is proven.

### Slice 8: rollout and cleanup

Enable behind a reversible gate, run score/UI validation, remove old surfaces and dead resize code, remove compatibility
only after telemetry confirms migration, and consolidate `docs/bot-reference.md` with the final operational state.

## Validation matrix

### Unit

- score components, caps, percentiles, deterministic ties and acceleration denominator protection;
- global multi-chain pool versus one-chain filtering;
- missing/partial coverage exclusion;
- pane duplicate normalization and preset resolution;
- Watchlist legacy preference normalization.

### Integration

- lifecycle persistence, idempotency and reorg rollback;
- Pre-bonded to Migrated transition;
- endpoint ready/unsupported/syncing states;
- Watchlist CRUD and folder deletion;
- UI preference migration;
- shared sparkline identity and duplicate-alert deduplication.

### Frontend build and smoke

- four view buttons, active state and at most 40 Trending rows;
- no Page, Per page or Filters controls;
- two different Monitored views and duplicate prevention;
- fixed presets at supported viewport widths;
- no horizontal resize, with vertical resize and drag exchange retained;
- Alerts Focus sparkline advances after a live bucket;
- Watchlist add/remove/folder/search behavior remains intact.

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
7. Enable internally, expand, then remove old UI/compatibility only after telemetry confirms no dependency.

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
- Operational docs, schema checks, targeted tests, frontend build and relevant smoke tests pass.
