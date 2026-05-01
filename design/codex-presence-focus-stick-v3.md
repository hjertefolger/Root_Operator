# Presence Focus Stick v3

## Diagnosis

Round 2 removed false success: `focus_element` now fails with `focus_not_sticky` when a fresh helper cannot read back the requested target as `AXFocusedUIElement`.

The new failure pattern says the setter is accepted but ignored. The important signal is that Notes is frontmost and readable, while neither the fresh snapshot nor the long-running observer sees an `AXFocusedUIElementChanged` event. That points away from stale AX caches and toward window ownership/key-window state at the moment of the setter.

Static inspection found two gaps in the current path:

- `cmdFocusElement` resolved candidates inside the active app window, then passed that active/focused window into the focus transaction. `prepareFocusTransaction` only resolved the target element's owning window when no known window was supplied. If AX reported a stale focused window, the transaction could raise/key the wrong window even though the target element had a different parent `AXWindow`.
- Electron only released the cursor-companion panel before external AX focus. Other Root Operator windows could still be the AppKit key window if they happened to be focused.

## Diagnostic Output

Implemented `ax-helper diagnostics`. It emits:

- system-wide `AXFocusedApplication`
- focused app metadata and its `AXFocusedWindow`
- focused app/window `AXFocusedUIElement`
- every `NSWorkspace.runningApplications` entry with `AXMainWindow`, `AXFocusedWindow`, `AXChildren`/`AXWindows` window lists, and key/main flags
- Root Operator focused/key-like windows as exposed by AX

`focus-element` now attaches this diagnostic payload to `focus_not_sticky`. The MCP-side focus verifier also invokes `diagnostics` if a mismatch is detected after the helper returns, or if an older helper returns `focus_not_sticky` without diagnostics.

Codex sandbox evidence:

- `npm run build:native` succeeds.
- `./build/native/ax-helper check` returns `{"trusted":false}` here.
- `./build/native/ax-helper diagnostics` returns `{"error":"not_trusted"}` here.

Because this launch context is not AX-trusted, the real Notes diagnostic must be captured from the trusted Root Operator environment with `scripts/test-presence-focus-stick-v3.sh`.

## Fix

The AX transaction now prefers `resolveContainingWindow(element)` over the caller-supplied active window. It sets main before raise, sets the app focused window, raises the owning window, reasserts main/focused window state, then sets element focus and runs the existing fresh-process sticky verification.

The Electron host now wires `prepareForExternalFocus` to blur any currently focused Root Operator `BrowserWindow` before invoking AX focus. This preserves normal focusability for RO windows, but releases key-window ownership before the target app/window activation.

I did not add HID click fallback in this patch. The requested acceptance path is still no clicks. If the trusted diagnostic shows the correct Notes window is key/main and the AX text area still refuses focus, the next change should add a clearly reported HID fallback after AX failure.

## Test Plan

- `npm run build:native`
- `node --test src/agent-actions.test.js`
- `./build/native/ax-helper check`
- `./build/native/ax-helper diagnostics`
- Trusted-machine real test: `scripts/test-presence-focus-stick-v3.sh`

The trusted script activates Notes, resolves the editor `AXTextArea`, calls `focus-element`, then requires `read-focused` and `select-all` to succeed on the same role. It writes before/after diagnostics and each command JSON to `/tmp/presence-focus-stick-v3.*`.

## Risks And Gaps

- Live Notes verification could not be completed from this sandbox because AX trust is false for this helper launch context.
- The diagnostic payload enumerates all running apps. AX messaging timeouts are short, but a pathological app could still make diagnostics slower on failure.
- If Notes accepts window key/main state but refuses child text focus, this patch will still fail cleanly with diagnostics rather than silently claiming success.
