# Presence Input Primitives Brainstorm

**Status:** design brainstorm for Presence input v1.6-v2.0  
**Branch context:** `feat/co-presence-v0`  
**Date:** 2026-05-01  
**Audience:** Root Operator engineering and product

## Executive Position

Presence should not promise "a second hardware cursor." macOS does not expose one. Presence should promise something stronger and more product-defensible: an agent body that is visibly present in the desktop, reasons over the same UI the user sees, and acts through the most decoupled channel available for the task.

The design center is therefore:

1. Prefer Accessibility actions and attributes. They are semantic, targetable, and do not move the user's hardware cursor.
2. Use keyboard CGEvents only behind a focus lease. They do not move the cursor, but they do type into the focused app.
3. Treat mouse CGEvents as cursor borrowing. A posted mouse event is a Quartz event with a cursor position, not a private agent pointer; Presence should require explicit user consent before using it.
4. Make every action visible. If the agent presses, writes, selects, types, or scrolls, the blue dot should travel to the target first, halo the target, act, dwell, and only then return or continue to the next target.

Apple's APIs line up with this split. `AXUIElementPerformAction` requests actions on accessibility objects and returns structured AX errors when unsupported ([Apple: AXUIElementPerformAction](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction)). `AXUIElementSetAttributeValue` sets AX attributes such as value, focus, position, size, or selected range where the target supports them ([Apple: AXUIElementSetAttributeValue](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue)). Quartz `CGEvent` represents low-level hardware-like events delivered through the window server ([Apple: CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent)), and `CGEventPost` posts those events into the event stream ([Apple: CGEventPost](https://developer.apple.com/documentation/coregraphics/cgevent/post%28tap%3A%29)). That is useful, but it is not invisible.

## 1. Capability Inventory

### Mouse

| Human action | Current Presence gap | macOS technical path | HID-decoupling concern |
|---|---|---|---|
| Click at coordinates | `agent_press_named` can press known AX elements; no arbitrary coordinate click. | First try `AXUIElementCopyElementAtPosition` to hit-test, then `AXPress` if the returned element supports it. `kAXPressAction` simulates a single click on a button-like element ([Apple: AX actions](https://developer.apple.com/documentation/applicationservices/carbon_accessibility/actions)). Fallback is `CGEventCreateMouseEvent` down/up at point. | AX path is fully decoupled. CG mouse path should be classified as cursor borrow because the event has a `mouseCursorPosition` in global coordinates ([Apple: CGEventCreateMouseEvent](https://developer.apple.com/documentation/coregraphics/cgevent/init%28mouseeventsource%3Amousetype%3Amousecursorposition%3Amousebutton%3A%29)). |
| Right-click / context menu | No primitive. | Prefer `kAXShowMenuAction` when listed by `AXUIElementCopyActionNames`; then navigate menu items by AX and press. Fallback is right mouse down/up CGEvents. | AX menu action is decoupled. CG right-click borrows cursor and must be consent-gated. |
| Double-click | No primitive. | Prefer semantic open/confirm path: select target via AX, then `AXConfirm` or app-exposed action if available. Otherwise two `AXPress` calls only when the element's behavior is known to be idempotent/opening. Fallback is double-click CGEvents. | Semantic path decoupled. CG double-click borrows cursor and has high blast radius in file managers and editors. |
| Drag from A to B, optionally with modifier | No primitive. | There is no general AX drag. Some lists expose selection/reordering attributes, but this is app-specific. General solution is mouse down, dragged events, mouse up via CGEvent, optionally with flags. | This is HID territory. It moves/borrows the system cursor and can disrupt the user. Require explicit consent plus visible borrow UI. |
| Scroll at point, vertical/horizontal by amount | No primitive. | Prefer AX scroll bars, `AXIncrement`/`AXDecrement`, table row navigation, or setting scroll bar value if exposed. Fallback is `CGEventCreateScrollWheelEvent`; wheel1 is vertical, wheel2 horizontal, and large values can behave unexpectedly ([Apple: CGEventCreateScrollWheelEvent](https://developer.apple.com/documentation/coregraphics/cgeventcreatescrollwheelevent)). | AX scroll is decoupled but spotty. CG scroll does not need to move the cursor in the same way a mouse click does, but routing is still focus/hover dependent by app; treat point-targeted scroll as consent or active-window only. |
| Hover-dwell | Blue dot can move; no hover action semantics. | Visual-only hover is overlay motion. True app hover requires `kCGEventMouseMoved` at point. | Visual hover is safe. App hover borrows cursor and can open tooltips/menus under the user's cursor model; require consent unless merely moving the dot. |
| Mouse-down / mouse-up separately | No primitive. | CG mouse event down/up only. AX has press, not generic down/up. | Always cursor borrow. This should be exposed only as a low-level, consent-token primitive for drag/canvas apps. |

### Keyboard

| Human action | Current Presence gap | macOS technical path | HID-decoupling concern |
|---|---|---|---|
| Single keystroke: Esc, Tab, Return, arrows, Delete, F-keys | No primitive. `AXConfirm` and `AXCancel` cover only some Return/Esc cases. | Use `CGEventCreateKeyboardEvent` for virtual key down/up. Apple notes character generation requires all relevant modifier key transitions ([Apple: CGEventCreateKeyboardEvent](https://developer.apple.com/documentation/coregraphics/cgevent/init%28keyboardeventsource%3Avirtualkey%3Akeydown%3A%29)). Prefer `AXConfirm`/`AXCancel` where semantically exact. | Does not move cursor, but sends input to the focused target. Must require a pre-action focus check and abort if user activity is detected. |
| Modifier combos: Cmd+S, Cmd+Shift+J, Cmd+Opt+arrow | No primitive. | Keyboard CGEvents with flags or explicit modifier down/up sequence. Use private event source state to avoid merging stale modifier state where possible; Apple documents private `CGEventSourceStateID` for independent source state tables ([Apple: CGEventSourceStateID](https://developer.apple.com/documentation/coregraphics/cgeventsourcestateid)). | Same focus risk. Also can trigger global app commands. Require explicit target app/window lease and short sequence caps. |
| Type text as keystrokes | Current `agent_write_selection` writes AX value/selection; it does not exercise IME, autocomplete, markdown shortcuts, paragraph styling, or app key handlers. | Use keyboard events per key for physical typing, or `keyboardSetUnicodeString` on CG keyboard events for Unicode text where physical layout is not desired ([Apple: CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent)). | High interference risk. Only allow into a verified focused text element, with user-idle guard, max length, and abort-on-user-keydown. |
| Hold modifier while doing X | No primitive. | Keyboard modifier down, perform AX or CG mouse action, modifier up. For AX actions, holding a modifier may not affect the semantic action unless the app checks current modifier state. | Holding modifier changes global session state during the lease. Keep the lease tiny, always release in finally/cleanup, and refuse if user keyboard activity starts. |

### Selection and Caret

| Human action | Current Presence gap | macOS technical path | HID-decoupling concern |
|---|---|---|---|
| Set caret position in text element | No primitive. | Set `kAXSelectedTextRangeAttribute` to a zero-length `CFRange`. Apple defines this as the current selected range in editable text and says it is required for editable text elements ([Apple: kAXSelectedTextRangeAttribute](https://developer.apple.com/documentation/applicationservices/kaxselectedtextrangeattribute)). | Fully decoupled when supported. |
| Set selection range | No primitive. Current write can replace an existing selection, but cannot create one. | Set `AXSelectedTextRange`; use `AXNumberOfCharacters` to validate bounds. | Fully decoupled when supported. Some web/Electron editors may not implement it. |
| Select all programmatically | No primitive except whole-value replace with explicit flag. | Read character count, set selected range to `{0, count}`. This is not Cmd+A and should not touch keyboard focus beyond AX focus. | Decoupled. |
| Move by word/line, extend selection | No primitive. | Preferred: range math via AX parameterized attributes such as `rangeForLine`, `rangeForPosition`, `stringForRange`, and `boundsForRange` ([Apple: NSAccessibility.ParameterizedAttribute](https://developer.apple.com/documentation/AppKit/NSAccessibility-swift.struct/ParameterizedAttribute)). Fallback: guarded keyboard combos like Option+Arrow or Shift+Command+Arrow. | AX path decoupled. Keyboard fallback can interfere with typing and must be guarded. |

### Clipboard

| Human action | Current Presence gap | macOS technical path | HID-decoupling concern |
|---|---|---|---|
| Read clipboard contents | No primitive. | `NSPasteboard.general` plus `readObjects(forClasses:options:)`, `string(forType:)`, `data(forType:)`. Apple describes pasteboard as a shared server used for cut/copy and inter-app transfer ([Apple: NSPasteboard](https://developer.apple.com/documentation/AppKit/NSPasteboard)). | Does not touch cursor/keyboard, but reads user-sensitive shared state. Needs user-visible audit and type filtering. |
| Write clipboard: text, image, file | No primitive. | `clearContents`, `writeObjects`, `setString`, `setData`, file URL items. `writeObjects` writes objects conforming to `NSPasteboardWriting` ([Apple: NSPasteboard writeObjects](https://developer.apple.com/documentation/appkit/nspasteboard/writeobjects%28_%3A%29)). | Mutates global user clipboard. Use explicit tool call, optional restore, and race detection via change count. |
| Programmatic Cmd+C/V/X equivalents | No primitive. | Best copy: AX read selected text/rich text where available. Best paste: AX selected text replace or value insert. True app copy/paste/cut uses Cmd+C/V/X CGEvents against focused app, optionally with temporary pasteboard write. | True equivalents require keyboard events and shared clipboard. Use focus lease, save/restore clipboard, and abort if clipboard changes mid-action. |

### Window and App

| Human action | Current Presence gap | macOS technical path | HID-decoupling concern |
|---|---|---|---|
| Activate app by bundle ID | No primitive. | `NSRunningApplication.runningApplications(withBundleIdentifier:)`, then `activate(options:)`; launch via `NSWorkspace` if not running. Apple documents `NSRunningApplication.activate` as an activation attempt that can fail ([Apple: NSRunningApplication activate](https://developer.apple.com/documentation/appkit/nsrunningapplication/activate%28options%3A%29)). | Does not synthesize HID, but steals foreground focus. Treat as workspace-affecting action. |
| Focus specific window | Partial via focused window reads, no setter primitive. | AX app element `kAXWindowsAttribute`, identify window, `kAXRaiseAction`, set app `AXFocusedWindow` or window `AXMain`/`AXFocused` where supported. `kAXFocusedWindowAttribute` and `kAXWindowsAttribute` are documented app-level attributes ([Apple: focused window](https://developer.apple.com/documentation/applicationservices/kaxfocusedwindowattribute), [Apple: windows](https://developer.apple.com/documentation/applicationservices/kaxwindowsattribute)). | Focus changes the user's active work surface. Must be deliberate and visible. |
| List windows of frontmost app | Current `agent_read_window` reads one focused tree. | AX `AXWindows`, plus `CGWindowListCopyWindowInfo` for z-order, bounds, owner PID, and window ID. Apple notes the window list can return bounds and window server management details ([Apple: CGWindowListCopyWindowInfo](https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo%28_%3A_%3A%29)). | Read-only, safe. |
| Switch next/prev app | No primitive. | Prefer direct activation from an app list. Cmd+Tab equivalent requires keyboard CGEvents and is global. | Direct activation is controlled but changes focus. Cmd+Tab is global HID and should be avoided unless requested. |
| Resize / move window | No primitive. | Set window `kAXPositionAttribute` and `kAXSizeAttribute`; Apple defines position as top-left global screen coordinates and size as visible dimensions ([Apple: kAXPositionAttribute](https://developer.apple.com/documentation/applicationservices/kaxpositionattribute), [Apple: kAXSizeAttribute](https://developer.apple.com/documentation/applicationservices/kaxsizeattribute)). | AX path decoupled from cursor. Still changes workspace layout. |
| Minimize / maximize / close | No primitive. | Press `AXMinimizeButton`, `AXZoomButton`, `AXCloseButton`, or set `AXMinimized`. | Decoupled. Closing is destructive and needs confirmation in unsaved contexts. |

### Visual Fallback

| Human action | Current Presence gap | macOS technical path | HID-decoupling concern |
|---|---|---|---|
| Region screenshot | No primitive. | Use ScreenCaptureKit for current macOS. Apple describes it as high-performance capture with fine-grained selection of displays, apps, and windows ([Apple: ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)). `CGWindowListCreateImage` exists but is deprecated and Apple says to use ScreenCaptureKit instead ([Apple: CGWindowListCreateImage](https://developer.apple.com/documentation/coregraphics/cgwindowlistcreateimage%28_%3A_%3A_%3A_%3A%29)). | No cursor/keyboard effect, but privacy-sensitive; requires Screen Recording permission. |
| Element screenshot | No primitive. | Resolve AX frame, capture that region, optionally include padding. | Decoupled. Beware overlay self-capture; exclude Presence window. |
| Color-pick at point | No primitive. | Capture 1x1 or small region and sample pixel; normalize display scale and color space. | Decoupled, but should not be used as a covert screen reader. |

### Higher-Order Patterns

**Apply paragraph style in Notes or Mail.** The reliable plan is not "type Cmd+A and hope." It is: focus the editor via AX, set full text selection using `AXSelectedTextRange`, invoke the app's style command through AX menu traversal or a guarded shortcut, set selection to line 1 using `rangeForLine`, then invoke Title. If the style menu is AX-visible, use AXPress on the menu items. If not, use keystroke combos under a focus lease. This is the v1.6 proof point: dot travels to the note body, selection halo sustains, style commands flash at the menu/toolbar target, and the user cursor never moves.

**Drag-to-reorder a list item.** Try AX first: selectable rows, reorder actions, or app-specific menu commands. Most apps will not expose generic drag semantics. General reorder requires mouse down/drag/up and therefore consented cursor borrow.

**Open a context menu, navigate, click item.** Prefer `AXShowMenu`, then read the shown menu AX tree and press a named item. If the menu cannot be shown semantically, ask to borrow the cursor for right-click. Do not silently CG right-click.

**Fill a multi-field form across tabs.** Use AX focus and value/selection write for each field. Use programmatic Tab only when the next field is not addressable by AX, and guard it with focus checks. Across browser tabs, prefer direct tab AX selection or app menu commands over Cmd+Tab-like global input.

## 2. Decoupling Architecture

Presence needs an action router, not just more tools. Every primitive should declare its channel:

**AX channel, preferred.** Actions include `AXPress`, `AXShowMenu`, `AXConfirm`, `AXCancel`, selected range mutation, value writes, focus assignment, and window frame changes. This is the only channel that fully preserves Tom's constraint: no hardware cursor movement and no synthetic keyboard input.

**Keyboard CGEvent channel, guarded.** Keyboard events do not move the mouse cursor, but they are still global session input aimed at whatever is focused. The mitigation is a pre-action focus lease:

- Snapshot frontmost app, focused window, focused UI element, and recent user input timestamp.
- Resolve target element and set `AXFocused` where appropriate; Apple documents that `AXFocused` can be set to accept keyboard focus for focusable elements ([Apple: kAXFocusedAttribute](https://developer.apple.com/documentation/applicationservices/kaxfocusedattribute)).
- Verify the frontmost app/window/element still matches.
- Post a bounded key sequence.
- Abort if passive event monitoring sees user keyboard or mouse activity during the lease.
- Verify expected postcondition when possible.

This means `agent_keystroke` is not a general "type anywhere" hammer. It is a scoped operation against a verified target.

**Mouse CGEvent channel, consented.** `CGEventCreateMouseEvent` creates mouse events at a global cursor position, and `CGWarpMouseCursorPosition` explicitly moves the mouse cursor without generating events ([Apple: CGWarpMouseCursorPosition](https://developer.apple.com/documentation/coregraphics/cgwarpmousecursorposition%28_%3A%29)). There is no public macOS API that gives an app a second independent native pointer for arbitrary AppKit hit-testing. Presence should model coordinate click, hover, down/up, and drag as "borrow cursor" operations. The default response without a consent token should be `requires_consent`, not best-effort synthesis.

**Clipboard channel, shared-state guarded.** Clipboard does not fire hardware input, but it mutates a global user resource. Save/restore is helpful but not perfect: if Tom copies something during the action, restoring the old clipboard would erase his new clipboard. Use change-count race detection and fail with `clipboard_changed` rather than guessing.

**Consent UX for HID synthesis.** The agent should explain the exact need in one line: "This app does not expose a reorder action. I need to borrow the cursor for a 600 ms drag from A to B." The blue dot travels to the start point, grows a borrow halo, and the UI offers Allow once / Always for this app and action class / Cancel. During borrow, user input cancels immediately; after borrow, the cursor returns to the original point if feasible, but the product copy should not pretend no borrow happened.

## 3. Visible-Presence Wiring

The current break in the promise is that `agent_press_named` and `agent_write_selection` act silently. The fix belongs above individual tools:

**`withVisibleAction(targetFrame, action)` at the avatar layer.** Every action-producing tool must return or resolve a target frame before firing. The wrapper moves the blue dot to the frame center or an edge-safe anchor, applies an action-specific halo, executes the action, observes the result, dwells briefly, then either continues to the next queued action or parks.

Frame sources:

- AX target frame from `AXPosition` + `AXSize`.
- Text selection frame from `boundsForRange` when available.
- Window/app frame from AX or CGWindowList.
- Screenshot/color-pick frame from explicit region.
- HID fallback point from requested coordinates.

Consecutive actions should be grouped into an action transaction. The dot should not park between "select all", "set Body", "select line 1", "set Title." It should travel from text body to menu/toolbar and back, with a dwell timer that resets after each action. Parking happens only after the transaction completes or after an inactivity timeout.

Halo timing should communicate action type:

- Read: quick 120-180 ms pulse, low opacity.
- Press: 160-220 ms flash at the target.
- Write/selection: 350-600 ms sustained halo, because text changed.
- Keystroke: 250-350 ms focus ring around the target text element or command surface.
- Drag: continuous path trace while borrowed.
- Screenshot/color-pick: camera-like bracket around the region, no click implication.

When the action target is adjacent to Tom's cursor, the dot should yield spatial priority. Use a smaller halo, offset the label away from the hardware cursor, and suppress hover decoration that could look like the user is clicking. If Tom moves his cursor onto the same target during the pre-action dwell, cancel or pause the agent action. User sovereignty beats animation continuity.

## 4. Proposed MCP Tool Surface

Keep the tool surface intentful but composable. Tools should default to visible action wiring and accept `visible: false` only for internal tests.

| Tool | Signature sketch | Notes |
|---|---|---|
| `agent_press` | `{ target, action?: "press"|"show_menu"|"confirm"|"cancel"|"increment"|"decrement", visible?: true }` | Supersedes `agent_press_named` while keeping it as an alias. Tight role/action allowlist. |
| `agent_keystroke` | `{ target?, sequence: [{ key, modifiers?, repeat? }], require_focus?: true }` | Accept sequences, not one key. Max events, focus lease required by default. |
| `agent_type_text` | `{ target, text, mode?: "physical"|"unicode", interval_ms?: number }` | Keystroke typing, not AX value write. Separate from `agent_write_selection`. |
| `agent_select_text` | `{ target, range: "all"|{start,length}|{line}|{point}, extend?: false }` | Programmatic selection via AX range. |
| `agent_set_caret` | `{ target, position: {index}|{line,column}|{point} }` | Zero-length selected range. |
| `agent_clipboard_read` | `{ types?: ["text","rtf","image","file_url"], max_bytes? }` | Read-only, audited. |
| `agent_clipboard_write` | `{ items, restore_after?: false }` | Text/image/file URL support; bounded size. |
| `agent_clipboard_apply` | `{ operation: "copy"|"cut"|"paste", target?, restore_clipboard?: true }` | Uses AX when possible, CG shortcut only under focus lease. |
| `agent_mouse` | `{ kind, point?, from?, to?, button?, modifiers?, amount?, consent_token? }` | Low-level coordinate fallback. Returns `requires_consent` by default. |
| `agent_window` | `{ operation, bundle_id?, window_id?, frame?, target? }` | list, activate, focus, move, resize, minimize, zoom, close. |
| `agent_screenshot` | `{ target?|region, include_cursor?: false }` | ScreenCaptureKit path; excludes Presence overlay by default. |
| `agent_color_pick` | `{ point, radius?: 1 }` | Small capture only. |
| `agent_menu_command` | `{ app?, path: string[], target_window? }` | AX menu traversal for formatting and app commands. |

Recommended target grammar:

- `{ kind: "focused" }`
- `{ kind: "cursor" }`
- `{ kind: "element", label, role?, index? }`
- `{ kind: "element_id", id }` from `agent_read_window` or `agent_find_element`
- `{ kind: "point", x, y }`
- `{ kind: "window", bundle_id?, title?, window_id? }`

Common error modes:

`ax_not_trusted`, `post_event_not_authorized`, `target_not_found`, `ambiguous_target`, `unsupported_role`, `unsupported_action`, `unsafe_focus`, `user_activity_detected`, `requires_consent`, `consent_denied`, `hid_cursor_borrow_required`, `clipboard_changed`, `screen_recording_not_authorized`, `action_timeout`, `rate_limited`, `postcondition_failed`.

Guardrails:

- AX write remains role-allowlisted and length-capped.
- Keystroke sequences cap event count and total duration.
- Mouse tools require consent token except scroll in active/focused target where AX scroll failed and user explicitly requested scrolling.
- Clipboard write/apply records old types/change count and fails on races.
- Window close requires either user instruction specificity or app-reported non-dirty state.

## 5. Phased Rollout

### v1.6 - Keystroke Synthesis and Dot-Follows-Action

Ship the visible action wrapper for existing read, press, find, and write flows. Add `agent_keystroke`, `agent_type_text`, and `agent_menu_command` behind focus leases. This closes the Notes/Mail formatting loop: the agent can select text semantically where possible, invoke menu/shortcut formatting where necessary, and make every target visible.

Risk: synthetic keys can interfere with Tom typing if focus is wrong or if he starts typing mid-action. The passive recent-events daemon becomes a safety dependency, not a nice-to-have.

### v1.7 - Selection Range and Clipboard

Add `agent_select_text`, `agent_set_caret`, select-all by AX range, and clipboard read/write/apply. This unlocks reliable text editing without using Cmd+A, plus paste workflows for apps that accept rich clipboard input better than AX value writes.

Risk: editor AX implementations vary. Clipboard restore has race conditions; fail closed when change counts move unexpectedly.

### v1.8 - Coordinate Mouse, Scroll, Hover

Introduce `agent_mouse` for click, right-click, double-click, scroll, and hover, but ship it with consent UX and `requires_consent` defaults. Keep AX hit-test-to-press as the preferred implementation for point clicks. Add point-target scroll only after AX scroll routes fail.

Risk: this is where the product can break trust. Messaging must be explicit: the agent is borrowing the cursor, not secretly operating a second HID pointer.

### v1.9 - Drag and Multi-Key Sequences

Add drag from A to B, drag with modifiers, low-level down/up, and richer key choreography such as hold modifier while pressing or dragging. This unlocks canvas tools, list reordering, timeline scrubbing, and spatial manipulation in AX-poor apps.

Risk: drag is the highest-risk primitive. It should be app-scoped, time-bounded, cancelable by any user input, and heavily logged.

### v2.0 - Window/App Management and Visual Fallback

Add app activation, window focus/list/move/resize/minimize/zoom/close, region screenshot, element screenshot, and color-pick. This rounds Presence out from "input helper" into "desktop co-presence layer."

Risk: focus/window changes disrupt the user's workspace even without HID. Screenshot fallback raises privacy and data-retention questions. Keep captures scoped, transient, and visible.

## 6. Open Questions

- How strict should the user-idle threshold be before keyboard CGEvents? 150 ms feels responsive; 500 ms is safer.
- Should simultaneous typing ever be supported, or should the agent always yield when user input is active?
- Can `CGEvent.postToPid` safely target background apps for any real workflows, or do too many apps require frontmost activation?
- Is drag-in-canvas in scope for Presence, or should RO explicitly say canvas apps require handoff/consent and are not part of the core promise?
- What notarization, TCC, and user-trust implications come with a CGEvent-heavy app? `CGPreflightPostEventAccess` and `CGRequestPostEventAccess` exist, but product review should treat this as a trust boundary ([Apple: CGPreflightPostEventAccess](https://developer.apple.com/documentation/coregraphics/cgpreflightposteventaccess%28%29), [Apple: CGRequestPostEventAccess](https://developer.apple.com/documentation/coregraphics/cgrequestposteventaccess%28%29)).
- What is the threat model if an attacker gains agent control and fires keystrokes or mouse events? Rate limits are not enough; RO likely needs user-visible action audit, per-channel permissions, and emergency stop.
- Should clipboard tools be available by default, or should clipboard read/write be a separate capability grant?
- How should Presence represent confidence when AX hit-testing returns a parent group rather than the visible child the user would name?
- Should the dot ever visually merge with the hardware cursor during consented borrow, or should it stay distinct and label the borrow?

## Recommended Order of Implementation

Start with a stacked branch series off `feat/co-presence-v0`:

1. `feat/presence-v1.6-visible-action-wrapper` - implement `withVisibleAction` and wire existing `agent_press_named`, `agent_write_selection`, reads, and find results to target-frame travel and halo.
2. `feat/presence-v1.6-guarded-keystrokes` - add focus lease, user-activity abort, `agent_keystroke`, `agent_type_text`, and `agent_menu_command`.
3. `feat/presence-v1.7-selection-ranges` - add caret, selection range, select-all, line/point range helpers, and visible selection halos.
4. `feat/presence-v1.7-clipboard` - add read/write/apply with change-count race handling and optional restore.
5. `feat/presence-v1.8-hid-consent` - add consent-token UX and the first low-level mouse/scroll primitives, with AX alternatives attempted first.
6. `feat/presence-v1.9-drag` - add drag and down/up only after consent UX has shipped and been exercised.
7. `feat/presence-v2.0-window-vision` - add window/app management and ScreenCaptureKit-backed visual fallback.

The key product discipline: do not let v1.8/v1.9 contaminate the v1.6 promise. Presence can feel complete for text, formatting, buttons, menus, and windows while still refusing unconsented HID mouse work. That refusal is not a limitation to hide; it is the trust model.
