# Auto Update Plan

## Goal

Add production-grade self-updating for the packaged macOS app with the least disruption to the current setup:

- keep the existing `electron-builder` packaging flow
- keep signed + notarized GitHub release artifacts
- preserve `~/.root-operator/workspace`, `~/.root-operator/runtime`, chat history, scheduler state, and keychain state across updates
- never surprise-restart the app while Root Operator is actively serving as a tunnel/chat assistant

## Recommendation

Use `electron-updater` with the `github` provider.

This is the best fit for the current app because:

- the app already builds with `electron-builder`
- the build already produces `latest-mac.yml` and blockmaps in `dist/`
- we need richer update lifecycle events than Electron's simpler updater path
- we need full control over when an update is installed because the app can be actively hosting a tunnel, Claude session, and scheduler jobs

Do **not** use `update-electron-app` as the primary path here.

It is appealingly simple, but it is a worse fit for Root Operator because we need:

- explicit install deferral while the app is active
- richer progress/state events for the tray UI
- tighter control over release metadata and provider configuration

## Current State

What is already working:

- signed + notarized macOS builds via `electron-builder`
- public GitHub releases
- `dmg` + `zip` targets for macOS
- generated `latest-mac.yml`
- generated blockmaps
- external persistent runtime under `~/.root-operator/...`

What is still missing:

- no `electron-updater` dependency
- no updater code in `main.js`
- no publish config in `package.json`
- no embedded `app-update.yml` inside the packaged app
- current release replacement flow uploads only binaries, not updater metadata
- no tray UI or IPC for update state

## Important Constraints

### 1. Version bumps are mandatory

Auto-update only works across real version changes.

Replacing assets under the same version tag is fine for manual downloads, but it will **not** update installed clients that already report the same app version.

That means every updater-visible release must:

- bump `package.json` version
- publish matching release metadata
- publish matching assets

### 2. Manual asset swapping is not enough

For auto-update, GitHub releases must include:

- `latest-mac.yml`
- the matching `.zip`
- blockmaps

The current "upload DMG + ZIP only" flow is not sufficient for a real updater.

### 3. Install timing must respect Root Operator activity

Root Operator is not a passive app. It may be:

- serving a live remote tunnel
- holding a Claude session
- keeping the machine awake
- running scheduled jobs

So we should allow:

- silent background check
- silent background download

But we should **not** auto-install immediately when an update finishes downloading.

Default behavior should be:

- notify when update is ready
- install only on explicit user action or safe idle state

## Proposed Architecture

## Phase 1: Main-process updater service

Add a dedicated updater module, e.g. `src/updater.js`, used from `main.js`.

Responsibilities:

- initialize only in packaged builds
- expose a simple state machine:
  - `idle`
  - `checking`
  - `available`
  - `downloading`
  - `downloaded`
  - `not-available`
  - `error`
- keep the latest update info + progress in memory
- schedule checks:
  - first check shortly after app ready
  - periodic checks every few hours
- gate installation when the app is busy

Recommended behavior:

- `autoDownload = true`
- `autoInstallOnAppQuit = false`
- explicit `quitAndInstall()` only from a user action or a safe idle state

## Phase 2: Electron builder publish configuration

Use an environment-driven `electron-builder` config file for GitHub publishing:

- provider: `github`
- owner: `UPDATE_REPO_OWNER`
- repo: `UPDATE_REPO_NAME`
- release type: `UPDATE_RELEASE_TYPE`
- tag prefix: `UPDATE_VPREFIXED_TAG_NAME`
- private feed toggle: `UPDATE_PRIVATE`

Also set:

- `electronUpdaterCompatibility: ">=2.16"`

Why:

- ensures `app-update.yml` is embedded in the packaged app
- makes the feed deterministic instead of inferred
- aligns the app with the generated `latest-mac.yml`
- allows staging and production feeds to come from the same codebase without hand-editing config

Important:

- `UPDATE_PRIVATE=true` is only suitable if client machines can provide `GH_TOKEN`
- for low-friction tester installs, a separate public staging repo is usually easier than a private one

## Phase 3: Release workflow cleanup

Add a real release script instead of manual asset replacement:

- local signed build remains available
- updater-ready release build should publish metadata + artifacts together

Recommended scripts:

- `build`
  - local signed/notarized build only
- `release`
  - `electron-builder --mac --publish always`

Recommended release discipline:

1. bump app version
2. create or target the matching GitHub release/tag
3. publish via `electron-builder`
4. verify metadata and assets landed together

This avoids the current fragile pattern where release binaries can diverge from updater metadata or tag/version state.

## Phase 4: IPC and tray UI

Expose updater state through preload IPC.

Likely new channels:

- `GET_UPDATE_STATE`
- `CHECK_FOR_UPDATES`
- `DOWNLOAD_UPDATE`
- `INSTALL_UPDATE`

Likely renderer events:

- `UPDATE_STATE`

Tray UI should show:

- `Checking for update...`
- `Update available`
- `Downloading update... 42%`
- `Update ready`
- `Update error`

Best UX for Root Operator:

- subtle banner or status row in the tray main view
- no forced modal
- `Restart to update` button when ready
- if tunnel/chat is active, label it clearly:
  - `Update ready — install when idle`

## Phase 5: Safe install gating

Before installing, check:

- tunnel active?
- Claude/channel active?
- scheduler currently running a job?

If any are true:

- do not auto-restart
- keep the downloaded update staged
- surface a message explaining why install is deferred

Safe install triggers:

- explicit user click in tray
- app idle with tunnel paused and no active Claude work
- optional "install on next quit" behavior later

## Phase 6: Post-update repair pass

On first launch after an update:

- run workspace/runtime integrity repair
- verify `.mcp.json`, runtime prompt/settings, and seeded identity files still exist
- re-check chat history store availability
- log previous version -> current version migration

This is especially important because Root Operator depends on external runtime assets and not just the app bundle.

## Recommended Initial Scope

Start with macOS only and a single stable channel.

Do not add staged rollouts, prerelease channels, or Windows/Linux update paths in the first implementation.

The first production-quality updater should do only this:

- check for updates
- download updates
- show progress/state in the tray
- let the user install when safe

## Testing Plan

### Functional

1. Install version `A` from `/Applications`
2. Publish version `B` with updater metadata
3. Launch version `A`
4. Verify:
   - check runs
   - update is found
   - download starts
   - progress appears in tray
   - update reaches ready state
   - install occurs only when requested/safe
   - relaunched app reports version `B`

### Persistence

Verify these survive the update:

- `~/.root-operator/workspace`
- `~/.root-operator/runtime`
- `~/Library/Application Support/Root_Operator/channel-history.jsonl`
- scheduler jobs
- secure tokens / keychain values

### Root Operator-specific safety

Verify install is deferred when:

- tunnel is live
- Claude is actively working
- a scheduler job is running

## Suggested Implementation Order

1. Add `electron-updater`
2. Add explicit `build.publish` config and repository metadata
3. Add `src/updater.js`
4. Wire updater state into `main.js`
5. Expose updater IPC in `preload.js`
6. Add tray UI in `src/renderer`
7. Add release script for metadata-aware publishing
8. Run installed-app upgrade test from `/Applications`

## Notes for This Repo

- The app already generates `latest-mac.yml`, which is a strong sign the packaging side is close.
- The app does **not** currently embed `app-update.yml`, so updater configuration is incomplete.
- The current public GitHub release flow is compatible with a GitHub provider updater, but only if we stop treating release assets as manually swappable binaries and start publishing the metadata set as a unit.
