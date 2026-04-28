# PumpFun Fast 5x Alert Plan

## Purpose
This document defines a staged plan for an experimental alert that tries to identify recently migrated low-cap tokens with a realistic chance of continuing toward a fast `5x`.

The goal is not to predict every winner before the first move. Based on the current data exploration, the safer version of this alert is a continuation signal:

- token migrated recently
- low/mid initial post-migration market cap
- early volume is abnormal
- market cap already confirmed strength
- alert tries to catch the remaining move toward `5x+`

This plan is intentionally isolated so the feature can be removed without touching existing user alerts, surge alerts, HVNC, high-cap dump, or catalog eligibility behavior.

## Current Code Reality

### Data that already exists
- `token_catalog`
  - stores token source, current market state, first seen time, migration grace, latest volumes, and monitoring metadata
- `token_market_buckets_1m`
  - stores minute market-cap/price buckets
  - gives us post-migration market-cap trajectory
- `token_market_volume_buckets_1m`
  - stores minute close values for rolling volume windows
  - gives us early `VOL 5M`, `VOL 1H`, and `VOL 6H` behavior
- `src/services/catalog-worker.js`
  - is already the canonical Dex evaluation loop
  - already writes the market and volume buckets
- `src/services/user-alert-matcher.js`
  - already handles user-facing backend alert matching

### What this means
The backend already has enough market data to test this alert without adding on-chain enrichment.

However, the current data is still limited:
- no holder distribution
- no sniper/dev-wallet analysis
- no LP-lock or token-authority enrichment
- no direct buy/sell velocity unless Dex fields are already persisted elsewhere

So this first version must be treated as a market-behavior signal, not a conviction score.

## Product Intent

Alert when a post-migration token has already shown enough early strength that it may continue toward a fast `5x`.

This is not:
- a pre-migration PumpFun scanner
- a guaranteed entry signal before the move starts
- a replacement for current `RECENT TOKEN SURGE`
- a broad volume alert

The expected practical behavior is:
- if the token already moved around `2x` quickly
- and early volume is unusually strong
- alert while there may still be room from roughly `2x` to `5x+`

## Working Name

Recommended internal name:
- `pumpfun-fast-5x`

Recommended UI label:
- `PUMPFUN FAST 5X`

Keep the name specific. Do not reuse generic surge naming, because this rule has different semantics and should be removable as a unit.

## Initial Hypothesis From Data

From the sampled post-migration winners and failed tokens:

- fast `5x` winners averaged materially higher early volume than failed tokens
- volume alone was not enough, because many failed tokens had high `VOL 5M`
- the better separator was early volume plus market-cap response
- `time_to_2x <= 10-15m` looked more useful than raw `max_vol_5m`
- common winner `first_mcap` range was roughly `18k-45k`
- acceptable wider range was roughly `15k-80k`

Initial heuristic:

```text
source = pumpfun-migrated
migration_age <= 60m
first_mcap_post_migration between 15k and 80k
early volume strong
current/p95 mcap confirms at least around 2x quickly
```

## Ponto Importante

This alert should not be sold to the system as "finds tokens before they pump".

The safer first version is a confirmation alert. It will intentionally miss the absolute bottom in exchange for fewer false positives.

If we later try a pre-confirmation version that alerts before `2x`, it should be a separate mode or separate rule, because false positives will be much higher.

## Isolation Requirements

The implementation must be easy to remove.

Required boundaries:
- new service file for signal generation
- new config block / env flags for this rule
- no changes to existing surge thresholds
- no changes to HVNC behavior
- no changes to catalog eligibility gates unless explicitly planned
- no shared cooldown state with current surge alerts
- no reuse of `user-alert-matcher` internals unless wrapped behind a small adapter

Recommended files, if implemented:
- `src/services/pumpfun-fast-5x-signal.js`
- `src/services/pumpfun-fast-5x-alert.js`
- `tests/pumpfun-fast-5x-signal.test.js`
- optional docs update after validation:
  - `docs/current-bot-state.md`
  - `docs/bot-complete-reference.md`

## Feature Flag

Start disabled by default.

Recommended env/config:

```text
PUMPFUN_FAST_5X_ALERT_ENABLED=false
PUMPFUN_FAST_5X_DRY_RUN=true
```

Semantics:
- `ENABLED=false`
  - no runtime work
- `ENABLED=true` and `DRY_RUN=true`
  - compute candidates and log/store diagnostics only
  - do not emit user alerts
- `ENABLED=true` and `DRY_RUN=false`
  - emit alerts

Ponto importante:
- dry-run must be useful enough to compare candidates against real outcomes before users receive alerts.

## Block 1 - Offline Analysis Query

Goal:
- keep the SQL exploration reproducible before turning it into code

Current artifact:
- [docs/pumpfun-fast-5x-analysis-query.md](/Users/ezequielmarinho/Volume-Bot-Alert/docs/pumpfun-fast-5x-analysis-query.md)

Tasks:
- save the analysis query in a doc or utility script
- generate a dataset with both winners and failed tokens
- label outcomes:
  - `fast_5x`
  - `slow_5x`
  - `near_miss_3x`
  - `failed`

Recommended constraints:
- only tokens with completed `5h` window
- `source = pumpfun-migrated`
- `first_mcap` between `15k` and `80k`
- enough market buckets to avoid sparse-data lies

Exit criteria:
- we can reproduce the same summary table:
  - count by outcome
  - avg first mcap
  - avg p95 mcap multiple
  - avg p95 vol 5m
  - avg early vol 5m

No production behavior changes in this block.

## Block 2 - Pure Signal Function

Goal:
- implement only a deterministic classifier with no sockets, no DB writes, and no user matching

Input shape:

```js
{
  source,
  migrationAgeMs,
  firstMcap,
  currentMcap,
  p95McapRecent,
  p95Vol5mRecent,
  avgVol5mFirst30m,
  timeTo2xMs,
  bucketCoverage
}
```

Output shape:

```js
{
  passes,
  reason,
  score,
  evidence
}
```

Initial thresholds:
- `source === 'pumpfun-migrated'`
- `migrationAgeMs <= 60m`
- `firstMcap >= 15_000`
- `firstMcap <= 80_000`
- `timeTo2xMs <= 15m`
- `p95Vol5mRecent >= 40_000` or `avgVol5mFirst30m >= 40_000`
- `currentMcap >= firstMcap * 2` or `p95McapRecent >= firstMcap * 2`

Exit criteria:
- unit tests cover pass, fail, and edge cases
- no DB access inside the signal function
- no alert emission

Ponto importante:
- this block should be small and reversible. If the heuristic is bad, deleting this service and test should remove the behavior.

## Block 3 - Candidate Data Builder

Goal:
- build the runtime facts needed by the pure signal function

Current artifacts:
- `src/services/pumpfun-fast-5x-candidates.js`
- `tests/pumpfun-fast-5x-candidates.test.js`

Recommended approach:
- query only recent PumpFun migrated tokens
- compute post-migration `start_ts`
- read `1m` market buckets from `start_ts` to now
- read volume buckets over the same window
- compute:
  - `firstMcap`
  - `currentMcap`
  - `p95McapRecent`
  - `p95Vol5mRecent`
  - `avgVol5mFirst30m`
  - `timeTo2xMs`
  - coverage counts

Constraints:
- cap the runtime universe
- never scan full history in the hot path
- require statement timeout or query limits for any ad hoc utility
- avoid adding heavy work to every catalog token evaluation

Exit criteria:
- can produce candidate diagnostics for recent migrated tokens
- dry-run logs or stores why candidates pass/fail
- no user-facing alerts yet

## Block 4 - Dry-Run Runtime

Goal:
- run the rule alongside the bot without emitting alerts

Current artifacts:
- `src/services/pumpfun-fast-5x-dry-run.js`
- `tests/pumpfun-fast-5x-dry-run.test.js`
- `config.pumpfunFast5xAlert`
- admin status field: `pumpfunFast5xDryRun`
- JSON view: `GET /api/admin/pumpfun-fast-5x/dry-run`
- browser table view: `GET /api/admin/pumpfun-fast-5x/dry-run.html`
- use `?refresh=true` on either route to force one immediate dry-run evaluation

Recommended behavior:
- scheduled evaluator every `30s-60s`
- only checks recently migrated tokens
- writes compact diagnostics or structured logs:
  - token address
  - symbol
  - first mcap
  - current mcap
  - volume evidence
  - pass/fail reason
  - computed score

Exit criteria:
- compare dry-run candidates against actual later outcomes
- estimate false positives
- estimate missed winners
- confirm CPU/DB impact is acceptable

Ponto importante:
- this block is where we decide if the alert deserves to exist. Do not skip dry-run straight to user alerts.

## Block 5 - Alert Emission

Goal:
- emit a real alert only after dry-run data looks acceptable

Recommended behavior:
- separate event type / rule key:
  - `pumpfun-fast-5x`
- independent cooldown:
  - start with one alert per token per `6h`
- no interaction with surge cooldowns
- alert payload includes the evidence:
  - first mcap
  - current mcap
  - current multiple
  - early volume metric
  - time to `2x`

Exit criteria:
- alert appears in feed with distinct label
- duplicate suppression works
- disabling the feature flag fully stops emission

## Block 6 - User Config, Only If Needed

Goal:
- decide whether this should be global/admin-only or user-configurable

Recommendation:
- start admin/global only
- do not add frontend controls initially

Reason:
- frontend config adds product surface area
- the heuristic may be temporary
- removing the feature is much easier if no user preference schema is introduced

If later promoted:
- add a user setting only after the rule is stable
- keep defaults conservative
- document the alert semantics clearly

## Rollback Plan

If the alert performs badly:

1. Set `PUMPFUN_FAST_5X_ALERT_ENABLED=false`
2. Leave dry-run disabled
3. Remove the isolated service/test files if desired
4. Remove only the dedicated scheduler/registration hook

No existing alert rule should need to be reverted.

## Validation Plan

For code implementation blocks:
- run `node --test` on new and affected tests
- run `npm run lint`
- if frontend is touched later, run `npm --prefix frontend run build`
- if schema/init is touched later, run `npm run db:schema-check`

For behavior validation:
- compare dry-run candidates against completed `5h` outcomes
- track:
  - candidates emitted
  - candidates that reached `3x`
  - candidates that reached `5x`
  - candidates that failed below `2x`
  - average time from alert to peak

## Open Questions

- Should the first real alert require strict `2x`, or allow `1.7x-1.9x` with stronger volume?
- Should the alert target only `pumpfun-migrated`, or include `dexscreener-discovery` with separate thresholds?
- Should we score the signal instead of using hard pass/fail thresholds?
- Should high-volume failed tokens be filtered by liquidity, buy/sell imbalance, or on-chain enrichment later?
- Should this become a user-facing alert, or stay an admin-only experimental signal?

## Recommended First Implementation Scope

Start with Blocks 1-4 only.

Do not implement user-facing alert emission until dry-run proves:
- enough winners are caught
- false positives are tolerable
- DB load is acceptable
- the rule adds value beyond existing surge alerts
