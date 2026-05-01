# Presence Cold-Start And Full Input Surface

## Confirmed Diagnosis

The current Presence stack has a good AX read/write path once a text element is already focused, but it is not a complete computer-use surface from a cold window state.

The blocking behavior is structural:

- `read_focused`, `keystroke`, `type_text`, and `select_*` all depend on `kAXFocusedUIElementAttribute`.
- `read_at_cursor` depends on the user's hardware cursor already hovering the right element.
- `find_element` and `press_named` walk only the focused window with the same 500-node depth-first cap as `read_window`; in Notes the sidebar consumes the budget before the editor is reached.
- `press_named` intentionally rejects rows, cells, text areas, and non-button roles.
- `agent_move_to` only moves the visible avatar; it does not move or borrow the system cursor.

The result is that a frontmost Notes window with no focused element can be observed at a coarse window level but cannot be entered. The fix is not one primitive. The agent needs a layered input model: AX first for semantic reliability, HID for the same mouse/keyboard surface a user has when AX does not expose the target.

## Design

### 1. AX cold-start primitives

Add these native helper commands and MCP tools:

- `agent_focus_element`: resolve an element by role/label/index/near hints, then set `kAXFocusedAttribute = true`.
- `agent_focus_at`: hit-test with `AXUIElementCopyElementAtPosition`, then set focus.
- `agent_press_at`: hit-test at a coordinate, then perform `AXPress` if the element exposes the action.
- `agent_read_subtree`: resolve a scoped subtree and return a bounded tree from that element, with optional role/label targeting and skip/prefer role traversal policy.

The tree walker should become priority-aware instead of pure depth-first. Toolbars and preferred roles are visited before deep sidebar/table content. `AXTextArea`, `AXTextField`, and `AXWebArea` need to survive the node cap because they are common action sites. Skip-role support is useful for intentional broad reads, but the default `read_window` should also prefer action-bearing and text-bearing roles so the Notes editor appears without a focused caret.

`focus_element` should not require a label when a role or near point is specific enough. That is required for Notes because the editor may have no title and its useful content is the value.

### 2. HID input primitives

Add native helper commands and MCP tools:

- `agent_click_at(x, y, button, count)`: move, down, up. Buttons: left/right/middle. Count: 1 to 3.
- `agent_drag(from_x, from_y, to_x, to_y, duration_ms)`: move to source, down, eased intermediate moves, up.
- `agent_scroll_at(x, y, dx, dy)`: wheel event at a coordinate.
- `agent_hover_at(x, y, duration_ms)`: move without button events.
- `agent_keystroke_global(key, mods, force)`: same key synthesis as `agent_keystroke`, but with `--no-focus-check`.
- `agent_key_hold(key, duration_ms, mods, force)`: key down, dwell, key up.
- `agent_modifier_latch(mods, duration_ms, force)`: modifier-down chord lane for app shortcuts that need a held modifier while mouse/keys occur.

All coordinates are screen-space logical points, matching Electron's `screen` API and AX frames. Native helper clamps to the nearest display frame before posting the event. The action response returns the effective coordinate/frame so the avatar and halo can show the exact action site.

### 3. Input lease and abort UX

HID is the only path that visibly borrows the user's hardware cursor. The lease policy should be explicit and conservative:

- Before any HID write, Node checks the activity guard unless `force=true`.
- A HID action calls `avatar.beginDriving()` before the helper runs and `avatar.endDriving()` in `finally`.
- While driving, the avatar switches to a distinct renderer state: larger dot, stronger ring, warmer color. The visible story is "agent is borrowing the cursor lane now."
- Every successful HID action travels the avatar to the effective action frame and pulses the halo.
- User motion/keyboard activity in the recent AX event ring aborts the next action. Within a single helper subprocess we cannot observe hardware deltas without an event tap, so action slices stay short. Drag duration is capped and has intermediate points. Node checks before each slice.
- Self-echo is ignored for a bounded window after successful agent actions so an agent click does not poison the next step.

A true in-process event tap that cancels mid-drag would be stronger, but it requires a long-running privileged input daemon and likely Input Monitoring permission. This branch will still add the self-echo and pre-action guard, and the helper keeps HID subprocesses bounded so control returns quickly. If a later app-level event tap already exists, `detectUserActivity` can consume it without changing the MCP surface.

### 4. Activity guard expansion

The guard should consider:

- text/focus changes: `AXValueChanged`, `AXSelectedTextChanged`, `AXFocusedUIElementChanged`
- window/app/menu movement: `app_activated`, `AXFocusedWindowChanged`, `AXMainWindowChanged`, `AXMenuOpened`
- mouse self-echo events emitted by helper responses should bump the same self-action timestamp used for keystrokes.

The subscribe daemon should add useful notifications where apps expose them: moved/resized windows, menu opened/closed, focused window changes. Node does not treat all movement events as user activity, but exposes them for window-follow and context.

### 5. Window follow

The current avatar travels to a static frame. For focus/dwell on an AX target, a later `AXMoved`/`AXResized` event should refresh the visible site. The near-term implementation keeps the avatar and halo grounded on each action result and extends subscribe payloads with frames for move/resize events. A persistent element lease by AXUIElement identity is brittle across subprocesses, so the practical production path is frame refresh by latest matching event from the frontmost app rather than keeping stale AX handles alive in Node.

### 6. Real-time event push

The existing MCP bridge is request/response. Injecting event summaries into the model's next turn would require chat ingestion changes outside this helper/MCP lane. This memo documents the target shape: channel-mode can prepend a compact recent-event summary from `agent-events` when building the next user envelope. I will not invent a second transport in this branch.

## Rejected Tradeoffs

- Pure HID first: rejected because AX focus/selection/menu commands are more precise, do not disturb cursor position, and preserve text semantics in Notes/TextEdit/Mail.
- Pure AX only: rejected because many apps expose partial trees or non-pressable canvas/row surfaces, and Finder-style drag/drop needs mouse-down/move/up.
- Increasing `TREE_MAX_NODES` alone: rejected because it makes every observation heavier and still fails on very large or pathological trees. Priority traversal and scoped reads solve the actual ordering problem.
- Mid-action abort inside every helper command via a new event tap: rejected for this run because it changes permission posture and daemon architecture. Short bounded HID subprocesses plus pre-action guard and visible driving state are shippable without a new system permission.
- Moving the avatar only, not the system cursor: rejected because it does not close cold-start or generic-app parity.

## Error Taxonomy

New helper errors follow the existing `{"error":"code","detail":"..."}` shape:

- `bad_coordinate`: x/y or deltas are non-finite or invalid.
- `bad_button`: unsupported mouse button.
- `bad_count`: unsupported click count.
- `bad_duration`: duration outside safe bounds.
- `no_element`: AX hit-test found nothing.
- `not_focusable`: focus target refused `kAXFocusedAttribute`.
- `focus_failed`: AX focus set returned non-success.
- `unsupported_action`: target does not expose the requested AX action.
- `hid_event_create_failed`: CGEvent creation failed.
- `event_source_private_failed`: private CGEventSource unavailable.
- `display_unavailable`: no display geometry available for clamp.

## Test Plan

Unit tests:

- Node validation for focus/click/drag/scroll/hover/global-keystroke args.
- Node guard coverage for all write-like tools, including new HID tools.
- Avatar state tests for driving begin/end renderer broadcasts.
- Helper-boundary tests with fake helper scripts proving argv generation and action-site avatar/halo calls.
- Tree formatting tests for scoped subtree and prioritized read output.

Native build checks:

- `node scripts/build-native-helpers.js`
- `build/native/ax-helper check`
- manual malformed-argv probes for new subcommands, verifying structured JSON errors.

End-to-end acceptance shape:

1. `agent_check_ax`
2. `agent_recent_events`
3. `agent_read_window` or `agent_read_subtree` resolves text-bearing right pane despite sidebar volume.
4. `agent_focus_element` or `agent_focus_at` focuses it.
5. `agent_read_focused`
6. `agent_select_all`
7. `agent_menu_command(["Format","Body"])`
8. `agent_select_range(0, firstLineLength)`
9. `agent_menu_command(["Format","Title"])`
10. `agent_read_focused`

Fallback path: if AX cannot resolve the target, use `agent_click_at`, `agent_type_text` or `agent_keystroke_global`, and read back via available AX or app-visible state.

## Self-Review Log

Review pass completed after implementation.

HIGH findings folded:

- Menu commands did not return an action-site frame, so successful menu actions could not visibly ground the avatar. Fixed by returning the leaf menu item role/frame from `menu-command` and calling `showActionAt` in Node.
- Native Swift builds wrote Clang modules under `~/.cache`, which is not writable in the Codex sandbox and could break local verification. Fixed `scripts/build-native-helpers.js` to set `CLANG_MODULE_CACHE_PATH` to a writable temp cache by default.

MED findings folded:

- Existing write/select actions were missing the expanded user-activity guard. Fixed `agent_write_selection`, `agent_select_range`, `agent_select_all`, and `agent_select_substring` to use the same `force=true` semantics.
- Existing keystroke/type-text/select helper results had no frame, which prevented avatar travel on successful actions. Fixed helper responses to include focused element role/frame where available.
- Tests could accidentally spawn the real helper through the source-tree fallback. Fixed `agent-actions` helperPath override and test deps so helper-boundary tests use stubs.
- Lowercase AX-prefixed roles such as `axtextarea` would have been normalized to `AXaxtextarea` in new element-target commands. Fixed role normalization to detect the prefix case-insensitively.

LOW findings / residual risk:

- Mid-action HID abort is bounded by short subprocess duration and pre-action activity checks, not a long-running event-tap cancel path. A true hardware event tap would require an additional daemon/permission model.
- Real-time event injection into the model's next turn remains a channel-ingestion change, not an MCP helper change. The design target is documented above.
- This environment reports `{"trusted":false}` from `build/native/ax-helper check`, so real Notes/Finder acceptance must be run on a machine where Root Operator has Accessibility permission.

Verification run:

- `node scripts/build-native-helpers.js` builds `build/native/cursor-pointer-tap` and `build/native/ax-helper`.
- `npm test` passes 140/140.
- Manual helper probes:
  - `build/native/ax-helper check` -> `{"trusted":false}`
  - `build/native/ax-helper click-at 0 0 --button bogus` -> `{"error":"not_trusted"}`
  - `build/native/ax-helper scroll-at 0 0 1 nan` -> `{"error":"not_trusted"}`
  - `build/native/ax-helper read-subtree --role AXTextArea` -> `{"error":"not_trusted"}`
