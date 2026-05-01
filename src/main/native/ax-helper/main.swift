// ROOT OPERATOR — AX HELPER
//
// Native macOS CLI that wraps Accessibility APIs so the Electron host
// can read text under the cursor / focused element and replace it,
// going through the AX channel — never moving the hardware cursor or
// synthesizing keyboard events.
//
// All output is JSON. Exit 0 on a structured result (including
// "no_element" / "no_text" outcomes). Exit 1 only on internal/argv
// errors. The host parses stdout as JSON.

import Foundation
import ApplicationServices
import AppKit

// MARK: — JSON output helpers

func emit(_ obj: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: obj, options: [])
        if let str = String(data: data, encoding: .utf8) {
            print(str)
        }
    } catch {
        // Last-ditch fallback — should never happen for our shapes.
        print("{\"error\":\"json_serialize\"}")
    }
}

func emitError(_ code: String, _ detail: String? = nil) -> Never {
    var obj: [String: Any] = ["error": code]
    if let d = detail { obj["detail"] = d }
    emit(obj)
    exit(0) // structured result, not internal error
}

func emitInternalError(_ message: String) -> Never {
    emit(["error": "internal", "detail": message])
    exit(1)
}

// MARK: — AX helpers

func axCopyAttribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, key as CFString, &value)
    return status == .success ? value : nil
}

func axCopyString(_ element: AXUIElement, _ key: String) -> String? {
    guard let raw = axCopyAttribute(element, key) else { return nil }
    if CFGetTypeID(raw) == CFStringGetTypeID() {
        return raw as? String
    }
    return nil
}

func axCopyPoint(_ element: AXUIElement, _ key: String) -> CGPoint? {
    guard let raw = axCopyAttribute(element, key) else { return nil }
    var point = CGPoint.zero
    if CFGetTypeID(raw) == AXValueGetTypeID()
        && AXValueGetValue(raw as! AXValue, .cgPoint, &point) {
        return point
    }
    return nil
}

func axCopySize(_ element: AXUIElement, _ key: String) -> CGSize? {
    guard let raw = axCopyAttribute(element, key) else { return nil }
    var size = CGSize.zero
    if CFGetTypeID(raw) == AXValueGetTypeID()
        && AXValueGetValue(raw as! AXValue, .cgSize, &size) {
        return size
    }
    return nil
}

// Read text from an element — value first, then fall back to nothing.
// Web inputs and many native fields expose kAXValueAttribute. Some text
// areas in third-party apps populate kAXSelectedTextAttribute only.
func readElementText(_ element: AXUIElement) -> (value: String?, selected: String?) {
    let value = axCopyString(element, kAXValueAttribute as String)
    let selected = axCopyString(element, kAXSelectedTextAttribute as String)
    return (value, selected)
}

func roleString(_ element: AXUIElement) -> String {
    return axCopyString(element, kAXRoleAttribute as String) ?? "AXUnknown"
}

func frameOf(_ element: AXUIElement) -> [String: Any]? {
    let pos = axCopyPoint(element, kAXPositionAttribute as String)
    let size = axCopySize(element, kAXSizeAttribute as String)
    guard let p = pos, let s = size else { return nil }
    return [
        "x": Double(p.x),
        "y": Double(p.y),
        "w": Double(s.width),
        "h": Double(s.height),
    ]
}

func resolveElementAtPoint(_ x: Float, _ y: Float) -> AXUIElement? {
    let system = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    let status = AXUIElementCopyElementAtPosition(system, x, y, &element)
    return status == .success ? element : nil
}

func resolveFocusedElement() -> AXUIElement? {
    let system = AXUIElementCreateSystemWide()
    guard let raw = axCopyAttribute(system, kAXFocusedUIElementAttribute as String) else {
        return nil
    }
    if CFGetTypeID(raw) == AXUIElementGetTypeID() {
        return (raw as! AXUIElement)
    }
    return nil
}

// MARK: — Read commands

func emitReadResult(_ element: AXUIElement) -> Never {
    let (value, selected) = readElementText(element)
    if value == nil && selected == nil {
        emit([
            "error": "no_text",
            "role": roleString(element),
        ])
        exit(0)
    }

    var result: [String: Any] = [
        "role": roleString(element),
        "value": value as Any? ?? NSNull(),
        "selectedText": selected as Any? ?? NSNull(),
    ]
    if let frame = frameOf(element) {
        result["frame"] = frame
    }
    emit(result)
    exit(0)
}

func cmdReadAt(_ args: [String]) -> Never {
    guard args.count >= 2,
          let x = Float(args[0]),
          let y = Float(args[1]) else {
        emitInternalError("read-at requires <x> <y>")
    }
    guard let element = resolveElementAtPoint(x, y) else {
        emitError("no_element")
    }
    emitReadResult(element)
}

func cmdReadFocused() -> Never {
    guard let element = resolveFocusedElement() else {
        emitError("no_focused_element")
    }
    emitReadResult(element)
}

// MARK: — Write commands

// Roles for which writing is unsafe — passwords, secure system fields,
// menu/UI elements that aren't text. Refusing here is a hard wall.
let WRITE_BLOCKED_ROLES: Set<String> = [
    "AXPasswordTextField",   // password inputs (Safari, Mail, system dialogs)
    "AXSecureTextField",     // older secure inputs
]

// Roles where writing is allowed. Anything outside this list is rejected
// to keep the agent away from menu items, buttons, file rows, etc.
let WRITE_ALLOWED_ROLES: Set<String> = [
    "AXTextField",
    "AXTextArea",
    "AXSearchField",
    "AXComboBox",            // editable combo boxes (e.g. address bars)
    "AXStaticText",          // some web composers expose this as editable
]

// Safer write semantics. When the user has a non-empty selection we use
// kAXSelectedTextAttribute (replaces the selection in place). When there
// is no selection AND the caller passed allowFullValue=true, fall back
// to kAXValueAttribute. Falling back to value-replace silently when a
// selection-set fails would erase the user's draft — Codex flagged this
// as HIGH and we hard-refuse instead.
func writeToElement(
    _ element: AXUIElement,
    _ text: String,
    allowFullValue: Bool
) -> Never {
    let role = roleString(element)

    if WRITE_BLOCKED_ROLES.contains(role) {
        emit([
            "error": "blocked_role",
            "role": role,
            "detail": "Refusing to write to a sensitive field.",
        ])
        exit(0)
    }
    if !WRITE_ALLOWED_ROLES.contains(role) {
        emit([
            "error": "unsupported_role",
            "role": role,
            "detail": "AX write is restricted to text-bearing roles.",
        ])
        exit(0)
    }

    // Best-effort focus restore: when the agent writes via cursor
    // resolution, the user's last interaction was the Presence bubble,
    // which steals focus from the target app. Setting kAXFocusedAttribute
    // on the resolved element returns the caret without moving the
    // hardware cursor or keyboard. Failure here is non-fatal — the
    // subsequent value/selection write may still succeed for some apps,
    // and where it doesn't, the user gets the existing structured error.
    _ = AXUIElementSetAttributeValue(
        element,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    )

    // Look at the selection first.
    let selectedText = axCopyString(element, kAXSelectedTextAttribute as String)
    let hasSelection = (selectedText != nil) && !(selectedText!.isEmpty)

    if hasSelection {
        let status = AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextAttribute as CFString,
            text as CFTypeRef
        )
        if status == .success {
            var ok: [String: Any] = ["ok": true, "mode": "selection", "role": role]
            if let frame = frameOf(element) { ok["frame"] = frame }
            emit(ok)
            exit(0)
        }
        // Hard refusal: do NOT silently fall back to whole-value replace.
        emit([
            "error": "selection_write_failed",
            "role": role,
            "detail": "ax_status=\(status.rawValue)",
        ])
        exit(0)
    }

    // No selection — only allow whole-field replace when explicitly
    // requested by the caller.
    if !allowFullValue {
        emit([
            "error": "no_selection",
            "role": role,
            "detail": "There is no selected text to replace. Pass --replace-all to overwrite the entire field.",
        ])
        exit(0)
    }

    let status = AXUIElementSetAttributeValue(
        element,
        kAXValueAttribute as CFString,
        text as CFTypeRef
    )
    if status == .success {
        var ok: [String: Any] = ["ok": true, "mode": "value", "role": role]
        if let frame = frameOf(element) { ok["frame"] = frame }
        emit(ok)
        exit(0)
    }
    emit([
        "error": "value_write_failed",
        "role": role,
        "detail": "ax_status=\(status.rawValue)",
    ])
    exit(0)
}

// Parse args into (positional, allowFullValue). The --replace-all flag
// can appear anywhere in argv — we strip it out before the remaining
// positional args are interpreted.
func parseWriteArgs(_ raw: [String]) -> ([String], Bool) {
    var rest: [String] = []
    var allowFull = false
    for a in raw {
        if a == "--replace-all" {
            allowFull = true
        } else {
            rest.append(a)
        }
    }
    return (rest, allowFull)
}

func cmdWriteAt(_ args: [String]) -> Never {
    let (rest, allowFull) = parseWriteArgs(args)
    guard rest.count >= 3,
          let x = Float(rest[0]),
          let y = Float(rest[1]) else {
        emitInternalError("write-at requires <x> <y> <text> [--replace-all]")
    }
    let text = rest[2..<rest.count].joined(separator: " ")
    guard let element = resolveElementAtPoint(x, y) else {
        emitError("no_element")
    }
    writeToElement(element, text, allowFullValue: allowFull)
}

func cmdWriteFocused(_ args: [String]) -> Never {
    let (rest, allowFull) = parseWriteArgs(args)
    guard !rest.isEmpty else {
        emitInternalError("write-focused requires <text> [--replace-all]")
    }
    let text = rest.joined(separator: " ")
    guard let element = resolveFocusedElement() else {
        emitError("no_focused_element")
    }
    writeToElement(element, text, allowFullValue: allowFull)
}

// MARK: — Window tree (Layer 1)

// Hard caps to keep payloads bounded. AX trees in a heavy app
// (Safari with many tabs, Slack with many threads) can fan out
// into thousands of nodes; the LLM doesn't need that fidelity to
// "see the room."
let TREE_MAX_DEPTH = 8
let TREE_MAX_NODES = 500
let TREE_VALUE_TRUNC = 200

func resolveActiveAppElement() -> (pid: pid_t, element: AXUIElement)? {
    guard let frontApp = NSWorkspace.shared.frontmostApplication else { return nil }
    let pid = frontApp.processIdentifier
    let appElem = AXUIElementCreateApplication(pid)
    return (pid, appElem)
}

func resolveFocusedWindow() -> AXUIElement? {
    guard let (_, appElem) = resolveActiveAppElement() else { return nil }
    if let raw = axCopyAttribute(appElem, kAXFocusedWindowAttribute as String) {
        if CFGetTypeID(raw) == AXUIElementGetTypeID() {
            return (raw as! AXUIElement)
        }
    }
    // Fallback: first window in kAXWindowsAttribute.
    if let raw = axCopyAttribute(appElem, kAXWindowsAttribute as String) {
        if CFGetTypeID(raw) == CFArrayGetTypeID() {
            let arr = raw as! [AXUIElement]
            if let first = arr.first { return first }
        }
    }
    return nil
}

func axCopyChildren(_ element: AXUIElement) -> [AXUIElement] {
    guard let raw = axCopyAttribute(element, kAXChildrenAttribute as String) else { return [] }
    if CFGetTypeID(raw) == CFArrayGetTypeID() {
        return (raw as! [AXUIElement])
    }
    return []
}

// On a window, the toolbar typically lives as a direct AXChildren entry
// AND/OR is exposed via the kAXToolbarAttribute (rare on modern Cocoa).
// In Notes the AXToolbar appears at AXChildren[1] AFTER a giant
// AXSplitGroup that contains the entire sidebar — depth-first walk
// hits the 500-node cap inside the split group long before the toolbar,
// so toolbar buttons (e.g. "New Note") are unreachable.
//
// Fix: when assembling children for the walk, hoist any AXToolbar(s) and
// kAXToolbarAttribute to the FRONT of the list so they're visited first.
// Costs ~one extra attribute-fetch per node but makes the toolbar room
// visible regardless of where Cocoa decided to attach it.
func axCopyChildrenForWalk(_ element: AXUIElement) -> [AXUIElement] {
    let children = axCopyChildren(element)
    let role = roleString(element)
    guard role == "AXWindow" else { return children }

    var toolbars: [AXUIElement] = []
    var rest: [AXUIElement] = []
    for child in children {
        if roleString(child) == "AXToolbar" {
            toolbars.append(child)
        } else {
            rest.append(child)
        }
    }

    // kAXToolbarAttribute isn't bridged into Swift's AX constants (only
    // AppKit's NSAccessibilityToolbarAttribute exposes it). The AX-level
    // attribute string is the well-known "AXToolbar". Some apps expose
    // their toolbar this way instead of as a child — capture it too.
    if let raw = axCopyAttribute(element, "AXToolbar") {
        let typeId = CFGetTypeID(raw)
        if typeId == AXUIElementGetTypeID() {
            toolbars.append(raw as! AXUIElement)
        } else if typeId == CFArrayGetTypeID() {
            toolbars.append(contentsOf: raw as! [AXUIElement])
        }
    }

    return toolbars + rest
}

func truncate(_ s: String, _ n: Int) -> String {
    if s.count <= n { return s }
    let end = s.index(s.startIndex, offsetBy: n)
    return String(s[..<end]) + "…"
}

func nodeSummary(_ element: AXUIElement) -> [String: Any] {
    var node: [String: Any] = ["role": roleString(element)]
    if let subrole = axCopyString(element, kAXSubroleAttribute as String) {
        node["subrole"] = subrole
    }
    if let title = axCopyString(element, kAXTitleAttribute as String), !title.isEmpty {
        node["label"] = truncate(title, TREE_VALUE_TRUNC)
    } else if let desc = axCopyString(element, kAXDescriptionAttribute as String), !desc.isEmpty {
        node["label"] = truncate(desc, TREE_VALUE_TRUNC)
    } else if let help = axCopyString(element, kAXHelpAttribute as String), !help.isEmpty {
        node["label"] = truncate(help, TREE_VALUE_TRUNC)
    }
    if let value = axCopyString(element, kAXValueAttribute as String), !value.isEmpty {
        node["value"] = truncate(value, TREE_VALUE_TRUNC)
    }
    if let frame = frameOf(element) {
        node["frame"] = frame
    }
    return node
}

// Counter passed by reference so depth-first walk can stop globally
// at TREE_MAX_NODES. (Swift inout in a closure isn't ergonomic; box
// it instead.)
final class NodeCounter { var count = 0 }

func walkTree(_ element: AXUIElement, depth: Int, counter: NodeCounter) -> [String: Any] {
    var node = nodeSummary(element)
    counter.count += 1
    if depth >= TREE_MAX_DEPTH || counter.count >= TREE_MAX_NODES {
        return node
    }
    let children = axCopyChildrenForWalk(element)
    if !children.isEmpty {
        var kids: [[String: Any]] = []
        for child in children {
            if counter.count >= TREE_MAX_NODES {
                node["truncated"] = true
                break
            }
            kids.append(walkTree(child, depth: depth + 1, counter: counter))
        }
        if !kids.isEmpty {
            node["children"] = kids
        }
    }
    return node
}

func cmdReadWindow() -> Never {
    guard let window = resolveFocusedWindow() else {
        emitError("no_window")
    }
    let counter = NodeCounter()
    let tree = walkTree(window, depth: 0, counter: counter)
    var result: [String: Any] = [
        "tree": tree,
        "node_count": counter.count,
        "max_depth": TREE_MAX_DEPTH,
        "max_nodes": TREE_MAX_NODES,
    ]
    if let frontApp = NSWorkspace.shared.frontmostApplication {
        result["app"] = frontApp.localizedName ?? ""
        result["bundle_id"] = frontApp.bundleIdentifier ?? ""
    }
    emit(result)
    exit(0)
}

// MARK: — Find / press by role + label (Layer 2)

// Roles AXPress is allowed to act on. Excludes text fields, areas,
// images, rows, and other non-pressable surfaces — pressing those is
// usually wrong and never what the user means by "press the X
// button." Keeping this tight is the difference between an agent
// that can act and an agent that can flail.
let PRESS_ALLOWED_ROLES: Set<String> = [
    "AXButton",
    "AXLink",
    "AXMenuItem",
    "AXMenuButton",
    "AXMenuBarItem",
    "AXCheckBox",
    "AXRadioButton",
    "AXPopUpButton",
    "AXDisclosureTriangle",
    "AXSwitch",
    "AXToolbarButton",
]

func roleMatches(_ element: AXUIElement, _ wanted: String) -> Bool {
    let role = roleString(element)
    if role.caseInsensitiveCompare(wanted) == .orderedSame { return true }
    // Allow "Button" → "AXButton" shorthand.
    let withPrefix = "AX" + wanted
    return role.caseInsensitiveCompare(withPrefix) == .orderedSame
}

func labelMatches(_ element: AXUIElement, _ wanted: String) -> Bool {
    let needle = wanted.lowercased()
    if let title = axCopyString(element, kAXTitleAttribute as String) {
        if title.lowercased().contains(needle) { return true }
    }
    if let desc = axCopyString(element, kAXDescriptionAttribute as String) {
        if desc.lowercased().contains(needle) { return true }
    }
    if let help = axCopyString(element, kAXHelpAttribute as String) {
        if help.lowercased().contains(needle) { return true }
    }
    if let value = axCopyString(element, kAXValueAttribute as String) {
        if value.lowercased().contains(needle) { return true }
    }
    return false
}

// Depth-first search for the first element matching role + label.
// Returns nil if not found within search caps.
func findElement(
    in element: AXUIElement,
    role: String?,
    label: String,
    depth: Int,
    visited: NodeCounter
) -> AXUIElement? {
    visited.count += 1
    if depth > TREE_MAX_DEPTH || visited.count > TREE_MAX_NODES { return nil }
    let roleOk = role == nil || role!.isEmpty || roleMatches(element, role!)
    if roleOk && labelMatches(element, label) {
        return element
    }
    for child in axCopyChildrenForWalk(element) {
        if let m = findElement(in: child, role: role, label: label, depth: depth + 1, visited: visited) {
            return m
        }
    }
    return nil
}

func cmdFindElement(_ args: [String]) -> Never {
    guard !args.isEmpty else {
        emitInternalError("find-element requires <label> [--role <role>]")
    }
    var label = ""
    var role: String? = nil
    var i = 0
    while i < args.count {
        let a = args[i]
        if a == "--role", i + 1 < args.count {
            role = args[i + 1]
            i += 2
        } else {
            label = label.isEmpty ? a : label + " " + a
            i += 1
        }
    }
    if label.isEmpty {
        emitInternalError("find-element requires a label substring")
    }
    guard let window = resolveFocusedWindow() else {
        emitError("no_window")
    }
    let visited = NodeCounter()
    guard let elem = findElement(in: window, role: role, label: label, depth: 0, visited: visited) else {
        emit(["error": "not_found", "searched": visited.count])
        exit(0)
    }
    var result: [String: Any] = [
        "found": true,
        "role": roleString(elem),
    ]
    // Toolbar buttons usually have an empty title and carry their human
    // label on AXDescription (or AXHelp for tooltip). Prefer title when
    // present, fall back so the user sees what we matched.
    if let title = axCopyString(elem, kAXTitleAttribute as String), !title.isEmpty {
        result["label"] = title
    } else if let desc = axCopyString(elem, kAXDescriptionAttribute as String), !desc.isEmpty {
        result["label"] = desc
    } else if let help = axCopyString(elem, kAXHelpAttribute as String), !help.isEmpty {
        result["label"] = help
    }
    if let frame = frameOf(elem) {
        result["frame"] = frame
    }
    emit(result)
    exit(0)
}

func cmdPressNamed(_ args: [String]) -> Never {
    guard !args.isEmpty else {
        emitInternalError("press-named requires <label> [--role <role>]")
    }
    var label = ""
    var role: String? = nil
    var i = 0
    while i < args.count {
        let a = args[i]
        if a == "--role", i + 1 < args.count {
            role = args[i + 1]
            i += 2
        } else {
            label = label.isEmpty ? a : label + " " + a
            i += 1
        }
    }
    if label.isEmpty {
        emitInternalError("press-named requires a label substring")
    }
    guard let window = resolveFocusedWindow() else {
        emitError("no_window")
    }
    let visited = NodeCounter()
    guard let elem = findElement(in: window, role: role, label: label, depth: 0, visited: visited) else {
        emit(["error": "not_found", "searched": visited.count])
        exit(0)
    }
    let elemRole = roleString(elem)
    if !PRESS_ALLOWED_ROLES.contains(elemRole) {
        emit([
            "error": "unsupported_role",
            "role": elemRole,
            "detail": "AX press is restricted to button-like roles. Found a non-pressable role; refuse.",
        ])
        exit(0)
    }
    let status = AXUIElementPerformAction(elem, kAXPressAction as CFString)
    if status == .success {
        var ok: [String: Any] = [
            "ok": true,
            "action": "press",
            "role": roleString(elem),
        ]
        if let title = axCopyString(elem, kAXTitleAttribute as String), !title.isEmpty {
            ok["label"] = title
        } else if let desc = axCopyString(elem, kAXDescriptionAttribute as String), !desc.isEmpty {
            ok["label"] = desc
        } else if let help = axCopyString(elem, kAXHelpAttribute as String), !help.isEmpty {
            ok["label"] = help
        }
        if let frame = frameOf(elem) {
            ok["frame"] = frame
        }
        emit(ok)
        exit(0)
    }
    emit([
        "error": "press_failed",
        "role": roleString(elem),
        "detail": "ax_status=\(status.rawValue)",
    ])
    exit(0)
}

// MARK: — Permission check

func cmdCheck() -> Never {
    let trusted = AXIsProcessTrusted()
    emit(["trusted": trusted])
    exit(0)
}

// MARK: — Subscribe / passive awareness (Layer 3)
//
// Long-running mode. Attaches an AXObserver to the frontmost app and
// re-attaches when the frontmost app changes. Each AX notification
// emits a JSON line on stdout that the Electron host reads with a
// JSONL parser. Exits on SIGINT / SIGTERM.

// Notifications subscribed per app. Curated to the events that move
// what's "happening on screen" forward — not every AXValueChanged
// from every text field while typing (that would flood the channel
// with tokens for almost no signal). The selected-text and value
// changes ARE valuable but rate-limited at consumer side.
let SUBSCRIBE_NOTIFICATIONS: [String] = [
    kAXFocusedWindowChangedNotification as String,
    kAXFocusedUIElementChangedNotification as String,
    kAXSelectedTextChangedNotification as String,
    kAXValueChangedNotification as String,
    kAXWindowCreatedNotification as String,
    kAXMainWindowChangedNotification as String,
]

// Boxed mutable state passed through the Unmanaged refcon channel
// so the C-style AXObserver callback can reach back into Swift state.
final class SubscribeState {
    var observer: AXObserver?
    var attachedPid: pid_t = 0
    var attachedAppName: String = ""
    var attachedBundleId: String = ""
}

func emitEvent(_ kind: String, _ details: [String: Any]) {
    var obj: [String: Any] = ["event": kind]
    obj["ts"] = Date().timeIntervalSince1970
    for (k, v) in details {
        obj[k] = v
    }
    emit(obj)
    // Force flush so the consumer sees the line immediately. stdout
    // is line-buffered when attached to a tty but block-buffered when
    // piped to a parent process.
    fflush(stdout)
}

let axObserverCallback: AXObserverCallback = { (observer, element, notification, refcon) in
    guard let refcon = refcon else { return }
    let state = Unmanaged<SubscribeState>.fromOpaque(refcon).takeUnretainedValue()
    let notifName = notification as String
    var details: [String: Any] = [
        "app": state.attachedAppName,
        "bundle_id": state.attachedBundleId,
        "role": roleString(element),
    ]
    if let title = axCopyString(element, kAXTitleAttribute as String), !title.isEmpty {
        details["label"] = truncate(title, TREE_VALUE_TRUNC)
    }
    if let value = axCopyString(element, kAXValueAttribute as String), !value.isEmpty {
        details["value"] = truncate(value, TREE_VALUE_TRUNC)
    }
    if let selected = axCopyString(element, kAXSelectedTextAttribute as String), !selected.isEmpty {
        details["selected_text"] = truncate(selected, TREE_VALUE_TRUNC)
    }
    if let frame = frameOf(element) {
        details["frame"] = frame
    }
    emitEvent(notifName, details)
}

func detachObserver(_ state: SubscribeState) {
    guard let observer = state.observer else { return }
    let runLoop = CFRunLoopGetCurrent()
    CFRunLoopRemoveSource(runLoop, AXObserverGetRunLoopSource(observer), .defaultMode)
    state.observer = nil
}

func attachObserver(to app: NSRunningApplication, state: SubscribeState) {
    detachObserver(state)
    let pid = app.processIdentifier
    state.attachedPid = pid
    state.attachedAppName = app.localizedName ?? ""
    state.attachedBundleId = app.bundleIdentifier ?? ""

    var observer: AXObserver?
    let createStatus = AXObserverCreate(pid, axObserverCallback, &observer)
    guard createStatus == .success, let obs = observer else {
        emitEvent("subscribe_attach_failed", [
            "app": state.attachedAppName,
            "bundle_id": state.attachedBundleId,
            "ax_status": Int(createStatus.rawValue),
        ])
        return
    }
    state.observer = obs
    let appElem = AXUIElementCreateApplication(pid)
    let refcon = Unmanaged.passUnretained(state).toOpaque()
    var subscribed: [String] = []
    var failed: [String: Int] = [:]
    for n in SUBSCRIBE_NOTIFICATIONS {
        let status = AXObserverAddNotification(obs, appElem, n as CFString, refcon)
        if status == .success {
            subscribed.append(n)
        } else {
            failed[n] = Int(status.rawValue)
        }
    }
    let runLoop = CFRunLoopGetCurrent()
    CFRunLoopAddSource(runLoop, AXObserverGetRunLoopSource(obs), .defaultMode)

    var details: [String: Any] = [
        "app": state.attachedAppName,
        "bundle_id": state.attachedBundleId,
        "subscribed": subscribed,
    ]
    if !failed.isEmpty {
        details["failed"] = failed
    }
    emitEvent("subscribe_attached", details)
}

func cmdSubscribe() -> Never {
    guard AXIsProcessTrusted() else {
        emit(["error": "not_trusted"])
        exit(0)
    }
    let state = SubscribeState()

    // Initial attach to the current frontmost app.
    if let front = NSWorkspace.shared.frontmostApplication {
        emitEvent("app_activated", [
            "app": front.localizedName ?? "",
            "bundle_id": front.bundleIdentifier ?? "",
            "pid": Int(front.processIdentifier),
        ])
        attachObserver(to: front, state: state)
    } else {
        emitEvent("subscribe_started", ["app": ""])
    }

    // Watch for app changes — re-attach the AXObserver when the user
    // switches apps. NSWorkspace posts didActivateApplicationNotification
    // on the workspace notification center.
    let center = NSWorkspace.shared.notificationCenter
    center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { note in
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        emitEvent("app_activated", [
            "app": app.localizedName ?? "",
            "bundle_id": app.bundleIdentifier ?? "",
            "pid": Int(app.processIdentifier),
        ])
        attachObserver(to: app, state: state)
    }
    // Detach when the active app terminates so we don't leak observer
    // run-loop sources for dead pids.
    center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: nil) { note in
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        if app.processIdentifier == state.attachedPid {
            detachObserver(state)
            emitEvent("subscribe_detached", [
                "app": app.localizedName ?? "",
                "reason": "app_terminated",
            ])
        }
    }

    // Clean exit on SIGINT / SIGTERM so the parent's spawn().kill() is
    // graceful. Signals fire on the run loop's main thread via dispatch.
    let sigintSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    let sigtermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let exitHandler: @Sendable () -> Void = {
        emitEvent("subscribe_stopped", [:])
        exit(0)
    }
    sigintSrc.setEventHandler(handler: exitHandler)
    sigtermSrc.setEventHandler(handler: exitHandler)
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    sigintSrc.resume()
    sigtermSrc.resume()

    // Block forever on the run loop. The AXObserver and NSWorkspace
    // callbacks both fire here.
    CFRunLoopRun()
    exit(0)
}

// MARK: — Entry point

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    emitInternalError("usage: ax-helper <read-at|read-focused|write-at|write-focused|read-window|find-element|press-named|subscribe|check> [args]")
}

let cmd = argv[1]
let rest = Array(argv.dropFirst(2))

switch cmd {
case "check":           cmdCheck()
case "read-at":         cmdReadAt(rest)
case "read-focused":    cmdReadFocused()
case "write-at":        cmdWriteAt(rest)
case "write-focused":   cmdWriteFocused(rest)
case "read-window":     cmdReadWindow()
case "find-element":    cmdFindElement(rest)
case "press-named":     cmdPressNamed(rest)
case "subscribe":       cmdSubscribe()
default:                emitInternalError("unknown command: \(cmd)")
}
