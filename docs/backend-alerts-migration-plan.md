# Backend Alerts Migration Plan

## Purpose
This document records the ideal staged plan for moving alert ownership from the frontend to the backend without throwing away the current bot architecture.

It is intentionally based on the current repository behavior rather than a greenfield assumption.

The goal is not just "send alerts from the backend".

The real target is:
- keep the current catalog/monitoring pipeline as the canonical market-state engine
- progressively shift alert detection, persistence, and delivery to the backend
- preserve correctness during migration
- end with a much simpler frontend that consumes alert events instead of owning alert logic

This plan is designed to survive chat switches and serve as the canonical roadmap for the migration.

## Current Code Reality

### What exists today
- `src/services/catalog-worker.js`
  - already performs the canonical backend token reevaluation loop
  - already computes the market fields that alerts depend on:
    - `mcap`
    - `priceUsd`
    - `volume5m`
    - `volume1h`
    - `volume6h`
    - `volume24h`
    - `priceChange1h`
    - `priceChange6h`
    - `priceChange24h`
    - `prevMcap`
    - `mcapDelta`
- `src/models/token-catalog.js`
  - already persists the latest token state and monitoring priority
- `frontend/src/state/app-controller.ts`
  - currently owns monitored alert evaluation
  - currently owns special alert evaluation
  - currently owns alert cooldown, dedupe, and single-fire session flags
  - currently stores alert cards in browser-local storage
- `src/models/user-config.js`
  - already persists per-user alert-related configs and filters
- `src/routes/config.js`
  - already exposes user config bootstrap
- `src/routes/dashboard.js`
  - already exposes the monitored state consumed by the frontend
- `src/services/socket-hub.js`
  - already provides authenticated realtime delivery infrastructure

### What this means
- the backend already knows token state
- the frontend already knows user preferences
- what is missing is a backend-owned alert subsystem:
  - alert rule ownership
  - per-user alert evaluation state
  - persisted alert events
  - delivery recovery after disconnect/reload

### Important architectural truth
The current monitored alerts are not just threshold comparisons.

The frontend logic currently depends on:
- user configs
- tracked token state
- session-local baselines
- session-local single-fire flags
- cross-alert cooldown
- duplicate suppression

That means moving alerts to the backend is not a transport change.

It is a state-model change.

## Product Goal

### End-state goal
Reach a backend-owned alert engine where:
- the backend decides whether an alert exists
- the backend persists alert events
- the backend can replay missed events after reconnect/reload
- the frontend only consumes and displays alert events
- the frontend no longer needs to rebuild monitored alert logic locally

### Migration principle
Do not try to replace the current frontend alert engine in one step.

Instead:
1. introduce backend event generation
2. compare it against the current frontend behavior
3. gradually move rule ownership
4. only then retire the frontend engine

This is the difference between a survivable migration and a rewrite trap.

## Current incremental landing zone

The repository now has backend-owned alert paths for monitored alerts, surge variants, Meteora, and GMGN claim signals.

What this proves:
- backend detection can read canonical market buckets
- backend event persistence can work without relying on an open browser tab
- frontend can consume backend-emitted alert events instead of deciding that rule locally
- authenticated socket delivery can be layered on top of persisted events instead of replacing them
- per-user per-rule delivery cursors can track replay/seen progress separately from browser-local alert state

What it does **not** prove yet:
- that the broader monitored-alert system is ready to move backend-side as-is
- that per-user thresholds or cooldown semantics can be layered onto the current global event tables

Important:
- the larger migration still needs per-user state for rules that depend on user config, session semantics, or individualized cooldowns

## Non-Goals
- rewriting the entire bot from scratch
- replacing the catalog worker as the canonical market-state loop
- requiring the backend to support arbitrary user-defined formula scripting
- introducing a second parallel token reevaluation pipeline

## Target Architecture

### Core split
Keep these responsibilities:

#### Canonical market-state engine
- owner: existing backend catalog pipeline
- source: `catalog-worker`
- output: current token state in `token_catalog`

#### Alert evaluation engine
- owner: new backend alert subsystem
- input:
  - canonical token state changes
  - user configs / subscriptions
  - persisted per-user alert state
- output:
  - persisted alert events
  - optional realtime socket pushes

#### Alert delivery layer
- owner: backend API + socket
- responsibilities:
  - unread fetch / replay
  - realtime push
  - ack/read cursor tracking when needed

#### Alert presentation layer
- owner: frontend
- responsibilities:
  - read alert feed
  - display alert cards / sounds / filters
  - no longer decide if the alert exists

## Recommended End-State Data Model

### 1. `alert_rule_templates`
Purpose:
- define backend-supported rule types

Examples:
- monitored volume threshold
- monitored mcap threshold
- HVNC
- old surge 1h
- old surge 6h
- meteora surge
- pumpfun volume
- pumpfun HVNC

This is optional as a physical table in the first pass.
It may initially live as code constants.

### 2. `user_alert_profiles`
Purpose:
- persist the effective backend-owned alert configuration for each user

Contents should include:
- enabled rule toggles
- thresholds
- `min-vol`
- `min-mcap`
- `max-mcap`
- pump alert thresholds
- any future alert-delivery prefs

This may be a materialized/effective projection of existing `user_config`, not necessarily a net-new manual config surface.

### 3. `user_alert_state`
Purpose:
- persist evaluation state per user + token + rule

This is the critical table for reproducing current semantics.

Suggested key:
- `(user_id, token_address, rule_key)`

Suggested fields:
- `user_id`
- `token_address`
- `rule_key`
- `monitoring_session_id`
- `baseline_value`
- `baseline_established_at`
- `last_alerted_value`
- `last_alerted_pct`
- `last_alerted_at`
- `last_fingerprint`
- `cooldown_until`
- `single_fire_fired`
- `last_seen_token_state_at`
- `updated_at`

Important:
- this table is what makes "same behavior as now" possible
- without it, the backend cannot reproduce the frontend's session-local logic

### 4. `monitoring_sessions`
Purpose:
- explicitly model alert-session semantics

This is separate from auth sessions.

Why:
- current alert semantics are tied to "monitoring session"
- auth session and alert session are not the same thing

Suggested fields:
- `id`
- `user_id`
- `started_at`
- `ended_at`
- `status`
- `source`

### 5. `alert_events`
Purpose:
- persist emitted alert events

Suggested fields:
- `id`
- `user_id`
- `monitoring_session_id`
- `token_address`
- `rule_key`
- `kind`
- `payload_json`
- `created_at`
- `dedupe_key`

Retention:
- start with `24h`
- delete by periodic cleanup job, not inline on every insert

### 6. `alert_delivery_cursors`
Purpose:
- allow reliable replay after disconnect/reload

Suggested fields:
- `user_id`
- `last_seen_event_id`
- `last_acked_event_id`
- `updated_at`

This can be simplified in early phases if unread tracking is not yet needed.

## Delivery Semantics

### Rules for "not losing alerts"
To avoid missed alerts, the system must separate:
- detection
- persistence
- delivery

That means:
- alert is detected in backend
- alert is inserted into `alert_events`
- socket push is only an optimization
- frontend must also have:
  - `GET /api/alerts`
  - `GET /api/alerts?since_id=...`

If socket disconnects:
- frontend reconnects
- frontend asks for backlog since its last known event id
- backend replays missed events from `alert_events`

Without this, alerts can still be lost even if the backend detects them.

## Performance Strategy

### What would actually get expensive
Not the `24h` alert table itself.

The expensive part is:
- evaluating many users against the same token changes
- preserving per-user/session rule state
- writing alert state and events

### What must not happen
Do not build the engine like this:
- every token refresh -> load every user -> evaluate everything in memory -> write many duplicated rows

That would scale badly.

### What should happen instead
Build the engine around:
- canonical token update batches
- only evaluating users whose effective configs make them eligible
- grouping users by comparable config shape where possible
- batched DB reads/writes
- bounded in-memory working sets

### Important constraint
Do not keep the entire `user × token × rule` state graph permanently in Node memory.

Use:
- DB as source of truth
- bounded in-process caches only where profiling proves they are needed

## Recommended Migration Phases

## Phase 0: Preparation

### Goal
Create observability and contracts before moving logic.

### Work
- document the exact current frontend alert semantics by rule
- list which rules are:
  - threshold-based
  - cooldown-based
  - baseline/session-based
  - single-fire
- identify the minimal event payload each alert type needs in the UI
- add a stable event schema proposal

### Exit condition
- no ambiguity remains about current rule behavior
- especially for:
  - monitored VOL
  - monitored MCAP
  - HVNC
  - old surge
  - Meteora surge
  - PumpFun alerts

## Phase 1: Backend Global Events (Light Foundation)

### Goal
Introduce backend alert persistence without reproducing full per-user semantics yet.

### Work
- create `alert_events`
- create `GET /api/alerts`
- create `GET /api/alerts?since_id=...`
- emit global/canonical events from backend for a small set of simple rules
- allow frontend to read/render these events alongside current local alerts

### Scope recommendation
Start with rules that are easiest to move:
- PumpFun migration events
- PumpFun volume alerts
- maybe HVNC if semantics are simple enough

### Why this phase matters
It proves:
- storage
- replay
- delivery
- frontend consumption

without yet solving full per-user parity.

### Exit condition
- backend can persist and replay alert events reliably
- frontend can display backend events without relying on socket-only delivery

## Phase 2: Hybrid Monitored Alerts

### Goal
Move monitored alerts to backend incrementally while still keeping frontend comparison.

### Work
- introduce `monitoring_sessions`
- introduce `user_alert_profiles`
- create a backend rule-evaluation worker/runner tied to canonical token refreshes
- evaluate monitored rules for a controlled subset:
  - monitored VOL first
  - monitored MCAP next
- keep frontend engine alive for comparison mode
- compare backend-emitted vs frontend-emitted alerts for the same user/session

### Required feature flags
- `backend_alerts_enabled`
- `backend_alerts_compare_mode`
- `backend_alerts_delivery_enabled`
- `frontend_alert_engine_enabled`

### Why compare mode is mandatory
This is how we catch drift without breaking users.

The backend and frontend should run in parallel temporarily and log:
- missing backend alert
- backend duplicate
- payload mismatch
- timing drift

### Exit condition
- monitored VOL and MCAP reach acceptable parity
- replay and reconnect behavior are proven

## Phase 3: Persist Session-Equivalent State

### Goal
Make backend semantics truly match the current frontend logic.

### Work
- introduce `user_alert_state`
- store:
  - baseline values
  - last alerted values
  - last alert timestamps
  - single-fire flags
  - cooldown state
  - dedupe fingerprints
- explicitly tie those states to `monitoring_session_id` when needed

### Important correction
Do not try to infer alert-session semantics from auth-session ids.

The current product behavior depends on whether monitoring is active, not just whether the user is authenticated.

### Exit condition
- backend can reproduce session-based behavior intentionally
- not just threshold checks

## Phase 4: Move Special Alerts

### Goal
Move the more nuanced rule families after the monitored foundation is stable.

### Candidates
- HVNC
- old surge 1h/6h
- Meteora surge
- PumpFun HVNC and other live-stream rules

### Reason for doing this later
These rules are more behaviorally specific and carry a higher regression risk than plain monitored thresholds.

### Exit condition
- backend owns all alert classes intended for the product

## Phase 5: Frontend Simplification

### Goal
Remove frontend ownership of alert logic.

### Work
- stop computing monitored alerts in `frontend/src/state/app-controller.ts`
- keep frontend responsibilities to:
  - fetch
  - replay
  - render
  - dismiss/ack UI actions
  - sounds
- reduce local/session-only alert state to view concerns only

### Exit condition
- frontend no longer decides whether an alert exists

## Phase 6: Scaling Path

### Goal
Prepare for higher user counts after correctness is proven.

### Work
- split alert evaluation into a dedicated worker process if needed
- keep web/API process separate from the alert engine if load justifies it
- add metrics:
  - evaluated users per cycle
  - tokens triggering evaluation
  - alert state reads/writes
  - event insert rate
  - replay lag
  - duplicate suppression rate

### Important
Do not prematurely split the system before correctness is proven.

First make it right.
Then make it cheaper and more scalable.

## Recommended Implementation Order By Rule Difficulty

### Easiest
- PumpFun migrate-derived events
- simple PumpFun volume threshold events

### Medium
- monitored VOL
- monitored MCAP

### Hard
- HVNC
- old surge
- Meteora surge

### Hardest
- full parity with current session-baseline logic
- especially where behavior depends on:
  - what the token looked like when monitoring started
  - whether the user had already seen an alert this session
  - dedupe fingerprints in recent windows

## API Surface To Add

### Read APIs
- `GET /api/alerts`
- `GET /api/alerts?since_id=...`
- `GET /api/alerts/unread-count` (optional)

### Action APIs
- `POST /api/alerts/ack`
- `POST /api/alerts/ack-all`
- `DELETE /api/alerts/:id` only if product semantics truly require deletion rather than ack

### Admin/debug APIs
- `GET /api/admin/alerts/status`
- `GET /api/admin/alerts/compare`
- `POST /api/admin/alerts/rebuild-state` only if we later need repair tooling

## What To Reuse From The Current Bot

### Reuse directly
- auth/session model
- user config model
- token catalog
- catalog worker
- websocket auth
- frontend alerts UI surface
- browser-local sound preferences

### Replace or restructure
- frontend alert decision ownership
- browser-local alert history as the only persistent feed
- session-only alert dedupe as frontend truth

## Why This Should Not Be A New Bot

Because the current project already solved a lot of the expensive platform work:
- auth
- account config
- token ingestion
- token reevaluation
- websocket auth
- monitored dashboard model
- PumpFun integration

Throwing that away would duplicate effort without solving the actual architectural problem.

The real migration is:
- not "new bot"
- but "new alert subsystem inside the current bot"

## Main Risks

### 1. Behavioral drift
The backend may not initially match the current frontend semantics.

Mitigation:
- compare mode
- dual-run period
- feature flags

### 2. Write amplification
Too many writes to `user_alert_state` and `alert_events`.

Mitigation:
- only persist meaningful state changes
- batch updates
- avoid duplicate event inserts

### 3. Over-caching in Node
Trying to hold too much per-user alert state in memory.

Mitigation:
- DB as source of truth
- bounded caches only after profiling

### 4. Treating auth session as monitoring session
This would break current semantics.

Mitigation:
- model monitoring session explicitly

### 5. Frontend and backend both emitting alerts to users after rollout
This creates duplicate user-visible alerts.

Mitigation:
- feature flags
- staged cutover per rule family

## Rollback Strategy

Every migrated rule family should be independently disableable.

At minimum:
- keep frontend alert engine available behind a flag during migration
- keep backend event generation disableable per rule family
- keep backend delivery disableable independently from backend detection

This allows rollback to:
- backend detect only
- backend detect + store but no UI use
- frontend-only again

without losing the rest of the bot.

## Suggested First Concrete Milestone

If we started this project for real, the first milestone should be:

### Milestone 1
- define backend event schema
- add `alert_events`
- add alert replay API
- emit a narrow class of backend events
- render them in frontend without removing current local alerts

This is the lowest-risk entry point that materially advances the architecture.

## Final Recommendation

The ideal path is:
- adapt the current bot
- do not rewrite from scratch
- build a dedicated alert subsystem in phases
- require parity validation before disabling frontend alert ownership

That path is hard, but it is realistic.

Trying to jump directly to "full backend parity for every alert rule" would be much riskier than the codebase actually requires.

## Practical Summary

### Best strategic path
- phase 1: backend event persistence + replay
- phase 2: hybrid monitored alerts
- phase 3: persisted per-user/session alert state
- phase 4: migrate special rules
- phase 5: retire frontend alert engine

### What makes this feasible
- the backend already owns token truth
- the repo already supports multi-user auth/config/socket
- the problem is mostly alert-state ownership, not missing product infrastructure

### What makes this difficult
- the current alert engine is stateful and session-based
- exact parity requires explicit persisted state, not just porting `if` statements
