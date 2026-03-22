# Bot API Sanitization Plan

## Purpose

This document is the working plan for reducing unnecessary API usage, improving refresh behavior for hot tokens, and cleaning accumulated low-value catalog entries without losing important bot behavior.

This is a discussion and execution document.

It separates:
- agreed goals
- proposed changes
- open decisions that still need discussion
- validation metrics

Last updated: `2026-03-21`

## Current Problem Summary

The current bot is spending too many requests on catalog evaluation and related upstream reads.

Main symptoms:
- `high` priority tokens can take minutes to show fresh data
- the catalog worker appears to be spending capacity on lower-value tokens
- discovery may be pushing too many addresses into immediate evaluation
- the system has accumulated a large amount of low-signal or stale catalog entries
- some auxiliary routes still generate avoidable upstream traffic

## Main Goals

- Improve freshness for `high` priority tokens
- Reduce wasted upstream requests
- Prevent catalog backlog from growing due to low-value tokens
- Keep important user-visible behavior intact
- Add enough metrics to validate whether changes actually help

## Constraints

- Do not make silent behavior changes that affect user-owned data without discussion
- Do not remove or weaken important manual-token behavior by accident
- Do not assume every cleanup candidate is safe to delete
- Prefer reversible or soft-cleanup approaches first

## Important Open Principle

Manual token persistence policy is not settled in this plan.

We should not implement any change that alters the permanence, backend persistence, or recovery semantics of manual tokens without explicit agreement first.

For now, the safe assumption is:
- user manual tokens remain protected
- cleanup should not delete or archive manual tokens automatically

## Proposed Work Order

1. Phase 1: Catalog cleanup plan and safe cleanup primitives
2. Phase 2: Discovery sanitization
3. Phase 3: Cache and recheck policy by priority
4. Phase 4: Metrics review and second-pass tuning
5. Phase 5: Optional extra sanitization for auxiliary routes and workers

## Phase 1

### Goal

Reduce pressure from stale or low-value catalog entries before changing refresh aggressiveness.

### Why Start Here

If we increase refresh intensity for `high` tokens before reducing catalog noise, we risk spending more requests on a bloated token set.

Cleaning first should:
- shrink the number of due evaluations
- reduce competition in the catalog worker queue
- make later cache/recheck tuning more meaningful

### Phase 1 Proposed Scope

- define what counts as a cleanup candidate
- add a safe way to exclude low-value tokens from active evaluation
- avoid destructive deletion in the first pass
- preserve user-owned tokens
- add visibility into how many tokens are active vs stale vs archived

### Phase 1 Proposed Safety Model

First pass should use soft cleanup, not hard delete.

Preferred approach:
- add an archive or inactive flag for cleanup candidates
- stop archived or inactive tokens from being selected for normal evaluation
- keep the record available for audit, rollback, and later review

### Phase 1 Candidate Rules

Current working rule:

- protected tokens never enter automatic cleanup
- `below 15k` is a suspicion threshold, not an automatic delete/archive rule
- a token becomes low-value when it is:
  - not protected
  - below `15k`
  - and has at least one strong low-relevance signal:
    - not eligible now
    - `vol24h < 1k` or null
    - stale for `5d+`
    - repeated bad state such as `dex-missing`, `dex-known-no-mcap`, or repeated `evaluation-error`

Operational treatment:

- `dexscreener-discovery` low-value tokens go to `quarantine`
- non-discovery low-value tokens that are stale `5d+` or in repeated bad state go to `soft archive`

### Phase 1 Decisions Still Open

- Whether cleanup should use a new DB column such as `is_archived`, `is_active_monitor_candidate`, or both
- Whether inactive tokens should be fully excluded from discovery reactivation or only skipped by the catalog worker
- What exact thresholds define "trash" or "dust"
- How long a token must remain low-value before archiving
- Whether some discovery sources should have a stricter cleanup rule than others

### Phase 1 Explicit Non-Goals

- do not change manual-token persistence semantics
- do not delete records permanently in the first pass
- do not retune `high`/`normal`/`low` cache windows yet

## Phase 2

### Goal

Stop discovery from flooding the evaluation queue with low-value immediate work.

### Proposed Direction

- discovery only inserts truly new tokens
- discovery does not update existing catalog rows
- discovery does not re-schedule existing catalog rows
- new addresses discovered by Dex are inserted and scheduled once
- existing addresses are counted as skipped, not refreshed

### Current Implementation Direction

- if address already exists in `token_catalog`, discovery skips it entirely
- discovery no longer acts as a refresh source for known tokens
- catalog freshness should come from the catalog worker, not repeated discovery re-entry

## Phase 3

### Goal

Align cache and recheck policy with actual priority.

### Current Direction Under Discussion

- `high` keeps sub-bands by `6h` volume
- `normal`: cache and recheck around `60s`
- `low`: split into stricter low-value bands instead of a single bucket
- `dormant`: long recheck windows

### Current Implementation Direction

- `high-hot`:
  - `mcap >= 100k`
  - `vol6h >= 30k`
  - recheck `15s`
  - cache `15s`
- `high-warm`:
  - `mcap >= 100k`
  - `15k <= vol6h < 30k`
  - recheck `30s`
  - cache `30s`
- `high-cold`:
  - `mcap >= 100k`
  - `vol6h < 15k`
  - recheck `60s`
  - cache `60s`
- `normal`:
  - `30k - 100k`
  - recheck `60s`
  - cache `60s`
- `low-near`:
  - `15k - 30k`
  - recheck `180s`
  - cache `180s`
- `low-dust`:
  - `0 - 15k`
  - recheck `600s`
  - cache `600s`
- `dormant`:
  - no useful `mcap`
  - recheck `1800s`
  - cache `1800s`
- error cooldown:
  - `60s`

## Phase 4

### Goal

Measure results before making more aggressive changes.

### Validation Metrics

- due token count
- due token count by priority
- oldest overdue age by priority
- total evaluations per cycle
- actual upstream fetch count
- cache hit vs miss count
- discovery addresses seen vs scheduled vs skipped
- average refresh age for `high`
- error count and upstream timeout count

## Phase 5

### Goal

Optional cleanup of secondary traffic sources after the main catalog path is healthier.

### Likely Candidates

- PumpFun metadata route caching
- Meteora worker tuning
- frontend polling backoff

## Proposed Initial Config Direction

This section is a proposal only.

- `high`: `>= 100k`
- `normal`: `30k - 100k`
- `low-near`: `15k - 30k`
- `low-dust`: `5k - 15k`
- `dormant`: `< 5k` or repeated no-signal states

Proposed timing direction:
- `high`: `15s`
- `normal`: `60s`
- `low-near`: `180s`
- `low-dust`: `600s`
- `dormant`: `1800s`

## Discussion Checklist

Before Phase 1 implementation, we should explicitly agree on:

- cleanup should be soft archive, not delete
- manual tokens are excluded from automatic cleanup
- what sources are protected from cleanup
- what stale thresholds should be used
- whether cleanup is based on market cap, volume, error states, age, or a combination

## Status

- overall objective: agreed
- work order: proposed
- phase 1 strategy: initial implementation approved
- manual-token persistence changes: not approved
- cleanup thresholds: initial `15k / vol24h < 1k / stale 5d+` rule approved
- discovery sanitization details: phase 2 approved and being implemented
- priority timing config: phase 3 approved and implemented
