# Workspace Catalog, Activity and Views Architecture Plan

Status: in progress (Blocks 0–8 complete; Block 9 in progress)

Created: 2026-07-15

## Objective

Separate persistent token identity from recent market activity, dashboard
visibility, risk approval and alert eligibility across Solana and Robinhood.

The workspace must not remove a token merely because it stopped swapping.
Monitored must rank the persistent token universe with metrics from the window
chosen by the user. Radar must provide persistent historical discovery and
charts based on user-selected filters. Alert and risk gates remain independent
and must not be weakened by this migration.

This document is the standalone implementation source of truth. It records the
decisions, repository evidence, target contracts, migration sequence, tests,
rollout and rollback. Implementation must not depend on conversation context.

## Relationship to existing plans

This plan supersedes the following product assumptions in
`docs/robinhood-full-workspace-support-plan.md`:

- Robinhood dashboard membership must not require a swap in the last 15
  minutes;
- inactive Robinhood tokens must not be removed from Monitored or Radar;
- `eligible_for_monitoring` must not define Radar membership;
- freshness is display and data-quality information, not token lifecycle;
- Robinhood Full Workspace Block 7 must wait until the visibility and activity
  contracts in this plan exist.

The existing Robinhood ingestion, multiprotocol aggregation, alert publication
and rollout safety requirements remain authoritative. This plan does not
replace `docs/robinhood-chain-onchain-monitoring-plan.md`.

## Approved product decisions

1. The USD 30,000 valuation floor is a default, user-adjustable view filter.
   It is never a destructive deletion or permanent eligibility mutation.
2. Monitored keeps every valid catalog token in its queryable universe. A
   token without volume in the selected window receives zero volume and falls
   in the ranking; it is not removed from the catalog or view model.
3. The semantic correction applies to both Solana and Robinhood. Chain-specific
   ingestion, valuation, risk and alert gates remain separate.
4. Radar is a historical explorer. Lack of recent swaps must not remove a token
   from Recent, Old Week, search or historical charts.
5. Realtime market updates are emitted as swaps are accepted. Identity is
   always `(chain,address)`.
6. Robinhood uses FDV terminology. FDV must never be copied into a market-cap
   field merely to satisfy a shared UI.
7. Existing destructive user actions remain destructive where already
   specified, including explicit folder deletion behavior. Inactivity and
   valuation filters are not destructive actions.

## Non-goals

- Do not unify Solana and Robinhood ingestion pipelines.
- Do not make Robinhood use Solana-only GMGN, Meteora, Pump.fun or bid-zone
  sources.
- Do not relax risk, blocklist, alert publication or rollout gates.
- Do not invent circulating supply or market cap for Robinhood.
- Do not fabricate chart zeroes for periods without observations.
- Do not make external metadata calls part of a swap-processing transaction.
- Do not retain every high-resolution bucket forever; historical resolution
  may degrade according to an explicit retention policy.
- Do not redesign custom alerts in this plan beyond keeping their eligibility
  independent from workspace visibility.

## Vocabulary

### Catalog identity

A token that the system has discovered and can identify. Catalog identity is
persistent and keyed by `(chain,address)`. It does not expire because market
activity stopped.

### Market activity

Accepted swaps and their derived volume, transaction, price and valuation
observations. Activity is measured over a requested time window and never
stored as a permanent token membership state.

### Workspace visibility

Whether a catalog identity may be queried and rendered for a user after
explicit administrative blocks, user blocks and current view filters are
applied. Workspace visibility is not alert eligibility.

### Freshness

The age of the latest observation used by a displayed metric. Freshness must
be returned with the value and may produce `fresh`, `stale` or `unknown` UI.
It may not delete or deactivate catalog identity.

### Valuation

- Solana: market cap when a trusted circulating-supply market-cap source is
  available;
- Robinhood: FDV from the accepted on-chain price and total supply contract.

Every public valuation includes its type and observation timestamp.

### View filter

A reversible user or request constraint such as valuation range, age, chain,
starred-only, search text or dismissed identity. A filter affects query output
only. It must not mutate catalog, risk or alert state.

### Risk eligibility

Chain-specific approval used by monitoring workers, enrichment, safety review
or alerts. Existing fields such as `eligible_for_monitoring` and
`is_active_monitor_candidate` currently represent parts of this contract.
They must not remain generic workspace membership flags.

## Repository evidence and current contradictions

### Robinhood membership is hardcoded to 15-minute activity

`src/models/robinhood-dashboard-read.js` defines `FRESH_MS` as 15 minutes.
Both `ACTIVE_CATALOG_ROWS_SQL` and the paged dashboard query require recent
buckets and `last_observed_at` newer than that boundary.

Consequence: a token that generated the highest volume 40 minutes ago is
absent when the user selects the 1-hour Monitored ranking, even though its
volume belongs to that window.

### Robinhood projection turns inactivity into product state

`src/models/robinhood-catalog.js#demoteInactive` writes:

- `eligibility_state = robinhood-dashboard-inactive`;
- `suppressed_reason = robinhood-no-swaps-15m`;
- `is_active_monitor_candidate = false`;
- `eligible_for_monitoring = false`.

`src/services/robinhood-catalog-projection-batch.js` invokes that demotion on
the same 15-minute boundary. This conflates accepted-observation freshness,
dashboard visibility and signal eligibility.

### Solana Monitored and Radar use signal-oriented eligibility

The following `src/models/token-catalog.js` queries require
`eligible_for_monitoring = true`:

- `listDashboardMonitored`;
- `listDashboardMonitoredForMerge`;
- `listDashboardMonitoredSlice`;
- `listDashboardTopPerformerCandidates`;
- `listDashboardHistoryBucket` through `buildHistoryBucketWhereSql`.

The field is written by catalog, discovery, GMGN, risk and cleanup paths. It is
therefore not safe to reinterpret it as persistent workspace visibility or to
set it unconditionally to true.

### Radar inherits the wrong lifecycle

`buildHistoryBucketWhereSql` requires both `eligible_for_monitoring = true` and
Solana `last_mcap` bounds. The route accepts chain identities, but a projected
Robinhood token has `eligible_for_monitoring = false`, `last_mcap = null` and
FDV in `last_fdv`. Robinhood Radar membership is therefore structurally
impossible under the current query.

### Monitored supports longer windows than its Robinhood universe

The frontend accepts Monitored volume sorts for `5m`, `1h`, `6h` and `24h`.
The default is `5m`, but `1h`, `6h` and `24h` are first-class user choices.
Constraining the candidate universe to 15-minute activity makes every longer
window incomplete.

### Combined pagination loads complete candidate sets

`src/services/dashboard-chain-reader.js` calls
`listDashboardMonitoredForMerge` for all eligible Solana rows and
`listActiveCatalogRows` for all fresh Robinhood rows. Then
`src/services/dashboard-chain-aggregation.js` sorts and slices the union in
memory.

Removing the freshness gate without redesigning pagination would make this
path grow with the entire catalog and eventually make the 3-second dashboard
refresh cadence unsafe.

### Monitored exit events encode the old meaning

`src/models/monitored-token-exit-event.js` records an exit whenever a row moves
from the current `eligible_for_monitoring` plus minimum-market-cap contract to
an ineligible state. Those historical events may remain useful for risk and
pipeline diagnosis, but they must not be interpreted as removal from the
workspace after this migration.

### Realtime chart rooms are address-only

`src/services/socket-hub.js` derives market rooms from address only and accepts
`market:subscribe { address }`. `frontend/src/services/socket/client.ts` uses
the same payload. Robinhood support would collide semantically with the
canonical workspace identity and lacks a chain-routed producer contract.

### Existing historical storage has different resolution boundaries

Robinhood minute buckets are retained for 14 days while hourly buckets are
permanent under the current retention worker. The historical product can be
persistent without pretending that minute-level resolution is permanent.

## Target architecture overview

The target separates five layers:

1. persistent catalog identity;
2. chain-native observations and buckets;
3. normalized current/window metric readers;
4. user-facing Monitored and Radar query policies;
5. chain-aware realtime delivery.

Data flows in one direction:

```text
chain ingestion
  -> accepted observations
  -> chain-native buckets
  -> normalized metric readers
  -> Monitored / Radar / charts
  -> chain-aware socket updates

catalog discovery
  -> persistent identity and metadata
  -> workspace visibility policy
  -> Monitored / Radar search universe

risk and alert evaluation
  -> independent eligibility and publication gates
  -> alert feed
```

No arrow from "no recent swaps" may mutate catalog identity or workspace
visibility.

## State separation contract

### Persistent catalog state

The catalog must preserve at least:

- `chain` and normalized `address`;
- discovery/creation timestamps;
- metadata and metadata freshness;
- latest accepted price and valuation when available;
- latest valuation observation timestamp;
- latest market activity timestamp;
- source provenance;
- explicit administrative block or deletion relationships.

Catalog presence does not claim that the latest valuation is current.

### Activity state

Activity is derived per request or maintained by a chain-native rolling metric
reader. Its normalized contract is:

```json
{
  "chain": "robinhood",
  "address": "0x...",
  "windowEnd": "2026-07-15T12:00:00.000Z",
  "volume5mUsd": 0,
  "volume1hUsd": 125000,
  "volume6hUsd": 410000,
  "volume24hUsd": 980000,
  "swaps5m": 0,
  "swaps1h": 18,
  "lastActivityAt": "2026-07-15T11:20:00.000Z",
  "coverage": {
    "5m": "complete",
    "1h": "complete",
    "6h": "complete",
    "24h": "complete"
  }
}
```

A complete window with no accepted swap has volume zero. A window with missing
or incomplete bucket coverage must be marked `partial` or `unavailable`; it
must not be silently represented as a trustworthy zero.

### Valuation state

Every normalized token row must expose valuation without chain ambiguity:

```json
{
  "mcap": null,
  "fdv": 52000,
  "valuation": {
    "type": "fdv",
    "usd": 52000,
    "observedAt": "2026-07-15T11:20:00.000Z",
    "freshness": "stale"
  }
}
```

Rules:

- Solana market cap populates `mcap` and `valuation.type = mcap`;
- Robinhood FDV populates `fdv` and `valuation.type = fdv`;
- a shared ordering helper may compare `valuation.usd` across chains;
- that helper must not change public terminology or copy values between fields;
- `fresh` initially means observed within 15 minutes;
- `stale` means a valid last observation older than 15 minutes;
- `unknown` means no usable valuation or observation timestamp;
- the freshness threshold is presentation/data-quality policy, not membership;
- a stale last-observed valuation may be filtered, but the UI must identify it
  as stale and must not label it "current".

### Workspace visibility policy

Create a dedicated policy boundary instead of another overloaded catalog
boolean. Its output should include reason codes, not only true/false:

```json
{
  "visible": true,
  "reasons": [],
  "filterMismatch": [],
  "riskState": "approved",
  "activityState": "stale"
}
```

Precedence:

1. malformed or unsupported identity is rejected;
2. explicit administrative block is globally excluded;
3. explicit user block is excluded for that user;
4. destructive deletion removes the relevant user-owned relationship, not the
   shared catalog identity unless an administrator explicitly deletes it;
5. chain-specific permanent junk/safety policy remains enforced;
6. user filters such as minimum valuation, maximum valuation, age, search,
   starred-only and dismissed identities affect query output only;
7. lack of swaps never changes catalog visibility;
8. risk/alert ineligibility does not automatically erase historical Radar
   data.

The exact mapping of existing Solana risk labels to hard workspace exclusion
must be frozen in Block 1 before code changes. The migration must preserve
current safety exclusions while removing activity as an exclusion reason.

## Monitored product contract

### Purpose

Monitored is a realtime sortable market leaderboard over the queryable catalog
universe. Its default emphasis is fast `5m` monitoring, but `1h`, `6h` and
`24h` are equally valid ranking windows.

### Membership

A token is eligible for the Monitored query when:

- its canonical catalog identity exists;
- its chain is selected;
- it passes explicit workspace safety/block policy;
- it passes the current reversible user filters.

There is no last-swap membership condition.

### Default filters

- Solana minimum market cap: USD 30,000;
- Robinhood minimum FDV: USD 30,000;
- both values are independently user-adjustable;
- lowering either filter can reveal retained catalog tokens;
- raising either filter cannot mutate catalog or alert state.

### Sorting

The request may contain ordered sort criteria. The backend must apply them in
the exact user-selected order. Supported Monitored criteria remain:

- volume: `5m`, `1h`, `6h`, `24h`;
- valuation: highest or lowest using chain-specific valuation;
- age: newest or oldest.

When a complete requested volume window contains no swaps, its value is zero.
When coverage is incomplete, the row must expose that state and sort using a
documented missing-value policy. The initial policy is:

- complete numeric values sort normally;
- partial numeric values sort after complete values with the same numeric
  direction;
- unavailable values sort after complete and partial values;
- deterministic ties use token creation/discovery age, valuation, chain and
  address.

### Pagination

Combined-chain pagination must not load the complete persistent catalog into
Node.js on every refresh.

For offset pagination page `p` and size `n`, each chain reader may return its
first `(p + 1) * n` rows under the identical normalized comparator plus its
exact filtered count. Merging those per-chain prefixes is sufficient to
produce the exact global page because no row below a chain's prefix can enter
the global first `(p + 1) * n` positions.

Requirements:

- both chain readers use equivalent sort and missing-value semantics;
- the combined coordinator deduplicates by `(chain,address)`;
- total is the sum of disjoint per-chain filtered totals;
- the merged page is sliced only after global deterministic sorting;
- requests receive a stable `asOf` timestamp so rolling windows do not shift
  between chain reads;
- deep-page cost and maximum page size are bounded;
- keyset pagination may replace offset pagination later without changing row
  semantics.

### Pins

Pins remain keyed by `(chain,address)` and never change risk or alert
eligibility. A pinned token that no longer passes the current valuation filter
remains in the separate pinned area with a visible filter-mismatch badge,
unless it is explicitly blocked, permanently rejected or deleted. This
behavior was adopted before Block 4 pin implementation.

### Realtime behavior

An accepted swap updates relevant rolling metrics, the open token chart and
the visible ranking. A swap does not add a token to a transient 15-minute
membership set and window expiration does not delete it.

The UI may re-rank at a bounded cadence rather than rebuilding the entire DOM
for every swap. Metric correctness and event ordering must be preserved.

## Radar product contract

### Purpose

Radar is the persistent historical explorer for catalog identities. It is not
a projection of the current Monitored candidate list.

### Membership

Radar queries the persistent workspace-visible catalog and applies user
filters. It must not require:

- `eligible_for_monitoring = true`;
- `is_active_monitor_candidate = true`;
- a swap within 15 minutes;
- positive volume in the selected sort window.

### Recent and Old Week

The existing split remains an age partition:

- Recent: token age below 7 days, subject to the configured age range;
- Old Week: token age of at least 7 days, optionally with an upper bound.

Age uses the best chain-native token creation timestamp. If unavailable, use
first trusted discovery/observation time and expose the provenance. Rows with
unknown age require an explicit `unknown` state; they must not silently enter
an incorrect age bucket.

### Filters

Radar supports reversible filters for:

- selected chains;
- Solana market-cap range;
- Robinhood FDV range;
- token age;
- search text;
- starred-only;
- dismissed identities;
- volume and price-change sort windows;
- valuation freshness if later exposed to the user.

All identity arrays and dismissal keys use `(chain,address)`. Legacy
address-only input remains a Solana adapter only.

### Historical metrics

Radar volume and price-change labels must distinguish:

- a complete window with zero activity;
- insufficient history for a baseline;
- a gap or partial ingestion interval;
- a stale latest valuation.

Price change is `null` when no trustworthy baseline exists. It must not be
coerced to zero. Volume may be zero only when coverage proves the full window
was observed.

### Charts

- Solana charts continue to use Solana market bucket sources;
- Robinhood charts use only Robinhood V2/V3/V4 accepted buckets;
- token totals aggregate activity across every accepted market;
- price/FDV candles use a deterministic primary-market policy and must not sum
  valuations across markets;
- minute resolution is available only within retained minute history;
- older Robinhood history uses hourly buckets honestly;
- gaps remain gaps and are not filled with invented zero candles;
- Robinhood chart labels say FDV, not market cap;
- chart request and cache identity includes chain, address, range and
  granularity.

The deterministic Robinhood primary market for a chart bucket is the market
with highest accepted volume in that bucket, then freshest observation,
protocol and market key. Activity totals still sum all accepted V2/V3/V4
markets.

## Alert and risk isolation

The workspace migration must not make all catalog tokens eligible for alerts.

Maintain separate contracts for:

- risk enrichment candidacy;
- automatic junk/block decisions;
- alert rule eligibility;
- Robinhood coverage/readiness;
- alert publication and delivery;
- workspace visibility.

Existing `eligible_for_monitoring` may remain temporarily as a legacy
signal/risk field for Solana. New Monitored and Radar reads must stop treating
it as their generic membership source. Renaming or decomposing the database
field is deferred until all writers and readers are inventoried and migrated.

`monitored_token_exit_events` remains historical evidence of the old
signal-oriented eligibility transition. New user-facing removal analytics
must not consume it as a workspace-exit stream after this plan launches.

## Normalized backend read boundaries

Introduce chain adapters behind one coordinator:

```text
workspace-token-reader
  listMonitoredPrefix(query)
  countMonitored(query)
  listRadarPage(query)
  getToken(identity, asOf)
  getHistory(identity, range, granularity, asOf)

solana-workspace-token-reader
robinhood-workspace-token-reader
```

Every adapter must return the same semantic DTO while reading chain-native
tables. Shared code owns identity, filters, sorting, pagination merge and
response shape. Chain adapters own valuation sources, bucket sources,
coverage and primary-market selection.

Do not create a new cross-chain table merely to avoid writing adapters. Add a
materialized or persisted current-metrics table only if Block 3 benchmarks
prove that indexed bucket/catalog reads cannot meet the refresh budget.

## Public API contract

### Monitored request

The existing route may evolve without changing its URL:

```text
GET /api/dashboard/monitored
  ?chains=solana,robinhood
  &page=0
  &perPage=30
  &minMcap=30000
  &minFdv=30000
  &sorts=[...]
  &asOf=<optional server-issued snapshot>
```

The first page establishes `asOf`. Background hydration must reuse it until a
new refresh cycle begins. This prevents page duplication or omission caused by
rolling metrics moving during pagination.

### Monitored response

```json
{
  "asOf": "2026-07-15T12:00:00.000Z",
  "total": 812,
  "page": 0,
  "perPage": 30,
  "hasMore": true,
  "tokens": [],
  "pinnedTokens": [],
  "coverage": {
    "solana": "ready",
    "robinhood": "ready"
  }
}
```

Each token includes:

- canonical `chain` and `address`;
- chain-specific `mcap` or `fdv`;
- normalized `valuation` object;
- `lastActivityAt`;
- activity metrics and per-window coverage;
- token age plus timestamp provenance;
- risk/visibility state needed for honest UI, without exposing sensitive
  internal evidence;
- existing metadata, link and capability fields.

### Radar request

`POST /api/dashboard/history-bootstrap` may remain the bootstrap route, but its
backend source changes from monitored eligibility to the persistent workspace
reader. Requests must carry:

- selected chains;
- independent `mcap` and `fdv` bounds;
- canonical dismissed/starred/pinned identities;
- age bounds;
- search and sort criteria;
- one shared `asOf` per bootstrap.

### Compatibility

- missing `chains` remains the legacy Solana default until every caller is
  migrated;
- legacy address-only identity arrays are interpreted as Solana only;
- Robinhood requests must always include chain;
- existing response fields remain during a deprecation window;
- new valuation and coverage fields are additive first;
- no route may fall back to Solana data when Robinhood is syncing or missing.

## Realtime contract

### Subscription identity

Replace address-only market rooms with canonical chain-aware rooms:

```json
{
  "chain": "robinhood",
  "address": "0x..."
}
```

Room keys use the same canonical token identity helper as persistence and
caches. The backend validates the chain before normalizing the address.

During migration, `{ address }` remains a Solana-only adapter. It must never
guess Robinhood from address shape at an internal boundary.

### Event envelope

```json
{
  "type": "market:bucket",
  "chain": "robinhood",
  "address": "0x...",
  "bucketTs": "2026-07-15T12:00:00.000Z",
  "sequence": "<monotonic source cursor or ordering tuple>",
  "activity": {},
  "valuation": {},
  "candle": {},
  "coverage": {}
}
```

Rules:

- emit only after the accepted observation/bucket transaction commits;
- preserve a source ordering value sufficient to reject older updates;
- duplicate delivery is safe and idempotent;
- events include chain on the wire and in the room key;
- one Robinhood swap updates the token aggregate, not a protocol-isolated card;
- V2/V3/V4 contributions remain available for diagnostics;
- external metadata lookup is never awaited before emission;
- subscription limits remain enforced per socket;
- authorization and rate limiting remain unchanged or stricter.

### Ranking updates

Token-specific socket events update open cards and charts immediately. Global
Monitored ranking can be reconciled using a bounded scheduled refresh because
one token update can change pagination relative to off-screen tokens.

The client must not claim an exact global order based only on locally received
events. It may optimistically update visible metrics, then reconcile the page
with the backend using a new `asOf` snapshot.

## Frontend state contract

All collections, cache keys and selections use canonical identity:

```text
solana:<base58 address>
robinhood:<lowercase 0x address>
```

At minimum migrate:

- tracked dashboard token maps;
- Monitored rows and pins;
- Recent and Old Week identity arrays;
- search/dismiss/star/block interactions;
- compact and expanded chart caches;
- requested sparkline scopes;
- active chart modal identity;
- socket desired subscriptions;
- token-specific loading and error state;
- per-token refresh/backoff state.

Never key a shared map only by address, even if Solana and Robinhood address
formats currently differ.

### Freshness presentation

- fresh values render normally;
- stale valuation shows its last-observed time and a stale indicator;
- unknown valuation renders `--`, never zero;
- complete zero volume renders `0`;
- unavailable volume renders `--` with coverage explanation;
- insufficient price history renders no percentage, not `0%`;
- absence of recent swaps does not show "removed" or "inactive".

### Chain-native terminology

- shared heading may say `Valuation`;
- Solana detail says `MCAP`;
- Robinhood detail says `FDV`;
- cross-chain valuation sort may retain the existing internal `mcap` sort name
  only as a compatibility adapter, not as visible Robinhood terminology.

## Cache policy

Cache keys include:

- ordered selected chain set;
- canonical token identity where token-specific;
- independent `minMcap` and `minFdv`;
- ordered sort criteria;
- age/search/star/dismiss filters where relevant;
- range and granularity for charts;
- `asOf` or a bounded time bucket for rolling metrics;
- policy/read-model version during rollout.

Invalidation is scoped by chain and identity. A Robinhood swap must not evict a
Solana token's chart merely because an address string happens to compare
similarly.

Realtime events may patch a token cache entry, but paged ranking caches require
reconciliation or bounded invalidation because ordering can change.

## Data migration strategy

### Existing Robinhood catalog rows

Rows marked `robinhood-dashboard-inactive` or
`robinhood-no-swaps-15m` remain valid catalog identities. Migration must make
them queryable without pretending their valuation is fresh.

Do not mass-set `eligible_for_monitoring = true`. The new workspace reader must
stop using that field for membership and read persistent identity separately.

### Existing Solana catalog rows

Do not expose every raw or unsafe Solana catalog artifact automatically. Block
1 must record which existing reasons represent:

- permanent administrative/safety exclusion;
- temporary enrichment or alert suppression;
- source grace period;
- low valuation view filtering;
- lack of recent data;
- archive/cleanup policy.

The new visibility policy preserves safety exclusions but removes only
activity-derived lifecycle behavior. This mapping must be table-driven and
covered by unit tests before replacing queries.

### Historical exit events

Do not delete or rewrite existing `monitored_token_exit_events`. Add semantic
version or consumer-side labeling if needed so historical entries remain
auditable as legacy signal-eligibility exits.

### Optional schema additions

Prefer additive columns only when existing timestamps cannot truthfully
represent:

- `last_market_activity_at`;
- `valuation_observed_at`;
- token-age timestamp provenance;
- normalized coverage/read-model version.

Before adding a column, trace all writers and prove that a derived indexed read
cannot meet correctness or latency. Any schema/init change requires runtime
schema update, schema-check coverage and rollback notes.

## Implementation size estimate

This is a large architectural migration. Current estimate:

- production code: approximately 1,800–2,600 added or materially changed lines;
- focused tests: approximately 900–1,400 lines;
- plan/reference/runbook updates: approximately 200–350 lines;
- total implementation: approximately 2,900–4,350 lines.

These numbers are directional. The Block 0 inventory did not materially change
them; Block 3 query benchmarks may. No implementation patch may attempt the
full change. Each cut should stay near 150–300 changed lines. Mechanical
identity migrations must be split by collection or surface, not bundled into
one giant patch.

## Implementation blocks

### Block 0 - Freeze the architecture and old assumptions

Goal: prevent implementation against the obsolete 15-minute membership model.

Work:

- mark Robinhood Full Workspace Block 7 as dependent on this plan;
- add a decision/reference note to `docs/bot-reference.md` only after code
  begins to change;
- inventory every reader and writer of `eligible_for_monitoring`,
  `is_active_monitor_candidate`, `eligibility_state` and `suppressed_reason`;
- classify each reason as workspace safety, risk/alert state, activity,
  valuation filter or cleanup;
- capture current query counts and latencies for both chains;
- record current Monitored/Radar API payloads as fixtures or focused contract
  assertions where a regression risk exists.

Acceptance:

- no unidentified writer can change a field used by the new visibility policy;
- activity-derived reasons are explicitly separated from safety reasons;
- baseline counts and query latency are recorded;
- no production behavior changes in this block.

Expected implementation cut: 100–220 lines, mostly tests/helpers/docs.

#### Block 0 completion record

Completed: 2026-07-15. This block changed documentation only and made no
production, schema or runtime behavior change.

##### Legacy field ownership inventory

The inventory searched both persisted snake-case fields and their camel-case
write inputs. No new workspace policy may treat any of these legacy fields as
an authoritative visibility flag.

Direct SQL writers:

- `src/models/token-catalog.js` owns shared/Solana upsert, evaluation,
  reactivation, administrative mirror and cleanup writes;
- `src/models/robinhood-catalog.js` owns Robinhood staging, projection, manual
  identity and 15-minute inactivity writes.

Write-intent producers, which call those repositories:

- `src/routes/admin.js` and `src/routes/catalog.js` for explicit administrative
  and catalog mutations;
- `src/services/catalog-worker.js`, `src/services/gmgn-catalog-ingestion.js`
  and `src/services/token-risk-review-sync-worker.js` for Solana evaluation,
  risk gates and automatic administrative blocks;
- `src/services/dex-discovery-worker.js`, `src/services/socket-hub.js`,
  `src/utils/import-bootstrap-token-catalog.js` and manual catalog routes for
  discovery/bootstrap candidate state.

Behavioral readers:

- `src/models/token-catalog.js` uses the fields for Monitored, Radar, top
  performers, evaluation queues, enrichment and cleanup;
- `src/models/robinhood-dashboard-read.js` synthesizes legacy monitoring state
  from 15-minute activity and excludes inactive rows;
- `src/models/token-market-bucket-1m.js`,
  `src/models/monitored-token-exit-event.js`,
  `src/services/token-risk-candidate-selector.js`,
  `src/services/catalog-worker.js` and
  `src/services/gmgn-catalog-ingestion.js` use them for worker, risk, alert or
  audit decisions;
- `src/services/dex-discovery-worker.js` and
  `src/services/manual-token-bootstrap.js` use cleanup state for reactivation;
- `src/routes/catalog.js`, `src/routes/dashboard.js` and
  `src/services/socket-hub.js` expose legacy eligibility in public/runtime
  payloads;
- `src/utils/debug-vol5m-stalls.js`, `src/utils/jupiter-api-probe.js` and
  `src/utils/list-monitored-exit-events.js` are diagnostic/audit consumers.

Schema-only owners are `src/utils/db-init-stage5.js`,
`src/utils/db-init-stage6.js`, `src/utils/db-init-stage21.js` and
`src/utils/runtime-schema.js`.

##### Frozen reason classification

| Existing state or relationship | Classification for the new policy |
| --- | --- |
| `admin_blocked_tokens` | authoritative global hard exclusion |
| `user_blocklist` | authoritative per-user hard exclusion |
| manual `junk_permanent` review | permanent Solana safety exclusion |
| `junk_probable` review | risk/review state; hard only when an administrative block exists |
| `admin-blocked` / `admin_blocked` catalog mirror | legacy signal mirror, not block authority |
| `low_activity_24h`, `dex-low-activity`, `gmgn-low-activity` | activity state; never workspace exclusion |
| `robinhood-no-swaps-15m`, `robinhood-dashboard-inactive` | activity/freshness; never workspace exclusion |
| `mcap_unavailable`, `dex-known-no-mcap`, `gmgn-known-no-mcap` | valuation unavailable; view/data-quality state |
| minimum or maximum MCAP/FDV query bounds | reversible view filter only |
| `gmgn_needs_risk_enrichment`, `gmgn-non-launch-grace` and their reasons | risk/source grace; alert eligibility remains independent |
| `robinhood-staged`, `robinhood-alerts-disabled` | Robinhood alert/rollout gate |
| `robinhood-workspace-read-only`, `robinhood-dashboard-active` | projection compatibility state, not workspace approval |
| `robinhood-manual`, `robinhood-manual-metadata-pending` | persistent identity/metadata readiness, not safety |
| `pending` and launchpad pre-migration states | worker/source lifecycle, not workspace membership |
| `cleanup_quarantine`, `cleanup_soft_archive` | worker/catalog cleanup state; not safety |
| `dex_unavailable`, `gmgn_dex_unavailable_zombie`, `evaluation_error`, `dex_pair_missing`, `unknown` | source/data-quality state; hard only if separately admin-blocked |
| `dex-low/normal/high`, `gmgn-low/normal/high`, `eligible_for_monitoring` | legacy signal/worker eligibility; not workspace membership |

The administrative relationship is deliberately authoritative: the measured
database had five Solana catalog rows with the legacy `admin-blocked` state but
no block relationship, and one block relationship whose catalog mirror did not
carry that state. Using the mirror alone would preserve stale blocks or miss an
active block.

##### Chain extension decision

Chain identity, implementation and runtime availability are separate:

- `solana`, `ethereum`, `bsc`, `base` and `robinhood` remain known identities;
- only a chain with catalog/metric/risk adapters is implemented for a surface;
- only a configured, ready implemented chain is available to workspace reads.

Block 1 must accept the available-chain set or registry instead of hardcoding
Solana and Robinhood. BSC and Base remain valid normalized identities but must
return `unsupported_workspace_chain` until their adapters and readiness exist.
Valuation type is explicit adapter input and must never be inferred from the
chain being EVM.

##### Measured baseline

Snapshot: restored local runtime database `volume_bot_vps_restore` at
`2026-07-15T04:35:50.530Z`, after connection warm-up. Latencies are one
observed run, not an SLO. Live ingestion can move counts after the snapshot.

| Current read | Rows | Observed latency |
| --- | ---: | ---: |
| Solana persistent catalog | 126,555 | included in 1,537.69 ms grouped count |
| Robinhood persistent catalog | 3,652 | included in 1,537.69 ms grouped count |
| Solana legacy Monitored merge, MCAP >= 30k | 473 | 742.27 ms |
| Robinhood 15-minute active merge, FDV >= 30k | 317 | 161.04 ms |
| Solana Radar Recent | 710 | 144.23 ms |
| Solana Radar Old Week | 13,904 | 607.48 ms |
| Robinhood Radar Recent | 0 | 8.12 ms |
| Robinhood Radar Old Week | 0 | 96.55 ms |
| Robinhood exact 50-row page | 50, more available | 3,635.38 ms |

Additional state counts at the snapshot were 14,658 Solana legacy-eligible
rows, 2,440 Robinhood rows suppressed for 15-minute inactivity, 3,028 Solana
rows suppressed for low activity, and 32,574 Solana cleanup rows. A later live
enumeration observed 2,510 Robinhood inactivity rows, confirming that these
counts are moving runtime evidence rather than fixtures.

##### Existing contract baselines

No new test duplicates were added. Existing focused assertions already freeze
the relevant observable contracts:

- `tests/dashboard.test.js` protects lean Solana Monitored, paged Monitored,
  Robinhood FDV-without-MCAP and Recent/Old Week payloads;
- its Radar diagnostic assertion records the obsolete
  `eligible_for_monitoring=false:gmgn-low-activity` exclusion that later blocks
  intentionally remove;
- `tests/robinhood-dashboard-read.test.js` protects the current 15-minute
  activity membership and freshness payload;
- `tests/dashboard-chain-reader.test.js` and
  `tests/dashboard-chain-aggregation.test.js` protect the current combined
  reader, identity deduplication, sorting and pagination behavior.

At Block 0 completion, `docs/bot-reference.md` remained unchanged as required.
Its decision/reference note was then added with the production policy boundary
in Block 1.

### Block 1 - Workspace visibility policy

Goal: introduce a pure, chain-aware policy that does not use recent activity as
membership.

Work:

- implement normalized identity and valuation-filter input;
- map existing hard safety exclusions without weakening them;
- distinguish view filter mismatches from permanent exclusions;
- return reason codes and valuation freshness;
- keep legacy signal/risk eligibility untouched;
- add table-driven unit tests for Solana and Robinhood states.

Acceptance:

- no-swap/stale rows remain workspace-visible;
- an admin-blocked token remains excluded;
- min valuation mismatch is reversible and has no write effect;
- Robinhood FDV and Solana market cap remain separate.

Expected implementation cuts: two cuts of 150–260 lines each, policy then
focused tests.

#### Block 1 completion record

Completed: 2026-07-15.

- added the pure `src/services/workspace-visibility-policy.js` boundary with
  no database dependency or catalog writes;
- canonical identity errors, runtime-unavailable chains, administrative/user
  blocks, chain safety and manual Solana `junk_permanent` reviews return
  distinct hard-exclusion reason codes;
- `junk_probable`, cleanup, inactivity and legacy catalog eligibility do not
  become workspace exclusions;
- risk approval comes only from explicit risk/review input, never from
  `eligible_for_monitoring`;
- valuation input is explicit and chain-native: Solana accepts MCAP and
  Robinhood accepts FDV, while mismatched types are discarded and reported as
  data quality instead of copied;
- minimum/maximum valuation failures are reversible `filterMismatch` values;
- valuation and activity freshness have independent 15-minute defaults;
- BSC/Base remain known identities and can be enabled by supplying chain
  policy, adapters and runtime availability without changing the policy core.

Focused table-driven unit coverage is in
`tests/workspace-visibility-policy.test.js`. The policy is intentionally not
wired into Monitored or Radar readers in this block, so user-visible behavior
and legacy alert/risk state remain unchanged. The two separately applied files
finished at 277 policy lines and 319 test lines.

### Block 2 - Persistent Robinhood catalog reader

Goal: stop using a 15-minute CTE as Robinhood catalog membership.

Work:

- add a persistent Robinhood identity query;
- retain last activity and last valuation timestamps;
- keep the existing 15-minute calculation as freshness only;
- stop `demoteInactive` state from controlling product visibility;
- preserve alert staging and publication safety;
- return stale and unknown metrics honestly.

Acceptance:

- a token last active 40 minutes ago remains queryable;
- its identity read does not claim that projected catalog volume is a complete
  1-hour window; complete `1h` ranking is delivered by the Block 3 adapter;
- its valuation is marked stale;
- no row is made alert-eligible by this change;
- latest activity is resolved across all supported protocols by token.

Expected implementation cuts: repository 180–280 lines; tests 150–250 lines.

#### Block 2 completion record

Completed: 2026-07-15.

- added the bounded, read-only
  `src/models/robinhood-workspace-catalog-read.js` repository, whose membership
  starts from persistent Robinhood `token_catalog` identities instead of a
  recent-activity CTE;
- `lastActivityAt` is the latest accepted observation across Robinhood
  Uniswap V2/V3/V4 hourly buckets, while FDV and `valuationObservedAt` come
  from the latest positive accepted FDV observation;
- the repository intentionally does not use `token_catalog.last_seen_at`,
  because a manually inserted identity receives that timestamp without any
  on-chain activity;
- the 15-minute boundary is applied only by the Block 1 policy to activity and
  valuation freshness; it is absent from catalog membership SQL;
- identities without bucket evidence return unknown activity/valuation, and
  rolling window metrics explicitly return `unavailable` until Block 3 rather
  than exposing projected catalog snapshots as complete windows;
- administrative blocks are evaluated by the policy after the identity is
  read. Legacy lifecycle/monitoring eligibility does not filter membership;
- the new path performs no writes and is not wired to current product routes,
  `demoteInactive`, alert staging or alert publication.

Focused coverage in `tests/robinhood-workspace-catalog-read.test.js` protects
the 40-minute stale case, manual-token unknown state, authoritative admin
block, stable address keyset pagination, input validation and the read-only SQL
boundary. The separately applied files finished at 216 repository lines and
156 test lines. Complete rolling-window aggregation and ranking remain Block 3
work by design.

### Block 3 - Window metric adapters and performance proof

Goal: provide comparable `5m/1h/6h/24h` semantics without unifying ingestion.

Work:

- implement Solana and Robinhood normalized metric adapters;
- define one `asOf` boundary per request;
- distinguish complete zero, partial and unavailable coverage;
- preserve Robinhood V2/V3/V4 token aggregation;
- benchmark representative catalog sizes and sort windows;
- inspect query plans and add only justified indexes;
- decide from evidence whether a persisted current-metrics read model is
  required.

Acceptance:

- a Robinhood token with no swap in 15 minutes but volume 40 minutes ago has
  zero `5m` and positive `1h`;
- no baseline produces `null` price change;
- both adapters return equivalent normalized semantics;
- p95 query budget is defined from measured local/production-like evidence;
- any schema change passes runtime and test schema checks.

Expected implementation cuts: one adapter per cut, 180–300 lines each; shared
coverage helpers and tests in separate cuts.

#### Block 3 completion record

Completed: 2026-07-15.

- added `src/services/workspace-window-metrics.js` as the shared normalized
  contract for minute-aligned `asOf`, `5m/1h/6h/24h` volume/swap windows,
  `1h/6h/24h` price changes and explicit `complete`, `partial` or
  `unavailable` coverage;
- a complete window without observations becomes numeric zero. Partial values
  remain visible but partial, unavailable values remain `null`, and a missing
  or insufficiently close price baseline produces `null` price change;
- added `src/models/robinhood-workspace-window-read.js`. It aggregates token
  volume and swaps across accepted Uniswap V2/V3/V4 minute buckets and uses
  an explicit immutable origin on the market ingestion cursor to prove
  continuous coverage; cursor `created_at` is not chain-history evidence. One
  deterministic primary market is selected only for comparable
  current/baseline prices;
- Robinhood latest activity prefers the current minute buckets and falls back
  to permanent hourly buckets; it is not restricted to the active pool
  registry or legacy monitoring eligibility;
- Stage 74 initializes existing Robinhood origins at their last checkpoint,
  so longer windows remain incomplete until enough continuous history accrues;
- added `src/models/solana-workspace-window-read.js`. It reads the latest
  rolling volume snapshot and price history without pretending that Solana
  ingestion is identical to Robinhood ingestion;
- current Solana rolling snapshots cannot prove equivalent swap counts or an
  exact last-swap timestamp. PumpFun pre-migration buckets are minute-aligned
  and their in-memory stream has no restart-safe continuity cursor, so these
  fields remain unavailable for that source too;
- added `src/services/rolling-volume-coverage.js` and persisted per-window
  provenance in `token_market_volume_buckets_1m.window_coverage`. A direct
  upstream value can be complete; a value preserved or filled from another
  source stays partial unless token age proves the shorter window covers its
  complete lifetime;
- legacy Solana rows receive `{}` rather than a guessed backfill. The adapter
  therefore preserves their numeric values as partial until a new ingestion
  write establishes provenance;
- coverage provenance is stored as `{ state, source }` per window. Legacy
  string states remain readable with unknown source, while same-minute writes
  merge each value and its source atomically;
- Stage 75 adds a `NOT VALID` constraint for allowed window keys, states and
  structured sources without scanning the historical table. The test schema
  profile now verifies Stages 63, 73, 74 and 75 against the real test database;
- Stage 73 adds the JSONB column using a constant default and creates its
  object check as `NOT VALID`, avoiding an immediate validation scan of the
  approximately 31 million existing rows while still enforcing the check for
  new writes. A later maintenance window may validate the legacy rows;
- fixed `token-market-volume-bucket-1m` normalization so SQL `null`/empty
  volume is no longer converted into numeric zero by `Number(null)`;
- GMGN, Dexscreener and manual pre-migration write paths now attach provenance
  derived from the raw snapshot before normalized/preserved values are stored;
- no product route, catalog lifecycle field, risk gate or alert publication
  path was changed in this block.

Performance evidence from the restored local database:

| Adapter/read | Observed latency |
| --- | ---: |
| Robinhood page 1 / 30 / 100 | 31 ms / 544 ms / 2,271 ms |
| Solana valid-identity page 1 / 30 / 100 | 38 ms / 18 ms / 39 ms |
| Robinhood warmed page 30, 20 samples | p50 15 ms / p95 17 ms / max 246 ms |
| Solana warmed page 30, 20 samples | p50 13 ms / p95 20 ms / max 175 ms |
| Solana legacy-row validation after Stage 73 | 84 ms |

`EXPLAIN ANALYZE` for page 30 used the existing token/time indexes. Solana
planned/executed in 15.932/11.173 ms; Robinhood planned/executed in
31.101/353.628 ms on a colder run. The only Robinhood sequential scan was the
small cursor table, not either bucket table. The evidence does not justify a
new index or persisted current-metrics read model in this block.

Block 4 should target p95 at or below 750 ms per chain adapter for a normal
30-row page on production-like local data, a combined hydration target at or
below 1.5 seconds and the existing 15-second hard statement timeout. The
2.271-second Robinhood 100-address cold observation is why Block 4 must keep
per-chain prefixes bounded and must not hydrate the complete catalog.

Focused unit/contract coverage protects the 40-minute Robinhood example,
cross-protocol aggregation, same-market price baselines, missing baselines,
Solana provenance, complete-zero semantics, bounded identities and Stages
63, 73, 74 and 75. The migrations were applied to the local restored database
and isolated test database; both runtime and test schema profiles passed after
the corrective audit.

### Block 4 - Exact Monitored queries and combined pagination

Goal: make Monitored a persistent-universe leaderboard with bounded reads.

Work:

- route each selected chain to its adapter;
- apply independent default/adjustable valuation filters;
- implement equivalent multi-sort and missing-value ordering;
- fetch bounded per-chain prefixes for exact combined pages;
- use a stable `asOf` across page hydration;
- include coverage and freshness in payloads;
- version cache keys and invalidation;
- preserve canonical pins.

Acceptance:

- changing from `5m` to `1h` can reveal/rank a token whose latest swap is
  older than 15 minutes;
- a zero-volume token remains in the filtered total and sorts below positive
  complete volume;
- combined total and page ordering are exact;
- no request loads the complete unbounded catalog;
- raising/lowering valuation filters performs no database mutation.

Expected implementation cuts: route/DTO 150–250 lines; pagination coordinator
180–280 lines; repository query changes and tests in separate cuts.

### Block 5 - Persistent Radar queries

Goal: make Recent and Old Week historical catalog views independent of
Monitored eligibility.

Work:

- replace `eligible_for_monitoring` membership in history bootstrap;
- apply chain-specific valuation bounds;
- preserve age, search, starred, dismissed and pinned identity filters;
- return token-age provenance and unknown-age state;
- remove Robinhood calls to Solana Meteora, bid-zone and market baseline paths;
- use normalized historical coverage.

Acceptance:

- Robinhood rows can enter Recent and Old Week;
- a token remains in Radar after days without swaps;
- Solana safety exclusions remain enforced;
- no FDV value is placed in `mcap`;
- Robinhood history bootstrap triggers no Solana-native market request.

Expected implementation cuts: backend query 200–300 lines; route assembly
150–250 lines; focused tests in a separate cut.

### Block 6 - Frontend identity, filters and freshness

Goal: render the new semantics without address-only state or false currency.

Work:

- migrate remaining Monitored/Radar maps and requests to canonical identity;
- add normalized valuation and freshness rendering;
- show zero versus unavailable coverage correctly;
- preserve user-adjustable `minMcap` and `minFdv` independently;
- hydrate pages under one `asOf` snapshot;
- keep stale tokens visible and stop inactive/removal wording;
- preserve chain-aware pin/star/block/manual actions from earlier blocks.

Acceptance:

- Solana and Robinhood identities cannot collide in state or DOM keys;
- Robinhood cards say FDV;
- stale last-observed valuation is visibly stale;
- no-activity rows are not presented as removed;
- frontend build passes with no new lint warning.

Expected implementation cuts: state/types 180–280 lines; controller/network
180–300 lines; Monitored UI and Radar UI as separate 150–280 line cuts.

### Block 7 - Chain-aware realtime market events

Goal: update metrics and charts as accepted swaps arrive.

Work:

- migrate socket rooms to `(chain,address)`;
- keep address-only subscription as a temporary Solana adapter;
- include chain and ordering information in `market:bucket` events;
- connect Robinhood committed bucket updates to the socket boundary;
- aggregate token activity across V2/V3/V4 before user-visible emission;
- make frontend merges idempotent and reject older updates;
- reconcile global ranking on a bounded cadence.

Acceptance:

- a Robinhood swap updates an open Robinhood token without touching Solana;
- duplicate/out-of-order events cannot regress the visible candle or metric;
- reconnect restores desired canonical subscriptions;
- metadata failures cannot delay swap processing;
- subscription authorization and limits remain intact.

Expected implementation cuts: socket protocol 150–250 lines; Robinhood event
bridge 180–300 lines; frontend client/merge 180–280 lines; tests separately.

### Block 8 - Native history and expanded charts

Goal: complete the original Robinhood Full Workspace Block 7 on the corrected
catalog/activity foundation.

Work:

- add chain-aware sparkline/history routes;
- implement Robinhood minute/hour bucket selection;
- aggregate activity and select deterministic price/FDV candles;
- carry chain through chart caches and modal routes;
- merge realtime committed candles;
- render gaps and insufficient history honestly;
- prevent all Solana-only auxiliary requests for Robinhood charts.

Acceptance:

- Robinhood charts contain only Robinhood observations;
- FDV is the valuation chart metric and price USD may be shown as auxiliary
  detail;
- 14-day minute retention and older hourly resolution are represented
  truthfully;
- realtime swaps update the open chart;
- no fabricated zero candle appears in a gap.

Expected implementation cuts: Robinhood history reader 200–300 lines; routes
and DTOs 150–250 lines; frontend caches/modal 200–300 lines; UI/tests separate.

### Block 9 - Legacy lifecycle cleanup

Goal: remove obsolete product dependencies without erasing useful risk history.

Work:

- remove dashboard reads of `robinhood-dashboard-inactive` and
  `robinhood-no-swaps-15m`;
- rename or document remaining demotion as diagnostic/risk state if still
  required;
- audit consumers of monitored exit events;
- remove obsolete address-only internal adapters after telemetry proves no
  caller remains;
- remove shadow response fields after the deprecation window;
- update bot reference and operational runbook.

Acceptance:

- no workspace query treats activity freshness as lifecycle;
- legacy fields have an explicit remaining owner or are removed safely;
- old clients no longer use deprecated adapters before deletion;
- historical audit data remains readable.

Expected implementation cuts: one legacy concern per 100–250 line cut.

### Block 10 - Rollout and closure

Goal: prove correctness, performance and operational safety across both chains.

Work:

- shadow-run new and legacy Monitored reads and compare documented differences;
- validate Solana-only, Robinhood-only and combined modes;
- run visible smoke flows for Monitored, Radar and expanded charts;
- observe query latency, counts, cache behavior and socket delivery;
- verify restart/backfill behavior and partial coverage UI;
- close superseded sections in the Robinhood workspace plan only after all
  acceptance gates pass.

Acceptance:

- no inactivity-based disappearance;
- no safety or alert eligibility regression;
- exact combined ordering and totals;
- no cross-chain identity leak;
- latency remains within the measured budget;
- rollback has been rehearsed or proven through the version switch.

## Required tests by risk

### Unit tests

Use unit tests for deterministic policy and calculation:

- workspace visibility reason mapping;
- independent market-cap and FDV filters;
- valuation freshness normalization;
- complete zero versus unavailable coverage;
- multi-sort missing-value ordering;
- bounded prefix merge correctness, including ties;
- canonical socket room identity;
- duplicate and out-of-order event reduction;
- Robinhood multiprotocol metric and primary-market selection.

Prefer table-driven additions to existing relevant suites. Do not repeat DTO
field mapping at multiple layers.

### Integration tests

Use integration tests for public contracts and persistence:

- Monitored route for Solana, Robinhood and combined mode;
- a token last active 40 minutes ago ranked by positive 1-hour volume;
- a complete zero-volume token retained in total and pagination;
- Radar history independent from `eligible_for_monitoring`;
- user filters do not write lifecycle fields;
- admin/user blocks remain effective;
- chain-aware socket subscription authorization and delivery;
- schema/init and indexes if any persisted read model is added.

### Smoke tests

Use a minimal browser suite for behavior not cheaply protected below:

- select Robinhood, choose Monitored `1h`, and retain a stale-but-relevant row;
- change the FDV floor and observe reversible visibility;
- open Radar history for a token without recent swaps;
- open a Robinhood chart and receive one realtime update;
- verify Robinhood surfaces do not call Meteora/bid-zone endpoints;
- switch combined mode and preserve chain badges/actions.

Do not reproduce every filter combination in Playwright.

## Validation checklist per block

For every edited implementation block:

1. run `npm run lint` first;
2. fix any new warning in changed files;
3. run focused `node --test ...` suites for affected contracts;
4. run `npm --prefix frontend run build` after frontend changes;
5. run `npm run db:schema-check` and test schema check after schema/init changes;
6. run applicable `npm run test:smoke` after assembled visible flows;
7. inspect `git diff --check` and scoped `git diff`;
8. preserve unrelated dirty-worktree changes;
9. do not edit `.env.example` as part of this plan;
10. commit each block/scope separately only after validation.

## Performance and observability

Record at minimum:

- filtered catalog count per chain;
- rows fetched per chain for a combined page;
- Monitored/Radar query duration and timeout count;
- cache hit/miss by chain, view and policy version;
- number and age distribution of stale valuations;
- coverage status counts by window;
- socket subscriptions by chain;
- accepted, emitted, duplicated, dropped and out-of-order market events;
- time from committed Robinhood swap bucket to client event;
- frontend reconciliation frequency and page reorder count.

Initial latency budgets must be based on measured repository/runtime behavior,
not invented in this document. Block 0 captures baseline and Block 3 establishes
the target budget before rollout.

## Rollout strategy

1. Add normalized fields and policy behind a versioned read path.
2. Shadow new Monitored/Radar queries without changing user-visible responses.
3. Compare totals after accounting for the intentional removal of activity
   membership.
4. Enable Robinhood-only for internal/admin validation.
5. Enable combined mode after exact pagination and identity tests pass.
6. Enable chain-aware realtime subscriptions with the Solana adapter retained.
7. Enable native Robinhood charts.
8. Remove legacy adapters only after telemetry shows no remaining caller.

Expected shadow differences are tokens previously excluded solely by recent
activity. Unexpected differences include blocked/junk tokens, wrong valuation
type, missing chain identity, incorrect totals or cross-chain leakage.

## Rollback strategy

- keep the legacy read path selectable during the shadow/deprecation window;
- make schema changes additive until the new path is stable;
- retain the Solana address-only socket adapter while rolling back clients is
  possible;
- disable Robinhood realtime/chart capability independently from ingestion;
- never roll back by deleting catalog identities or historical buckets;
- preserve user pins, stars, folders, blocklist and manual tokens;
- if combined pagination fails, fall back to per-chain views rather than
  returning an inexact mixed page;
- if coverage is uncertain, render partial/unavailable rather than zero.

## Important points

1. Removing the 15-minute membership gate will increase visible/queryable
   Robinhood counts substantially. The pagination redesign must land before the
   product query starts reading the persistent universe.
2. The old 15-minute threshold is not deleted conceptually. It becomes a
   freshness badge and data-quality signal, which is the role it can support
   truthfully.
3. The USD 30,000 floor hides rows by default but never destroys them. Tokens
   can reappear automatically after valuation recovery or a user filter change.
4. Last-observed FDV or market cap can be stale. A token with no swaps cannot
   have its on-chain valuation described as current without another trusted
   price observation.
5. Monitored and Radar may show a token that is not eligible for alerts. The UI
   must not imply alert approval from presence in either view.
6. Realtime visible metrics do not make client-side global ranking exact.
   Backend reconciliation remains necessary because off-screen rows also move.
7. `eligible_for_monitoring` is too overloaded to rename casually. First stop
   product reads from depending on it; decompose writers only after inventory.
8. Solana and Robinhood share product semantics but retain chain-native sources
   and valuation types. A generic SQL substitution is not sufficient.
9. Robinhood activity must remain token-level across V2/V3/V4. A realtime event
   from one market cannot replace aggregate token totals with that market alone.
10. The current combined implementation loads full candidate sets. Expanding
    its membership before bounded pagination would be a performance regression.
11. Historical charts and current leaderboard metrics have different retention
    and coverage contracts. Neither should fabricate data to look continuous.
12. The original Robinhood Full Workspace Block 7 is blocked on at least Blocks
    1–5 of this plan and is completed by Blocks 7–8 here.

## Open decision before the relevant implementation block

The pinned-token behavior described in Block 4 is resolved. There are no open
product decisions required by the current implementation blocks.

## Completion definition

This architecture is complete only when all of the following are true:

- catalog identities persist independently from swap frequency;
- Monitored ranks the filtered persistent universe over the selected window;
- selecting `1h`, `6h` or `24h` is not constrained by a hidden 15-minute gate;
- Radar history remains queryable without recent swaps;
- valuation floors are reversible view filters;
- stale and unavailable data are represented honestly;
- Solana market cap and Robinhood FDV remain semantically separate;
- risk and alert eligibility remain at least as strict as before;
- combined pagination is exact and bounded;
- caches, actions, routes and sockets use `(chain,address)`;
- Robinhood swaps update metrics and charts in realtime after commit;
- no Robinhood surface invokes a Solana-native market dependency;
- all mandatory lint, build, focused tests, schema checks and smoke validations
  pass without new warnings.
