# Presence Focus Stick Diagnosis

## Diagnosis

The cold-start chain failed because `agent_focus_element` treated `AXUIElementSetAttributeValue(target, AXFocused=true)` as the whole operation. In live Notes, that setter can return success without making the target the system-wide `AXFocusedUIElement` that later `read_focused`, `select_all`, and keyboard primitives depend on.

Three hypotheses were tested against the code path:

- Focus-stealing renderer: the cursor companion is a focusable macOS panel. It focuses the textarea when the user opens the bubble, but after submit it only closes the renderer input state; it does not blur the panel or make the panel non-focusable. A panel can remain key without changing `NSWorkspace.frontmostApplication`, so `read_subtree` can still see Notes while system AX focus is empty or owned by the panel.
- Frontmost app versus key window: the helper resolves the Notes window from the frontmost app, but it does not activate the target process, raise the target window, set the app focused window, or mark the window main/focused before setting element focus. Some apps accept the element setter while refusing to route keyboard focus into a non-key window.
- AX setter semantics: the helper reports success from the setter status only. There is no postcondition check against the system-wide focused element, so false-positive focus success propagates into the next tool call.

The first and third are confirmed by code inspection and the user's live trace: `focus_element` returned success, then an immediate `read_focused` saw `no_focused_element`. The second is a required hardening step because AX focus is window/app-context-sensitive on Cocoa apps including Notes.

This environment cannot run the live Notes reproduction from the shell because `build/native/ax-helper check` reports `{"trusted":false}`. The fix below adds native verification so a live run can distinguish real focus from false-positive setter success.

## Fix

1. Cursor companion releases keyboard ownership when input closes:
   - Clear the delayed refocus timer.
   - Blur the panel if it is focused.
   - Set the panel non-focusable while only the passive dot/reply/loader layers are visible.
   - Re-enable focusability before opening or refocusing the input.

2. Native focus becomes a full focus transaction:
   - Resolve the target's process and containing window.
   - Activate the target app, set it frontmost where AX allows it, raise the window, set the app focused window, and mark the window main/focused where supported.
   - Set `AXFocused=true` on the target element.
   - Poll `kAXFocusedUIElementAttribute` briefly and only return success if the system-wide focused element matches the target or a direct ancestor/descendant identity.

3. Failure is explicit:
   - If the setter fails, keep the existing `not_focusable` / `focus_failed` behavior.
   - If the setter succeeds but the postcondition never becomes true, return `focus_not_sticky` with the last observed focused role and AX status details.

## Acceptance

A passing live Notes cold start should show:

1. `agent_read_subtree(...)` resolves the Notes editor.
2. `agent_focus_element(role: "AXTextArea", ...)` returns focused success with `verified=true` in the helper payload.
3. Immediate `agent_read_focused` returns the Notes `AXTextArea`.
4. `agent_select_all`, `agent_menu_command(["Format","Body"])`, `agent_select_range(...)`, and `agent_menu_command(["Format","Title"])` run without `no_focus`.

If step 2 fails with `focus_not_sticky`, the helper is no longer lying about focus. The remaining diagnosis should inspect the reported focused role/bundle and any target-window AX statuses.

## Verification

- `node scripts/build-native-helpers.js` builds `build/native/ax-helper` cleanly.
- `npm test` passes 144/144.
- `build/native/ax-helper check` returns `{"trusted":false}` in this shell, so the live Notes acceptance must be run from the trusted Root Operator app context.
- `build/native/ax-helper read-focused` returns `{"error":"no_focused_element"}` in this shell, matching the untrusted/no-live-focus state and not exercising the Notes path.
