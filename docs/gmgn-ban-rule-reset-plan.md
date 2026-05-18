# GMGN Ban Rule Reset Plan

Context: the current production evidence showed that GMGN low-liquidity spam is real, but routing it through catalog buckets and the token-risk review worker made the VPS pay too much per junk token.

Goal after resetting to `7fff1a02f28dd361551a428000e2f23dfd9cbe5d`: reapply a smaller rule set that blocks the obvious GMGN spam as early as possible, avoids market-bucket writes for throwaway tokens, and keeps heavier risk-review logic for cases where it adds independent evidence.

## Evidence Summary

Ban evidence collected after the CPU spike showed these dominant rule families:

- `low_liquidity_under_1k`: `338` bans
- `gmgn-security:top10-holder-rate`: `226` bans
- `gmgn-origin:new-non-pump-high-launch-mcap`: `155` bans
- `gmgn-volume:low-mcap-extreme-vol5m`: `131` bans
- `gmgn-info:low-mcap-high-holders`: `71` bans

The low-liquidity bans were mostly real junk, but they were too expensive because they happened after the tokens had entered catalog/review/bucket paths.

## Pipeline Rule

Low-liquidity GMGN spam must be handled in `gmgn-catalog-ingestion` before:

- catalog upsert
- `token_catalog.applyEvaluationResult`
- `token_market_buckets_1m` writes
- `token_market_volume_buckets_1m` writes
- GMGN security/info/kline lookups
- risk-review sync worker

The block may still write:

- `admin_blocked_tokens`
- compact `admin_block_evidence`

## Rule 1: GMGN Low-Liquidity Spam Early Block

Label:

- `gmgn-liquidity:under-1k-spam`

Pipeline:

- `gmgn-ingestion:low-liquidity-spam`

Conditions:

- source is GMGN ingestion
- token is automatic, not manual
- token is not already admin-blocked
- token is GMGN-only:
  - no existing Dex confirmation
  - no existing `dex-low`, `dex-normal`, or `dex-high` eligibility
- token age is known and `< 2h`
- current GMGN liquidity is known and `< $1,000`
- market cap is missing or below `$150,000`
- address does not use a known launch suffix that should be allowed to mature:
  - `pump`
  - `bags`
  - `brrr`

Action:

- insert into `admin_blocked_tokens`
- capture minimal evidence:
  - GMGN snapshot
  - mcap
  - liquidity
  - age
  - source
  - rule label
- return early from `ingestGmgnToken`
- do not write catalog row
- do not write market bucket
- do not write volume bucket
- do not queue GMGN risk review
- do not run security/info/kline checks

Reasoning:

- This rule targets high-volume GMGN spam with the cheapest possible path.
- It replaces `low_liquidity_under_1k` in the token-risk review worker.
- It also replaces the separate GMGN thin-liquidity hard-ban variants for the first implementation pass.

## Rule 2: GMGN Security Top-10 Holder Block

Label:

- `gmgn-security:top10-holder-rate-{pct}%`

Pipeline:

- `gmgn-ingestion:security`

Conditions:

- source is GMGN ingestion
- token is automatic, not manual
- token is not already admin-blocked
- token is young enough for GMGN preliminary checks: `< 6h`
- GMGN security lookup returns `top10HolderRate >= 70%`

Action:

- insert into `admin_blocked_tokens`
- capture evidence with GMGN security payload
- stop ingestion for the token

Reasoning:

- This rule had `226` bans and is independent of liquidity bucket behavior.
- It is a high-confidence structural rug signal.

## Rule 3: GMGN Low-Mcap High-Holder Anomaly

Label:

- `gmgn-info:low-mcap-high-holders:{mcap}:{holders}`

Pipeline:

- `gmgn-ingestion:info`

Conditions:

- source is GMGN ingestion
- token is automatic, not manual
- token is not already admin-blocked
- token is young enough for GMGN preliminary checks: `< 6h`
- GMGN info lookup returns:
  - holder count `>= 1,500`
  - market cap `<= $150,000`

Action:

- insert into `admin_blocked_tokens`
- capture evidence with GMGN info payload
- stop ingestion for the token

Reasoning:

- This rule had `71` bans.
- It catches synthetic holder-count anomalies without depending on liquidity.

## Rule 4: GMGN Low-Mcap Extreme 5m Volume

Label:

- `gmgn-volume:low-mcap-extreme-vol5m:{mcap}:{vol5m}`

Pipeline:

- `gmgn-ingestion:low-mcap-extreme-volume`

Conditions:

- source is GMGN ingestion
- token is automatic, not manual
- token is not already admin-blocked
- token age is known and `< 24h`
- market cap is known and `<= $100,000`
- GMGN `vol5m >= $500,000`
- `vol5m / mcap >= 4`

Action:

- insert into `admin_blocked_tokens`
- capture evidence with GMGN market snapshot
- stop ingestion for the token

Reasoning:

- This rule had `131` bans.
- It is cheaper than security/info/kline because it uses the current GMGN market snapshot.

## Rule 5: GMGN New Non-Pump High-Launch Mcap

Label:

- `gmgn-origin:new-non-pump-high-launch-mcap:{mcap}:{vol5m}`

Pipeline:

- `gmgn-ingestion:new-non-pump-high-launch-mcap`

Conditions:

- source is GMGN ingestion
- token is automatic, not manual
- token is not already admin-blocked
- token has no existing Dex confirmation
- address does not end with `pump`,`bags` or `brrr`
- token age is known and `< 2h`
- market cap is known and between `$50,000` and `$100,000`
- GMGN `vol5m >= $200,000`
- `vol5m / mcap >= 4`
- GMGN 5m volume sanity checks pass:
  - `vol5m > 0`
  - if `vol1m` is present, `vol1m < 90%` of `vol5m`
  - if `vol1h` is present, `vol5m <= vol1h`

Action:

- insert into `admin_blocked_tokens`
- capture evidence with GMGN market snapshot
- stop ingestion for the token

Reasoning:

- This rule had `155` bans.
- It catches fake high-launch non-pump tokens while avoiding raw GMGN 1m/5m mirror-volume bugs.

## Rule 6: Existing Generic Risk-Review Classifier

Label:

- existing `auto-junk-probable:*` labels from `token-junk-metric`

Pipeline:

- `risk-review-sync`

Conditions:

- keep the pre-existing generic classifier after reset
- do not add new low-liquidity-specific hard bans to this worker in the first pass

Allowed recurring reason-code families:

- `holder_concentration_extreme`
- `liquidity_to_mcap_too_low`
- `meteora_absent_above_400k_mcap`
- `price_dislocation_extreme`
- `volume_to_mcap_too_low`
- `buy_sell_imbalance_high`
- `buy_sell_imbalance_extreme`
- `holder_count_extremely_low_for_mcap`

Reasoning:

- This classifier produced fewer bans than the GMGN spam rules and is useful for non-GMGN or later-stage tokens.
- It should not become the primary path for high-volume GMGN low-liquidity spam.

## Non-Ban Guardrail: GMGN Non-Launch 15-Minute Grace

State:

- `eligibility_state = gmgn-non-launch-grace`
- `suppressed_reason = gmgn_non_launch_grace_period`

Conditions:

- source is GMGN ingestion
- token is automatic, not manual
- token is not already admin-blocked
- token has no existing Dex confirmation
- token age is known and below `15m`
- address does not use a known launch suffix:
  - `pump`
  - `bags`
  - `brrr`

Action:

- keep the token out of monitored
- prevent alerts while the grace window is active
- schedule `next_evaluation_at` for token creation time plus `15m`
- keep normal catalog/bucket writes so later review has market context

Reasoning:

- Most GMGN non-launch trash is either auto-blocked or becomes obviously weak within the first few minutes.
- This is a temporary suppression, not a permanent ban, so it reduces alert noise without blocking legitimate late-confirming tokens.

## Rules Not To Reapply In The First Pass

Do not recreate these as separate risk-review hard bans immediately after reset:

- `low_liquidity_under_1k`
- `gmgn_confirmed_micro_liquidity`
- `gmgn_low_mcap_thin_support`
- `gmgn_low_mcap_extreme_24h_churn_thin_liquidity`
- `gmgn_young_low_cap_high_churn_thin_liquidity`
- `gmgn_unprotected_liquidity`

Replacement:

- use `gmgn-liquidity:under-1k-spam` as the cheap early GMGN-only block
- let security/info/volume rules catch the remaining high-confidence cases
- leave generic risk-review classifier for later-stage/non-GMGN cases

## Operational Guardrails

- Keep each rule in the earliest possible pipeline stage.
- Avoid adding new reads from `token_market_buckets_1m` for ban confirmation.
- Avoid creating one rule per liquidity variant.
- Avoid queuing security/info/kline checks for tokens already caught by the early low-liquidity spam rule.
- Evidence should be compact and sufficient for counting rule families later.
- Add counters to the GMGN ingestion summary for each early block rule.

## Proposed Commit Slices After Reset

1. Add `gmgn-liquidity:under-1k-spam` early block only.
2. Reapply GMGN security/info/volume launch blocks, if missing after reset.
3. Reapply compact block evidence/counters if needed.
4. Update docs/tests.
