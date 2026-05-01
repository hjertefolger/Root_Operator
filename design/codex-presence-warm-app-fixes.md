# Presence Warm-App Fixes

Branch: `feat/co-presence-v0`  
Round: warm-app reliability + co-presence feel

## Executive Read

The production-shaped systems do not depend on a single focused window or a single postcondition check. They treat app launch, app activation, element traversal, input, visual feedback, and post-action reads as one action envelope. Our bridge has most of those pieces, but they are split across tool paths and several paths still assume a clean cold-start state.

The specific warm-app failures map to four local gaps:

1. `launch_app` only accepted `bundle_id` in chain steps, so `{ bundle: "com.apple.Notes" }` failed before the idempotent path could run.
2. `resolve` did not support the `var`/`app` aliases used by the caller, and its window-scoped search had no all-windows/app-subtree fallback when the selected window was the wrong duplicate AXWindow.
3. `focus_element` raised and focused windows, but once the target app was main-but-not-key it had no cursor-invariant HID fallback to make the OS accept the focus transition.
4. HID restore used a fixed sleep and one cursor read, which races CGEvent delivery.
5. The visible feedback path only replayed the last framed chain step, and the halo/dot animation read as a debug flash rather than a persistent agent body.

## Upstream Study

### 1. Reliability Architecture

MacosUseSDK exposes higher-level action envelopes rather than one-off helpers. `ActionCoordinator` builds an operation with optional pre-traversal, visual animation, input, delay, post-traversal, and diffing:

```swift
// MacosUseSDK/Sources/MacosUseSDK/ActionCoordinator.swift:35-52
public struct ActionOptions: Sendable {
    public let beforeState: AccessibilityNode?
    public let beforeStateJson: String?
    public let performBeforeTraversal: Bool
    public let performAfterTraversal: Bool
    public let includeDiff: Bool
    public let includeFullAfterState: Bool
    public let animate: Bool
    public let delaySeconds: Double
}
```

The central route for input is also shared:

```swift
// MacosUseSDK/Sources/MacosUseSDK/ActionCoordinator.swift:383-455
case .click:
    try await inputController.click(at: point, button: button)
case .typeText:
    try await inputController.typeText(text)
case .setAccessibilityValue:
    try setAccessibilityValue(app: appElement, at: point, value: value, preferredRoles: preferredRoles)
case .pressAccessibility:
    try pressAccessibilityElement(app: appElement, at: point, preferredRoles: preferredRoles)
case .setAccessibilitySelected:
    try setAccessibilitySelected(app: appElement, at: point, selected: selected, preferredRoles: preferredRoles)
```

The MCP server wraps this in a guarded one-call action that saves state, engages the input guard, runs optional chained actions, traverses afterward, and restores frontmost app/cursor:

```swift
// mcp-server-macos-use/Sources/MCPServer/main.swift:1802-1889
let savedFrontmostApp = saveFrontmostApp ? NSWorkspace.shared.frontmostApplication : nil
let savedCursorPos = saveCursorPosition ? CGEvent(source: nil)?.location : nil
...
try? inputGuard?.engageForInput()
...
let actionResult = try await ActionCoordinator.performAction(...)
...
try? inputGuard?.disengage()
```

Fazm’s ACP bridge takes the same architectural stance at the process boundary: tool calls are tracked by ID, logged as activity, timed out, and then completed through one relay path. The relevant shape is the `pendingToolCalls` map and the tool activity lifecycle:

```ts
// fazm/acp-bridge/src/index.ts:362-370
const pendingToolCalls = new Map<string, {
  resolve: (v: any) => void,
  reject: (e: Error) => void,
  timer: NodeJS.Timeout,
  toolName?: string,
}>();
```

```ts
// fazm/acp-bridge/src/index.ts:2763-2840
sendToolActivity({
  event: 'tool_call_started',
  id: toolCallId,
  name,
  input,
  ts: Date.now(),
});
...
inFlightToolCalls.set(toolCallId, { name, startTime: Date.now(), input });
```

```ts
// fazm/acp-bridge/src/index.ts:2886-2901
if (inFlightToolCalls.has(toolCallId)) {
  inFlightToolCalls.delete(toolCallId);
  sendToolActivity({ event: 'tool_call_completed', id: toolCallId, name, ts: Date.now() });
}
```

Our local architecture is close in `agent_run_chain`/`agent_act`, but the visual feedback path was still bolted onto the final framed step only, and some helper steps still used single-window resolution.

### 2. Warm-App Handling

MacosUseSDK’s app opener explicitly pre-finds an already running process, then treats that process as a valid success even if the later open/activate call is not the source of truth:

```swift
// MacosUseSDK/Sources/MacosUseSDK/AppOpener.swift:137-160
if let bID = bundleIdentifier {
    if let runningApp = NSRunningApplication.runningApplications(withBundleIdentifier: bID).first {
        foundPID = runningApp.processIdentifier
    }
}
```

```swift
// MacosUseSDK/Sources/MacosUseSDK/AppOpener.swift:215-225
if let pid = foundPID {
    fputs("warning: activation/open failed but app was already running with pid \(pid), returning existing process.\n", stderr)
    return AppOpenResult(name: finalAppName ?? appIdentifier, pid: pid, bundleIdentifier: bundleIdentifier)
}
```

The traversal layer also reactivates a regular app before reading its tree:

```swift
// MacosUseSDK/Sources/MacosUseSDK/AccessibilityTraversal.swift:148-157
if runningApp.activationPolicy == .regular && !runningApp.isActive {
    let activated = runningApp.activate(options: [.activateIgnoringOtherApps])
    if activated {
        Thread.sleep(forTimeInterval: 0.3)
    }
}
```

mcp-server-macos-use activates the target app before coordinate actions:

```swift
// mcp-server-macos-use/Sources/MCPServer/main.swift:1655-1662
if let targetApp = findRunningApplication(nameOrBundle: appName) {
    activateApp(targetApp)
    await MainActor.run { accessibilityEngine.scrollPointIntoView(x: x, y: y) }
}
```

Our `launchAppPayload` did an idempotent return for `bundle_id`, but chain dispatch required `bundle_id` exactly. That made the warm Notes call fail before the running-app branch.

### 3. Element Resolution

MacosUseSDK’s point resolver walks the application tree breadth-first and chooses the smallest containing frame, because hit-testing and focused-window assumptions are not reliable in complex apps:

```swift
// MacosUseSDK/Sources/MacosUseSDK/AccessibilityActions.swift:43-77
fileprivate func findAXElement(in app: AXUIElement, at point: CGPoint, preferredRoles: Set<String>, maxNodes: Int = 4000) -> AXUIElement? {
    var bestPreferred: (element: AXUIElement, area: CGFloat)? = nil
    var bestAny: (element: AXUIElement, area: CGFloat)? = nil
    var queue: [AXUIElement] = [app]
    var visited = 0
    while let current = queue.first, visited < maxNodes {
        queue.removeFirst()
        visited += 1
        if let frame = axFrame(of: current), frame.contains(point) {
            let area = frame.width * frame.height
            if let role = axRole(of: current), preferredRoles.contains(role) {
                if bestPreferred == nil || area < bestPreferred!.area { bestPreferred = (current, area) }
            }
            if bestAny == nil || area < bestAny!.area { bestAny = (current, area) }
        }
        var children: AnyObject?
        let cErr = AXUIElementCopyAttributeValue(current, kAXChildrenAttribute as CFString, &children)
        if cErr == .success, let arr = children as? [AXUIElement] { queue.append(contentsOf: arr) }
    }
    return bestPreferred?.element ?? bestAny?.element
}
```

The full traversal engine is more defensive than that simple function. It tracks visited nodes, caps depth/nodes/time, and explicitly enqueues window attributes that are often not plain `AXChildren`:

```swift
// MacosUseSDK/Sources/MacosUseSDK/AccessibilityTraversal.swift:99-105
private var visitedElements = Set<AXElementKey>()
private let maxDepth = 100
private let maxElements = 2000
private let maxTraversalSeconds: TimeInterval = 5.0
```

```swift
// MacosUseSDK/Sources/MacosUseSDK/AccessibilityTraversal.swift:375-411
if attr == kAXWindowsAttribute as String || attr == kAXMainWindowAttribute as String {
    if let elems = value as? [AXUIElement] { for e in elems { enqueue(e, depth + 1) } }
    else if CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() { enqueue(value as! AXUIElement, depth + 1) }
}
...
let status = AXUIElementCopyAttributeValues(current, attr as CFString, 0, childCount, &values)
```

Our helper has a capped candidate walk, but `cmdFocusElement` was rooted only at `resolveFocusedWindow()`, and `chainRootElements(scope: "window")` could also return the wrong duplicate window. The fix is not a new named tool; it is all-window/app-root fallback in the shared resolver.

### 4. HID Cursor Invariance

The current cloned upstream does not implement the settle-poll described in the brief. MacosUseSDK posts click events without restoring the hardware cursor:

```swift
// MacosUseSDK/Sources/MacosUseSDK/InputController.swift:93-102
let mouseDown = CGEvent(mouseEventSource: eventSource, mouseType: mouseDownType, mouseCursorPosition: point, mouseButton: cgButton)
let mouseUp = CGEvent(mouseEventSource: eventSource, mouseType: mouseUpType, mouseCursorPosition: point, mouseButton: cgButton)
mouseDown?.post(tap: .cghidEventTap)
try await Task.sleep(nanoseconds: 50_000_000)
mouseUp?.post(tap: .cghidEventTap)
```

mcp-server-macos-use saves and restores, but also uses a one-shot restore:

```swift
// mcp-server-macos-use/Sources/MCPServer/main.swift:1905-1910
if saveCursorPosition, let savedPos = savedCursorPos {
    if let moveEvent = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: savedPos, mouseButton: .left) {
        moveEvent.post(tap: .cghidEventTap)
    }
}
```

So this round should lift the state-save contract, but implement our own bounded settle-poll. Our old local code warped, slept 10ms, and read once, which explains the intermittent `cursor_restore_failed`.

### 5. Action Verification

MacosUseSDK’s generic AX set helpers return on AX success, but the action coordinator’s envelope can traverse after the action and diff the result:

```swift
// MacosUseSDK/Sources/MacosUseSDK/ActionCoordinator.swift:227-243
if options.delaySeconds > 0 { try await Task.sleep(nanoseconds: UInt64(options.delaySeconds * 1_000_000_000)) }
...
if options.performAfterTraversal || options.includeDiff {
    let afterState = try await traversalEngine.traverseApplicationWithFocus(app: app)
    afterJson = afterState.toJSON()
}
```

mcp-server-macos-use likewise runs a final traversal after a tool action, making false success visible to the caller:

```swift
// mcp-server-macos-use/Sources/MCPServer/main.swift:1840-1889
let actionResult = try await ActionCoordinator.performAction(...)
...
if returnScreenshot { ... }
```

Our `setValuePayload` and `setGenericAttributePayload` accepted `AXUIElementSetAttributeValue == .success` without reading the attribute back. For `AXValue`, the helper should poll the actual value and fail if it never matches.

### 6. Visible Feedback

MacosUseSDK has optional drawing/highlighting in the action envelope:

```swift
// MacosUseSDK/Sources/MacosUseSDK/ActionCoordinator.swift:359-365
if options.animate {
    Task.detached {
        await DrawVisuals.drawAccessibilityTree(nodes: nodes)
    }
}
```

Fazm’s bridge publishes tool activity events for every tool call, and its UI can represent tool start/completion consistently:

```ts
// fazm/Desktop/Sources/Chat/ACPBridge.swift:1004-1008
case .toolActivity(let event):
    onToolActivity?(event)
case .toolResultDisplay(let display):
    onToolResultDisplay?(display)
```

They do not ship Tom’s desired dot/halo body, but their lesson is that visual state belongs on the shared action path. Our local `agent_run_chain`/`agent_act` only replayed the last framed step, so successful `hid`, `set_attribute`, or earlier `perform_action` steps could be invisible.

### 7. Lift, Adapt, Reject

Lift:

- The MacosUseSDK application-root/tree-walk mindset: never assume `kAXFocusedWindow` is the only root.
- The mcp-server action envelope: save cursor/frontmost state, execute, post-read, restore.
- The Fazm activity fanout: one shared post-success hook rather than per-tool decorations.

Adapt:

- MacosUseSDK’s point resolver is already partly local in `findSmallestElementContainingPoint`; extend the same idea to all-window roots for label/role resolution.
- mcp-server’s cursor save/restore is the right contract, but needs a bounded settle-poll because one-shot restore races.
- Visual feedback should be nonblocking like Fazm tool activity, but with product-specific motion/halo rather than logs.

Reject:

- A fallback to external scripting to activate or set state. It hides bridge failure and is explicitly banned for this round.
- Adding more named MCP tools. The failures are in generic `launch_app`, `resolve`, focus, HID, and shared feedback.

## Failure Mapping

### Failure 1: `launch_app` Not Idempotent for Warm Notes

Cause: chain dispatch accepted only `bundle_id`. Tom’s step used `bundle`.

Implementation:

- Add bundle/app alias resolution in `performChainStep`, `wait_for_app_window`, `chainRootElements`, `pressNamedPayload`, and menu paths.
- Keep running-app success idempotent, but on warm success activate and raise the best known window before returning.
- Return diagnostics: `already_running`, `frontmost_settled`, `raised_window`, window frame/statuses.

### Failure 2: `resolve` Misses Existing Textarea

Cause: alias mismatch (`var`, `app`) plus too-narrow roots in window/focus flows.

Implementation:

- Accept `var` as an alias for `as`.
- Resolve `app` by bundle id, bundle alias, localized running app name, or app URL-derived bundle id.
- For app/window scopes, search focused window, main window, every `AXWindows` entry, and the app root, with uniqueness and existing node caps.
- Report real searched/match counts on failure.

### Failure 3: `focus_element` Main-But-Not-Key

Cause: after raise/focused setters, there is no final OS-level click bootstrap when the target app reports main windows that are not key.

Implementation:

- Reassert app/window activation and raise via existing `prepareFocusTransaction`.
- If fresh focus verification still fails for text targets, perform a synthetic HID click at the target center using the cursor-invariant click path.
- Immediately restore the cursor and fail if restore fails.
- Re-run AX focused setters and fresh-process verification. Never return success without `fresh_verified`.

### Failure 4: `agent_click_at` Cursor Race

Cause: fixed 10ms wait + single cursor read after restore.

Implementation:

- Replace restore with bounded settle-poll: post restore, poll current cursor until it is within tolerance and stable for consecutive reads or timeout.
- Include `cursor_restore_attempts` and `cursor_restore_settle_ms`.
- Keep erroring on failed restore.

### Failure 5: Dot/Halo Invisible or Mechanical

Cause: only last chain frame showed feedback, halo was static, avatar had no detached idle presence.

Implementation:

- Add one shared action feedback replay function in `agent-actions.js` that schedules every successful framed bridge action in `agent_run_chain` and `agent_act`.
- Keep individual tools on `showActionAt`.
- Change avatar travel to distance-scaled curved motion with overshoot/settle, active idle drift, and seeded micro-tours.
- Change halo to living overlay: animated dotted border scan plus wave-field spots, low-alpha accent color, fade in/out, click-through.
- Put tuning values in one shared config file.

## Acceptance Scenarios

The new `scripts/test-presence-warm-app.sh` should:

1. Warm Notes: use bridge `launch_app`, resolve Notes editor through all-window/app fallback, press New Note, write, format Title/Body, verify value, assert cursor delta <= 1.
2. Warm Safari to Warm Notes: launch/activate both via bridge; set Safari address field by AX; switch to Notes; append to an existing editor with AX value/selection operations; assert cursor delta <= 1.
3. Window-not-key recovery: set up Notes with sidebar focus through bridge/HID, then focus the editor and require fresh-process verification.
4. HID click stress: run five `click-at` calls at different points within two seconds, every result `ok`, no `cursor_restore_failed`.
5. Visual feedback audit: run a five-step generic bridge action with `perform_action`, `set_attribute`, `hid`, `set_attribute`, `perform_action` and capture `/tmp/codex-warm-app-test.mov` for human review.
6. Idle co-presence: focus a Notes textarea and capture `/tmp/codex-presence-idle.mov` for 30 seconds; the dot must drift, at least one micro-tour must occur, halo scan and wave-field must animate, and there must be no hard snaps/flicker.

Human visual review remains necessary for scenarios 5 and 6 because the screen recording is the contract for Tom’s co-presence feel. The script can verify bridge success, cursor invariance, and recording creation; it cannot decide whether the motion feels alive.
