# Codex Review: Presence v1.6 + v1.7 Input Pipeline

Reviewed branch: `feat/co-presence-v0`

Reviewed commits:
- `154b65a` feat(presence): dot follows AX actions (visible body at action site)
- `81dc5ad` feat(presence): motion polish - edge-landing, curved bezier path, detach kick
- `334b135` feat(presence): v1.6 keystrokes + v1.7 selection ranges + AX menu commands

## Findings

### 1. Self-action grace can hide real user input for 800ms

Severity: HIGH

File and line range:
- `src/main/agent-actions.js:360-396`
- `src/main/agent-actions.js:529`, `600`, `635`, `679`, `704`, `719`, `742`, `772`

What's wrong / risky:

`lastSelfActionAt` is set after every successful mutating action, and `detectUserActivity()` ignores any trigger event whose timestamp is inside `[lastSelfActionAt - 800ms, lastSelfActionAt + 800ms]`. That window is broad and unscoped: it does not check whether the event matches the action we just performed.

This can mask Tom's real activity immediately after an agent action. Example: the agent selects text, Tom types 300ms later, then the agent sends a keystroke at 500ms. The `AXValueChanged` or `AXSelectedTextChanged` from Tom lands inside the self-action window and is ignored as if it were an echo from the agent.

The backward half of the window can also mask real user activity that happened shortly before an unguarded action such as `select-*` or `menu-command`, because those actions bump `lastSelfActionAt` even though they did not first run the user-activity guard.

Concrete fix:

Replace the single timestamp with short, action-scoped echo records. Only ignore events that match the kind/app/role/frame/value shape expected from the action, and keep the post-action grace small.

```js
const SELF_ECHO_PRE_MS = 100;
const SELF_ECHO_POST_MS = 250;
let selfEchoWindows = [];

function recordSelfEcho(startMs, endMs, match) {
    selfEchoWindows.push({
        startMs: startMs - SELF_ECHO_PRE_MS,
        endMs: endMs + SELF_ECHO_POST_MS,
        match,
    });
    selfEchoWindows = selfEchoWindows.filter((w) => w.endMs >= Date.now() - USER_ACTIVITY_WINDOW_MS);
}

function isSelfEcho(e) {
    const tsMs = eventTimeMs(e);
    if (!Number.isFinite(tsMs)) return false;
    return selfEchoWindows.some((w) => (
        tsMs >= w.startMs &&
        tsMs <= w.endMs &&
        typeof w.match === 'function' &&
        w.match(e)
    ));
}
```

For writes/type-text, match `AXValueChanged` in the same bundle/window/role and, when available, matching value prefix or frame. For selection commands, match `AXSelectedTextChanged` in the same focused element. For press/menu commands, either match a known focus/window transition or do not suppress the event. Add a regression test where a user event 300ms after an agent action blocks the next keystroke.

### 2. Keyboard guard fails open when the event subscriber is unavailable, and there is no real focus lease

Severity: HIGH

File and line range:
- `src/main/agent-actions.js:374-379`
- `src/main/agent-actions.js:621-679`
- `src/main/native/ax-helper/main.swift:1036-1047`

What's wrong / risky:

`detectUserActivity()` returns `null` when `getAgentEvents` is missing, when `getEvents` is missing, or when the subscriber has only emitted non-trigger health/error events. The keyboard paths interpret `null` as "safe". If the AX subscriber is not running, not trusted, crashed, stale, or not yet attached, keystrokes and type-text proceed with no activity guard.

Separately, Swift's `ensureFocusedElement()` only verifies that some UI element has focus. It does not verify that focus is still on the app/window/element the agent intended. If focus moves and the subscriber misses or ignores the transition, the keystroke is sent to whatever currently has system focus.

Concrete fix:

Make the guard fail closed unless there is a healthy subscriber, and add an explicit focus lease for keyboard synthesis.

Minimum guard health change:

```js
function detectUserActivity() {
    const events = typeof deps.getAgentEvents === 'function' ? deps.getAgentEvents() : null;
    if (!events || typeof events.getEvents !== 'function') {
        return { event: 'guard_unavailable', detail: 'agent events not wired' };
    }
    if (typeof events.isHealthy === 'function' && !events.isHealthy()) {
        return { event: 'guard_unavailable', detail: 'AX subscriber not healthy' };
    }
    // existing event scan...
}
```

Focus lease change:

- Add a helper command such as `focused-context` returning frontmost pid, bundle id, focused window title/id where available, focused role, and frame.
- Record a short-lived lease after `agent_read_focused`, `agent_read_at_cursor` after focus restoration, `agent_write_selection`, and `agent_select_*`.
- Require an unexpired lease for `agent_keystroke` and `agent_type_text`, unless `force=true`.
- Pass expected pid/bundle/window/role/frame to Swift and validate immediately before posting the CGEvent.

Swift-side shape:

```swift
func ensureFocusedElement(expected: FocusExpectation?) -> AXUIElement {
    let focused = resolveFocusedElementOrEmit()
    if let expected = expected {
        guard currentFocusedContextMatches(focused, expected) else {
            emitError("focus_lease_lost", "focused target changed before keystroke")
        }
    }
    return focused
}
```

### 3. Activity trigger set misses app/window/menu changes that move the keyboard target

Severity: HIGH

File and line range:
- `src/main/agent-actions.js:382-386`
- `src/main/native/ax-helper/main.swift:801-808`

What's wrong / risky:

The subscriber already emits `app_activated`, `AXFocusedWindowChanged`, `AXMainWindowChanged`, and `AXWindowCreated`, but `detectUserActivity()` only treats `AXValueChanged`, `AXFocusedUIElementChanged`, and `AXSelectedTextChanged` as blockers.

A user can switch apps, click another window, create a dialog, or change the main/focused window inside the 1.2s guard window and the next keystroke can still proceed. Those events are exactly the class of changes that make "whatever currently has focus" unsafe.

Menu activity is also missing. The local SDK exposes `kAXMenuOpenedNotification`, `kAXMenuClosedNotification`, and `kAXMenuItemSelectedNotification`; none are subscribed or considered. A user-opened menu should block keyboard synthesis.

Concrete fix:

Expand the trigger set and subscribe to menu notifications:

```swift
let SUBSCRIBE_NOTIFICATIONS: [String] = [
    kAXFocusedWindowChangedNotification as String,
    kAXFocusedUIElementChangedNotification as String,
    kAXSelectedTextChangedNotification as String,
    kAXValueChangedNotification as String,
    kAXWindowCreatedNotification as String,
    kAXMainWindowChangedNotification as String,
    kAXMenuOpenedNotification as String,
    kAXMenuClosedNotification as String,
    kAXMenuItemSelectedNotification as String,
]
```

```js
const triggers = new Set([
    'AXValueChanged',
    'AXFocusedUIElementChanged',
    'AXSelectedTextChanged',
    'AXFocusedWindowChanged',
    'AXMainWindowChanged',
    'AXWindowCreated',
    'app_activated',
    'AXMenuOpened',
    'AXMenuItemSelected',
]);
```

Treat app/window/menu events as user activity by default. Only classify them as self-caused when there is a specific recorded self-echo window that expected that exact transition.

### 4. `.privateState` isolation is good, but the fallback weakens it

Severity: MED

File and line range:
- `src/main/native/ax-helper/main.swift:1050-1056`

What's wrong / risky:

Using `CGEventSource(stateID: .privateState)` is the right choice for this trust boundary. Apple's docs describe the private state as an independent event state table. That is what you want so posted events do not inherit stale hardware modifier state.

The issue is the fallback to `.hidSystemState`. Apple's docs describe HID system state as reflecting hardware event sources. If private source creation fails, the safer behavior is to fail the action, not silently switch to a source that can reintroduce the hardware-state coupling this code is trying to avoid.

Concrete fix:

Remove the fallback:

```swift
func makeEventSource() -> CGEventSource? {
    return CGEventSource(stateID: .privateState)
}
```

If this ever fails in production, return `event_source_private_failed` and keep the keyboard action blocked.

### 5. `agent_menu_command` bypasses the user-activity guard

Severity: MED

File and line range:
- `src/main/agent-actions.js:755-772`

What's wrong / risky:

`agent_menu_command` invokes a command in the current frontmost app without checking recent user activity. This is not CGEvent keyboard synthesis, but it can still trigger destructive or state-changing actions in whichever app is frontmost at execution time. If Tom switches apps or opens a menu right before the call, the command walks the new app's menu bar.

Concrete fix:

Give `agent_menu_command` the same guard behavior and `force` escape hatch as keyboard tools:

```js
const force = args.force === true;
if (!force) {
    const offending = detectUserActivity();
    if (offending) {
        return {
            result: formatActivityRefusal(offending, 'menu command'),
            isError: true,
        };
    }
}
```

Update the tool schema with `force` and make the error text say override requires explicit Tom confirmation.

### 6. Menu walk is too optimistic for real macOS AX menu trees

Severity: MED

File and line range:
- `src/main/native/ax-helper/main.swift:1283-1322`

What's wrong / risky:

The current walk assumes that after opening a non-leaf item, the next path segment is a direct child of that same element. In common AX menu trees, a top-level `AXMenuBarItem` has an `AXMenu` child, and the actual `AXMenuItem` children are under that container. The current code can fail at depth 1 for otherwise valid paths.

It also reads children immediately after `AXPress` with no retry/poll, which can race menu population. Finally, prefix matching picks the first prefix match, so a segment like `"Save"` can accidentally match the wrong item if both `"Save"` and `"Save As..."` or localized variants are present in an unexpected order.

Concrete fix:

- Prefer exact normalized title matches.
- Allow prefix matching only when it produces exactly one candidate.
- For non-leaf nodes, use `kAXShowMenuAction` when supported, fall back to `kAXPressAction`, then poll briefly for children.
- Descend through an intermediate `AXMenu` container before matching the next segment.

Sketch:

```swift
func actionNames(_ element: AXUIElement) -> Set<String> {
    var raw: CFArray?
    guard AXUIElementCopyActionNames(element, &raw) == .success,
          let names = raw as? [String] else { return [] }
    return Set(names)
}

func openMenuNode(_ element: AXUIElement) -> AXError {
    let names = actionNames(element)
    if names.contains(kAXShowMenuAction as String) {
        return AXUIElementPerformAction(element, kAXShowMenuAction as CFString)
    }
    return AXUIElementPerformAction(element, kAXPressAction as CFString)
}

func visibleMenuChildren(of element: AXUIElement) -> [AXUIElement] {
    let kids = children(of: element)
    if kids.count == 1, roleString(kids[0]) == "AXMenu" {
        return children(of: kids[0])
    }
    return kids
}
```

Add an integration check against at least TextEdit/Notes for paths with top-level menus and nested submenus.

### 7. `type-text` cap is high for the first keyboard-synthesis path

Severity: MED

File and line range:
- `src/main/agent-actions.js:653-678`
- `src/main/native/ax-helper/main.swift:1117-1138`

What's wrong / risky:

`agent_type_text` permits 8000 UTF-16 code units from JS. The Swift helper's direct cap uses `t.count`, which is grapheme-count based and can represent many more UTF-16 units for emoji or composed text. The helper then posts the entire text as one Unicode keyboard event.

For `agent_write_selection`, 8000 characters is an existing AX-value blast radius. For `type-text`, this is now a real keyboard event path and should be more conservative. Long single-event Unicode payloads also do not behave like natural typing in all apps; app key handlers and autocomplete behavior can differ from per-character key events.

Concrete fix:

- Lower `MAX_TYPE_TEXT_LENGTH` to a smaller default such as 1000-2000 UTF-16 code units.
- In Swift, cap `utf16.count`, not `t.count`.
- Require `force=true` or an explicit `long_text=true` for larger payloads.
- For natural typing semantics, chunk by grapheme or by small UTF-16 chunks and re-run the user-activity guard between chunks.

```swift
let utf16 = Array(t.utf16)
if utf16.count > 2000 {
    emitError("text_too_long", "max 2000 UTF-16 code units; got \(utf16.count)")
}
```

### 8. Edge landing can choose the wrong display for spanning frames

Severity: MED

File and line range:
- `src/main/agent-actions.js:317-338`

What's wrong / risky:

`computeFrameLanding()` chooses a display from the frame center, checks only whether the right candidate fits inside that display's work area, then falls back to the left candidate without validating that the left candidate is inside any display work area.

On side-by-side or negative-coordinate multi-display setups, especially when an AX frame spans displays, the center display is not always the display containing the desired landing point. The fallback can land on the wrong display edge or outside the work area vertically.

Concrete fix:

Validate right and left candidates independently against the display nearest each candidate. Clamp `y` to the candidate display's work area.

```js
function candidateInsideWorkArea(point, screen) {
    const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
    const wa = display && display.workArea;
    if (!wa) return { ok: true, point };
    const clamped = {
        x: Math.min(Math.max(point.x, wa.x), wa.x + wa.width),
        y: Math.min(Math.max(point.y, wa.y), wa.y + wa.height),
    };
    return {
        ok: point.x >= wa.x && point.x <= wa.x + wa.width &&
            point.y >= wa.y && point.y <= wa.y + wa.height,
        point: clamped,
    };
}
```

Prefer a contained right candidate, then contained left, then the least-clamped fallback.

### 9. Override error text is understandable but too casual for a trust-boundary override

Severity: LOW

File and line range:
- `src/main/agent-actions.js:625`
- `src/main/agent-actions.js:672`
- `channel-bridge.cjs:289`, `301`

What's wrong / risky:

The error says "Pass force=true to override." That is clear for developers, but this path is specifically a user-consent boundary. The runtime error should remind the agent that force is only appropriate after Tom explicitly confirms. The `agent_type_text` refusal also omits the app name even when available.

Concrete fix:

Use one shared formatter:

```js
function formatActivityRefusal(e, action) {
    const where = [e.app, e.role, e.label].filter(Boolean).join(' / ');
    return `Refused ${action}: recent Tom activity detected (${e.event}${where ? ` in ${where}` : ''}). Retry with force=true only after Tom explicitly confirms.`;
}
```

### 10. Tests cover the happy policy path but miss the dangerous edges

Severity: LOW

File and line range:
- `src/agent-actions.test.js:461-482`
- `src/agent-avatar.test.js:331-374`

What's wrong / risky:

The current tests prove one recent `AXValueChanged` blocks a keystroke. They do not cover the safety edges introduced by this branch.

Concrete fix:

Add focused tests for:

- Guard unavailable blocks keyboard actions unless `force=true`.
- Recent `app_activated`, `AXFocusedWindowChanged`, `AXMainWindowChanged`, `AXWindowCreated`, and `AXMenuOpened` block keyboard actions.
- Real user activity inside the current 800ms self-action window blocks after the self-window fix.
- `force=true` bypasses only after the handler has produced the explicit consent wording.
- `agent_menu_command` uses the same guard.
- Prefix-ambiguous menu matches return `ambiguous_menu_segment`.
- `agent_select_substring` handles emoji/surrogate-pair needles.
- Multi-display `computeFrameLanding()` validates candidate display work areas.

## Non-Findings / Notes

- Swift modifier flag combination is correct: `CGEventFlags` is an `OptionSet`, and `insert(.maskCommand)`, `insert(.maskShift)`, `insert(.maskAlternate)`, `insert(.maskControl)`, and `insert(.maskSecondaryFn)` combine as expected.
- Setting the same flags on key down and key up is normal for synthetic shortcut events. No stuck-modifier risk showed up in this code because it does not synthesize separate modifier-down events.
- The 12ms key down/up delay is reasonable for shortcut chords. If Slack/Mail-specific testing shows missed shortcuts, make it configurable at 15-25ms; I would not block merge on this alone.
- The `withUnsafeBufferPointer` use in `cmdTypeText` is not a memory-safety issue as written. The buffer is valid during `keyboardSetUnicodeString`, and the event owns its associated Unicode payload before `post`.
- `agent_select_substring` is UTF-16-code-unit correct. Using `NSString.range(of:)` and `(needle as NSString).length` gives the same units expected by `kAXSelectedTextRangeAttribute`; emoji/surrogate-pair needles select as length 2 or more UTF-16 units, not split bytes. The tool copy should say "UTF-16 code units" rather than just "characters" for `agent_select_range`.
- Bezier control magnitudes look acceptable. For a 700px travel, the perpendicular control offset is 84px before Bezier weighting, capped at 90px for longer travels. That should read as visible but not excessive. No merge blocker there.

## Ship-It Summary

Fix before merging to `master`:

- Fail closed when the AX event subscriber/guard is unavailable.
- Add an actual focus lease, or at minimum validate focused app/window/role immediately before posting CGEvents.
- Replace the unscoped 800ms self-action timestamp with scoped self-echo records.
- Add app/window/menu events to the activity triggers and subscribe to menu notifications.
- Remove the `.hidSystemState` fallback from keyboard event source creation.
- Put `agent_menu_command` behind the same user-activity guard.
- Fix the basic menu traversal hazards if `agent_menu_command` is enabled in master: exact-or-unique matching, intermediate `AXMenu` container descent, and a short child-population retry.
- Make `type-text` conservative for the first CGEvent release: cap by UTF-16 units in Swift and either lower the default cap or require explicit override for long payloads.

Can wait for v1.7 polish:

- Full menu-command integration coverage across Slack/Mail/Notes/TextEdit and localized menu titles.
- Chunked natural-typing semantics for `type-text` after a little real-app testing.
- Multi-display edge landing candidate validation.
- Error-message tone and expanded tests beyond the safety regressions above.

## Verification

- `node --test src/agent-actions.test.js src/agent-avatar.test.js src/agent-events.test.js` passed: 70/70.
- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swiftc -module-cache-path /tmp/codex-swift-module-cache -typecheck src/main/native/ax-helper/main.swift` passed. Running `swiftc` without the explicit Xcode developer dir first failed because the default SDK/toolchain cache path was outside the sandbox and the selected SDK/toolchain pair was inconsistent.

## References Checked

- Apple Developer Documentation: [CGEventSourceStateID](https://developer.apple.com/documentation/coregraphics/cgeventsourcestateid?language=objc)
- Apple Developer Documentation: [CGEventSource](https://developer.apple.com/documentation/coregraphics/cgeventsource)
- Apple Developer Documentation: [CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent)
- Apple Developer Documentation: [AXUIElementPerformAction](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction)
- Apple Developer Documentation: [AXActionConstants.h miscellaneous defines](https://developer.apple.com/documentation/applicationservices/axactionconstants_h/miscellaneous_defines)
- Local SDK headers confirmed `kAXShowMenuAction`, `kAXMenuOpenedNotification`, `kAXMenuClosedNotification`, and `kAXMenuItemSelectedNotification` in `ApplicationServices.framework/.../HIServices.framework/.../Headers`.
