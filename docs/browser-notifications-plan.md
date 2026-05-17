# Browser Notifications Plan

## Goal

Add native browser notifications for backend alert events, similar to the notifications shown by apps like X, while keeping the first implementation scoped to the existing authenticated web app session.

This plan focuses only on browser notifications. Telegram, Discord, email, SMS, and mobile push are out of scope.

## Current Repo Evidence

The app already has the right alert delivery foundation:

- backend alert events are published through `src/services/backend-alert-publisher.js`
- realtime delivery uses the authenticated socket event `alert:event`
- frontend socket binding is in `frontend/src/services/socket/client.ts`
- frontend receives socket alerts in `frontend/src/state/app-controller.ts`
- alert sound side effects already run in `frontend/src/main.ts`
- alert kind config gates already exist in `src/models/user-config.js`
- alert UI toggles already exist in `frontend/src/ui/sections/layout-sections.ts`

The browser notification feature should attach to this existing flow instead of creating a second alert pipeline.

## Critical Validation

Native browser notifications are not the same thing as backend push notifications.

There are two possible levels:

1. Browser notification while the web app is open in at least one tab.
2. Push notification even when the tab is closed.

The first level can be implemented with the Notifications API and the existing socket flow. The second level requires Service Worker, Push API, VAPID keys, subscription storage, unsubscribe handling, and backend push delivery.

For this repo, the first level is the correct initial block because it is much smaller, fits the current architecture, and validates UX before adding schema and push infrastructure.

## Scope For V1

V1 should support:

- an explicit user-controlled browser notification master toggle
- permission request from a user gesture
- notification delivery for new `alert:event` payloads received by socket
- no duplicate notification for the same alert id
- notification title/body generated from existing `AlertEntry` fields
- optional icon from token image when it is a safe URL, with app favicon fallback
- only notify when the app is hidden/backgrounded by default
- respect existing alert kind toggles
- keep sound behavior unchanged

V1 should not support:

- notifications after every tab is closed
- Service Worker push
- Telegram delivery
- mini chart images inside notification
- per-kind browser notification toggles unless the first implementation stays small
- backend schema changes

## UX Model

Add a small browser notification control near the existing sound/config controls.

Suggested controls:

- master toggle: `Browser Notifications`
- action button when permission is not decided: `Enable`
- read-only status:
  - `Allowed`
  - `Blocked`
  - `Not supported`
  - `Off`

Important browser rule:

- call `Notification.requestPermission()` only from a click/tap handler
- do not request permission automatically on page load

Recommended default:

- toggle defaults to `off`
- after user clicks enable and permission is granted, persist it as `on`
- if permission is denied, keep toggle off and show blocked status

## Persistence Choice

For V1, use browser-local storage, not backend `user_configs`.

Reason:

- notification permission is browser/device-specific
- enabling notifications on one browser should not imply the permission exists on another device
- avoiding backend config avoids schema/test blast radius for the first block

Suggested storage key:

- `trendscope_browser_notifications_v1:<user-scope>`

Suggested stored shape:

```json
{
  "enabled": true,
  "notifyWhenVisible": false
}
```

The `user-scope` can reuse the existing sound storage pattern based on email/username.

## Frontend Design

Add a new service:

- `frontend/src/services/alerts/browser-notifications.ts`

Responsibilities:

- detect support:
  - `typeof window !== 'undefined'`
  - `'Notification' in window`
  - secure context when available
- expose current permission/status
- request permission from click handler
- persist/load local settings
- format notification content
- show notification for eligible alert
- track sent alert ids in memory

Suggested API:

```ts
export type BrowserNotificationStatus =
  | 'unsupported'
  | 'default'
  | 'granted'
  | 'denied';

export function loadBrowserNotificationSettings(scope: string): BrowserNotificationSettings;
export function saveBrowserNotificationSettings(scope: string, settings: BrowserNotificationSettings): void;
export function getBrowserNotificationStatus(): BrowserNotificationStatus;
export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationStatus>;
export function maybeNotifyAlert(alert: AlertEntry, options: BrowserNotificationOptions): boolean;
```

Notification format:

- title:
  - `VOL alert: SYMBOL`
  - `MCAP alert: SYMBOL`
  - `HVNC: SYMBOL`
  - `OLD 1H surge: SYMBOL`
  - `METEORA 1H: SYMBOL`
  - `HIGH CAP DUMP: SYMBOL`
- body:
  - include percent, mcap, volume, and address fragment when available
- tag:
  - `alert:${alert.id}`
- data:
  - address
  - alert id
  - rule key

Click behavior:

- focus the existing tab if possible
- optionally route to live workspace/alerts panel in a later block

## Integration Points

### `frontend/src/main.ts`

Current sound side effects loop over `state.data.alerts`.

Add a parallel browser notification side effect:

- track `notifiedAlertIds`
- skip alert if already notified
- skip catch-up alerts that were created before the current session became active
- call `maybeNotifyAlert(...)`
- mark notified only when a notification was actually created or intentionally skipped as catch-up

This keeps notification side effects close to existing sound behavior.

### `frontend/src/state/app-controller.ts`

Add controller methods:

- `enableBrowserNotifications()`
- `disableBrowserNotifications()`
- `setBrowserNotificationsVisibleMode(enabled: boolean)` only if needed

Hydrate local notification settings after authentication, similar to sound settings.

### `frontend/src/state/app-state.ts`

Add UI state:

```ts
browserNotifications: {
  enabled: boolean;
  permission: 'unsupported' | 'default' | 'granted' | 'denied';
  notifyWhenVisible: boolean;
}
```

### `frontend/src/ui/sections/layout-sections.ts`

Render controls near sound controls:

- `Browser Notifications` toggle/button
- permission/status label

Avoid visible explanatory paragraphs in-app. Keep the UI compact and operational.

## Eligibility Rules

A browser notification should fire only when:

- user is authenticated
- app runtime mode is active
- browser notification setting is enabled
- browser permission is `granted`
- alert kind is enabled by existing alert toggles
- alert id has not already notified in this page session
- document is hidden, unless `notifyWhenVisible` is enabled

Do not trigger notifications for historical catch-up alerts loaded from REST.

## Block Plan

### Block 1: Notification service and local settings

Scope:

- create browser notification service
- add storage helpers
- add formatter helpers
- add focused unit tests where practical

Expected size:

- small to medium

Validation:

- `npm run lint`
- affected frontend tests if available

### Block 2: Controller/state/UI wiring

Scope:

- add state fields
- hydrate/persist local notification settings
- add enable/disable controller actions
- render compact browser notification controls

Expected size:

- medium

Validation:

- `npm run lint`
- `npm --prefix frontend run build`

### Block 3: Alert side effect integration

Scope:

- call notification service for new socket-delivered alerts
- avoid duplicates
- skip catch-up/historical alerts
- respect document visibility and existing alert kind toggles

Expected size:

- small to medium

Validation:

- `npm run lint`
- `npm --prefix frontend run build`

### Block 4: Docs and manual QA checklist

Scope:

- update `docs/current-bot-state.md`
- update `docs/bot-complete-reference.md`
- add manual test checklist

Validation:

- review `git diff`

## Manual QA Checklist

Test in Chrome or another Chromium browser:

1. Start app on `localhost`.
2. Login.
3. Confirm browser notification status starts as off/default.
4. Click enable.
5. Grant permission.
6. Trigger or simulate a backend alert.
7. With tab visible, confirm default behavior does not notify.
8. Hide/minimize tab and trigger another alert.
9. Confirm native notification appears.
10. Click notification and confirm the app tab focuses.
11. Disable browser notifications in app.
12. Trigger another alert and confirm no notification appears.
13. Deny permission in browser settings and confirm UI shows blocked/denied.

## Future Push API Block

Only after V1 is validated, consider real push with closed-tab support.

That future block would require:

- Service Worker registration
- Push API subscription flow
- VAPID key config
- backend subscription table
- register/unregister endpoints
- delivery service
- cleanup of expired subscriptions
- schema/init updates
- `npm run db:schema-check`

## Pontos importantes

- Browser Notifications V1 depends on the app being open in a browser tab because it uses the existing socket flow.
- Closed-tab notifications are a different feature and require Service Worker + Push API.
- Permission must be requested from a user gesture; automatic prompts are blocked or create bad UX.
- Notification permission is device/browser-specific, so V1 should use local storage instead of backend `user_configs`.
- HTTPS is required in production; `localhost` works for development.
- Existing alert kind toggles should still gate browser notifications.
- Sound and browser notifications should remain independent controls.
- Avoid notifying on historical REST catch-up alerts, otherwise users can get spammed after login.
