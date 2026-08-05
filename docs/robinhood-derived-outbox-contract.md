# Robinhood derived live-emit outbox — contract (Corte 5)

Status: **Corte 5 code-complete** (slices 1–4 done, dormant behind
`ROBINHOOD_DERIVED_OUTBOX_ENABLED` off + the `robinhood-derived` group unselected). Shadow
comparison and monolith cutover are Corte 6/7.

## Why this exists

The live board, realtime alerts, live catalog and market aggregates are all driven
by a single in-memory fan-out hub (`emitMarketBucketUpdate`, `server.js`) that today
fires **only** from the ingestion monolith's `commitMarketRange`. `robinhood-processing`
(Corte 4) already persists observations and 1m buckets from frozen evidence, but it
**discards** the `liveBuckets` those writes produce — so nothing live happens on that
path. The V4-liquidity halt incident (2026-08-03) was exactly this: data intact, board
frozen, because the emit rides the monolith's market cursor.

The derived outbox lets the processing commit **also** publish "this bucket changed",
durably, so a separate `robinhood-derived` consumer can replay the same fan-out without
the monolith. It is the prerequisite for removing the monolith (Corte 7 — "1 em 1").

This is **not** a rewrite of the derived workers. `robinhood-live-catalog-worker`,
`robinhood-realtime-alert-worker`, `robinhood-market-aggregate-worker`,
`market-bucket-realtime` (the pg_notify socket relay) and the standard-alert publication
stay **unchanged**. Only their *feeder* changes: from the monolith's in-memory emit to
the derived consumer draining this outbox. The catalog **projection** worker (60s
metadata/image/dexscreener poll), staging, and aggregate backfill are already
independent pollers and are out of scope.

## Table: `robinhood_derived_outbox` (stage 104)

One row per **changed live bucket per commit** (append-per-emit, mirroring the
monolith's per-`liveBucket` emit). Surrogate `id BIGSERIAL` gives FIFO order.

| column | meaning |
| --- | --- |
| `id` | monotonic order + identity (PK) |
| `chain` | always `robinhood` |
| `protocol` | `uniswap-v2` \| `uniswap-v3` \| `uniswap-v4` |
| `market_key`, `token_address`, `bucket_ts` | bucket identity (observability / debugging) |
| `last_block_number`, `last_log_index` | on-chain position of the update |
| `payload` | the **fully built** `market:bucket` event (`buildRobinhoodMarketBucketUpdate` output) |
| `status` | `pending` → `leased` → (delete on success) / `blocked` (dead-letter) |
| `lease_owner`, `lease_until` | lease held by the claiming consumer |
| `attempt_count`, `next_attempt_at`, `last_error` | retry/backoff bookkeeping |
| `created_at`, `updated_at` | audit timestamps |

Indexes: `idx_..._claim (next_attempt_at, id) WHERE status='pending'` for the claim scan;
`idx_..._lease (lease_until) WHERE status='leased'` for reclaiming abandoned leases.

## Lifecycle (queue semantics)

- **Write (producer):** `commitHeadProcessingBatch` inserts one row per `liveBucket`
  **in the same transaction** as the observation/bucket write → atomic, at-least-once.
  No cursor, no emit inside the transaction. *(slice 3)*
- **Claim:** the consumer `SELECT … FOR UPDATE SKIP LOCKED` by `(next_attempt_at, id)`,
  sets `status='leased'` + `lease_until`. *(slice 4)*
- **Success → delete:** after the fan-out's relay `pg_notify` has completed, the row is
  **deleted** (self-pruning; no `completed` state kept — this is a transient signal,
  not an audit log). The derived path uses an awaited direct publish; it never treats
  an in-memory relay enqueue as durable completion.
- **Transient failure → retry:** back to `pending` with `attempt_count++` and exponential
  `next_attempt_at` backoff.
- **Poison → blocked:** past max attempts the row becomes a `blocked` dead-letter, kept
  for inspection; it never blocks the rest of the queue.
- **Crash recovery:** a `leased` row whose `lease_until` has passed is reclaimed to
  `pending`. Nothing is lost because the row was committed with the data.

## Consumer wake & latency

The consumer is woken by `LISTEN`/`NOTIFY` on a derived channel (reusing the proven
`postgres-realtime-listener` primitive), then drains the claimable rows; if the listen
connection drops it falls back to interval polling until it reconnects. Steady-state
latency is one extra localhost NOTIFY hop (~ms) over today's path — which itself already
routes through pg_notify + a 25ms coalescing window in `market-bucket-realtime`, so the
delta is imperceptible against the browser round-trip both designs already pay. Worst
case (listen drop) degrades to poll latency **without losing a tick** — the durability
upgrade over today's at-most-once in-memory emit.

## Payload note

The payload is built at **commit** time (same as the monolith builds it at its commit
time), using the processing watermark as the cursor analog for `coverage.state` and
`sequence`. The consumer fans out the stored payload verbatim; it does not re-value or
re-query. Downstream coalescing (`market-bucket-realtime` by `chain:address`, the
realtime alert worker by max `observedAt`) makes append-per-emit safe — latest-wins holds
exactly as it does for the monolith today.

## Slice roadmap

1. **Schema + contract** *(done)* — `robinhood_derived_outbox`, runtime-schema entry, this doc.
2. **Extract fan-out hub** *(done)* — `robinhood-market-bucket-fanout.js`, both the monolith
   and the derived consumer call it.
3. **Processing writes the outbox** *(done)* — `commitHeadProcessingBatch` appends `liveBuckets`
   and NOTIFYs in the same transaction; `resolveMarketFrontier` supplies the strict frontier.
4. **`robinhood-derived` consumer** *(done)* — outbox repository + runner (SKIP LOCKED) + worker
   (NOTIFY wake + prune) + isolated group/port 3008/config; producer gated by
   `ROBINHOOD_DERIVED_OUTBOX_ENABLED` (off); `server.js` wires the dormant group.

Then Corte 6 (shadow/compare/cutover — co-start the in-memory sinks, re-point the alert rollout
gate at capture/processing health) and Corte 7 (remove the monolith).
