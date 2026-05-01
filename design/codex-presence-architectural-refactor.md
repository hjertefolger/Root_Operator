# Presence Architectural Refactor: Chain DSL to Generic Computer Use

Date: 2026-05-01
Branch: `feat/co-presence-v0`

## Executive Summary

Tom's critique is correct: `agent_run_chain` made the Notes create flow reliable, but it did so by adding a fixed helper-side DSL rather than by exposing a general macOS computer-use substrate. The first adjacent human action, "right-click the note in the sidebar and delete it," failed because the chain vocabulary did not include contextual-menu or arbitrary AX action verbs. That is an architecture failure, not a missing operation.

The refactor should keep the atomic single-process execution property that made the create flow work, but replace the workflow-specific chain vocabulary with a small generic action model:

- resolve AX elements by app/window/scope/label/role/point/attributes;
- inspect an element's available AX actions and attributes;
- perform any AX action exposed by that element (`AXPress`, `AXShowMenu`, `AXIncrement`, custom action names);
- set supported AX attributes (`AXValue`, `AXSelected`, `AXFocused`, `AXSelectedText`, selected text range);
- use cursor-invariant HID only when AX cannot express the action;
- verify destructive actions by re-reading state from a fresh helper process.

Existing named tools should remain as compatibility wrappers while new callers move to the generic surface.

## A. Critique of the Current Architecture

### What Is Working

The current branch solved important pieces:

- AX reads/writes, subtree search, focus transactions, menu-bar walking, text selection, and HID click/drag/scroll/hover/key events exist.
- `agent_run_chain` executes in one native helper process, so AX element references and focus survive across steps.
- HID commands save and restore the hardware cursor, and the existing Notes create acceptance test verifies cursor delta.
- The bridge has user-activity guards and rate limits.

Those are worth preserving.

### What Is Wrong

`agent_run_chain` is a fixed-vocabulary workflow runner. It currently supports a list like `launch_app`, `wait_for_app_window`, `press_named`, `resolve`, `focus`, `set_value`, `select_all`, `menu`, `select_range`, `insert_text`, `verify_value`, and `read`. That means the abstraction boundary is "which app workflows did we remember to encode?" rather than "what can macOS expose about this UI element?"

The leak shows up immediately:

- Contextual menus: no `AXShowMenu`, no generic `performAction`, no context-menu item resolver.
- Non-button AX actions: no `AXIncrement`, `AXDecrement`, `AXConfirm`, `AXCancel`, `AXPick`, app custom actions, or generic action enumeration.
- Selectable rows/lists: rows often expose `AXSelected` instead of `AXPress`; we have named selection for focused text, not generic selectable controls.
- Attribute updates: `AXValue` and text range are hardcoded, but AX has a broader settable attribute model.
- Element targeting: outside the chain, fresh helper invocations lose in-process element identity and focus. Inside the chain, targets are named but only usable by the hardcoded verbs.
- Menus: app menu bar traversal exists, but transient contextual menus are not represented as a first-class target scope.
- Destructive verification: the chain can verify text value, but not "the sidebar no longer contains this row" or "the target disappeared" as a generic postcondition.

The outcome is predictable: every missing human action becomes a new helper op, a new bridge tool, a new formatter, and a new test. That is the wrong slope.

## B. Audit of mediar-ai Repos

All code inspection was performed with `gh repo clone` / `gh issue` and local `git` reads against:

- `mediar-ai/MacosUseSDK`
- `mediar-ai/mcp-server-macos-use`
- `mediar-ai/fazm`

### MacosUseSDK

Repo metadata reports MIT license. Direct code lifting from this repo is viable with attribution.

Relevant implementation findings:

- `Sources/MacosUseSDK/AccessibilityActions.swift` exposes AX fallbacks by point and PID:
  - `setAccessibilityValue(pid:at:value:)`
  - `pressAccessibilityElement(pid:at:)`
  - `setAccessibilitySelected(pid:at:selected:)`
- Those functions are generic in the right way: they hit-test or tree-walk by point, find a suitable AX element, then perform the AX primitive rather than encoding app workflows.
- The SDK added a tree-walk finder because `AXUIElementCopyElementAtPosition` is unreliable for Catalyst table rows. It chooses the smallest containing element, optionally preferring roles like `AXRow`, `AXOutlineRow`, `AXListItem`, `AXButton`, or text roles.
- Commit history shows production lessons:
  - `aaa79dd fix: activate target app before input to prevent first-click being eaten`
  - `c9be8ad fix: use ranged AX children retrieval to prevent blocking on large containers`
  - `df6989d fix: add 5-second time limit on traversal to prevent AX API hangs`
  - `aef5bfc feat: replace DFS with BFS traversal`
  - `4513eea Add setAccessibilitySelected for Catalyst row selection`
  - `ffdc377 Tree-walk AX finder for setSelected (Catalyst row case)`
  - `b39ef7f Plumb axSetValue + axPress through performAction orchestration`
- Their traversal is bounded: max depth, max elements, max seconds, and ranged child retrieval with `AXUIElementCopyAttributeValues`.

What to lift directly:

- The point-tree-walk pattern for "smallest element containing point, with preferred roles."
- Bounded BFS and ranged children retrieval.
- Parent-chain walk to convert text/cell hit-test leaves into actionable row/list ancestors.

What not to copy as-is:

- Their HID source uses `.hidSystemState`; our helper intentionally uses `.privateState` to avoid merging with stale hardware modifier state.
- Their input functions do not preserve cursor position internally. Our cursor invariant must remain stricter.

### mcp-server-macos-use

Repo metadata reports license "Other", so use it as architecture reference, not direct copied code unless separately verified.

Their MCP tool surface is much smaller than ours but broader in capability:

- `macos-use_open_application_and_traverse`
- `macos-use_click_and_traverse`
- `macos-use_type_and_traverse`
- `macos-use_press_key_and_traverse`
- `macos-use_scroll_and_traverse`
- `macos-use_set_value_and_traverse`
- `macos-use_press_ax_and_traverse`
- `macos-use_set_selected_and_traverse`
- `macos-use_refresh_traversal`

Important patterns:

- Actions return a traversal or diff after the action. The model sees the result of the action immediately.
- `click_and_traverse` can locate an element by text, center the coordinates, click, optionally type, optionally press a key, and then traverse. This reduces MCP round trips and focus loss.
- It activates the target app before input, because macOS can consume the first click for activation.
- It saves cursor and frontmost app before disruptive actions, then restores both.
- It has an InputGuard overlay and Esc-to-cancel event tap during automation. That is a user-safety pattern, though Root Operator's current user-activity guard is more aligned with Tom's "no visible cursor borrow" requirement.
- It detects cross-app handoff after interactions and traverses the new frontmost app.
- It writes large traversal output to `/tmp/macos-use` and returns compact summaries to avoid context bloat.
- It has auto-scroll-to-reveal logic for points outside a window viewport.

Closed issue findings:

- Issue #5 ("Cannot replicate video behaviour") confirms the server exposes primitives; the client prompt/model must chain screenshot/traversal/analyze/click/type. This reinforces that the tool surface should expose generic capability, not app-specific workflows.
- Issue #1 is installation/docs only.

### fazm

Repo metadata does not report a license. Treat as production-pattern reference only.

Relevant findings:

- Changelog confirms Fazm bundled `mcp-server-macos-use` in v1.5.0 and moved screen capture/macOS automation to native accessibility APIs.
- `ChatPrompts.swift` routes "Desktop apps" to macos-use tools and includes a critical safety instruction: only type user-requested text into apps, never reasoning/debug notes.
- `FloatingControlBarWindow.swift` explicitly avoids dismissing the chat on programmatic focus changes during tool calls. It only collapses on physical mouse-down events, and uses a separate "chat active" source of truth because tool calls can create long quiet gaps.
- `ACPBridge.swift` kills MCP server process trees on stop and sweeps orphaned bridge/MCP processes on app startup. That is not part of this helper refactor, but it is a relevant lesson for long-running automation subprocesses.
- Fazm's public issues were mostly packaging/language issues; no closed issue exposed a better AX contextual-menu trick.

## C. Refactor Proposal

### Current Surface vs Proposed Generic Surface

Current Presence tools include more than 28 named operations:

| Category | Current tools |
|---|---|
| Avatar | `agent_move_to_cursor`, `agent_move_to`, `agent_park` |
| Read/search | `agent_read_at_cursor`, `agent_read_focused`, `agent_read_window`, `agent_read_subtree`, `agent_find_element`, `agent_recent_events`, `agent_check_ax` |
| Focus/press | `agent_focus_element`, `agent_focus_at`, `agent_press_named`, `agent_press_at`, `agent_menu_command` |
| Text | `agent_write_selection`, `agent_type_text`, `agent_select_range`, `agent_select_all`, `agent_select_substring` |
| HID | `agent_click_at`, `agent_drag`, `agent_scroll_at`, `agent_hover_at`, `agent_keystroke`, `agent_keystroke_global`, `agent_key_hold`, `agent_modifier_latch` |
| Atomic | `agent_run_chain` |

Proposed generic substrate:

| New primitive | Purpose | Subsumes |
|---|---|---|
| `agent_observe` | Traverse/read app/window/subtree/menu/focused/point scopes with bounded BFS, actions, settable attributes, frames, labels, values. | `read_window`, `read_subtree`, `find_element`, parts of `read_at_cursor`, `read_focused` |
| `agent_act` | Atomic list of generic steps in one helper process. Steps: `launch`, `wait_window`, `resolve`, `inspect`, `perform_action`, `set_attribute`, `hid`, `sleep`, `read`, `verify`. | `agent_run_chain` and most named action tools |
| `agent_hid` | Cursor-invariant HID action by declarative kind: click/drag/scroll/hover/key/type/modifier. | HID named tools |
| `agent_recent_events` | Keep as-is. Passive awareness remains separate. | unchanged |
| Compatibility wrappers | Keep current names, implemented through generic primitives. | preserves callers |

The native helper should expose the same generic model directly:

- `observe`: JSON input, returns traversal/search result.
- `act`: JSON input, executes steps atomically.
- `hid`: optional direct one-shot HID wrapper.
- Existing commands remain for compatibility until callers migrate.

### Generic `agent_act` Step Model

Example for the right-click/delete class:

```json
{
  "cursor_tolerance": 1,
  "steps": [
    { "op": "launch", "bundle_id": "com.apple.Notes", "activate": true },
    { "op": "wait_window", "bundle_id": "com.apple.Notes" },
    {
      "op": "resolve",
      "as": "note",
      "bundle_id": "com.apple.Notes",
      "scope": "app",
      "label": "Bridge test - wow moment",
      "prefer_roles": ["AXRow", "AXOutlineRow", "AXCell", "AXStaticText"]
    },
    { "op": "perform_action", "target": "note", "action": "AXShowMenu", "fallback": { "kind": "right_click" } },
    { "op": "resolve", "as": "delete_item", "scope": "system", "role": "AXMenuItem", "label": "Delete" },
    { "op": "perform_action", "target": "delete_item", "action": "AXPress" },
    { "op": "resolve", "as": "confirm_delete", "scope": "system", "role": "AXButton", "label": "Delete", "optional": true },
    { "op": "perform_action", "target": "confirm_delete", "action": "AXPress", "optional": true },
    { "op": "verify_absent", "bundle_id": "com.apple.Notes", "scope": "app", "label": "Bridge test - wow moment" }
  ]
}
```

Key detail: the chain is still atomic, but the vocabulary is generic AX/HID. New human actions do not require new chain verbs if macOS exposes the action or attribute.

### What This Covers

- Right-click/context menu: `perform_action(AXShowMenu)` if available; otherwise cursor-invariant HID right-click at the target frame center.
- Menu item press: resolve transient `AXMenuItem` in `system`, `app`, or `focused` scope, then `AXPress`.
- Catalyst/sidebar selection: `set_attribute(AXSelected, true)` on row/list ancestors.
- Sliders/steppers: `perform_action(AXIncrement)` / `AXDecrement`, or set `AXValue` if settable.
- Checkbox/radio/button/link/menu item: `perform_action(AXPress)`.
- Text entry: `set_attribute(AXValue)`, `set_attribute(AXSelectedText)`, or HID typing.
- App activation/key window establishment: `launch`/`activate`/`raise_window`/`focus` remain generic setup steps.

## D. HID Layer and Cursor Invariance

Our cursor-invariant policy is stricter than MacosUseSDK/mcp-server-macos-use and should remain.

MacosUseSDK:

- Provides click/right-click/scroll/key/type primitives.
- Activates before input in coordinator.
- Does not inherently guarantee hardware cursor restoration.
- Uses `.hidSystemState`.

mcp-server-macos-use:

- Saves cursor and frontmost app before disruptive actions.
- Restores cursor after action with a mouse-move event.
- Restores previous frontmost app.
- Adds InputGuard to block hardware input during automation.

Root Operator should keep and centralize:

- Save hardware cursor position before any HID step.
- Use `.privateState` event source for keyboard/mouse where possible.
- Move/click/drag/scroll.
- Warp/restore cursor to the exact saved position.
- Re-read cursor and fail if delta exceeds tolerance.
- Never silently report success when cursor restore failed.

The bug in our current architecture is not the HID invariant. The bug is that HID restore exists only in individual commands; if `run-chain` grows HID steps, cursor borrow/restore must be a reusable helper primitive applied per HID step and again verified at chain end.

## E. Migration Plan

### Commit 1: Design Memo

- Add this memo.
- Run `npm test`.
- Commit memo only.

### Commit 2: Generic Native Substrate

Helper changes:

- Add bounded BFS/ranged child traversal utility inspired by MacosUseSDK, with MIT attribution where directly lifted.
- Add generic target resolution over scopes:
  - `window` (default current behavior)
  - `app`
  - `focused`
  - `system`
  - `target` subtree
- Add action/attribute introspection in traversal payloads.
- Add generic `performActionPayload(element, action)`.
- Add generic `setAttributePayload(element, attribute, value)`.
- Add `verify_absent` / `verify_present` that re-resolves in a fresh helper process or independent AX snapshot, not a stale chain reference.
- Extend `run-chain` first, or add `act` and make `run-chain` a compatibility alias. Existing create-flow steps remain supported.
- Add contextual-menu support:
  - try `AXShowMenu`;
  - if unsupported, use cursor-invariant right-click at target center;
  - resolve `AXMenuItem` from system/app transient menu scope;
  - press it with `AXPress`.

Bridge changes:

- Add `agent_act`.
- Add `agent_observe` if useful for the MCP layer.
- Keep all existing tool names in `channel-bridge.cjs`.
- Implement old `agent_run_chain` by passing through to helper unchanged until callers migrate; generic ops can coexist with legacy ops in the same chain.
- Keep named wrappers stable.

Tests:

- Unit tests for `agent_act` validation and helper argv.
- Swift helper build.
- Existing `npm test`.
- Existing `scripts/test-presence-parallel.sh`.
- New `scripts/test-presence-notes-context-delete.sh`.

### What Gets Deleted Later

Not in the first implementation commit:

- Duplicate `cmdMenuCommand` and chain menu-walk copies should be unified.
- Named helper commands like `press-named`, `press-at`, `select-all`, etc. can eventually become thin compatibility wrappers over generic resolution/action/attribute code.
- Bridge descriptions can eventually hide old tools once callers have migrated.

### What Stays

- `agent_run_chain` behavior for the create-flow acceptance test.
- User-activity guard in JS.
- Cursor-invariant HID policy.
- AX focus diagnostics and fresh-process verification.
- `recent_events` passive awareness.

## Acceptance Criteria for This Refactor

- Notes create flow still passes.
- New contextual-delete acceptance script deletes `Bridge test - wow moment` from Notes without AppleScript delete and without Cmd+Delete.
- If `AXShowMenu` is unavailable on the note row, the helper falls back to cursor-invariant right-click.
- Confirmation dialog handling is generic: resolve a `Delete` button and `AXPress`.
- A fresh helper process verifies the note title is absent.
- Hardware cursor delta is <= 1 point, and a restore failure is reported as failure.
