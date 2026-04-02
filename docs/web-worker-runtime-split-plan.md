# Web/Worker Runtime Split Plan

## Purpose

This document records the practical plan for separating the backend runtime roles so the bot can safely run more than one backend instance without duplicating singleton background work.

It is based on the current repository behavior, not on a greenfield redesign.

The goal is not "microservices".

The real goal is:
- allow a web instance to serve users without also starting the full worker set
- keep a worker instance responsible for singleton background jobs
- reduce the current fragility around multi-instance deployment
- do this with the minimum amount of architecture change needed right now

## Current Code Reality

Today the runtime is mixed in [src/server.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/server.js).

Inside `bootstrapRuntime()`:
- a cleanup interval is started
- `socketHub` is started
- `catalogWorker` is started
- `catalogCleanupWorker` is started
- `meteoraSnapshotWorker` is started
- `dexDiscoveryWorker` is started
- `lateralizationWorker` is started

Relevant code:
- [src/server.js:167](/Users/ezequielmarinho/Volume-Bot-Alert/src/server.js#L167)
- [src/server.js:190](/Users/ezequielmarinho/Volume-Bot-Alert/src/server.js#L190)

That means one backend process currently owns three different responsibilities:
- web/API
- realtime socket runtime
- singleton background jobs

The `bootstrapped` flag only protects against duplicate startup inside the same process.

It does not protect against:
- a second backend instance
- horizontal scale
- overlap during deploys
- a debug/staging instance pointing to the same database

Current implementation status after the first runtime-split pass:
- `config/index.js` now resolves explicit runtime flags:
  - `RUN_SOCKET_HUB`
  - `RUN_BACKGROUND_JOBS`
- `config.runtime.role` now resolves to:
  - `combined`
  - `web`
  - `background`
  - `idle`
- `src/server.js` now separates:
  - `bootstrapWebRuntime(httpServer)`
  - `bootstrapBackgroundRuntime()`
- runtime role/status is now visible in:
  - `GET /api/health`
  - `GET /api/admin/ws-status`
- `package.json` now includes:
  - `npm run start:web`
  - `npm run start:worker`
  - `npm run dev:web`
  - `npm run dev:worker`

## Problem Statement

If a second backend instance is started against the same environment today, it will also start the cleanup loop and the full worker set.

That can lead to:
- duplicated catalog processing
- duplicated discovery polling
- duplicated Meteora refreshes
- duplicated lateralization runs
- extra upstream pressure and rate limiting
- inconsistent operational behavior

This is the architectural risk we want to remove now.

## Non-Goals

This plan is not about:
- introducing leader election
- introducing distributed locks
- adding a queue system
- rewriting workers into a separate application
- fully redesigning deployment infra

Those may become relevant later, but they are not the correct next step for the current stage of this bot.

## Minimum Viable Target

We want two runtime roles.

### 1. Web role
- serves HTTP/API
- serves authenticated socket traffic
- does not run singleton background jobs
- does not run the hourly cleanup singleton

### 2. Worker role
- runs singleton background jobs
- runs the cleanup singleton
- may still expose HTTP for healthcheck if convenient
- does not need public user-facing traffic
- does not need socket runtime

## Recommended Runtime Flags

Do not use only one vague flag if it hides different concerns.

Use explicit runtime role toggles:
- `RUN_SOCKET_HUB`
- `RUN_BACKGROUND_JOBS`

Where `RUN_BACKGROUND_JOBS` includes:
- cleanup interval
- `catalogWorker`
- `catalogCleanupWorker`
- `meteoraSnapshotWorker`
- `dexDiscoveryWorker`
- `lateralizationWorker`

This is more correct than a simple `RUN_WORKERS` flag because the cleanup loop is also singleton runtime work.

## Backward Compatibility Rule

Do not break the current local/default behavior during the first implementation step.

If no runtime flags are set:
- the app should continue behaving as it does today
- socket runtime still starts
- background jobs still start

This keeps local development and current single-instance deploy behavior intact while the role split is introduced.

## Implementation Plan

### Phase 1. Add explicit runtime config

Add config support for:
- `RUN_SOCKET_HUB`
- `RUN_BACKGROUND_JOBS`

Expected behavior:
- default: both enabled
- web-only: socket on, background off
- worker-only: socket off, background on

Likely files:
- [config/index.js](/Users/ezequielmarinho/Volume-Bot-Alert/config/index.js)
- [src/server.js](/Users/ezequielmarinho/Volume-Bot-Alert/src/server.js)

Status:
- completed

### Phase 2. Split bootstrap responsibilities

Refactor the current `bootstrapRuntime()` into smaller runtime bootstrap functions.

Recommended split:
- `bootstrapWebRuntime(httpServer)`
- `bootstrapBackgroundRuntime()`

This should make the ownership explicit:
- web runtime owns `socketHub`
- background runtime owns cleanup + workers

Important:
- preserve the current startup order unless there is a concrete reason to change it
- do not mix behavior changes with this refactor

Status:
- completed

### Phase 3. Surface runtime role in health/admin status

The runtime should report its active role clearly.

Expose enough status to answer:
- is this instance web-enabled?
- is this instance running background jobs?
- is socket runtime enabled here?

Likely places:
- `/api/health`
- existing admin worker/runtime status endpoints

The point is operational clarity, not extra product surface.

Status:
- completed

### Phase 4. Add explicit start modes

Keep `npm start` compatible, but introduce clearer role-specific commands.

Possible scripts:
- `start:web`
- `start:worker`

These should simply set env flags and reuse the same codebase entrypoint.

Relevant file:
- [package.json](/Users/ezequielmarinho/Volume-Bot-Alert/package.json)

Status:
- completed

### Phase 5. Document deployment role assignment

Record how production should run after the split.

Target deployment shape:
- one web instance
- one worker instance

Example intent:
- web instance: `RUN_SOCKET_HUB=true`, `RUN_BACKGROUND_JOBS=false`
- worker instance: `RUN_SOCKET_HUB=false`, `RUN_BACKGROUND_JOBS=true`

This step should update deployment/runbook docs only after the code supports the role split safely.

Status:
- in progress at the documentation level only
- code support now exists, but the production VPS topology has not yet been explicitly split into separate web and background processes

## Validation Plan

### Scenario A. Legacy default
- start the app with no new flags
- confirm current behavior remains intact
- confirm socket runtime still works
- confirm workers still start

### Scenario B. Web-only runtime
- start with background jobs disabled
- confirm HTTP/API works
- confirm socket works
- confirm workers do not start
- confirm cleanup singleton does not start

### Scenario C. Worker-only runtime
- start with socket disabled and background jobs enabled
- confirm workers start
- confirm cleanup starts
- confirm no socket runtime is started

### Scenario D. Two-process sanity check
- run one web-only process
- run one worker-only process
- confirm only one process owns the workers

## Risks To Watch During Implementation

### Risk 1. Accidentally disabling socket on the web instance

`socketHub` currently starts inside the same block as workers.

If the split is done carelessly, the result can be:
- workers separated
- realtime broken

### Risk 2. Forgetting cleanup is also singleton work

If we only gate the named workers but leave cleanup always on, the multi-instance duplication problem remains partially alive.

### Risk 3. Breaking local behavior too early

If the first patch changes default startup behavior, it will create confusion and false regressions.

The first phase must preserve current behavior by default.

### Risk 4. Poor operational visibility

If the instance role is not visible in health/status output, it becomes too easy to deploy the wrong role and not notice immediately.

## What We Should Not Do First

Do not start with:
- leader election
- distributed locks
- a separate repository
- a queue rewrite
- Kubernetes-style complexity

That would be overengineering relative to the current problem.

The correct first win is role separation inside the existing app.

## Recommended Execution Order For The Next Work Session

1. add runtime flags in config
2. split `bootstrapRuntime()` into web/background responsibilities
3. update health/admin status to expose active role
4. add role-specific npm scripts
5. validate legacy, web-only, and worker-only modes
6. document deployment usage

## Success Criteria

This work is successful when:
- one backend instance can serve users without running workers
- one backend instance can run workers without serving realtime socket traffic
- the current single-instance default still works
- startup role is visible and unambiguous
- scaling the web side no longer implies duplicating singleton background work

## Ponto importantes

- The real issue is not "multiple instances are bad". The issue is that every instance currently starts singleton runtime work.
- `bootstrapped` only protects within one process. It is not multi-instance protection.
- Cleanup must be treated as part of singleton background runtime, not forgotten as a side detail.
- The correct first move is runtime-role separation, not distributed coordination.
- This should be implemented with minimal behavioral change first, then deployed as two roles only after validation.
