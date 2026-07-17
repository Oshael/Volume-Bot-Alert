# Robinhood Custom Alerts and Capability-Aware Actions Completion Plan

Status: in progress (Blocks 0-2 complete; Block 3 frontend pending)

Created: 2026-07-16

## Objective

Complete the unfinished Robinhood Full Workspace Block 8 contracts for custom
alerts, generic token actions, notifications and external links.

The result must let the product distinguish three states explicitly:

- supported and ready for the selected chain;
- structurally supported but blocked by Robinhood rollout/readiness;
- unsupported for that chain or metric.

No client, route or worker may infer a token chain from its address shape. Every
public and internal token identity remains `(chain,address)`.

## Relationship to existing plans

This plan completes the still-open parts of Block 8 in
`docs/robinhood-full-workspace-support-plan.md`.

It depends on the chain identity, persistent catalog, normalized valuation,
Robinhood publication authorization and native history work already delivered
through `docs/workspace-catalog-activity-views-architecture-plan.md`.

It does not replace the Robinhood ingestion, signal or rollout gates in
`docs/robinhood-chain-onchain-monitoring-plan.md`. Custom alerts must use those
gates rather than create an independent path around them.

## Current repository evidence

### Storage is prepared but runtime ownership is still Solana-only

- Stage 58 added `chain` to `user_custom_alert_rules` and created the active
  `(chain,token_address)` index.
- The 2026-07-16 runtime inventory found four legacy `solana/mcap` rules, all
  disabled and normalized to the canonical `spot` window; there were no active
  or Robinhood custom rules. The Stage 58 active chain/token index was present.
- `src/models/user-custom-alert-rule.js` normalizes chain-aware identities and
  can store a Robinhood rule.
- The same model deliberately rejects automatic Robinhood triggering through
  `NON_SOLANA_CUSTOM_ALERT_TRIGGER_DISABLED`.
- `src/routes/dashboard.js` forces `chain: 'solana'` when rules are listed or
  created and uses the Solana catalog baseline reader.
- update and disable operations are owned only by `(id,user_id)` and do not
  require the rule chain in their mutation boundary.
- `src/services/user-alert-matcher.js` accepts only Solana tokens, lists custom
  rules without a chain argument and evaluates `price` or `mcap` only.

The test named `stores generic Robinhood rules but keeps automatic triggering
disabled` is therefore a fail-closed foundation test, not evidence that the
feature is complete.

### The public custom-alert contract loses chain

- frontend custom-alert input, rule and API payload types carry
  `tokenAddress`, but not `chain`;
- the token picker intentionally filters candidates to Solana;
- a pasted EVM address can pass the frontend address-shape check, but the route
  later interprets it as Solana and rejects it for the wrong reason;
- rules support only the persisted metric names `price` and `mcap`;
- the Stage 48 database constraint also accepts only `price` and `mcap`;
- the API exposes no explicit capability response for metric/window support.

### Robinhood already has a safe publication boundary

- `automatic-alert-publication-guard.js` issues an opaque authorization only
  when Robinhood alerts are requested and rollout is effectively publishable;
- `user-alert-event.createEventOnce` accepts a non-Solana event only with that
  authorization;
- Robinhood alert delivery already provides transactional persistence,
  chain-scoped dedupe and post-commit publication;
- the current Robinhood matcher is token-level across accepted V2/V3/V4
  activity, but it evaluates the built-in five-minute signal, not user custom
  rules.

Custom-alert evaluation must reuse this authorization and delivery boundary.
Removing the non-Solana guards globally would weaken the rollout contract.

### Generic token actions are mostly chain-aware

Manual, folder, pin, star and block mutations now carry chain through client,
route and persistence boundaries. Robinhood smoke coverage protects the main
manual/star/block flow, and pin handling is canonical-identity aware.

Remaining work is an exhaustive surface audit rather than a new CRUD design:

- verify remove/unpin/unblock/folder removal and reload behavior;
- require explicit chain on every non-legacy mutation;
- retain address-only input only as a documented Solana compatibility adapter;
- include chain in notification data and any navigation target;
- prove that same-address identities on different EVM chains cannot collide.

### External-link behavior is only partially verified

- the Robinhood explorer helper points to Robinhood Blockscout;
- Solana trading terminals are omitted for Robinhood;
- market navigation accepts any non-empty stored `pairUrl` before falling back
  to the explorer;
- the frontend helper does not prove that a stored pair URL belongs to the
  requested chain.

Chain correctness must be enforced at the metadata boundary and defensively at
render time. A missing verified market URL must fall back to the verified
explorer, never to a Solana destination.

## Approved product contract

### Custom-alert capability matrix

Custom alerts in this plan are spot threshold crossings. Rolling-window custom
alerts are not introduced.

| Chain | Metric | Stored name | Supported window | Source |
| --- | --- | --- | --- | --- |
| Solana | Price USD | `price` | `spot` | accepted Solana market snapshot |
| Solana | Market cap USD | `mcap` | `spot` | trusted circulating market cap |
| Robinhood | Price USD | `price` | `spot` | committed token-level accepted bucket |
| Robinhood | FDV USD | `fdv` | `spot` | committed token-level accepted bucket |

Required rejection behavior:

- Robinhood `mcap` is rejected; FDV is never copied into market cap;
- Solana `fdv` remains rejected until a separate trusted product contract is
  approved;
- every rolling window such as `5m`, `1h`, `6h` or `24h` is rejected for custom
  alerts in this plan;
- unknown chains, metrics and windows fail closed with stable error codes;
- readiness failure is distinct from unsupported capability.

The canonical window value is `spot`. Legacy rules without a stored window are
read as `spot` during migration.

### Capability response

The backend readiness/config contract must expose per-chain custom-alert
capabilities without enabling them solely because the chain is selectable.

The minimum normalized response per chain is:

```json
{
  "supported": true,
  "ready": false,
  "metrics": ["price", "fdv"],
  "windows": ["spot"],
  "reason": "rollout_not_publishable"
}
```

`supported` describes implemented product behavior. `ready` remains derived
from live rollout state. The frontend may render a disabled explanation when
supported is true but ready is false; it may not silently fall back to Solana.

### Normalized evaluation input

Custom-rule evaluation receives a chain-neutral, token-level observation:

```json
{
  "chain": "robinhood",
  "address": "0x...",
  "observedAt": "2026-07-16T00:00:00.000Z",
  "ordering": { "blockNumber": 1, "logIndex": 2 },
  "values": {
    "price": 0.001,
    "fdv": 1000000
  }
}
```

The Robinhood observation must be produced only after the aggregate token
bucket is committed. It represents accepted token activity across V2/V3/V4,
not a protocol-isolated market card.

Duplicate or older observations cannot regress a rule's evaluation cursor or
emit a second event. External metadata failures cannot delay evaluation.

### Crossing, persistence and delivery

- rules retain `cross_above` and `cross_below` semantics;
- creation stores the baseline for the selected metric and valuation type;
- evaluation compares like-for-like metric types only;
- a missing previous value arms the rule but does not invent a crossing;
- trigger mutation and event insert occur transactionally;
- event dedupe includes user, rule, chain and rule id;
- Robinhood event creation requires the opaque rollout authorization;
- a blocked rollout leaves the rule active and emits nothing;
- delivery uses the existing backend feed/socket path after commit;
- event payloads carry chain, metric, previous/current/target values and
  valuation type.

### Generic action contract

Every action originating from a token surface must preserve canonical identity
through completion:

- copy copies the displayed contract and retains chain in action metadata;
- manual add/remove and folder add/remove use `(chain,address)`;
- pin/unpin/reorder use `(chain,address)` and stable positions;
- star/unstar and block/unblock use `(chain,address)`;
- alert-feed actions and notification navigation retain the event chain;
- reload restores the same chain-owned state;
- a missing chain is accepted only by explicitly documented legacy Solana
  adapters.

Servers must reject an EVM-shaped address presented through a legacy
address-only endpoint instead of guessing its chain.

### External-link contract

- explorer destinations come from a chain allowlist;
- Robinhood explorer links use the Robinhood Blockscout origin;
- market links are accepted only from chain-validated metadata with an approved
  HTTPS origin and path contract;
- redirects, non-HTTP schemes and chain-mismatched paths are rejected;
- when no verified market destination exists, use the explorer;
- Solana terminal URLs are never rendered for a Robinhood identity;
- link builders return `null` for future chains until their destination is
  explicitly approved.

## Target architecture

### Chain-aware rule repository

All public model operations use a canonical identity or explicit chain:

- `createRule(userId, identity, rule)`;
- `listRules(userId, filters)` with explicit selected chains;
- `listActiveByTokenIdentity(identity)`;
- `updateRule(id, userId, chain, patch)`;
- `disableRule(id, userId, chain)`;
- `markTriggered(id, userId, chain, options)`.

Update, disable and trigger queries include `chain` in their `WHERE` clause.
An id owned by another chain cannot be mutated through the wrong route.

### Shared custom-rule evaluator

Extract crossing and normalized metric selection from the Solana matcher into a
small service that has no ingestion dependency. Both chain owners call it with
their own committed normalized observations.

The service returns intents; it does not issue rollout authorization and does
not publish directly. Solana retains its existing path. Robinhood hands intents
to its authorized delivery boundary.

This preserves separate ingestion pipelines while sharing deterministic custom
rule semantics.

### Frontend capability ownership

The custom-alert picker stores `{chain,address}` and keys candidates by
`chain:address`. Metric options are derived from the selected token's
capability response.

The UI must distinguish:

- selectable metric;
- unsupported metric, with an explicit explanation;
- supported metric temporarily unavailable due to readiness;
- stale baseline, which is displayed but not silently replaced.

Editing an existing rule preserves its chain. A user cannot change a rule to a
different chain by editing the address field; that requires creating a new
rule.

## Implementation blocks

### Block 0 - Freeze capability and migration contract

- add table-driven capability policy for chain, metric and window;
- define stable unsupported/readiness error codes;
- inventory existing custom rules and confirm Stage 58 application;
- decide the next schema stage number from the repository at implementation
  time;
- document rollback before applying the migration.

Acceptance: one policy function is the backend source of truth; frontend
normalization cannot expand it.

Expected cuts: policy and tests, 150–250 changed lines; migration and runtime
schema registration, 120–220 changed lines.

### Block 1 - Complete chain-aware persistence and routes

- add persisted `fdv` metric support and canonical `spot` window;
- backfill legacy rows to `spot` without changing their trigger status;
- make repository ownership chain-aware for every operation;
- accept explicit chain in list/create/update/disable routes;
- replace the hardcoded Solana baseline lookup with per-chain adapters;
- return capability/readiness errors without converting them to generic 500s.

Acceptance: Robinhood price/FDV rules round-trip through PostgreSQL; a wrong-
chain update/delete affects zero rows; unsupported combinations return 4xx with
stable codes.

Expected cuts: schema/init 120–220 lines; model 180–280 lines; routes and
integration tests 180–300 lines.

### Block 2 - Shared evaluator and Robinhood authorized delivery

- extract deterministic crossing evaluation;
- pass chain to active-rule lookup and trigger mutation;
- add ordered-observation/idempotency protection;
- connect committed Robinhood token aggregates to the evaluator after commit;
- issue and consume rollout authorization only in the existing Robinhood
  publication owner;
- deliver custom events through chain-aware event persistence and backend feed;
- keep rules active while rollout is blocked.

Acceptance: an accepted Robinhood crossing emits exactly one custom event;
duplicates/out-of-order inputs emit none; disabled rollout emits none; FDV is
never exposed as MCAP.

Expected cuts: evaluator 180–280 lines; Solana adapter 100–180 lines;
Robinhood integration 200–320 lines; delivery tests 180–300 lines.

### Block 3 - Frontend custom-alert capability UI

- add chain and window to API/state types;
- key candidates and rules by canonical identity;
- include Robinhood tokens only when capability data allows them;
- render Price/FDV choices for Robinhood and Price/MCAP for Solana;
- show unsupported versus temporarily unavailable states explicitly;
- preserve rule chain across edit, list and disable operations;
- render FDV terminology in previews, feed cards and browser notifications.

Acceptance: the UI cannot submit a mismatched metric/window; direct malformed
API requests still fail closed; same-address EVM identities remain isolated.

Expected cuts: types/controller 160–260 lines; modal UI 180–300 lines; visible
tests 150–250 lines.

### Block 4 - Generic action and external-link audit

- audit every generic token surface and action against the canonical action
  contract;
- close missing remove/unpin/unblock/folder/reload test coverage;
- include chain in browser notification data and navigation;
- centralize chain-validated explorer/market destination resolution;
- reject mismatched stored market URLs and test explorer fallback;
- prove Robinhood actions never generate Solana terminal or explorer URLs.

Acceptance: representative create and inverse actions survive reload for both
chains; link tests cover approved, missing, malformed and mismatched URLs.

Expected cuts: action gaps 120–220 lines; link resolver 120–220 lines; focused
integration/smoke coverage 150–260 lines.

### Block 5 - Rollout and closure

- shadow-log custom-rule decisions without delivery;
- compare expected crossings against committed Robinhood observations;
- enable delivery only under the existing rollout gates;
- observe dedupe, latency, errors and blocked-readiness behavior;
- run Solana-only, Robinhood-only and combined visible flows;
- update the parent workspace plan only after every acceptance gate passes.

Acceptance: no cross-chain mutation or URL leakage; no duplicate custom event;
unsupported combinations are visibly rejected; rollback has been rehearsed.

Expected cuts: telemetry/ops documentation 120–220 lines; final validation and
plan closure in a separate cut.

## Test strategy

### Unit

- capability matrix by chain, metric and window;
- normalized identity and wrong-chain rejection;
- crossing semantics for price, MCAP and FDV;
- missing baseline, duplicate and out-of-order observations;
- link allowlist and chain-mismatch rejection.

### Integration

- Stage migration and runtime schema check;
- create/list/update/disable ownership by `(user,chain,id)`;
- Robinhood authorized event persistence and transactional trigger;
- blocked rollout leaves the rule active;
- backend feed preserves custom metric and chain;
- inverse generic actions persist and survive reload.

### Smoke

- create a Robinhood Price rule and a Robinhood FDV rule;
- reject Robinhood MCAP and rolling-window submissions;
- receive one Robinhood custom alert in the feed;
- filter its sound/browser delivery by chain;
- edit and disable the rule without touching a same-address identity;
- exercise verified market link and explorer fallback;
- verify no Solana destination is rendered for Robinhood.

## Mandatory validation by change type

- run affected tests with `node --test ...` after every cut;
- run `npm run db:schema-check` and `npm run db:schema-check:test` for the new
  schema/init stage;
- run `npm --prefix frontend run build` for every frontend cut;
- run repository lint and reject new warnings;
- run the applicable Chromium smoke after visible-flow changes;
- review the complete cut diff before proposing a commit;
- keep schema, backend evaluator, frontend and rollout commits separated.

## Rollout and rollback

### Stage 76 rollback boundary

The safe rollback is functional: disable Robinhood custom-alert readiness and
return application reads to Solana while retaining the additive `window`
column and expanded metric constraint. Stored rules must not be deleted or
silently converted between FDV and market cap.

A destructive rollback is allowed only before any `metric = 'fdv'` rule exists
and after backup. First verify:

```sql
SELECT chain, metric, "window", COUNT(*)
FROM user_custom_alert_rules
GROUP BY chain, metric, "window";
```

If any FDV or non-spot row exists, stop. Otherwise remove the window constraint
and column, replace `user_custom_alert_rules_metric_check` with the original
`price/mcap` check, deploy the previous runtime schema, and run both schema
checks. Never change rule `status`, `triggered_at` or historical events during
rollback.

Rollout order:

1. apply and validate schema while runtime behavior remains disabled;
2. deploy capability responses and chain-aware CRUD;
3. shadow-evaluate Robinhood observations without delivery;
4. compare crossings, ordering and dedupe telemetry;
5. enable authorized delivery for internal/admin users;
6. expand only while the existing Robinhood rollout remains publishable.

Rollback order:

1. disable Robinhood custom-alert readiness/delivery;
2. stop evaluator consumption while leaving rules stored and active;
3. retain chain, metric and window columns for forward compatibility;
4. revert UI capability exposure;
5. do not delete user rules or historical events.

## Completion definition

This plan is complete only when:

- custom-alert persistence, evaluation and delivery preserve chain end to end;
- Robinhood Price and FDV spot rules can trigger through authorized delivery;
- unsupported metric/window combinations fail closed with visible reasons;
- generic create and inverse actions preserve identity and survive reload;
- notifications and external links remain chain-correct;
- no Robinhood action, notification or link targets a Solana identity or URL;
- all schema, unit, integration, build, lint and visible smoke gates pass;
- the parent Robinhood workspace plan records Block 8 as complete.
