# Frontend Render Refactor Plan

## Purpose
This document records the ideal implementation plan for the current highest-priority frontend performance fix:

- stop rebuilding the entire app on every meaningful state change

This plan is intentionally scoped around render architecture only.

It does **not** change alert semantics.
It does **not** move alerts to the backend.
It does **not** change the product rules.

The goal is:
- keep the current bot behavior
- keep the current alert engine behavior
- keep the current polling and monitored logic initially
- reduce renderer churn, DOM churn, and restore spikes

This is the safest first move before any larger architectural migration.

## Why This Is The Current Priority

Based on the current code and the collected memory profiles, the strongest problem pattern is:
- too many frontend updates
- full UI reconstruction
- heavy DOM/layout/paint churn
- especially bad restore behavior when the browser tab becomes visible again

The current code path that most strongly suggests this is:
- `frontend/src/ui/app-shell.ts`
  - `renderAppShell()` currently does `root.innerHTML = ''`
  - then rebuilds the full shell tree
- `frontend/src/main.ts`
  - that render path is called repeatedly from the controller subscription
- `frontend/src/state/app-controller.ts`
  - many independent flows call `emit()`

That means the frontend is currently paying a global render cost for local state changes.

This is likely more important than any single list cap or one isolated state collection.

## Current Code Reality

### Current render shape
- `frontend/src/main.ts`
  - subscribes to controller state
  - decides whether to render immediately or defer
- `frontend/src/ui/app-shell.ts`
  - builds the entire visible app
  - destroys the prior root tree with `root.innerHTML = ''`
- `frontend/src/ui/sections/*`
  - each section returns a freshly created DOM tree

### Current architectural consequence
Even if only one area changes, the app currently tends to:
- rebuild the shell
- rebuild the panel structures
- rebuild section trees
- rebind events again
- recreate DOM nodes again

This is exactly the kind of pattern that can produce:
- memory pressure in Chromium renderer/compositor
- high layout/paint cost
- large spikes when hidden tabs become visible again

## Main Goal

Replace global app rebuilds with targeted section-level updates while preserving current behavior.

That means:
- the controller remains the state engine
- the controller remains the alert engine for now
- the render layer becomes incremental

## Non-Goals
- moving alerts to the backend
- changing monitored polling cadence at the start
- changing alert rules
- changing PumpFun logic at the start
- redesigning the product UX from scratch

## Success Criteria

The refactor is successful if:
- the bot still behaves the same
- alerts still fire the same way
- the browser uses less memory over time
- tab restore becomes materially faster
- hidden/visible bursts shrink
- DOM churn is reduced
- the renderer stops rebuilding unrelated sections on local changes

## Target Render Architecture

## Core idea
Keep one stable app shell mounted.

Then update only the affected surface.

### High-level split

#### 1. Root shell
Owns:
- top-level app container
- workspace header
- static panel layout
- stable section mount points

This shell should be created once and reused.

#### 2. Section renderers
Each major surface should get its own update path:
- monitored
- lateralized
- manual
- recent
- old week
- pumpfun
- alerts
- toasts
- auth overlays / profile overlays

Each section should be able to:
- mount once
- update its own contents later
- avoid forcing unrelated sections to rebuild

#### 3. State-to-view invalidation
The renderer should know:
- what changed
- which section needs repaint
- whether the shell itself needs repaint

This is the key shift:
- from global redraw
- to targeted invalidation

## Recommended UI Surface Split

The following product split is compatible with this refactor and likely beneficial:

### Workspace A
- Alerts
- PumpFun
- Monitored Tokens
- Manual Tokens

### Workspace B
- Recent Tokens
- Old Tokens 1 Week+

This is not mandatory for the first patch, but it fits the architecture well because:
- `Recent` / `Old Week` are derived/routed views
- `Alerts` / `PumpFun` / `Monitored` are the hot live surfaces
- isolating these surfaces reduces unrelated repaint pressure

Important:
- the real win is not "two pages"
- the real win is "independent update surfaces"

Even if the UX remains on one page, the code should still move in this direction.

## Recommended Migration Phases

## Phase 0: Guard Rails

### Goal
Freeze current behavior before touching render architecture.

### Work
- document which render surfaces are allowed to change behavior
- explicitly mark alert semantics as out of scope
- keep current controller logic intact
- keep current polling intact initially

### Exit condition
- everyone agrees this phase is render-only

## Phase 1: Stable Root Shell

### Goal
Stop destroying the entire app tree on every render.

### Work
- refactor `frontend/src/ui/app-shell.ts`
- mount the root shell once
- create stable section containers inside it
- replace `root.innerHTML = ''` global rebuild behavior

### Important constraint
Do not change how state is computed in this phase.

The only concern is:
- create stable DOM structure
- stop global destruction/recreation

### Expected gain
- lower DOM churn
- lower event rebinding churn
- less renderer pressure

### Main risk
- focus/scroll/modal behavior drifting during the shell refactor

### Mitigation
- preserve existing draft/focus/scroll helpers where possible
- do not rewrite those rules at the same time

## Phase 2: Independent Section Updates

### Goal
Allow sections to update independently.

### Work
Introduce a render coordinator that can update only:
- monitored
- lateralized
- manual
- recent
- old week
- pumpfun
- alerts
- toasts
- overlays

### Practical shape
Each section should get:
- `mountXSection(container, initialState, controller)`
- `updateXSection(container, state, controller)`

Or an equivalent small renderer object.

### Rules
- if only alerts changed, do not rebuild monitored
- if only PumpFun changed, do not rebuild Recent / Old Week
- if only auth overlay changed, do not rebuild the main workspace

### Expected gain
- lower cross-panel repaint cost
- less DOM creation
- less work under frequent state changes

## Phase 3: Change Detection / Dirty Regions

### Goal
Avoid repainting sections whose effective inputs did not change.

### Work
Define a small invalidation model.

Examples:
- monitored data changed -> update monitored section
- alerts changed -> update alerts section
- PumpFun tokens or status changed -> update pump section
- user menu open/closed -> update header/profile area only

### Important note
This does not require deep immutable diffing of the whole app state.

A pragmatic first version can use:
- explicit "section dirty" flags
- or a compact revision counter per area

This is usually safer than trying to diff giant nested objects.

### Expected gain
- fewer unnecessary updates
- lower CPU per state transition

## Phase 4: Section-Level Hotspot Hardening

### Goal
Optimize the hottest panels after the architecture is decoupled.

### Highest-likelihood hotspots
- Monitored
- PumpFun
- Alerts
- Recent / Old Week when derived lists churn

### Work examples
- keep stable row wrappers where possible
- update only changed row content
- avoid rebuilding the whole list when only one token changed
- reduce list-wide event rebinding

### Important
Do this after the shell and section architecture are stable.

Trying to micro-optimize rows while the whole app still full-rerenders is the wrong order.

## Phase 5: Hidden Tab Restore Safety

### Goal
Reduce the huge burst when the browser tab becomes visible again.

### Work
Once section-level updates exist:
- ensure hidden-tab backlog does not force full-surface rebuild
- restore only the sections that truly need immediate catch-up
- avoid triggering global layout storms after visibility change

### Expected gain
- lower memory spike on restore
- lower perceived freeze time

## What Must Stay Unchanged During This Plan

At least for the initial implementation passes:
- monitored alert logic in `app-controller.ts`
- special alert logic in `app-controller.ts`
- current monitored polling cadence
- current config semantics
- current PumpFun semantics

This is what makes the refactor safe.

We are changing:
- render architecture

We are not changing:
- bot rules

## How To Validate Safety

### Functional validation
- monitored alerts still fire
- HVNC still fires
- old surge still fires
- alerts panel still restores local history
- manual tokens still work
- Recent / Old Week routing still works
- PumpFun panel still updates
- auth modals still behave correctly

### Performance validation
- lower average render duration
- lower max render duration
- lower visible-tab CPU churn
- smaller tab-restore spikes
- more stable memory profile over time

## Recommended First Technical Cut

If we started implementation now, the first safe cut should be:

1. keep `app-controller.ts` intact
2. keep `main.ts` subscription contract intact
3. refactor `app-shell.ts` so the shell mounts once
4. make `alerts`, `pumpfun`, and `monitored` independent update surfaces first

Why these first:
- they are the hottest live surfaces
- they are the most likely contributors to observed churn

## Option 2: Emit Reduction

This is the current secondary option, not the first one.

## Why it is secondary
The current evidence suggests the biggest immediate architectural smell is the full re-render model.

Reducing `emit()` frequency may help, but:
- it changes responsiveness semantics more directly
- it can hide problems instead of fixing them
- it is easier to reason about after the render architecture is no longer globally destructive

## When to apply it
Only after Phase 1 and Phase 2 have landed and been measured.

## What it would involve
- coalescing related state updates more aggressively
- reducing repeated emits from noisy flows
- separating "state changed" from "UI must repaint now"
- possibly lowering some timer-driven UI updates

## Potential benefit
- fewer render triggers
- lower restore backlog
- lower CPU churn

## Potential cost
- less immediate UI feedback in some areas
- risk of masking logic problems rather than fixing architectural ones

## Recommendation for Option 2
Treat it as:
- a measured follow-up
- not the first intervention

## Risks Of This Refactor

### 1. Focus / typing regressions
The current UI has many focus-preservation helpers.

Risk:
- search inputs
- auth modals
- config fields

Mitigation:
- preserve current draft/focus helpers first
- do not rewrite those systems simultaneously

### 2. Scroll restoration regressions
Stable shell + partial updates can accidentally break panel scroll expectations.

Mitigation:
- validate panel scroll state after each phase

### 3. Event binding drift
Today full rerender naturally recreates and rebinds everything.

After refactor:
- bindings must be handled intentionally

Mitigation:
- move to mount/update ownership per section

### 4. Hidden coupling between sections
Some sections currently assume global rerender side effects.

Mitigation:
- surface those dependencies explicitly
- treat them as invalidation rules

## Why This Plan Comes Before Backend Alert Migration

Because the current data does not strongly support a simple frontend JS leak from alert arrays.

The stronger evidence points to:
- render churn
- global UI rebuild cost
- restore spikes

So the safest order is:
1. fix render architecture
2. remeasure
3. then decide how much alert-backend migration is still needed for performance

## Final Recommendation

The current best path is:
- implement Option 1 first
- keep behavior unchanged
- measure results
- only then consider Option 2

This is the highest-confidence way to improve the frontend without risking alert correctness.

## Practical Summary

### Best first action
- replace global full-app rerender with stable shell + independent section updates

### Keep unchanged at first
- alert logic
- polling logic
- token merge logic
- PumpFun logic

### Secondary possible addition
- reduce `emit()` frequency only after measuring the post-refactor result
