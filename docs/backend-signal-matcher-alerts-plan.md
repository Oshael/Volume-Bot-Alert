# Backend Signal/Matcher Alerts Plan

## Purpose
This document defines the concrete architecture we should follow if we move monitored alerts out of the frontend without turning the backend into a per-user market recalculation engine.

It exists because the current repository already has:
- a canonical backend market pipeline
- a partially backend-owned alert path (`high-cap-dump-5m`)
- a frontend alert engine that is causing live-tab performance problems

The goal is to make the next migration steps explicit before code changes start.

This document complements:
- [docs/backend-alerts-migration-plan.md](/Users/ezequielmarinho/Volume-Bot-Alert/docs/backend-alerts-migration-plan.md)
- [docs/live-history-split-and-backend-alerts-plan.md](/Users/ezequielmarinho/Volume-Bot-Alert/docs/live-history-split-and-backend-alerts-plan.md)

This one is narrower:
- it focuses on the `compute market once, match users later` model
- it explains why that model is viable for this repository
- it breaks the migration into executable blocks

## Current Code Reality

### What the backend already does
- `src/services/catalog-worker.js`
  - is the canonical token reevaluation loop
  - already fetches Dex data
  - already derives and persists:
    - `mcap`
    - `price`
    - `volume5m`
    - `volume1h`
    - `volume6h`
    - `volume24h`
    - `priceChange1h`
    - `priceChange6h`
    - `priceChange24h`
    - `tokenCreatedAt`
    - monitoring priority / eligibility
- `src/models/token-catalog.js`
  - already stores the latest token state used by the frontend
- `src/services/high-cap-dump-alert.js`
  - already proves that backend-side detection, persistence, and socket delivery are possible

### What the frontend still does
- `frontend/src/state/app-controller.ts`
  - downloads the monitored universe repeatedly in the live workspace
  - rebuilds tracked token state
  - evaluates:
    - volume alerts
    - mcap alerts
    - HVNC
    - Meteora surge
    - old surge
  - owns cooldowns / single-fire behavior / local dedupe for several rules

### What this means
The backend already computes most of the expensive market facts.

The frontend is still doing two jobs:
1. infer signals from token state
2. decide which signals matter to a user

That is the core architectural problem.

## Why the frontend freezes today

The live workspace keeps running while the tab is hidden for up to `20 minutes` in:
- `frontend/src/main.ts`

During that time, the live runtime still:
- polls monitored state every `3s`
- rebuilds tracked state
- reevaluates alert logic

The heavy part is not only the final alert card render.

The heavy part is the repeated local processing pipeline behind it.

This is why simply "making the alert UI lighter" is not enough.

## Core Principle

Do not calculate market conditions per user.

Instead:
1. calculate market facts once
2. derive alert signals once
3. apply user preferences to those signals

This is the main difference between:
- a scalable backend-owned alert engine
- an expensive per-user recalculation system

## Terminology For This Migration

### 1. Market facts
Canonical token facts already known by the backend.

Examples:
- current `volume5m`
- previous `volume5m`
- current `mcap`
- previous `mcap`
- `priceChange1h`
- `priceChange6h`
- `volume24h`
- `tokenCreatedAt`
- Meteora summary

These are expensive because they come from the ingestion / catalog pipeline.

### 2. Signals
Derived values computed from those facts.

Examples:
- `vol5mChangePct`
- `mcapChangePct`
- `isMcapDeclining`
- `ageMs`
- `passesHvncPrereqs`
- `passesMeteoraPrereqs`

These are cheap.

### 3. User match
The final per-user decision.

Examples:
- `vol5mChangePct >= user.threshold`
- `currentVolume5m >= user.minVol`
- `mcap >= user.minMcap`
- `mcap <= user.maxMcap` if configured

These are also cheap.

## Concrete Example: VOL 5M

### Market facts
The worker updates token `ABC`:

```json
{
  "address": "ABC",
  "prevVolume5m": 10000,
  "currentVolume5m": 18000,
  "prevMcap": 250000,
  "currentMcap": 300000
}
```

### Signal generation
Backend computes once:

```json
{
  "address": "ABC",
  "vol5mChangePct": 80,
  "currentVolume5m": 18000,
  "currentMcap": 300000,
  "isMcapDeclining": false
}
```

### User matching
Users:

```json
[
  { "user": "u1", "thresholdPct": 50, "minVol": 8000,  "minMcap": 30000, "maxMcap": 0 },
  { "user": "u2", "thresholdPct": 80, "minVol": 14000, "minMcap": 30000, "maxMcap": 0 },
  { "user": "u3", "thresholdPct": 90, "minVol": 10000, "minMcap": 30000, "maxMcap": 0 }
]
```

Matches:
- `u1` -> yes
- `u2` -> yes
- `u3` -> no

Important:
- the backend did **not** recalculate market data three times
- it computed the signal once
- it ran three cheap comparisons

This is the model we want.

## Concrete Example: 20 Users With Different Minimum Volumes

If 20 users all use `VOL 5M 50%`, but each one has a different `minVol`:
- user 1: `1k`
- user 2: `2k`
- user 3: `3k`
- ...
- user 20: `20k`

And the signal is:

```json
{
  "vol5mChangePct": 50,
  "currentVolume5m": 12000,
  "currentMcap": 300000
}
```

Then:
- users `1` through `12` match
- users `13` through `20` do not

Again:
- the token signal was computed once
- only the final gate differed per user

## Why presets like `5k`, `10k`, `15k` are not required

Preset thresholds would simplify the product surface, but they do not buy enough backend savings for this repository.

Comparing:
- `currentVolume5m >= 13500`

is not materially more expensive than comparing:
- `currentVolume5m >= 15000`

The expensive work is:
- market ingestion
- state persistence
- event persistence
- delivery

Not:
- one additional numeric comparison

That means user-chosen thresholds are still reasonable as long as we do not recalculate market state per user.

## Scope Rule For The First Backend Version

The first backend-owned matcher should **not** try to serve every registered user in the system.

It should only evaluate alerts for users who are effectively active for the product.

This is important because the current frontend semantics are also session-driven:
- alerts only exist when the authenticated runtime is active

So the first backend version should aim to match that product behavior:
- active authenticated sessions
- active live workspace users
- alert feed consumers currently participating in the product

This keeps cost bounded while we migrate.

## Recommended Target Architecture

### Layer 1: market engine
Owner:
- existing `catalog-worker`

Responsibility:
- fetch and persist canonical token state

Do not duplicate this layer.

### Layer 2: signal builder
Owner:
- new backend module

Responsibility:
- convert canonical token state changes into reusable alert signals

Output examples:
- `vol5mChangePct`
- `mcapChangePct`
- `ageMs`
- `meteoraChange1h`
- `isHvncCandidate`
- `isMcapDeclining`

### Layer 3: user matcher
Owner:
- new backend alert matcher

Responsibility:
- load normalized alert profiles for active users
- apply filters and thresholds to the signal
- manage cooldown / dedupe / single-fire state

### Layer 4: event store + delivery
Owner:
- backend feed + socket layer

Responsibility:
- persist `user alert events`
- replay unread events
- deliver realtime alerts to the right sockets

### Layer 5: frontend consumer
Owner:
- frontend `Alerts` UI

Responsibility:
- render backend-produced alerts
- play sound
- search / clear / star / interact
- stop deciding whether the alert exists

## What should move first

### Good first backend candidates
- `monitored-vol`
- `monitored-mcap`
- `hvnc`
- `meteora-surge`

Why:
- they mostly depend on already available token facts
- they are mostly threshold gates
- they fit the signal/matcher model well

### Rule that should not move first
- `old-surge`

Why:
- current logic depends on session-local baseline behavior in the frontend
- current state uses `_oldSurgeSessionBase1h` / `_oldSurgeSessionBase6h`
- reproducing that exactly requires persisted per-user rule state

That makes it a later block, not a first block.

## Proposed Data Model

### 1. `user_alert_profile_cache`
Purpose:
- normalized effective alert preferences for active users

This can start as:
- in-memory projection from existing `user_config`

It does not need to be a table on day one.

Suggested normalized fields:
- `userId`
- `ruleEnabled.monitoredVol`
- `ruleEnabled.monitoredMcap`
- `ruleEnabled.hvnc`
- `ruleEnabled.meteoraSurge`
- `thresholdPct`
- `mcapThresholdPct`
- `minVol`
- `minMcap`
- `maxMcap`
- `hvncMinVol`
- `meteoraAlert1hThreshold`

### 2. `user_alert_rule_state`
Purpose:
- cooldown / dedupe / single-fire / rearm state per user + token + rule

Suggested key:
- `(user_id, token_address, rule_key)`

Suggested fields:
- `last_alerted_at`
- `last_alerted_value`
- `last_alerted_pct`
- `cooldown_until`
- `rearm_required`
- `last_fingerprint`
- `updated_at`

### 3. `user_alert_events`
Purpose:
- user-owned alert feed

Suggested fields:
- `id`
- `user_id`
- `rule_key`
- `kind`
- `token_address`
- `payload`
- `triggered_at`
- `dedupe_key`

### 4. `user_alert_delivery_cursor`
Purpose:
- replay / seen tracking for each user

We already have analogous delivery-cursor patterns in the repository.

## Execution Plan By Blocks

Important execution rule:
- keep implementation blocks small
- target blocks below roughly `300` changed lines when practical
- if a block is likely to exceed `450+` lines, stop and estimate first

### Block 0: freeze the scope
Goal:
- define the exact backend MVP

In scope:
- `monitored-vol`
- `monitored-mcap`
- `hvnc`
- `meteora-surge`

Out of scope:
- `old-surge`
- pumpfun alert migration
- custom formula scripting

Deliverable:
- this document agreed and frozen

### Block 1: extract backend signal builders
Goal:
- make signal computation explicit and testable

Work:
- add a new backend module for reusable token alert signal generation
- compute only pure signal data from canonical facts
- no user matching yet

Likely files:
- new `src/services/token-alert-signal-builder.js`
- touch `src/services/catalog-worker.js`
- new `tests/token-alert-signal-builder.test.js`

Validation:
- `npm run lint`
- affected `node --test ...`

### Block 2: introduce normalized active-user alert profiles
Goal:
- avoid reading raw `user_config` ad hoc for every token/user comparison

Work:
- define normalized profile shape
- load only active users
- cache effective alert preferences in memory

Likely files:
- new `src/services/user-alert-profile-cache.js`
- possibly touch auth/session/socket integration
- new tests for normalization

Critical rule:
- do not evaluate every registered account in the database by default

### Block 3: add persisted per-user alert state
Goal:
- reproduce cooldown / dedupe semantics outside the browser

Work:
- add `user_alert_rule_state`
- add model methods for:
  - `getState`
  - `upsertState`
  - `markTriggered`
  - `markRearmed`

Likely files:
- new schema stage
- new `src/models/user-alert-rule-state.js`
- runtime schema wiring
- tests

Validation:
- `npm run lint`
- `npm run db:schema-check`
- affected `node --test ...`

### Block 4: add persisted per-user alert events
Goal:
- build a real backend-owned user alert feed

Work:
- add `user_alert_events`
- add event model
- define payload format close to current alert cards

Likely files:
- new schema stage
- new `src/models/user-alert-event.js`
- tests

Critical rule:
- event payload should already include enough metadata for the frontend to render without re-deriving the market state

### Block 5: add matcher for simple rules
Goal:
- actually generate alerts in the backend for the simple rules

Work:
- new `user-alert-matcher` service
- consume signal output
- match active user profiles
- write `user_alert_events`
- update `user_alert_rule_state`

Likely files:
- new `src/services/user-alert-matcher.js`
- touch `src/services/catalog-worker.js`
- tests

Important:
- this block should still avoid `old-surge`

### Block 6: delivery and feed API
Goal:
- let the frontend consume backend-owned user alerts

Work:
- add per-user feed route
- add cursor handling
- add socket emission targeted to user sockets

Likely files:
- `src/routes/dashboard.js`
- `src/services/socket-hub.js`
- maybe new `src/services/user-alert-feed.js`
- tests

Important:
- do not break the existing high-cap-dump backend feed during this block
- either coexist or consolidate carefully

### Block 7: frontend consumes backend alerts for migrated rules
Goal:
- stop running migrated rules locally in the browser

Work:
- frontend fetches backend user-alert feed
- socket events append backend-owned alerts
- remove local evaluation for migrated rules
- keep UI behavior, search, clear, sound

Likely files:
- `frontend/src/state/app-controller.ts`
- `frontend/src/services/api/catalog.ts` or dashboard API module
- `frontend/src/ui/sections/alerts-section.ts`

Important:
- this is the block that should materially reduce the live hidden-tab freeze

### Block 8: revisit `old-surge`
Goal:
- decide whether to:
  - migrate it with persisted per-user session semantics
  - redesign it as a simpler backend rule
  - or keep it frontend-only longer

This block should be deliberately separate.

## What success looks like

After Blocks 1 through 7:
- the live frontend no longer needs the monitored universe just to detect the simple alert rules
- hidden-tab freeze should drop substantially
- backend owns event persistence and replay for migrated rules
- frontend alert UI becomes a feed consumer, not a market engine

## What this plan intentionally avoids

It does not assume:
- arbitrary user scripting
- per-user market recalculation
- giant backend scans over all users every cycle
- bucketed preset-only thresholds like `5k`, `10k`, `15k`

The intended model is:
- market once
- signal once
- match many

## Decision Summary

For this repository, the correct architecture is:
- keep the backend as the canonical market-state engine
- extract reusable alert signals from that engine
- match user preferences against those signals
- move simple alert rules first
- delay `old-surge` until the state model is ready

This is the highest-leverage path because it removes duplicated browser work without turning the backend into a naive per-user market recomputation system.

## Ponto importantes
- The backend alert migration should initially target active authenticated users, not the entire user table.
- The expensive part is signal generation from market state; user threshold comparison is cheap.
- `old-surge` is the riskiest rule to migrate because its current semantics are session-local.
- Preset threshold buckets would simplify UX at the cost of flexibility, but they do not solve the core cost problem.
- The first measurable product win should be reduced `Alerts` freeze in hidden-tab recovery, not perfect rule migration completeness.
