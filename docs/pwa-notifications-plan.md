# PWA Notifications Plan

## Goal

Notify users when Claude sends an assistant reply:

- iPhone PWA notification
- macOS desktop notification from the Electron app

## Current State

- The mobile/web client is already installable as a PWA:
  - `client.html` includes a manifest and Apple touch icons.
  - `public/manifest.json` uses `display: "standalone"`.
- There is currently no service worker, no Push API usage, and no notification permission flow in the client.
- Assistant replies are already centralized in one reliable place:
  - `main.js` -> `channelManager.on('claude_reply', ...)`
- Paired devices already have stable identifiers (`kid`) and names, which makes push subscriptions easy to bind to trusted devices.
- The app already persists chat history in the agent workspace, so unread-count/badge logic can build on that later.

## Platform Constraints

### iPhone / iPad

Web Push works on iPhone/iPad only for Home Screen web apps, not for an ordinary Safari tab.

Key requirements:

- user must add the app to the Home Screen
- app must request notification permission from a direct user gesture
- app must use a service worker
- push subscription must use standards-based Web Push / VAPID
- push events must result in a user-visible notification

Relevant sources:

- WebKit: Web Push for Home Screen web apps on iOS/iPadOS 16.4+
- WebKit: `id` in the manifest is used to identify the app
- MDN: `PushManager.subscribe()` should be called from a user gesture
- MDN: `showNotification()` should be used from the service worker, especially on mobile

### macOS Desktop App

This is much simpler:

- use Electron `Notification` in the main process
- trigger it from the same assistant-reply event in `main.js`
- clicking the notification should focus/open the local desktop chat window

## Recommended Architecture

### 1. Add Web Push subscription support to the PWA

Add:

- `public/sw.js`
- client-side service worker registration
- push subscription flow behind an explicit `Enable notifications` button

Flow:

1. user installs PWA to Home Screen
2. user pairs/authenticates as today
3. user taps `Enable notifications`
4. app:
   - registers service worker
   - requests `Notification` permission
   - calls `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`
5. client sends the subscription to the Electron main process over the already-authenticated WebSocket

### 2. Bind subscriptions to paired devices

Store subscriptions keyed by paired device `kid`, not just by endpoint.

Recommended stored shape:

```json
{
  "kid": "device-key-id",
  "name": "My iPhone",
  "subscription": { "...": "PushSubscription JSON" },
  "platform": "ios-pwa",
  "createdAt": "2026-03-24T00:00:00.000Z",
  "updatedAt": "2026-03-24T00:00:00.000Z"
}
```

Why this is the right trust model:

- `kid` is already the app’s paired-device identity
- registration can happen only after authenticated pairing
- removing a paired device can also remove its push subscriptions

### 3. Send notifications from the main process on Claude reply

Use the existing assistant reply fan-out point in `main.js`:

- persist history
- send to active WebSocket clients
- send to local desktop chat
- emit desktop notification
- emit Web Push to subscribed devices

This keeps all notification decisions in one place.

### 4. Service worker behavior

In `sw.js`:

- `push` handler:
  - parse payload
  - call `self.registration.showNotification(...)`
  - optionally update app badge
- `notificationclick` handler:
  - focus existing app client if open
  - otherwise open the chat URL
- `pushsubscriptionchange` handler:
  - resubscribe and resync with backend if possible

### 5. Desktop notification behavior

In Electron main:

- use `new Notification({ title, body })`
- click action should open/focus local desktop chat

Recommended first-pass behavior:

- notify when Claude sends an assistant reply
- suppress notifications if the local desktop chat window is focused

Optional stricter behavior:

- always notify, even if chat is focused

## Privacy / Security Recommendation

There are two reasonable payload policies:

### Option A: generic notification body

Example:

- title: `Root Operator`
- body: `Claude sent a new message`

Pros:

- strongest privacy
- simplest

Cons:

- less useful

### Option B: include a short preview

Example:

- title: `Root Operator`
- body: first 80-120 chars of assistant reply

Pros:

- much better UX

Cons:

- more message content appears on lock screens

Recommendation:

- start with generic text by default
- later add a setting for message previews

## Manifest / PWA Changes Needed

`public/manifest.json` should gain an `id`, for example:

```json
{
  "id": "/",
  "name": "Root_Operator",
  "short_name": "Root_Operator"
}
```

This is especially useful on iOS/iPadOS because WebKit uses the manifest ID as part of app identity.

## Suggested Implementation Order

### Phase 1: Desktop notifications

Smallest, safest first step:

- Electron notification on `claude_reply`
- click focuses local chat window

### Phase 2: PWA notification permission + service worker

- add `sw.js`
- register service worker
- add `Enable notifications` UI
- handle install / unsupported states cleanly

### Phase 3: Push subscription persistence

- generate/load VAPID keys
- store subscriptions by `kid`
- remove subscriptions when paired device is removed

### Phase 4: Push delivery

- send Web Push on Claude replies
- add service worker click handling
- add badge count

## Recommendation For This Repo

This should be implemented from the Electron main process, not a separate cloud service.

Why:

- Claude replies originate locally in `main.js`
- the app already knows which paired devices are trusted
- the laptop already has network access through the normal runtime
- it avoids adding another infrastructure component

The only new server-side capability needed is standards-based Web Push delivery, which can be done from the Electron app itself.

## Libraries / APIs To Use

- Browser:
  - `navigator.serviceWorker.register()`
  - `registration.pushManager.subscribe()`
  - `Notification.requestPermission()`
  - `ServiceWorkerRegistration.showNotification()`
- Electron:
  - `Notification`
- Delivery:
  - `web-push` npm package

## Good Product UX

Show notification UI only when it makes sense:

- if not installed on iPhone Home Screen:
  - show `Add to Home Screen to enable notifications`
- if installed but not permitted:
  - show `Enable notifications`
- if enabled:
  - show `Notifications on`

Also worth adding later:

- `Send test notification`
- per-device notification toggle
- message preview on/off

