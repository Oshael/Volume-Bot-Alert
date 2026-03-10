# Next Backend Architecture

## Current Progress
- Phase 1 started.
- Database init script created: `src/utils/db-init-stage5.js`.
- Base model created: `src/models/token-catalog.js`.
- Phase 1.5 started: operational catalog fields + first eligibility worker scaffold added.
- Phase 2 started: `token_market_snapshots` schema + first market snapshot worker scaffold added.

## Goal
Move the bot from frontend-heavy monitoring to backend-owned token memory and historical market data.

## Phase Objective
After V68 is stable, the backend becomes the long-term source of truth for:
- known tokens
- monitoring eligibility
- MCAP/price history
- Meteora pool history

The frontend remains the UI, filters, and interaction layer.

## Core Components

### 1. Permanent token catalog
A backend table of all tokens known by the product.

Suggested fields:
- `address`
- `symbol`
- `name`
- `chain`
- `first_seen_at`
- `last_seen_at`
- `last_mcap`
- `last_price`
- `last_pair_address`
- `last_pair_url`
- `last_image_url`
- `last_twitter_url`
- `source` (`bootstrap`, `manual`, `trending`, `pumpfun`, `meteora`, etc.)
- `is_active_monitor_candidate`

Purpose:
- token can leave visible bars without being forgotten
- token can become eligible again when rules fit
- bootstrap seed and discovered tokens converge into one catalog

### 2. Monitoring eligibility layer
Separate logic from visibility.

Concept:
- token may be out of visible UI range
- backend still keeps last known state
- backend periodically reevaluates whether the token should re-enter active monitoring

Suggested derived states:
- `visible_now`
- `eligible_for_recent`
- `eligible_for_old_week`
- `suppressed_by_dismiss`
- `suppressed_by_blocklist`
- `inactive_but_known`

### 3. MCAP/price history store
Persist snapshots over time for real historical comparisons.

Suggested table:
- `token_market_snapshots`
  - `token_address`
  - `ts`
  - `mcap`
  - `price`
  - `vol_5m`
  - `vol_1h`
  - `vol_6h`
  - `vol_24h`

Use cases:
- stable 5m delta without frontend baseline jumps
- future sparkline mini-chart
- server-side alert logic based on true history

Recommended retention strategy:
- dense retention for recent windows
- optional rollups later for older data

### 4. Meteora pool history store
Persist TVL over time instead of keeping it only in frontend memory.

Suggested table:
- `token_meteora_snapshots`
  - `token_address`
  - `ts`
  - `tvl`
  - `pool_count`
  - `pool_address` (optional representative/latest)

Use cases:
- real 1H / 6H / 24H Meteora movement
- backend-driven tooltip values
- historical pool analytics later

### 5. Bootstrap seed becomes catalog input, not monitor spam
The current seed should evolve into catalog seeding, not frontend active polling of all 85 tokens.

Better future behavior:
- backend imports seed tokens into permanent catalog
- backend decides which subset is actively monitored right now
- frontend receives only the relevant visible/eligible subset

### 6. Frontend API shape after backendization
Suggested endpoints:
- `GET /api/catalog/visible`
- `GET /api/catalog/history/:address`
- `GET /api/catalog/sparkline/:address`
- `GET /api/catalog/meteora/:address/history`

Or a consolidated shape:
- `GET /api/dashboard/bootstrap`
  - visible monitored tokens
  - visible recent/old-week tokens
  - sparkline summaries
  - latest Meteora deltas

## Processing Model

### Ingestion
Backend workers ingest from:
- DexScreener
- PumpFun
- Meteora
- bootstrap seed
- manual user additions

### Evaluation
Backend periodically evaluates:
- token eligibility for monitoring
- token eligibility for Recent / Old Week bars
- alert conditions
- re-entry conditions when MCAP range becomes valid again

### Delivery
Frontend receives prepared state instead of raw heavy polling burden.

## Why This Solves Current Pain
- fewer frontend API bursts
- fewer CORS/proxy/rate-limit issues in browser
- stable historical deltas
- real sparkline data on page load
- token memory that survives visibility changes
- cleaner path to make the frontend non-copy-critical

## Recommended Build Order
1. Permanent token catalog table + seed importer.
2. Operational catalog fields and first eligibility worker.
3. Snapshot tables for MCAP/price and Meteora TVL.
4. Background polling workers in backend.
5. Eligibility engine for re-entry into monitoring.
6. Read APIs for frontend visible state.
7. Sparkline endpoint/UI.
8. Gradual removal of equivalent heavy polling from frontend.
