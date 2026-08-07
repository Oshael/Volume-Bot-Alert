# Chain-Scoped Bot Settings Safe Recovery Plan

Status: Ready for implementation  
Created: 2026-07-28  
Target branch: `Robinhood-Implementation`  
Recovery baseline: `aaeb567d`

## 1. Purpose

This document defines the safe reconstruction of the chain-scoped Bot Settings
feature that was implemented and then unintentionally removed on 2026-07-20.

The recovered feature must allow each user to:

- configure Solana and Robinhood alert thresholds independently;
- enable or disable each alert rule next to its threshold;
- configure a chain even while that chain is inactive in the workspace selector;
- use the top workspace chain selector as the authoritative switch for Radar
  monitoring and backend alert generation;
- keep browser-notification chain selection independent;
- keep sound settings shared across chains;
- use Solana-only controls only for Solana;
- use Robinhood-only controls only for Robinhood.

The goal is behavioral recovery, not a literal replay of the old patch. The
implementation must be adapted to the repository's current cache,
configuration, visibility, and alert lifecycle contracts.

## 2. Incident summary

The original feature was implemented in an uncommitted working tree on
2026-07-20. A later task attempted to roll back only its own experiment but used
file-wide `git restore` operations against the shared working tree. Those
operations removed the earlier Bot Settings work as collateral.

The recovery must not repeat that failure mode.

Mandatory safeguards:

- never use a file-wide restore to isolate changes from one task;
- never treat every dirty file as belonging to the current task;
- inspect `git status` before every cut;
- commit each completed cut separately;
- stage only files and hunks belonging to the current cut;
- review the complete staged diff before every commit;
- stop if unexpected changes appear in an overlapping file;
- preserve unrelated untracked files;
- use commit reverts for rollback after a cut has been committed.

## 3. Current baseline

The recovery begins after these isolated commits:

- `64a2c52e` — manual token sort controls;
- `a4e16b8a` — FOMO terminal support;
- `aaeb567d` — removal of obsolete tracked project notes.

Expected untracked files at the start:

- `DESCOBERTAS-NODE.md`
- `docs/hetzner-multichain-wallet-roadmap.md`
- `docs/normalized-swap-retention-capacity-plan.md`
- `docs/solana-yellowstone-grpc-firehose-plan.md`
- this recovery plan until it is intentionally committed.

No tracked modification may be present when Cut 1 starts.

## 4. Non-goals

This recovery does not include:

- database schema changes;
- different sound selections per chain;
- a third blockchain;
- a redesign of the top workspace chain selector;
- changes to alert calculation formulas;
- changes to alert cooldown, rearm, or deduplication behavior;
- deletion of legacy global configuration keys;
- changes to Robinhood rollout visibility rules;
- changes to card rendering outside Bot Settings;
- migrations that eagerly rewrite every user's stored configuration.

Any of these requirements must be handled in a separate plan and commit series.

## 5. Required product behavior

### 5.1 Bot Settings navigation

The sidebar must contain:

1. Solana
2. Robinhood, when Robinhood is globally available to the user
3. Notifications
4. Sound

`Thresholds` and `Alerts & Chains` must no longer be separate categories.

The chain tabs are configuration scopes. They must not depend on whether the
chain is currently selected in the top workspace selector.

Example:

- Robinhood is available to the user.
- The top selector currently enables only Solana.
- The Robinhood Bot Settings tab remains visible and editable.
- Robinhood alerts do not run until Robinhood is enabled in the top selector.

If Robinhood is hidden by rollout or visibility policy, the UI must not expose
the Robinhood configuration tab merely because scoped keys exist in storage.

### 5.2 Master chain behavior

`chainFilters.enabledChains` is authoritative for:

- live Monitored content;
- Radar content;
- visible alert feed content;
- backend alert matching for active user profiles.

The legacy `radarChains` and `alertFeedChains` values may remain in persisted UI
preferences for backward compatibility, but runtime normalization must derive
them from `enabledChains`.

`browserNotificationChains` remains independently configurable, constrained to
the currently enabled chains.

The system must never allow zero enabled workspace chains.

### 5.3 Inline alert controls

Every threshold-controlled alert must display:

- its threshold input;
- its unit;
- an adjacent on/off switch;
- an accessible label containing the rule and chain.

The switch must:

- update visually immediately;
- persist only the scoped configuration key;
- revert visually if persistence fails;
- remain consistent with any server-normalized response;
- avoid duplicate requests from a single click.

### 5.4 Chain-specific fields

Solana settings:

- 5-minute volume-rise threshold and toggle;
- 5-minute market-cap-rise threshold and toggle;
- minimum volume;
- minimum and maximum market cap;
- HVNC minimum volume and toggle;
- Recent 1H and 6H surge thresholds and toggles;
- Old 1H and 6H surge thresholds and toggles;
- Meteora 1H threshold and toggle;
- Pump claim toggle;
- Bags claim toggle;
- shortcut terminal preferences.

Robinhood settings:

- 5-minute volume-rise threshold and toggle;
- 5-minute FDV-rise threshold and toggle;
- minimum volume;
- minimum and maximum FDV;
- HVNC minimum volume and toggle;
- Recent 1H and 6H surge thresholds and toggles;
- Old 1H and 6H surge thresholds and toggles.

Robinhood must not expose:

- market-cap alerts;
- Meteora alerts;
- Pump claim alerts;
- Bags claim alerts;
- Solana-only launchpad behavior.

Solana must not expose or enable Robinhood FDV alert rules.

### 5.5 Shared settings

Notifications retains:

- browser notification permission/status;
- browser notification chain selection;
- card effects;
- safety prompts;
- the existing admin-only legacy chain field, if it still must remain
  editable. It must not be deleted or repurposed during this recovery.

Sound retains:

- global sound mode;
- alert-type sound toggles;
- global volume;
- uploaded sound selection.

Sounds are deliberately not scoped by blockchain.

## 6. Configuration storage design

The existing `user_configs` key/value table is sufficient. No schema migration
is planned.

Scoped keys use this format:

```text
solana-<legacy-key>
robinhood-<legacy-key>
```

Examples:

```text
solana-threshold
solana-alert-vol-enabled
solana-mcap-threshold
solana-alert-mcap-enabled
robinhood-threshold
robinhood-alert-vol-enabled
robinhood-fdv-threshold
robinhood-alert-fdv-enabled
```

The allowed scoped-key catalog must be explicit per chain. It must not generate
Robinhood variants for Solana-only rules.

### 6.1 Compatibility rules

For an existing user with no stored scoped value:

1. read the current legacy global value;
2. expose it as the in-memory fallback for both supported chains where valid;
3. do not write the fallback merely because the configuration was read;
4. persist a scoped key only after the user changes that chain's setting.

For an existing user with an explicit scoped value:

- the scoped value always wins;
- a later global-key change must not overwrite it.

For a new user:

- scoped defaults match the current safe defaults;
- Robinhood FDV alerts remain off unless the existing default contract says
  otherwise;
- unsupported rules are hard-disabled in the normalized chain profile.

Legacy global keys must remain accepted and readable throughout this recovery.
They provide the rollback-compatible fallback and must not be deleted.

## 7. Normalized alert profile design

The profile cache must continue returning the current top-level legacy fields
for compatibility while adding:

```js
{
  enabledChains: ['solana', 'robinhood'],
  alertConfigByChain: {
    solana: { /* normalized Solana settings */ },
    robinhood: { /* normalized Robinhood settings */ }
  }
}
```

Chain profile selection must:

- preserve user identity;
- preserve `configVersion`;
- preserve `loadedAt`;
- preserve `alertSessionKey`;
- preserve presence and hidden-session metadata;
- replace only the alert settings and `ruleEnabled` map;
- hard-disable unsupported rules even if a malformed stored value exists.

The selector must be a small pure helper with unit tests. Matchers must not
duplicate chain-profile merging logic.

## 8. Cache and cross-process invalidation

The repository now uses event-driven user configuration invalidation. The old
2026-07-20 implementation predates this contract and must not be copied
literally.

Required behavior:

- a scoped configuration PATCH invalidates the local profile cache;
- it publishes the normal PostgreSQL invalidation event;
- a change to `chainFilters.enabledChains` also invalidates the alert profile;
- the chain-filter invalidation must force refresh even though the
  `user_configs` version did not change;
- other UI preference changes must not invalidate alert profiles;
- active alert sessions must retain their session identity across refreshes;
- all web/background processes must converge on the new profile.

The implementation may reuse the existing config invalidation channel with an
explicit forced-invalidating version contract, or add a narrowly scoped helper.
It must not restore polling-based cache invalidation.

## 9. Runtime alert enforcement

Before evaluating a candidate, each matcher must:

1. discard profiles where the candidate chain is not in `enabledChains`;
2. select the normalized configuration for that chain;
3. evaluate the existing rule without changing its calculation semantics.

Affected runtime paths:

- Solana user alert matcher;
- Robinhood HVNC matcher;
- Robinhood standard alert matcher.

The recovery must not alter:

- threshold crossing rules;
- startup priming;
- repeat steps;
- cooldowns;
- alert session keys;
- state persistence;
- cross-window deduplication;
- publishability checks.

## 10. Frontend state behavior

The frontend must:

- normalize Radar and alert-feed chains from the master selection;
- continue persisting the complete chain-filter object expected by the API;
- ignore stale independent Radar/feed selections from older preferences;
- preserve the browser notification subset;
- keep a chain's configuration data loaded while the chain is inactive;
- render only configuration tabs allowed by `availableChains`;
- send scoped keys through the existing partial config PATCH endpoint.

Alert visibility and local sound/notification decisions must resolve the
appropriate scoped key from the alert's chain, with a legacy global fallback.

## 11. Implementation cuts

Each cut is limited to 500 changed lines, including code and tests. A cut ends
after validation, complete diff review, and a user-facing report. Starting one
cut never authorizes the next.

### Cut 1 — Scoped configuration contract

Estimated size: 380–450 changed lines.

Primary files:

- `src/models/user-config.js`
- `src/services/user-alert-profile-cache.js`
- `src/services/chain-alert-profile.js`
- `tests/user-config.test.js`
- `tests/user-alert-profile-cache.test.js`
- `tests/config.test.js`

Deliverables:

- explicit allowed scoped keys;
- legacy fallback behavior;
- normalized `alertConfigByChain`;
- pure chain-profile selector;
- no runtime matcher changes yet.

Safety property:

The backend understands and returns scoped configuration while all current
matchers continue using the legacy top-level profile.

Required validation:

```bash
npm run lint
node --test tests/user-config.test.js \
  tests/user-alert-profile-cache.test.js \
  tests/config.test.js
```

Commit scope:

```text
feat(config): add chain-scoped alert profiles
```

### Cut 2 — Runtime enforcement and invalidation

Estimated size: 350–450 changed lines.

Primary files:

- `src/routes/config.js`
- `src/services/user-config-sync.js`, only if required by the selected design
- `src/services/chain-alert-profile.js`
- `src/services/user-alert-matcher.js`
- `src/services/robinhood-alert-matcher.js`
- `src/services/robinhood-standard-alert-matcher.js`
- corresponding matcher, route, cache, and sync tests

Deliverables:

- chain-disabled profiles filtered before matching;
- chain-specific settings selected before evaluation;
- chain-filter UI preference changes invalidate alert profiles cross-process;
- alert session metadata preserved.

Safety property:

Existing alert calculations remain unchanged. Only profile eligibility and
configuration selection become chain-aware.

Required validation:

```bash
npm run lint
node --test \
  tests/user-alert-matcher.test.js \
  tests/robinhood-alert-matcher.test.js \
  tests/robinhood-standard-alert-matcher.test.js \
  tests/user-alert-profile-cache.test.js \
  tests/user-config-sync.test.js \
  tests/config.test.js
```

Commit scope:

```text
feat(alerts): enforce chain-scoped user settings
```

### Cut 3 — Master chain semantics in the frontend

Estimated size: 300–420 changed lines.

Primary files:

- `src/models/user-ui-pref.js`
- `frontend/src/utils/token-chain.ts`
- `frontend/src/state/alert-feed-actions.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/services/alerts/browser-notifications.ts`
- focused unit tests

Deliverables:

- master selection controls Radar and alert-feed visibility;
- browser notification chains remain independent;
- stale legacy Radar/feed filters normalize safely;
- local alert behavior resolves scoped keys;
- no Bot Settings visual redesign yet.

Safety property:

The existing UI remains usable while frontend semantics become compatible with
the new backend contract.

Required validation:

```bash
npm run lint
npm --prefix frontend run build
node --test \
  tests/frontend-token-chain.test.js \
  tests/browser-notifications.test.js \
  tests/user-ui-pref.test.js
```

Commit scope:

```text
feat(workspace): use the master chain alert scope
```

### Cut 4 — Bot Settings structure and interaction

Estimated size: 350–450 changed lines.

Primary files:

- `frontend/src/ui/sections/layout-sections.ts`
- focused smoke-test setup if it fits under the cut limit

Deliverables:

- Solana and available Robinhood sidebar tabs;
- removal of the Alerts & Chains tab;
- chain-specific fields;
- inline accessible toggles;
- Pump and Bags separated;
- card effects moved to Notifications;
- global sound section preserved;
- inactive but available chains remain configurable.

Safety property:

Every input name maps to an allowed scoped backend key. Unsupported fields are
not merely hidden; their rules are also disabled by backend normalization.

Required validation:

```bash
npm run lint
npm --prefix frontend run build
```

Commit scope:

```text
feat(settings): restore chain-scoped bot controls
```

### Cut 5 — Styling, failure behavior, and visible regression protection

Estimated size: 250–350 changed lines.

Primary files:

- `frontend/src/styles/app.css`
- `frontend/src/ui/sections/layout-sections.ts`, only for small corrections
- `tests/smoke/chain-selector.spec.js`

Deliverables:

- final responsive layout;
- consistent toggle sizing;
- readable surge labels;
- Pump/Bags visual hierarchy;
- optimistic-toggle rollback on request failure;
- smoke coverage for independent chain settings and master selector behavior.

Required validation:

```bash
npm run lint
npm --prefix frontend run build
npx playwright test tests/smoke/chain-selector.spec.js \
  --grep "chain-scoped bot settings|master chain selector"
```

Commit scope:

```text
test(settings): protect chain-scoped bot behavior
```

## 12. Mandatory regression matrix

### Configuration compatibility

- Fresh user receives valid defaults for both available chains.
- Existing global-only user sees the same effective values in both profiles.
- Explicit Solana override does not alter Robinhood.
- Explicit Robinhood override does not alter Solana.
- A later global update does not overwrite an explicit scoped value.
- Invalid or unsupported scoped keys are rejected.
- Robinhood cannot enable Solana-only rules.
- Solana cannot enable Robinhood-only FDV rules.

### Chain activation

- Solana only: only Solana profiles are evaluated.
- Robinhood only: only Robinhood profiles are evaluated.
- Both enabled: both are evaluated independently.
- Disabling Robinhood invalidates cached profiles in all processes.
- Re-enabling Robinhood uses the latest stored Robinhood settings.
- At least one workspace chain always remains enabled.

### User interface

- Solana settings remain visible when only Robinhood is active.
- Robinhood settings remain visible when only Solana is active, provided
  Robinhood is available to that user.
- Robinhood tab is absent when rollout visibility hides Robinhood.
- Switching tabs does not overwrite unsaved or stored values from the other
  chain.
- Inline toggle updates immediately.
- Failed PATCH restores the previous toggle state and surfaces an error.
- Pump and Bags have independent keys and switches.
- Notifications and Sound remain operational.

### Alert lifecycle

- Profile refresh does not create a new alert session.
- Primed state survives configuration refresh.
- Cooldowns and repeat thresholds remain unchanged.
- Existing rule-state rows continue to use the same chain and rule keys.
- No duplicate alert is emitted because a profile changed shape.

## 13. Validation discipline

Before every cut:

```bash
git status --short
git diff --check
```

After edits:

1. run lint;
2. run the smallest affected test set;
3. run frontend build for frontend changes;
4. run smoke only for visible integrated behavior;
5. inspect `git diff --check`;
6. inspect `git diff --stat`;
7. inspect the complete diff;
8. verify changed-line count is at most 500;
9. stage only the intended files or hunks;
10. inspect the complete staged diff;
11. commit with the cut's scope;
12. stop and report before starting another cut.

Do not rerun a passing validation unless a later edit can affect it.

## 14. Stop conditions

Stop immediately and request direction if:

- a cut exceeds 500 changed lines;
- estimated scope grows by more than 20%;
- a schema migration becomes necessary;
- a new subsystem is required;
- existing changes appear in a file needed by the cut;
- current behavior contradicts this plan;
- event-driven invalidation cannot safely represent chain-filter changes;
- a test exposes a preexisting failure relevant to the contract;
- alert lifecycle logic must change to make scoped profiles work;
- a globally hidden chain would be exposed by the proposed UI.

## 15. Deployment order

The completed feature should normally deploy as one tested commit series.

If deployment must be split:

1. deploy Cut 1 and Cut 2 backend compatibility first;
2. verify old frontend behavior remains functional;
3. deploy Cut 3 through Cut 5 frontend behavior;
4. verify configuration PATCHes and cross-process invalidation;
5. verify alert counts per chain.

Never deploy the scoped-key frontend before the backend accepts those keys.

## 16. Production verification

Use a controlled user account.

1. Record existing global settings.
2. Open Bot Settings and verify both available chain tabs.
3. Change one harmless Robinhood threshold.
4. Reload and verify persistence.
5. Confirm the Solana value did not change.
6. Disable Robinhood in the top selector.
7. Confirm Robinhood disappears from Radar and Alerts.
8. Confirm its Bot Settings tab remains available.
9. Re-enable Robinhood.
10. Confirm the stored Robinhood threshold returns.
11. Toggle one Robinhood alert off.
12. Confirm the worker refreshes the profile without restarting.
13. Restore the controlled user's original settings.

Operational signals to inspect:

- configuration PATCH errors;
- PostgreSQL config invalidation publish/listen errors;
- active profile counts by chain;
- unexpected drops in Solana alert publication;
- duplicate alert events after profile refresh;
- browser console errors while switching settings tabs.

## 17. Rollback strategy

Scoped values are additive and can remain stored safely during rollback.

Preferred rollback order:

1. revert Cut 5;
2. revert Cut 4;
3. revert Cut 3;
4. revert Cut 2;
5. revert Cut 1 only if required.

Why this order is safe:

- reverting the UI first stops new scoped writes;
- legacy global keys remain available;
- reverting runtime selection returns matchers to the legacy profile;
- stored scoped rows are ignored if their schema entries are later removed;
- no destructive data migration needs reversal.

Rollback commands must target commits, not entire dirty files:

```bash
git revert <commit>
```

Do not use:

```bash
git restore -- <shared-dirty-file>
git reset --hard
```

## 18. Completion criteria

The recovery is complete only when:

- all five cuts are committed separately;
- no cut exceeds 500 changed lines;
- all required lint, build, unit, integration, and smoke validations pass;
- the complete final diff series has been reviewed;
- no unrelated tracked changes remain;
- existing users retain their effective configuration;
- Solana and Robinhood settings persist independently;
- the master selector gates backend alerts per chain;
- browser notification and sound behavior match this plan;
- cross-process cache invalidation is proven by tests;
- rollback remains possible without deleting user data.

## 19. Important operational note

The highest-risk part of this recovery is not the Bot Settings markup. It is the
relationship between `enabledChains`, event-driven profile invalidation, and the
three alert matchers.

A visually correct UI is not sufficient evidence of success. The feature is
safe only when disabling a chain:

- updates persisted UI preferences;
- invalidates cached profiles in every relevant process;
- removes that chain's profiles from matching;
- does not reset alert sessions for the remaining chain;
- can be reversed without losing the disabled chain's stored settings.
