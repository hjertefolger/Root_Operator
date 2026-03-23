# Staging Update Test

## Staging Repo

The staging updater feed is published to:

- [hjertefolger/Root_Operator_Staging](https://github.com/hjertefolger/Root_Operator_Staging)

This repo is intended for updater testing only.

## Commands

Build a signed/notarized staging app without publishing:

```bash
npm run build:staging
```

Build an unsigned staging app:

```bash
npm run build:unsigned:staging
```

Publish a staging release with updater metadata:

```bash
npm run release:staging
```

`release:staging` will:

- point the updater feed at `hjertefolger/Root_Operator_Staging`
- use `prerelease` release type by default
- fetch `GH_TOKEN` from `gh auth token` if it is not already exported

## First End-to-End Test

1. Bump `package.json` to a staging test version, for example `2.0.1`.
2. Run `npm run build:staging` if you want to install a local staged build first, or `npm run release:staging` if you want the first version published too.
3. Install that build from the staging release into `/Applications`.
4. Bump to the next version, for example `2.0.2`.
5. Run `npm run release:staging` again.
6. Launch the already-installed `2.0.1` app.
7. Verify:
   - main tray view shows the update strip
   - Settings shows the permanent update row
   - update downloads successfully
   - restart is blocked while Root Operator is busy
   - restart installs the update when idle
   - workspace/runtime/chat history persist after relaunch

## Notes

- Replacing release assets under the same version does not test updater behavior.
- Real updater tests require real version bumps.
- The staging repo is public so client machines do not need `GH_TOKEN` for update checks.
