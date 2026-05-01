# Presence Parallel Computer Use

## Diagnosis

The current failure is not a simple Root Operator panel stealing focus back.
Live diagnostics from this branch, with the helper AX-trusted, show:

- Notes is `NSWorkspace.frontmostApplication` and `is_active=true`.
- The Notes window is `is_main=true` but `is_key=false`.
- `system_focused_application_status=-25204` and
  `system_focused_ui_element_status=-25204` (`kAXErrorNoValue`).
- `root_operator_focused_windows=[]`.
- Root Operator Electron panels are present, but every reported panel has
  `is_key=false` and `is_main=false`.
- Apple's `CursorUIViewService`
  (`com.apple.TextInputUI.xpc.CursorUIViewService`) exposes a key window while
  Notes is active. Its AX payload reports the Notes pid on the window object,
  which is consistent with TextInputUI owning the caret-adjacent text service
  surface while the Notes document window itself is not key.

The stronger signal is the focus transaction itself. `focus-element` sets
app/window/target focus successfully (`ax_status=0` for app frontmost, focused
window, window focused, target focused, and app focused UI element). In the same
helper process, polling can see `focused_role=AXTextArea`. A fresh helper process
immediately afterwards returns `{"error":"no_focused_element"}`. That means
the AX focused element is not a durable system postcondition across MCP helper
invocations.

The user-observed HID click behavior fits the same model: a click can briefly
land focus on the `AXTextArea`, then the text-input/window-server state settles
back to a window-level or no-focused-element state before the next MCP call.
The round-trip gap is the bug surface.

## Design

### Single-process action chain

Add a native `ax-helper run-chain` command. The command takes JSON steps and
executes them inside one helper process, keeping resolved AX element handles in a
named in-memory map for the lifetime of the chain.

This avoids relying on `kAXFocusedUIElement` as an inter-process global. A chain
can resolve the Notes editor once, set value and selection ranges directly on
that element, invoke app menu items, read the element back, and verify the final
text before any focus bounce between MCP calls can invalidate the operation.

The chain is intentionally generic enough for production use:

- `launch_app` opens an app by bundle id through `NSWorkspace`.
- `wait_for_app_window` waits until an app exposes at least one AX window.
- `press_named` resolves and AX-presses named controls such as Notes' toolbar
  `New Note` button.
- `resolve` stores an element by role/label/index/near hints.
- `focus` runs the existing hardened focus transaction but can continue when the
  same process can see the target while fresh-process focus is unavailable.
- `set_value`, `insert_text`, `select_all`, `select_range`, `select_substring`,
  `menu`, and `read` operate on stored targets without going back through global
  focus.
- The response records every step result plus final cursor invariance data.

MCP gets an `agent_run_chain` wrapper so the same primitive is available to the
agent, not just to scripts.

### Cursor invariance

Every HID primitive must capture and restore the hardware cursor inside the
native helper invocation:

- Capture with `CGEvent(source:nil)?.location` before any HID event.
- Post the short event burst at the requested point.
- Restore with `CGWarpMouseCursorPosition` in a `defer` path.
- Emit `cursor_before`, `cursor_after`, `cursor_restored`, and
  `cursor_delta` in the JSON result.

`run-chain` also captures the cursor at the beginning and end of the whole
chain. The acceptance script fails if the cursor moves outside a small tolerance.

AX-first remains the policy. HID is used only for surfaces that do not expose AX
actions, and the acceptance path is expected to use no HID at all.

### Host focus discipline

The Electron host already blurs Root Operator windows before external focus and
the cursor companion sets its panel non-focusable outside input mode. Keep that,
but treat it as necessary hygiene rather than the primary fix. The live evidence
does not show an RO key window during the Notes failure.

For long chains, the helper owns the target app/window until the chain ends.
Root Operator should not refocus any BrowserWindow during the chain; the MCP
tool uses the existing host focus release before spawning `run-chain`.

## Acceptance Criteria

- `scripts/test-presence-parallel.sh` exists and is executable.
- The script quits Notes, verifies no Notes windows are present, starts a noisy
  `tail -f /tmp/distractor.log` Terminal distractor, then uses agent/native
  primitives to open Notes, press the toolbar `New Note` button, create content,
  apply Format > Title and Format > Body, and verify final note text.
- No `force=true` is required in the script.
- The script captures cursor position before and after the chain and fails if
  the cursor was not restored within tolerance.
- `npm test` stays green.
- Existing focused-element tools continue to return honest
  `focus_not_sticky` failures when fresh-process focus is unavailable.

## Risk Register

- Rich text verification: AX exposes the Notes text value but not a simple
  public "this range is Title/Body" assertion. The script can verify text and
  menu command success; visual style verification remains a manual or screenshot
  follow-up unless Notes exposes richer AX attributes.
- Background formatting: Format menu invocation may still require Notes to be
  frontmost. The chain minimizes focus dependence, but macOS menu state is
  process-global. True simultaneous keyboard focus in another app remains a
  WindowServer limitation for menu-driven commands.
- Cursor restoration visibility: `CGWarpMouseCursorPosition` restores inside
  the same helper call. Very long hover/drag operations can still make the
  hardware cursor visibly travel during the call, so long HID operations should
  remain guarded and avoided for the Notes acceptance path.
- App-specific semantics: The chain is generic, but the acceptance script is
  Notes-specific. Other apps may require additional target resolution or
  verification steps.
