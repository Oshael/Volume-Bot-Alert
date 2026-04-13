# Live Workspace Panel Layout Plan

## Goal

Allow the user to personalize the `live` workspace layout with direct drag interactions, prioritizing:

- moving `alerts`, `monitored`, and `pumpfun` between positions
- resizing `alerts` and `monitored`
- letting `alerts` or `monitored` occupy most or all of the live workspace
- keeping the result clean, fast, and reversible

This is not a generic dashboard builder. It should feel intentional and controlled.

## Current Reality

Today the layout is fixed in the frontend:

- `manual` renders in its own slot above the main live grid
- the main live grid is hard-coded in [frontend/src/ui/app-shell.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/app-shell.ts)
- the live panel area is a fixed 3-column grid in [frontend/src/styles/app.css](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/styles/app.css)
- `monitored`, `pumpfun`, and `alerts` each render into dedicated slots
- only `collapsed` state is persisted today

There is no existing concept of:

- panel order preferences
- width/span preferences
- drag-and-drop layout state
- separate live layout vs history layout preferences

## Important Constraints

### 1. This should start as `live workspace only`

Trying to make this universal for both `live` and `history` on the first pass would be a mistake.

Reason:

- `history` has a different panel model (`lateralized` and `bid-zone`)
- it already uses a different grid shape
- the live request is much clearer and higher-value

Recommendation:

- first version only controls `monitored`, `pumpfun`, `alerts`
- `manual` stays outside the drag system
- `history` is explicitly out of scope for v1

### 2. PumpFun should have limited flexibility

Your rule makes sense:

- `pumpfun` can move positions
- `pumpfun` should not become a 2-column or 3-column dominant panel in v1

That keeps the layout sane and avoids one noisy panel becoming the whole workspace.

### 3. This should not be freeform pixel dragging

The correct model here is not:

- drag panel anywhere on screen

The correct model is:

- drag between predefined slots
- choose width spans from a constrained set
- persist a small clean layout schema

That gives the Apple-like feel without turning the workspace into a chaotic builder.

### 4. Mobile must stay deterministic

Desktop can support panel order and spans.

Mobile should almost certainly:

- ignore width spans
- preserve only order
- stack panels vertically

Otherwise the responsive behavior becomes fragile fast.

## Recommended V1 Scope

### Panels under layout control

- `monitored`
- `pumpfun`
- `alerts`

### Panels outside layout control

- `manual`
- all `history` panels

### Allowed spans in v1

- `alerts`: `1`, `2`, `3`
- `monitored`: `1`, `2`, `3`
- `pumpfun`: `1` only

### Allowed order in v1

Any order among:

- `monitored`
- `pumpfun`
- `alerts`

### Supported outcomes

- alerts on the left, center, or right
- alerts wide (`2/3`)
- alerts full width (`3/3`)
- monitored wide (`2/3`)
- monitored full width (`3/3`)
- pumpfun moved between columns but always standard width

## Proposed UX

### Drag model

Each live panel header gets a drag handle.

The interaction should feel like:

- press and drag the panel header
- live drop targets appear between panels
- release to reorder

This should reorder cards within a constrained grid, not float them freely.

### Resize model

Span changes should not depend on header buttons in v1.

Recommended first cut:

- keep drag on the panel header for reordering only
- add a thin draggable resize rail on the right edge for eligible panels
- snap the width to:
  - `1/3`
  - `2/3`
  - `3/3`

Reason:

- `monitored` already has a crowded header
- `pumpfun` already has inline config inputs in the header
- putting more buttons there would make the shell noisier and harder to use
- keeping resize on the edge and reorder on the header avoids ambiguous gestures

Important rule:

- do not use the same drag gesture for both reorder and resize
- reorder belongs to the header drag affordance
- resize belongs to the edge rail

If this lands well, the resize rail can get more visual polish later.

## Proposed State Model

Add a dedicated live layout preference in `uiPrefs`.

Suggested shape:

```ts
livePanelLayout: {
  order: Array<'monitored' | 'pumpfun' | 'alerts'>;
  spans: {
    monitored: 1 | 2 | 3;
    pumpfun: 1;
    alerts: 1 | 2 | 3;
  };
}
```

### Default

```ts
{
  order: ['monitored', 'pumpfun', 'alerts'],
  spans: {
    monitored: 1,
    pumpfun: 1,
    alerts: 1,
  },
}
```

## Architecture Changes Needed

### Frontend state

Add live layout prefs to:

- [frontend/src/state/app-state.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/state/app-state.ts)
- [frontend/src/state/app-controller.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/state/app-controller.ts)

### Persisted config

Add layout prefs to:

- [frontend/src/services/api/config.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/services/api/config.ts)
- backend `ui-prefs` normalization and validation

Likely backend touch points:

- [src/models/user-ui-pref.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/models/user-ui-pref.js)
- config route tests in [tests/config.test.js](/Users/ezequielmarinho/Volume-Bot-Alert/tests/config.test.js)

### Render layer

Refactor the live panel render path in:

- [frontend/src/ui/app-shell.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/app-shell.ts)

Needed change:

- stop treating `monitored`, `pumpfun`, and `alerts` as permanently fixed positions
- render them from a computed layout descriptor

### CSS / interaction layer

The current fixed grid in:

- [frontend/src/styles/app.css](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/styles/app.css)

needs to become:

- a 3-column layout with per-panel span classes
- deterministic order styling
- mobile fallback to vertical stack
- resize rail styling for `alerts` and `monitored`
- drag affordance styling for header reorder

## Implementation Phases

### Phase 1: Persisted live layout schema

- add `livePanelLayout` to frontend state defaults
- add backend normalization/validation
- persist/load through `uiPrefs`
- add config tests

Exit:

- new users get default live layout
- persisted layout reloads correctly

### Phase 2: Render from layout descriptor

- compute ordered live panel descriptors in `app-shell`
- render panels based on order rather than fixed slot assumptions
- support span classes for `alerts` and `monitored`
- keep `pumpfun` fixed to span `1`

Exit:

- layout can be changed programmatically and renders correctly

### Phase 3: Resize rails for span

- add draggable resize rails to `alerts` and `monitored`
- persist span changes

Exit:

- user can snap to `1/3`, `2/3`, `3/3`

### Phase 4: Drag-and-drop reorder

- draggable handle in panel header
- constrained drop zones
- persist reordered layout

Exit:

- user can reorder `monitored`, `pumpfun`, `alerts`

### Phase 5: Polish

- drag preview
- drop target styling
- keyboard-safe fallbacks
- mobile behavior sanity pass

## Risks

### App shell coupling

This touches one of the most sensitive frontend files:

- [frontend/src/ui/app-shell.ts](/Users/ezequielmarinho/Volume-Bot-Alert/frontend/src/ui/app-shell.ts)

The right move is to introduce a layout descriptor, not pile `if/else` branches onto the current fixed-slot logic.

### Persisted preference drift

If the layout schema is not normalized hard on both frontend and backend, users can end up with invalid saved layouts after future changes.

### Drag complexity

True drag-and-drop can get messy fast if done before the render layer is layout-driven.

That is why reorder should come after persisted schema and descriptor rendering.

## Recommendation

This feature is worth doing, but only with this scope:

- `live workspace only`
- drag reorder only for `monitored`, `pumpfun`, `alerts`
- resize rails only for `alerts` and `monitored`
- no freeform pixel resize
- no `history` workspace support in v1

That version is strong enough to feel premium, without turning the layout system into a rewrite.

## Decision

Recommended v1:

- `manual` stays fixed
- `history` stays fixed
- `pumpfun` can move but not expand
- `alerts` and `monitored` can move and span `1/3`, `2/3`, `3/3`
- layout persists in `uiPrefs`
