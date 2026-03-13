# Frontend Vite Progress

## Purpose
Track the real migration state of the new Vite frontend so the next session does not depend on chat history.

## Current Frontend Workspace
- New frontend lives in `frontend/`.
- Stack currently validated:
  - `Vite 7`
  - `TypeScript`
  - `socket.io-client`
- Build command validated repeatedly:
  - `cmd /c "set npm_config_cache=%CD%\.npm-cache&& npm run build"`
  - PowerShell variant also validated:
  - `$env:npm_config_cache = (Get-Location).Path + '\.npm-cache'; npm run build`

## Current File Shape
- `frontend/src/main.ts`
- `frontend/src/state/app-state.ts`
- `frontend/src/state/app-controller.ts`
- `frontend/src/services/api/`
- `frontend/src/services/socket/`
- `frontend/src/services/dex/`
- `frontend/src/ui/`
- `frontend/src/ui/sections/`
- `frontend/src/styles/app.css`
- `frontend/src/utils/auth-storage.ts`
- `frontend/src/utils/bar-storage.ts`

## Implemented And Working

### 1. Vite scaffold
Implemented:
- isolated frontend workspace under `frontend/`
- Vite config
- TS config
- app entrypoint
- modular folder structure
- `app-shell` now reduced to a composition file, with UI sections extracted under `frontend/src/ui/sections/`

Validated:
- production build passes

### 2. Auth/session flow
Implemented:
- local token storage helper
- `API_BASE` resolution with:
  - `?api=` override
  - localhost fallback
  - Railway fallback for `vercel.app`
- authenticated API fetch with `Authorization: Bearer <token>`
- login flow using `/api/auth/login`
- session restore using `/api/auth/me`
- logout using `/api/auth/logout`
- logout-all using `/api/auth/logout-all`

Validated:
- compile/build passes

Not yet fully validated end-to-end from this environment:
- live remote login against Railway from this machine hit Windows TLS/client credential issues during ad-hoc shell tests
- frontend code path itself is wired; browser validation is still recommended

### 3. Config hydration and persistence
Implemented:
- load `/api/config`
- store config payload in frontend state
- expose summary counts for:
  - config keys
  - manual tokens
  - blocklist
  - starred tokens
  - bootstrap tokens
- patch monitoring config via `PATCH /api/config`

Implemented editable monitoring fields:
- `interval`
- `threshold`
- `mcap-threshold`
- `min-vol`
- `min-mcap`
- `max-mcap`
- `old-mcap-min`
- `old-mcap-max`
- `old-week-mcap-min`
- `old-week-mcap-max`
- `min-mcap-remove`
- `dead-cycles`
- `hvnc-min-vol`
- `old-per-page`
- `old-week-per-page`
- `sound-volume`
- `sound-mode`

Validated:
- compile/build passes

### 4. Socket integration
Implemented:
- authenticated Socket.io client
- socket lifecycle binding
- `auth:revoked` handling
- `dex:tokenData` handling
- `dex:subscribe` emission for tracked tokens in the monitored set

Validated:
- compile/build passes

### 5. Manual Tokens slice
Implemented:
- add manual token via `POST /api/config/tokens`
- remove manual token via `DELETE /api/config/tokens/:address`
- rehydrate list from `/api/config`
- enrich manual rows from socket-delivered Dex data
- display:
  - symbol
  - name
  - Dex link
  - image
  - MCAP
  - price
  - volumes
  - price changes
  - protection badge
- `Copy CA` action exists on manual token cards
- `Block` action exists on manual token cards

Important note:
- this is account-backed already; not browser-local-only

Validated:
- compile/build passes

### 6. First monitored loop slice
Implemented:
- start/stop monitoring controls
- cycle counter
- uptime label
- monitored count
- per-cycle refresh through socket `dex:subscribe`
- monitored set now merges:
  - user manual tokens from `/api/config/tokens`
  - tracked bootstrap tokens from `/api/config.bootstrapTokens`
- local tracked fields per token:
  - `prevVolume5m`
  - `prevMcap`
  - `lastAlertAt`
  - `deadCycles`
  - `createdAt`
  - `manual`
  - `_userManual`
- local threshold checks for monitored alerts:
  - volume threshold
  - MCAP threshold
  - shared cooldown
  - basic suppression when MCAP is declining during volume spike
- monitored config editor wired to backend config patch
- `min-mcap-remove` sweep is isolated in the controller and already respects `_userManual` protection
- `Copy CA` action exists on monitored cards
- `Block` action exists on monitored cards

Validated:
- compile/build passes

### 7. First age-routing slice
Implemented:
- first routed `Recent Tokens` view derived from monitored tokens
- first routed `Old Tokens 1 Week+` view derived from monitored tokens
- routing uses Dex `pairCreatedAt`
- routing enforces:
  - `Recent Tokens` = `0d-7d`
  - `Old Tokens 1 Week+` = `7d+`
  - mutual exclusion between the two buckets
- routing currently excludes `_userManual` tokens to avoid duplicating explicit manual entries in discovery bars
- routing respects the configured MCAP windows:
  - `old-mcap-min`
  - `old-mcap-max`
  - `old-week-mcap-min`
  - `old-week-mcap-max`
- both routed bars already expose:
  - Dex link
  - Copy CA
  - Block action
  - age label
  - dismiss action
  - pagination controls
  - per-page input
- routed-bar pagination settings now sync through backend config keys when authenticated
- local per-account persistence now exists for:
  - dismissed Recent tokens
  - dismissed Old Week tokens
  - Recent removal log
  - Old Week removal log
- routed bars now expose `Clear Dismissed` controls so local dismissed state can be reset without touching backend data
- automatic removal logging now records tokens that leave a routed bar because of age/MCAP changes
- zero-MCAP safety is now respected in routed bars: tokens already in Recent/Old Week are not auto-removed just because a cycle returns `mcap <= 0`
- local routed-bar removal logs now expire after 8 hours to keep this transient state lightweight

Important note:
- persistence is currently browser-local and account-scoped
- server-backed dismissed/log persistence is still not implemented

Validated:
- compile/build passes

### 8. Alerts panel slice
Implemented:
- monitored alerts now create real alert objects in modular state
- alerts panel renders token identity, badge label, pct, MCAP, volume, timestamp, and Dex link
- alert count is now driven by alert objects rather than only a counter
- `Copy CA` action exists on alert cards
- `Block` action exists on alert cards
- `Star` action now exists on alert cards
- first HVNC groundwork now exists in controller/state/UI:
  - `hvnc-min-vol` config is editable
  - tokens can fire one HVNC alert based on age plus `vol24h`
  - alert cards now support a dedicated HVNC variant
- first old-surge groundwork now exists in controller/state/UI:
  - routed old tokens can fire one old-surge alert from `priceChange1h` / `priceChange6h`
  - alert cards now support a dedicated old-surge variant
- alert cards now carry richer classification context:
  - token AGE chip when available
  - behavior-specific headline text
  - per-type chips for HVNC / old-surge / monitored vol / monitored MCAP
  - starred state when applicable

Still missing for parity:
- uploaded/custom sound parity and persisted sound config
- exact V68 thresholds and UX validation in browser
- PumpFun alert variants

Implemented now:
- synthetic Web Audio fallback tones for monitored, MCAP, HVNC, and old-surge alerts
- alert sounds are isolated in `frontend/src/services/alerts/sound.ts`
- sound enable/volume are now user-configurable in the modular alerts panel
- sound preferences persist locally via `frontend/src/utils/sound-storage.ts`, now scoped by authenticated account when available
- when authenticated, sound mode/volume now also sync through `/api/config` using `sound-mode` and `sound-volume`

Validated:
- compile/build passes
### 9. Starred tokens slice
Implemented:
- token cards now expose a star toggle in the modular frontend
- starred state is visible on manual, monitored, recent, old-week, and alert cards as a visual highlight only
- starred sync uses the existing backend `PUT /api/config` contract because starred tokens are already part of the full config payload

Validated:
- compile/build passes


### 11. First PumpFun live slice
Implemented:
- authenticated socket listeners now handle:
  - `pump:status`
  - `pump:newToken`
  - `pump:trade`
  - `pump:migrate`
  - `sol:price`
- PumpFun live state now exists in modular frontend state:
  - connection status
  - SOL/USD price
  - visible pump rows
  - session migration count
  - session bond-target calibration
  - recent migration summary rows
- Pump rows now:
  - gate by `pump-entry-vol`
  - optionally filter out tokens older than `pump-max-age-min` without affecting the live stream itself
  - sort by MCAP descending
  - accumulate `vol5m` on a 5-minute sliding window
  - accumulate total volume in session
  - support local `X` remove without block semantics
  - support `Copy CA`
  - support `Block`
- first Pump alert groundwork now exists:
  - `pump-min-vol` one-shot alert per token per session
  - Pump HVNC variant using the live 5m volume path
- Pump config UI now exists for:
  - `pump-entry-vol`
  - `pump-min-vol`
  - `pump-max-age-min` (0 = disabled)
- first session-local migration tracking now exists:
  - migration rows captured from `pump:migrate`
  - migration toast stack now exists with copy-CA and synthetic migrate sound
  - bond target recalibrated from recent migration MCAP samples and synced through config
- first Pump GC slice now exists:
  - 30s GC loop while monitoring is active
  - inactive token removal
  - low-MCAP timed removal
  - silence-based migration detection for high-MCAP tokens
  - server-side `pump:unsubscribe` on GC removals
- Pump rows now also expose first bond-progress UI using the calibrated bond target
- Pump trade processing now includes fallback MCAP estimation from bonding-curve reserve fields when direct MCAP is absent
- Pump migration detections now also report to `/api/catalog/migrated` from the modular frontend path
- migration toast presentation has been tightened toward the V68 layout

Validated:
- compile/build passes
### 10. First blocklist slice
Implemented:
- add blocked token via `POST /api/config/blocklist`
- remove blocked token via `DELETE /api/config/blocklist/:address`
- dedicated blocklist section in the new frontend
- immediate UI filtering of blocked addresses from:
  - manual tokens
  - monitored tokens
  - recent tokens
  - old week tokens
  - alerts list
- blocklist count is now wired to backend-backed state
- `Copy CA` action exists on blocked-token rows

Validated:
- compile/build passes

## Intentionally Not Done Yet
- full V68 alert-card parity (sound behavior, browser-level UX validation, and remaining variants)
- migration toast parity
- PumpFun live migration
- PumpFun GC parity
- exact V68 remove/dismiss semantics for `Recent Tokens` and `Old Tokens 1 Week+`
- exact dead-cycle behavior remains under review
- server-backed persistence for routed-bar dismissed/log state

## Current Gaps To Treat Carefully

### Product-semantic gaps still open
- current monitored loop is still a simplified first slice
- it does not yet fully reproduce all V68 removal semantics
- the protected/manual distinction now exists in the model, but only the first `_userManual` + `min-mcap-remove` interaction is wired
- age routing is now present with first local dismissed/log persistence and local pagination, but not yet with backend persistence or full V68 controls
- alert rendering now has first HVNC and old-surge variants, but is still not the full V68 alerts panel
- blocklist behavior now covers the first PumpFun live slice, but GC and toast parity are still not ported

### Rules that must stay visible during next work
- `tok.manual` and `tok._userManual` are not the same concept
- only `_userManual` protects against the MCAP removal sweep
- `dead-cycles` is `Rule under review`, not a locked behavior to preserve blindly
- `Recent Tokens` and `Old Tokens 1 Week+` must respect V68 age routing semantics
- dismissed tokens must not silently re-enter their bar
- removal logs should only reflect automatic routing/filter exits, not manual dismiss actions
- PumpFun production flow must use backend socket transport, not direct browser WS
- shared alert cooldown semantics matter

## Recommended Next Steps
1. Tighten routed-bar fidelity:
   - verify manual dismiss semantics against V68 edge cases
   - decide whether routed-bar dismissed/log state stays browser-local or moves server-side
2. Increase alert fidelity:
   - validate HVNC and old-surge behavior in-browser against V68
   - add missing sound behavior and any remaining alert-card UX differences
3. Tighten monitored semantics:
   - decide whether `dead-cycles` survives as removal, downgrade, or no-op
   - refine non-user tracked token lifecycle after the new routing exists
4. Tighten PumpFun live parity:
   - migration toast UX
   - GC + unsubscribe behavior
   - exact V68 migration heuristics
5. Then validate the modular frontend visually in browser against V68.

## Practical Working Rule
- Prefer migrating one behavior slice at a time.
- Keep `app-shell` as a thin composition layer; add new UI behavior in section modules rather than rebuilding a monolith.
- Keep using build validation after each slice.
- Do not treat the current new frontend as behavior-complete yet.
- Treat `volume-alert-botV68.html`, `docs/v68-behavior-contract.md`, and `docs/v68-migration-checklist.md` as the parity contract.



















### 12. Visual parity stage 1: shell/header/config reset
- Replaced the dashboard-style hero/status/auth/config shell with a V68-style top shell in `frontend/src/ui/sections/layout-sections.ts`.
- `app-shell.ts` now composes the new legacy shell first and only renders the functional sections below it when authenticated.
- The base theme in `frontend/src/styles/app.css` was reset toward the terminal/table visual language from V68: mono typography, flat surfaces, thinner borders, header/status bar, config grid, and legacy action row.
- `saveMonitoringConfig(...)` now accepts both numeric and string config values so the shell can persist `chain`, `sound-mode`, and numeric thresholds from a single top config surface.
- Build validation passed after the shell refit.

### Next recommended slice
- Refit `Manual Tokens`, `Recent Tokens`, and `Old Tokens 1 Week+` from card grids into dense row/table bars close to the legacy HTML.

### 13. Visual parity stage 2: age bars converted to dense rows
- `Manual Tokens`, `Recent Tokens`, and `Old Tokens 1 Week+` were moved from card-grid rendering into denser V68-style row tables.
- Added compact bar headers, inline actions, per-page controls, removal-log controls, and token row highlighting in `frontend/src/ui/sections/manual-section.ts`, `frontend/src/ui/sections/routed-sections.ts`, and `frontend/src/ui/sections/shared.ts`.
- Added bar/table styling in `frontend/src/styles/app.css` for the cyan/green/orange age bars.
- Sorting semantics were preserved as-is: manual rows currently render MCAP-first, while routed bars still use Vol 24H descending.
- Build validation passed after the bar refit.

### Next recommended slice
- Refit `Monitored Tokens`, `PumpFun - Live`, and `Alerts` into compact V68-like panels, then do browser visual validation.

### 14. Visual parity stage 3: core panels compacted
- `Monitored Tokens`, `PumpFun - Live`, and `Alerts` were refit into compact three-column panels closer to the V68 density and hierarchy.
- `app-shell.ts` now groups these three modules into a dedicated `legacy-panels` grid.
- The monitored panel now renders compact rows with start/stop control, volume badge, and delta badge.
- The PumpFun panel now renders compact live rows with right-side MCAP/volume, inline removal, and compact bond bar.
- The alerts panel now renders stacked alert rows with compact header, sound controls, and inline actions.
- Added panel styling in `frontend/src/styles/app.css` for the three-column layout, panel headers, compact rows, and alert rows.
- Build validation passed after the panel refit.

### Next recommended slice
- Browser visual validation against the legacy HTML, followed by targeted polish only where the layout still visibly diverges.


### 15. Terminal selector parity: dropdown terminals restored
- Replaced the simple terminal links with a shared V68-style terminal dropdown in `frontend/src/ui/sections/shared.ts`.
- The dropdown now renders `Axiom`, `Photon`, `BullX`, `GMGN`, and `Padre` with the legacy color coding and hover menu behavior.
- `Axiom` and `Padre` now follow the legacy address priority: `pairAddress -> mintAddress -> address`.
- Dex normalization now carries `mintAddress` and `pairAddress` into the frontend token model, and alert/pump payloads forward those fields so terminal links can be built correctly across bars, monitored rows, PumpFun, and alerts.
- Added trade-menu styling and open-up/open-down positioning in `frontend/src/styles/app.css` and `frontend/src/ui/app-shell.ts`.
- Production build validation passed after the terminal dropdown port.

### Next recommended slice
- Browser-test the terminal dropdown interactions in each panel/bar and then move on to button behavior fixes (copy, search, profile, star, block) using the same shared action cluster.


### 16. Interaction stability and realtime wiring fixes
- `frontend/src/main.ts` now protects interactive flows against aggressive full-shell rerenders:
  - focused field editing lock
  - short click lock for buttons/links/actions
  - list interaction lock while pointer is inside monitored/pump/alerts/token tables
- `frontend/src/ui/app-shell.ts` now preserves per-panel scroll draft across renders for:
  - Monitored
  - PumpFun
  - Alerts
- Hover persistence is now namespaced by section so the same token address in different panels does not cross-highlight another row.
- Manual token add flow was debugged and stabilized:
  - `window.__botDebug` added in browser for state snapshots
  - manual add now updates local state first and syncs backend after
  - render/click timing issues around manual add were reduced enough for normal single-click use
- Dex payload normalization was hardened to accept multiple payload shapes (`pairs`, `data.pairs`, `data.data.pairs`), which helped isolate realtime/filter issues from parsing issues.
- Build validation passed after each stability change.

### 17. Discovery and monitored semantics tightened
- `Recent Tokens` was confirmed to be strongly affected by its MCAP floor; lowering `MCAP MIN` to `$30k` restored expected routed entries in browser validation.
- `Monitored Tokens` now hides non-user-manual tokens with confirmed `MCAP > 0 && < $30k`, matching the intended floor behavior more closely.
- Manual token insertion now also pushes the token into monitored state immediately so the user sees it before Dex enrichment finishes.
- Build validation passed.

### 18. Alerts parity pass: tone classes and V68-style card content
- `Alerts` now classify tones more faithfully:
  - `normal` for smaller moves
  - `critical` for `>= 100%`
  - `mega` for `>= 200%`
  - `old-surge` keeps orange/mega treatment
  - `HVNC` keeps mega treatment
  - `pumpfun-vol` keeps its own purple pump tone
- Alert cards now render more V68-like content:
  - image beside ticker
  - `VOL 5M X -> Y`
  - `MCAP A -> B`
  - stats line with `MCAP / AGE / 1H / 6H / 24H`
  - links line with `Dex / X Buscar / X Perfil`
  - actions line with `Copiar CA / Terminal / Block / Star`
- Age formatting is now normalized globally to a simplified display:
  - `< 1m` => `Xs`
  - `< 1h` => `Xm`
  - `< 1d` => `Xh`
  - `>= 1d` => `Xd`
- Build validation passed.

### 19. Starred-token behavior refined
- Star toggles now update visually immediately in the DOM before waiting for the next render cycle.
- Star persistence moved to a short debounced background sync so UI feedback is immediate and backend writes are batched.
- Starred tokens no longer recolor the ticker text; the highlight is now limited to:
  - glowing star button
  - subtle box/row outline glow
- Star support is now visible across bars, monitored rows, and alerts.
- Build validation passed.

### 20. Terminal dropdown parity and remaining caveats
- Terminal dropdowns now use per-boundary direction logic rather than viewport-only logic, so they choose `open-up/open-down` and `open-left/open-right` relative to the containing list/panel.
- Dropdown styling was made more opaque and higher-z to avoid blending into alert text.
- Pump terminal menus are biased to open leftward to avoid crossing panel boundaries.
- Remaining caveat:
  - terminal menus in dense list contexts are improved but still need browser validation; if hover remains unstable, the next safest step is to switch terminal menus from hover-open to click-open.
- Build validation passed.

### 21. Current known rough edges before final cleanup
- Hover/scroll stability is much better than before, but dense live panels can still feel brittle under heavy realtime updates.
- Terminal dropdowns in alerts/manual/recent/old may still need one more interaction-model pass.
- There is temporary browser debug instrumentation (`window.__botDebug`) that should be removed once interaction/realtime debugging is fully complete.
- The migration is now well past structural risk; remaining work is mostly interaction polish and parity fixes, not monolith-level architecture risk.
