# Monitor Sparklines Plan

## Purpose
This document defines the first implementation plan for market sparklines in the `/monitor` workspace.

The goal is intentionally narrow:
- show a compact market sparkline in `Recent Tokens` and `Old Tokens 1 Week+`
- use a `48h` lookback window
- return `240` visual points per token
- limit the first version to the `15` visible tokens in `recent` and the `15` visible tokens in `old-week`
- refresh the sparkline data every `1 minute`

This plan is grounded in the current repository behavior, not in assumptions from the old bot versions.

## Current Code Reality

### What already exists
- market history already exists in `token_market_buckets_1m`
- per-token history can already be loaded through:
  - `src/models/token-market-bucket-1m.js`
  - `listHistoryByAddress(...)`
- there is already a generic API route for bucket history:
  - `GET /api/catalog/history/:address`
  - file: `src/routes/catalog.js`

Important code-backed facts:
- `token_market_buckets_1m` is the current main market-history path
- the catalog worker writes minute buckets during normal token evaluation
- fresh raw `token_market_snapshots` are no longer the normal live path

Relevant references:
- `docs/current-bot-state.md`
- `src/models/token-market-bucket-1m.js`
- `src/routes/catalog.js`

### What the `/monitor` workspace does today
`Recent Tokens` and `Old Tokens 1 Week+` in the `/monitor` workspace are no longer purely local derived lists there.

Current flow:
1. frontend leader tab calls `POST /api/dashboard/history-bootstrap`
2. backend returns paged `recent` and `oldWeek` token slices
3. frontend applies those slices into the shared tracked-token store
4. follower tabs receive synchronized state through `BroadcastChannel`

Relevant files:
- `frontend/src/state/app-controller.ts`
- `frontend/src/services/api/catalog.ts`
- `src/routes/dashboard.js`

Important implication:
- if sparkline payload is embedded directly into `history-bootstrap`, it becomes part of the main `/monitor` refresh path
- that increases coupling between token metadata refresh and chart-series refresh
- that is not ideal for a first version

### Why the initial idea of sending raw `48h` history is not ideal
With `1m` buckets:
- `48h` = `2880` points per token

With the requested first-scope visible set:
- `15 recent + 15 old-week = 30 tokens`
- `30 * 2880 = 86,400` raw points per refresh

Even with a `1m` refresh interval, this is still more data than a compact table sparkline needs.

The main problem is not only database cost.
The bigger problems are:
- unnecessary JSON payload size
- unnecessary parse/serialize work
- unnecessary frontend diff churn
- avoidable coupling with the tracked-token refresh pipeline

## V1 Decision

### Final V1 scope
The first implementation should use:
- workspace: `/monitor`
- surfaces:
  - `Recent Tokens`
  - `Old Tokens 1 Week+`
- lookback window: `48h`
- visual point count: `240`
- refresh cadence: every `1m`
- token scope per refresh:
  - only the `15` visible tokens from `recent`
  - only the `15` visible tokens from `old-week`

### Series source
The source of truth should remain:
- `token_market_buckets_1m.close_mcap`

Why `mcap` first:
- it already aligns with the live product emphasis
- it avoids introducing a second visual interpretation axis in v1
- the older market-history planning already identified `price` and `mcap` as the meaningful long-lived series, not rolling volume windows

### Downsampling requirement
The backend should not send all `2880` raw points for the initial sparkline response.

Instead:
- backend reads up to `48h` of `1m` buckets
- backend compresses that series to `240` visual points
- frontend renders the compact series only

Reason:
- `240` points is dense enough to show the `48h` shape
- `240` points is still lightweight for a compact table cell
- it avoids turning a small monitor-side visual into a heavy transport format

## Proposed Architecture

### Backend
Add a dedicated batch endpoint for sparklines instead of reusing the generic per-token history route.

Suggested endpoint:
- `POST /api/catalog/sparklines`

Suggested request shape:
```json
{
  "addresses": ["tokenA", "tokenB"],
  "hours": 48,
  "points": 240
}
```

Suggested response shape:
```json
{
  "generatedAt": "2026-04-20T12:00:00.000Z",
  "hours": 48,
  "points": 240,
  "items": [
    {
      "address": "tokenA",
      "pairAddress": "pair123",
      "coverageRatio": 0.93,
      "series": [120000, 121300, 119800]
    }
  ]
}
```

Notes:
- `series` should be numeric and already ordered for rendering
- include `coverageRatio` so the frontend can dim or mark weak charts later if needed
- keep the payload focused on chart rendering only

### Frontend
Do not store sparkline arrays inside `trackedTokensByAddress`.

Use a separate cache, for example:
- `sparklineByAddress`

Reason:
- the current tracked-token equivalence check is optimized for token fields, not chart arrays
- arrays recreated on each refresh would increase invalidations and rerender pressure
- a dedicated cache keeps the existing monitored/history token pipeline simpler

Suggested behavior:
- when `/monitor` is active, collect visible token addresses from:
  - current `recent` page
  - current `old-week` page
- request sparklines for those addresses only
- refresh every `1m`
- followers can receive the sparkline snapshot through the existing history-tab leadership model if we decide to broadcast it in the same style later

Important:
- the target is to keep sparkline refresh aligned with the token snapshot cadence in `/monitor`
- this does not guarantee that every token will always gain a brand-new bucket each minute, because bucket writes still depend on worker evaluation cadence

### UI
The current routed panels are table-style surfaces, not large cards.

Relevant file:
- `frontend/src/ui/sections/shared.ts`

Implication:
- sparkline should be added as a dedicated compact table column
- v1 should avoid expanded hover charts, overlays, or drilldown behavior
- the first goal is to validate:
  - layout fit
  - signal readability
  - runtime cost

## Performance Expectation

### Expected backend cost
For v1:
- max tokens per refresh: `30`
- visual points returned: `30 * 240 = 7,200`

This is a low-risk response size for a `1m` refresh cadence.

The heavier part is reading the `48h` raw bucket history before downsampling, but even that is bounded:
- max raw bucket rows read: `30 * 2880 = 86,400`

At a `1m` cadence and only for the leader `/monitor` tab, this is still acceptable for a controlled first version.

### Expected frontend cost
Frontend cost should be low if:
- sparkline data is kept outside `trackedTokensByAddress`
- only visible routed-page tokens are requested
- the chart is rendered as a very small SVG or canvas line
- refresh happens every `1m`, not every `3s`

This means the expected practical cost is:
- low network cost
- low parse cost
- low paint cost
- low memory churn

### What would make it expensive
Avoid these in v1:
- embedding raw `48h` arrays into `history-bootstrap`
- sending all `2880` minute points to the browser
- refreshing the sparkline with the same cadence as monitored token refresh
- storing the series directly inside each tracked token object

## Risks And Constraints

### Pair churn
The chart can mislead if the effective best pair changes inside the `48h` window.

V1 stance:
- do not block the feature on full pair-churn handling
- but keep the pair identity available in the response so we can refine this later

### Coverage gaps
Some tokens will not have a perfect `48h` minute-by-minute series because bucket persistence depends on worker evaluation cadence.

V1 stance:
- allow incomplete series
- return `coverageRatio`
- do not fake a “perfect” line if history is sparse

### Visual interpretation
This first version validates the monitor UX, not final chart semantics.

That means:
- no attempt to infer support/resistance from the sparkline
- no chart-driven alerts
- no coupling to backend signal logic

## Implementation Blocks

### Block 1 - Backend sparkline read path
Scope:
- add a dedicated batch endpoint for routed monitor sparklines
- validate addresses/hours/points inputs
- read `48h` bucket history per address
- downsample to `240` points

Expected output:
- a stable backend contract for chart series only

### Block 2 - Frontend sparkline cache and fetch loop
Scope:
- add a separate `sparklineByAddress` cache
- fetch only visible `recent` and `old-week` addresses
- refresh every `1m`
- keep this separate from `history-bootstrap`

Expected output:
- chart data lifecycle without inflating tracked-token refresh cost

### Block 3 - Routed table rendering
Scope:
- add a compact sparkline column to `recent` and `old-week`
- render only when chart data exists
- keep layout compact and readable

Expected output:
- visible v1 sparkline in the monitor tables

### Block 4 - Validation and tuning
Scope:
- verify payload size and render behavior
- verify visible-page token limiting works
- test sparse-history tokens
- tune visual density if `240` points looks too dense or too thin

Expected output:
- confidence that the monitor version is cheap enough and visually useful

## Validation Checklist

When implementation starts, the minimum validation should include:
- `npm run lint`
- affected `node --test ...` suites for:
  - dashboard/history routes
  - catalog route additions
  - any new sparkline utility
- `npm --prefix frontend run build`
- review `git diff` before any commit suggestion

## Decision Summary
The first sparkline version should be:
- in `/monitor`, not `/alerts`
- only for `Recent Tokens` and `Old Tokens 1 Week+`
- only for the `15` visible tokens from each list
- based on `48h` of `1m` market buckets
- delivered as `240` downsampled `mcap` points
- refreshed every `1m`
- implemented through a separate sparkline pipeline, not embedded into `history-bootstrap`
