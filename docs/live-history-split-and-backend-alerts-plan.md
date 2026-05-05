# Live/History Split And Backend Alerts Plan

## Purpose
This document defines the concrete staged plan for the next product direction:

1. split the frontend into two real workspaces
2. keep the live workspace focused on the hot runtime surfaces
3. move `Recent` / `Old Week` into a separate history workspace
4. after that split is stable, begin the backend-alert migration

This is intentionally based on the current repository behavior.

It is **not** a greenfield rewrite plan.
It is a migration plan that preserves the current bot while moving toward a lighter frontend.

## Current Code Reality

### What exists today
- `frontend/src/state/app-controller.ts`
  - owns one mixed runtime
  - runs monitored polling every `3s`
  - derives `Recent` / `Old Week` from monitored tokens through `deriveAgeBuckets()`
  - computes alerts in the frontend
  - handles PumpFun live state in the same controller
- `frontend/src/ui/app-shell.ts`
  - mounts all major surfaces in one shell
  - already supports section-level render invalidation after the refactor work
- `frontend/src/services/socket/client.ts`
  - opens one socket per browser tab
  - keeps desired PumpFun subscriptions per tab
- `src/services/socket-hub.js`
  - deduplicates upstream PumpFun subscriptions per mint across sockets
  - does **not** deduplicate frontend polling across browser tabs

### What this means
Today:
- one authenticated tab can run the full live frontend
- two tabs can duplicate:
  - dashboard polling
  - local monitored-token state
  - local alert computation
  - socket clients
- `Recent` / `Old Week` are not independent products yet
  - they are frontend-derived views of monitored state

This is the core architectural constraint.

## Product Goal

### End-state goal
Reach a shape where:
- `/workspace/live`
  - owns `Monitored`, `Manual`, `PumpFun Live`, `Alerts`
- `/workspace/history`
  - owns `Recent`, `Old Week`
- `history` can still show fresh dashboard-derived data
- `history` does **not** need the full live runtime stack
- later, alerts move to the backend
- once alerts are backend-owned, the frontend no longer needs to keep the whole monitored universe alive just to avoid losing alerts

## Non-Goals
- trying to solve multi-tab coordination completely in this phase
- rewriting the app around a full router framework
- moving alerts to the backend before the workspace split
- doing broad emit throttling that would risk degrading live token metrics

## Main Architectural Rule

Do **not** treat "history workspace" as just a hidden tab of the current runtime.

If `history` still boots:
- monitored polling
- local alerts
- PumpFun live socket behavior
- full live-only side effects

then the split will look cleaner but will not fix the real cost structure.

The split only has real value if workspaces get different runtime capabilities.

## Target Workspace Model

## Workspace A: Live

### URL
- `/workspace/live`

### Surfaces
- `Monitored`
- `Manual`
- `PumpFun`
- `Alerts`

### Responsibilities
- monitored polling
- canonical live token UI updates
- live user-facing metrics:
  - `mcap`
  - `volume`
  - `price change`
  - `mcap delta`
- current frontend alert engine for the migration period
- PumpFun realtime behavior

### Important rule
During the split phase, this workspace keeps current alert semantics intact.

## Workspace B: History

### URL
- `/workspace/history`

### Surfaces
- `Recent`
- `Old Week`

### Responsibilities
- show fresh dashboard-derived history buckets
- keep `Recent` / `Old Week` visually current
- support search, sort, page, dismiss, starred-only, removal logs

### Important rule
This workspace must **not** boot the live runtime stack.

That means:
- no local monitored alert evaluation
- no PumpFun live runtime
- no live-only toasts
- no live-only background behavior that only exists for the main workspace

## Why History Still Needs Fresh Dashboard Data

The history workspace should still show updated values.

That is valid.

But it must do so as a **history-focused reader**, not as a second copy of the full live workspace.

So the target is:
- `history` still receives updated dashboard state
- but it only derives and renders `Recent` / `Old Week`
- and it avoids the other hot runtime responsibilities

This is the key compromise:
- yes, opening the history workspace costs memory and polling by user choice
- but closing that workspace should fully remove that extra cost
- and the main live workspace becomes less overloaded

## Why We Are Not Prioritizing Broad Emit Work First

The current code still shows high `emit` volume in `frontend/src/state/app-controller.ts`.

However, broad emit work right now is not the best next move because:
- we must preserve live token metrics exactly
- we must preserve current alerts until the backend owns them
- a lot of current frontend cost comes from carrying too many responsibilities in one workspace

So the next product-aligned move is:
- split responsibilities first
- then move alerts to the backend
- only do deeper emit tuning if it is still worth it afterward

## Recommended Staged Plan

## Phase 1: Introduce Real Workspace Routing

### Goal
Create two real URLs with distinct workspace selection:
- `/workspace/live`
- `/workspace/history`

### Work
- add lightweight workspace routing in the frontend shell
- keep auth-route handling intact
- persist the current workspace in URL, not just local UI state
- mount only workspace-relevant sections in each route

### Expected result
- `Recent` / `Old Week` stop being mounted in the live workspace
- the live workspace visually shrinks to the hot surfaces only

### Important constraint
At this phase, do **not** yet break alert behavior.

## Phase 2: Split Runtime Capabilities

### Goal
Stop treating "app active" as one global mode.

### Work
Introduce capability-aware workspace startup.

Suggested runtime split:
- `live`
  - monitored polling
  - local alerts
  - PumpFun socket behavior
  - live toasts
- `history`
  - monitored dashboard refresh
  - age-bucket derivation
  - no alerts
  - no PumpFun runtime
  - no live-only side effects

### Suggested implementation direction
Do not keep using only:
- `state.runtime.mode = active|stopped`

Instead introduce workspace/runtime capability flags such as:
- `workspace = live | history`
- `capabilities = { dashboard, alerts, pumpfun, liveToasts }`

This avoids accidentally enabling alerts in the history workspace.

### Critical code truth
Today `applyMonitoredDashboard()` can lead into frontend alert evaluation when `runtime.mode === 'active'`.

So the history workspace cannot simply become "active" using the current semantics.

That would risk:
- duplicate local alerts
- duplicated runtime cost
- product confusion

## Phase 3: Make History Workspace Dashboard-Reader Only

### Goal
Allow the history workspace to show updated values while keeping it narrowly scoped.

### Work
Refactor the history path so it does:
- dashboard fetch
- tracked-token merge only as needed for history
- `deriveAgeBuckets()`
- history rendering

And it explicitly does **not** do:
- `maybeFireSpecialAlerts()`
- `maybeFireLocalAlert()`
- PumpFun live socket work
- PumpFun token GC/toasts

### Acceptable cost model
If the user opens both workspaces in two browser tabs:
- yes, dashboard polling can happen in both tabs
- that is acceptable in the short term because the second workspace is user-chosen
- closing the history tab removes its extra cost immediately

This is a valid product tradeoff.

### Important note
This phase reduces frontend responsibility, but it does **not** yet solve multi-tab duplication globally.

That is acceptable for now.

## Phase 4: Stabilize The Split Before Backend Alerts

### Goal
Prove that:
- live workspace keeps current live behavior
- history workspace updates correctly
- opening history does not accidentally recreate the full live stack

### Validation checklist
- live workspace still updates `mcap`, `vol`, `price change`, `mcap delta`
- live workspace still fires current frontend alerts correctly
- history workspace updates `Recent` / `Old Week` while open
- history workspace closing removes its extra frontend cost
- opening both tabs does not duplicate PumpFun upstream subscription per mint
- history workspace does not fire duplicate alerts

### Exit condition
The workspace split is trusted enough that alerts can start moving out of the frontend.

## Phase 5: Add Multi-Tab Coordination

### Goal
Reduce duplicated frontend polling/work when the user opens more than one workspace tab.

### Why this is separate
The `live/history` split improves responsibility boundaries, but it does **not** automatically prevent:
- duplicated `fetchDashboardMonitored()` polling
- duplicated dashboard merge work
- duplicated socket clients per browser tab

So if users often keep multiple bot tabs open, multi-tab coordination should come before deeper backend-alert migration work.

### Recommended mechanism
Use `BroadcastChannel` for same-origin tab coordination.

### Target behavior
- one tab becomes the leader for dashboard polling
- follower tabs do not run their own full dashboard polling loop when a healthy leader exists
- leader broadcasts:
  - dashboard snapshots
  - freshness timestamps
  - workspace/runtime status
- follower tabs consume those updates and only render their relevant workspace state
- if the leader closes or becomes stale, another tab takes over

### Scope for the first pass
Focus only on:
- dashboard polling ownership
- optional basic runtime status handoff

Do **not** try to fully share:
- all DOM/UI state
- auth modal state
- local ephemeral drafts

### Important constraint
This should be same-origin coordination only.

It is meant for:
- `live` + `history`
- `live` + `live`
- `history` + `history`

opened under the same bot origin.

### Exit condition
Opening two bot tabs no longer causes both tabs to independently drive the full dashboard polling loop under normal conditions.

## Phase 6: Begin Backend Alerts Migration

### Goal
Move alert ownership off the frontend after the workspace split is stable.

### Work
Begin the staged backend migration from `docs/backend-alerts-migration-plan.md`, but now with a better product shape:
- live workspace becomes alert consumer
- history workspace remains dashboard/history reader

### Why this order is better
Once workspaces are split:
- frontend responsibilities are clearer
- backend alert delivery targets are clearer
- it becomes easier to remove "monitor all tokens locally for alerts" from the live workspace

## Phase 7: Retire Frontend Alert Ownership

### Goal
After backend alerts are proven, remove frontend ownership of alert existence.

### Resulting architecture
- backend:
  - detects alerts
  - persists events
  - replays missed alerts
- frontend live workspace:
  - reads alert feed
  - displays sounds/cards/filters
  - no longer owns alert truth
- frontend history workspace:
  - remains a dashboard/history reader

This is the point where deeper emit optimization becomes much less strategically important.

## Concrete Implementation Order

### Step 1
Add workspace routing and separate shell mounting.

### Step 2
Introduce capability-aware runtime startup so `history` cannot accidentally run alerts/PumpFun.

### Step 3
Keep `history` on fresh dashboard reads, but restrict it to deriving/rendering history only.

### Step 4
Validate two-tab behavior with:
- live only
- history only
- live + history together

### Step 5
Add `BroadcastChannel` coordination so multi-tab dashboard polling is not duplicated unnecessarily.

### Step 6
Start backend alert migration using the existing staged alert plan.

### Step 7
Once backend alerts are correct, remove the requirement for the live frontend to keep the full monitored universe alive for alert correctness.

## What This Plan Avoids

This plan deliberately avoids:
- broad emit throttling that could make live token metrics feel stale
- trying to build a perfect multi-tab leader-election system before the product split
- moving alerts to the backend while the frontend is still one mixed runtime blob

Those would create more risk than value right now.

## Risks

### Risk 1: fake split
If `history` is only a visual route and still boots the live runtime, performance gains will be smaller than expected.

### Risk 2: duplicate alerts
If `history` enters the current `runtime.mode = active` path without capability separation, it can duplicate frontend alert evaluation.

### Risk 3: duplicated dashboard polling across tabs
This will still exist until the `BroadcastChannel` phase is implemented.

That is acceptable temporarily, but should be understood explicitly.

### Risk 4: too much backend work too early
Trying to migrate alerts backend-side before the workspace split is stable would mix two migrations and increase regression risk.

## Recommendation

The correct next product move is:

1. split `live` and `history` into real workspaces
2. give `history` fresh dashboard data without giving it the full live runtime
3. only after that, begin backend alert ownership migration

This sequence is more aligned with the current repository than doing broad emit work first.

## Final Position

Yes, the user can intentionally open two browser tabs and pay more memory for that choice.

That is acceptable.

What is **not** acceptable is:
- making every single workspace carry the full live runtime cost
- or letting the history workspace accidentally run alerts and PumpFun

The split should be real.
Then the backend alert migration can remove the deepest remaining frontend cost later.
