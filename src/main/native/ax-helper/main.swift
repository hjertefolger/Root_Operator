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

func axCopyElement(_ element: AXUIElement, _ key: String) -> AXUIElement? {
    guard let raw = axCopyAttribute(element, key) else { return nil }
    if CFGetTypeID(raw) == AXUIElementGetTypeID() {
        return (raw as! AXUIElement)
    }
    return nil
}

func pidOf(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    let status = AXUIElementGetPid(element, &pid)
    return status == .success ? pid : nil
}

func framesApproximatelyEqual(_ a: [String: Any]?, _ b: [String: Any]?) -> Bool {
    guard let a = a, let b = b else { return false }
    let keys = ["x", "y", "w", "h"]
    for key in keys {
        guard let av = a[key] as? Double, let bv = b[key] as? Double else {
            return false
        }
        if abs(av - bv) > 1.0 { return false }
    }
    return true
}

func elementIdentityMatches(_ a: AXUIElement, _ b: AXUIElement) -> Bool {
    if CFEqual(a, b) { return true }
    guard let aPid = pidOf(a), let bPid = pidOf(b), aPid == bPid else { return false }
    if roleString(a) != roleString(b) { return false }
    return framesApproximatelyEqual(frameOf(a), frameOf(b))
}

func elementHasAncestor(_ ancestor: AXUIElement, child: AXUIElement) -> Bool {
    var current: AXUIElement? = child
    var depth = 0
    while let elem = current, depth < 20 {
        if elementIdentityMatches(ancestor, elem) { return true }
        current = axCopyElement(elem, kAXParentAttribute as String)
        depth += 1
    }
    return false
}

func focusMatches(target: AXUIElement, focused: AXUIElement) -> Bool {
    if elementIdentityMatches(target, focused) { return true }
    // Some apps report the focused leaf inside the requested container, or
    // the requested control while AX returns a child text node. Treat either
    // direct ancestry relation as a successful focus transaction.
    if elementHasAncestor(target, child: focused) { return true }
    if elementHasAncestor(focused, child: target) { return true }
    return false
}

func resolveContainingWindow(_ element: AXUIElement) -> AXUIElement? {
    if let window = axCopyElement(element, kAXWindowAttribute as String) {
        return window
    }
    if let topLevel = axCopyElement(element, "AXTopLevelUIElement"),
       roleString(topLevel) == "AXWindow" || roleString(topLevel) == "AXSheet" {
        return topLevel
    }

    var current: AXUIElement? = element
    var depth = 0
    while let elem = current, depth < 20 {
        let role = roleString(elem)
        if role == "AXWindow" || role == "AXSheet" {
            return elem
        }
        current = axCopyElement(elem, kAXParentAttribute as String)
        depth += 1
    }
    return nil
}

func actionNames(_ element: AXUIElement) -> Set<String> {
    var raw: CFArray?
    guard AXUIElementCopyActionNames(element, &raw) == .success,
          let names = raw as? [String] else { return [] }
    return Set(names)
}

func emitElementActionResult(
    ok: Bool,
    action: String,
    element: AXUIElement,
    extras: [String: Any] = [:]
) -> Never {
    var result: [String: Any] = [
        "ok": ok,
        "action": action,
        "role": roleString(element),
    ]
    if let label = displayLabel(element) {
        result["label"] = label
    }
    if let frame = frameOf(element) {
        result["frame"] = frame
    }
    for (k, v) in extras {
        result[k] = v
    }
    emit(result)
    exit(0)
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

let TREE_DEFAULT_PREFERRED_ROLES: Set<String> = [
    "AXTextArea",
    "AXTextField",
    "AXSearchField",
    "AXComboBox",
    "AXWebArea",
    "AXButton",
    "AXLink",
    "AXMenuButton",
    "AXPopUpButton",
    "AXToolbar",
]

func frameArea(_ element: AXUIElement) -> Double {
    guard let f = frameOf(element),
          let w = f["w"] as? Double,
          let h = f["h"] as? Double else { return 0 }
    return max(0, w) * max(0, h)
}

func frameMinX(_ element: AXUIElement) -> Double {
    guard let f = frameOf(element), let x = f["x"] as? Double else { return 0 }
    return x
}

func walkPriority(_ element: AXUIElement, preferRoles: Set<String>) -> Int {
    let role = roleString(element)
    if preferRoles.contains(role) { return 1200 }
    if TREE_DEFAULT_PREFERRED_ROLES.contains(role) { return 1000 }
    switch role {
    case "AXToolbar", "AXMenuBar", "AXMenuBarItem":
        return 950
    case "AXWindow", "AXSheet", "AXPopover":
        return 850
    case "AXSplitGroup", "AXGroup", "AXScrollArea", "AXTabGroup":
        return 650
    case "AXTable", "AXOutline", "AXBrowser":
        return 150
    case "AXRow", "AXCell", "AXStaticText":
        return 80
    default:
        return 300
    }
}

func sortChildrenForWalk(_ children: [AXUIElement], preferRoles: Set<String>) -> [AXUIElement] {
    return children.enumerated().sorted { a, b in
        let ap = walkPriority(a.element, preferRoles: preferRoles)
        let bp = walkPriority(b.element, preferRoles: preferRoles)
        if ap != bp { return ap > bp }
        let aa = frameArea(a.element)
        let ba = frameArea(b.element)
        if aa != ba { return aa > ba }
        let ax = frameMinX(a.element)
        let bx = frameMinX(b.element)
        if ax != bx { return ax > bx }
        return a.offset < b.offset
    }.map { $0.element }
}

// On a window, the toolbar typically lives as a direct AXChildren entry
// AND/OR is exposed via the kAXToolbarAttribute (rare on modern Cocoa).
// In Notes the AXToolbar appears after a giant split group that contains
// the sidebar, so pure depth-first traversal can burn the node cap before
// reaching high-value controls. Child ordering is priority-aware:
// text/action-bearing roles first, large/right-hand containers before
// narrow sidebars, table/row content last.
func axCopyChildrenForWalk(_ element: AXUIElement, preferRoles: Set<String> = []) -> [AXUIElement] {
    let children = axCopyChildren(element)
    let role = roleString(element)
    let sortedChildren = sortChildrenForWalk(children, preferRoles: preferRoles)
    guard role == "AXWindow" else { return sortedChildren }

    var toolbars: [AXUIElement] = []
    var rest: [AXUIElement] = []
    for child in sortedChildren {
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

func walkTreeScoped(
    _ element: AXUIElement,
    depth: Int,
    counter: NodeCounter,
    skipRoles: Set<String>,
    preferRoles: Set<String>
) -> [String: Any] {
    var node = nodeSummary(element)
    counter.count += 1
    if depth >= TREE_MAX_DEPTH || counter.count >= TREE_MAX_NODES {
        return node
    }
    let children = axCopyChildrenForWalk(element, preferRoles: preferRoles)
        .filter { !skipRoles.contains(roleString($0)) }
    if !children.isEmpty {
        var kids: [[String: Any]] = []
        for child in children {
            if counter.count >= TREE_MAX_NODES {
                node["truncated"] = true
                break
            }
            kids.append(walkTreeScoped(
                child,
                depth: depth + 1,
                counter: counter,
                skipRoles: skipRoles,
                preferRoles: preferRoles
            ))
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

// Score a single attribute against the needle. Higher = stronger match.
// Returns nil if the haystack doesn't contain the needle.
func attrScore(_ haystack: String?, _ needle: String, exact: Int, prefix: Int, substr: Int) -> Int? {
    guard let raw = haystack else { return nil }
    let h = raw.lowercased()
    if h.isEmpty { return nil }
    if h == needle { return exact }
    if h.hasPrefix(needle) { return prefix }
    if h.contains(needle) { return substr }
    return nil
}

// Score how well `wanted` matches this element's labels. Title is
// strongly preferred over description / help so e.g. "More" matches the
// real "More" button rather than Media's help text "More media options."
// Value is a weak signal — many text-bearing roles will substring-hit
// the needle as content rather than identity.
//
// Score bands (highest first):
//   1000 / 800 / 600   title  (exact / prefix / substr)
//    300 / 250 / 200   description
//    150 / 120 / 100   help
//     50 /  40 /  30   value
// Returns nil if no field contains the needle.
func labelScore(_ element: AXUIElement, _ wanted: String) -> Int? {
    let needle = wanted.lowercased()
    if needle.isEmpty { return nil }
    var best: Int? = nil
    func consider(_ s: Int?) {
        guard let s = s else { return }
        if best == nil || s > best! { best = s }
    }
    consider(attrScore(axCopyString(element, kAXTitleAttribute as String), needle,
                       exact: 1000, prefix: 800, substr: 600))
    consider(attrScore(axCopyString(element, kAXDescriptionAttribute as String), needle,
                       exact: 300, prefix: 250, substr: 200))
    consider(attrScore(axCopyString(element, kAXHelpAttribute as String), needle,
                       exact: 150, prefix: 120, substr: 100))
    consider(attrScore(axCopyString(element, kAXValueAttribute as String), needle,
                       exact: 50, prefix: 40, substr: 30))
    return best
}

// Walk the tree once and collect every (element, score, ordinal) match.
// `ordinal` is the traversal order (0, 1, 2 …) used as a deterministic
// tie-breaker since Swift's `sort` is not guaranteed stable. Bounded by
// TREE_MAX_DEPTH / TREE_MAX_NODES same as the read-window walker.
func collectMatches(
    in element: AXUIElement,
    role: String?,
    label: String,
    depth: Int,
    visited: NodeCounter,
    out: inout [(elem: AXUIElement, score: Int, ordinal: Int)]
) {
    visited.count += 1
    if depth > TREE_MAX_DEPTH || visited.count > TREE_MAX_NODES { return }
    let roleOk = role == nil || role!.isEmpty || roleMatches(element, role!)
    if roleOk, let s = labelScore(element, label) {
        out.append((element, s, out.count))
    }
    for child in axCopyChildrenForWalk(element) {
        collectMatches(in: child, role: role, label: label, depth: depth + 1, visited: visited, out: &out)
    }
}

// Distance from frame center to a given screen point. Used as the
// primary sort when --near is supplied. Elements without a frame sort
// last via Double.infinity.
func frameDistance(_ element: AXUIElement, _ point: CGPoint) -> Double {
    guard let f = frameOf(element),
          let fx = f["x"] as? Double,
          let fy = f["y"] as? Double,
          let fw = f["w"] as? Double,
          let fh = f["h"] as? Double else { return .infinity }
    let cx = fx + fw / 2.0
    let cy = fy + fh / 2.0
    let dx = cx - Double(point.x)
    let dy = cy - Double(point.y)
    return (dx * dx + dy * dy).squareRoot()
}

// Resolve the desired match from the collected list given optional
// disambiguation hints. Sort order:
//   - if `near` is supplied: by distance ascending, score descending
//     as tiebreaker — "the X closest to (px,py), best lexical match
//     among ties wins."
//   - otherwise: by score descending — "the best lexical match."
// `index` then picks the Nth entry (0-based) from the sorted list.
func resolveMatch(
    matches: [(elem: AXUIElement, score: Int, ordinal: Int)],
    near: CGPoint?,
    index: Int
) -> (elem: AXUIElement, rank: Int, total: Int)? {
    if matches.isEmpty { return nil }
    var sorted = matches
    if let p = near {
        sorted.sort { a, b in
            let aDist = frameDistance(a.elem, p)
            let bDist = frameDistance(b.elem, p)
            if aDist != bDist { return aDist < bDist }
            if a.score != b.score { return a.score > b.score }
            return a.ordinal < b.ordinal
        }
    } else {
        sorted.sort { a, b in
            if a.score != b.score { return a.score > b.score }
            return a.ordinal < b.ordinal
        }
    }
    if index < 0 || index >= sorted.count { return nil }
    return (sorted[index].elem, index, sorted.count)
}

// Parse the shared find/press argv: [<label tokens...>] with optional
// `--role <r>`, `--index <n>`, `--near <x,y>`. Label tokens are joined
// with spaces. Returns nil-or-error if any flag is malformed.
struct FindArgs {
    var label: String
    var role: String?
    var index: Int
    var near: CGPoint?
}

func parseFindArgs(_ args: [String], cmd: String) -> FindArgs {
    var label = ""
    var role: String? = nil
    var index: Int = 0
    var near: CGPoint? = nil
    var i = 0
    while i < args.count {
        let a = args[i]
        if a == "--role", i + 1 < args.count {
            role = args[i + 1]
            i += 2
        } else if a == "--index", i + 1 < args.count {
            guard let n = Int(args[i + 1]) else {
                emitInternalError("\(cmd): --index requires an integer")
            }
            index = n
            i += 2
        } else if a == "--near", i + 1 < args.count {
            let parts = args[i + 1].split(separator: ",")
            guard parts.count == 2,
                  let x = Double(parts[0]),
                  let y = Double(parts[1]) else {
                emitInternalError("\(cmd): --near requires <x,y>")
            }
            near = CGPoint(x: x, y: y)
            i += 2
        } else {
            label = label.isEmpty ? a : label + " " + a
            i += 1
        }
    }
    if label.isEmpty {
        emitInternalError("\(cmd) requires a label substring")
    }
    return FindArgs(label: label, role: role, index: index, near: near)
}

struct ElementArgs {
    var label: String?
    var role: String?
    var index: Int
    var near: CGPoint?
    var skipRoles: Set<String>
    var preferRoles: Set<String>
}

func parseElementArgs(_ args: [String], cmd: String, requireTarget: Bool = true) -> ElementArgs {
    var label = ""
    var role: String? = nil
    var index: Int = 0
    var near: CGPoint? = nil
    var skipRoles = Set<String>()
    var preferRoles = Set<String>()
    var i = 0
    while i < args.count {
        let a = args[i]
        if a == "--role", i + 1 < args.count {
            let rawRole = args[i + 1]
            role = rawRole.lowercased().hasPrefix("ax") ? rawRole : "AX" + rawRole
            i += 2
        } else if a == "--index", i + 1 < args.count {
            guard let n = Int(args[i + 1]) else {
                emitInternalError("\(cmd): --index requires an integer")
            }
            index = n
            i += 2
        } else if a == "--near", i + 1 < args.count {
            let parts = args[i + 1].split(separator: ",")
            guard parts.count == 2,
                  let x = Double(parts[0]),
                  let y = Double(parts[1]) else {
                emitInternalError("\(cmd): --near requires <x,y>")
            }
            near = CGPoint(x: x, y: y)
            i += 2
        } else if a == "--skip-role", i + 1 < args.count {
            let rawRole = args[i + 1]
            let r = rawRole.lowercased().hasPrefix("ax") ? rawRole : "AX" + rawRole
            skipRoles.insert(r)
            i += 2
        } else if a == "--prefer-role", i + 1 < args.count {
            let rawRole = args[i + 1]
            let r = rawRole.lowercased().hasPrefix("ax") ? rawRole : "AX" + rawRole
            preferRoles.insert(r)
            i += 2
        } else {
            label = label.isEmpty ? a : label + " " + a
            i += 1
        }
    }
    if requireTarget && label.isEmpty && (role == nil || role!.isEmpty) {
        emitInternalError("\(cmd) requires a label substring or --role")
    }
    return ElementArgs(
        label: label.isEmpty ? nil : label,
        role: role,
        index: index,
        near: near,
        skipRoles: skipRoles,
        preferRoles: preferRoles
    )
}

func collectElementCandidates(
    in element: AXUIElement,
    role: String?,
    label: String?,
    depth: Int,
    visited: NodeCounter,
    preferRoles: Set<String>,
    out: inout [(elem: AXUIElement, score: Int, ordinal: Int)]
) {
    visited.count += 1
    if depth > TREE_MAX_DEPTH || visited.count > TREE_MAX_NODES { return }
    let roleOk = role == nil || role!.isEmpty || roleMatches(element, role!)
    var score: Int? = nil
    if let label = label, !label.isEmpty {
        score = labelScore(element, label)
    } else if roleOk {
        score = walkPriority(element, preferRoles: preferRoles)
    }
    if roleOk, let s = score {
        out.append((element, s, out.count))
    }
    for child in axCopyChildrenForWalk(element, preferRoles: preferRoles) {
        collectElementCandidates(
            in: child,
            role: role,
            label: label,
            depth: depth + 1,
            visited: visited,
            preferRoles: preferRoles,
            out: &out
        )
    }
}

// Pick a "label" for response payloads using the same priority used by
// labelScore: title > description > help. Returns nil if every field
// is empty.
func displayLabel(_ element: AXUIElement) -> String? {
    if let title = axCopyString(element, kAXTitleAttribute as String), !title.isEmpty {
        return title
    }
    if let desc = axCopyString(element, kAXDescriptionAttribute as String), !desc.isEmpty {
        return desc
    }
    if let help = axCopyString(element, kAXHelpAttribute as String), !help.isEmpty {
        return help
    }
    return nil
}

func cmdFindElement(_ args: [String]) -> Never {
    guard !args.isEmpty else {
        emitInternalError("find-element requires <label> [--role <role>] [--index <n>] [--near <x,y>]")
    }
    let parsed = parseFindArgs(args, cmd: "find-element")
    guard let window = resolveFocusedWindow() else {
        emitError("no_window")
    }
    let visited = NodeCounter()
    var matches: [(elem: AXUIElement, score: Int, ordinal: Int)] = []
    collectMatches(in: window, role: parsed.role, label: parsed.label, depth: 0, visited: visited, out: &matches)
    guard let pick = resolveMatch(matches: matches, near: parsed.near, index: parsed.index) else {
        emit([
            "error": "not_found",
            "searched": visited.count,
            "match_count": matches.count,
        ])
        exit(0)
    }
    var result: [String: Any] = [
        "found": true,
        "role": roleString(pick.elem),
        "match_count": pick.total,
        "match_index": pick.rank,
    ]
    if let label = displayLabel(pick.elem) {
        result["label"] = label
    }
    if let frame = frameOf(pick.elem) {
        result["frame"] = frame
    }
    emit(result)
    exit(0)
}

func cmdPressNamed(_ args: [String]) -> Never {
    guard !args.isEmpty else {
        emitInternalError("press-named requires <label> [--role <role>] [--index <n>] [--near <x,y>]")
    }
    let parsed = parseFindArgs(args, cmd: "press-named")
    guard let window = resolveFocusedWindow() else {
        emitError("no_window")
    }
    let visited = NodeCounter()
    var matches: [(elem: AXUIElement, score: Int, ordinal: Int)] = []
    collectMatches(in: window, role: parsed.role, label: parsed.label, depth: 0, visited: visited, out: &matches)
    guard let pick = resolveMatch(matches: matches, near: parsed.near, index: parsed.index) else {
        emit([
            "error": "not_found",
            "searched": visited.count,
            "match_count": matches.count,
        ])
        exit(0)
    }
    let elemRole = roleString(pick.elem)
    if !PRESS_ALLOWED_ROLES.contains(elemRole) {
        emit([
            "error": "unsupported_role",
            "role": elemRole,
            "match_count": pick.total,
            "match_index": pick.rank,
            "detail": "AX press is restricted to button-like roles. Found a non-pressable role; refuse.",
        ])
        exit(0)
    }
    let status = AXUIElementPerformAction(pick.elem, kAXPressAction as CFString)
    if status == .success {
        var ok: [String: Any] = [
            "ok": true,
            "action": "press",
            "role": elemRole,
            "match_count": pick.total,
            "match_index": pick.rank,
        ]
        if let label = displayLabel(pick.elem) {
            ok["label"] = label
        }
        if let frame = frameOf(pick.elem) {
            ok["frame"] = frame
        }
        emit(ok)
        exit(0)
    }
    emit([
        "error": "press_failed",
        "role": elemRole,
        "match_count": pick.total,
        "match_index": pick.rank,
        "detail": "ax_status=\(status.rawValue)",
    ])
    exit(0)
}

struct FocusTransaction {
    var pid: pid_t?
    var window: AXUIElement?
    var statuses: [String: Int] = [:]
    var activated: Bool?
}

func statusPayload(_ statuses: [String: Int]) -> [String: Any] {
    var out: [String: Any] = [:]
    for (k, v) in statuses { out[k] = v }
    return out
}

func prepareFocusTransaction(target element: AXUIElement, window knownWindow: AXUIElement?) -> FocusTransaction {
    var tx = FocusTransaction(pid: pidOf(element), window: knownWindow)
    if tx.window == nil {
        tx.window = resolveContainingWindow(element)
    }

    guard let pid = tx.pid else {
        return tx
    }

    if let running = NSRunningApplication(processIdentifier: pid) {
        if #available(macOS 14.0, *) {
            tx.activated = running.activate()
        } else {
            tx.activated = running.activate(options: [.activateIgnoringOtherApps])
        }
    }

    let appElem = AXUIElementCreateApplication(pid)
    let frontmostStatus = AXUIElementSetAttributeValue(
        appElem,
        kAXFrontmostAttribute as CFString,
        kCFBooleanTrue
    )
    tx.statuses["app_frontmost"] = Int(frontmostStatus.rawValue)

    if let window = tx.window {
        let raiseStatus = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        tx.statuses["window_raise"] = Int(raiseStatus.rawValue)

        let focusedWindowStatus = AXUIElementSetAttributeValue(
            appElem,
            kAXFocusedWindowAttribute as CFString,
            window
        )
        tx.statuses["app_focused_window"] = Int(focusedWindowStatus.rawValue)

        let mainStatus = AXUIElementSetAttributeValue(
            window,
            kAXMainAttribute as CFString,
            kCFBooleanTrue
        )
        tx.statuses["window_main"] = Int(mainStatus.rawValue)

        let focusedStatus = AXUIElementSetAttributeValue(
            window,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        )
        tx.statuses["window_focused"] = Int(focusedStatus.rawValue)
    }

    // App/window activation is asynchronous in several Cocoa apps. A short
    // settle makes the following AXFocused setter land after the key-window
    // transition instead of racing it.
    Thread.sleep(forTimeInterval: 0.05)
    return tx
}

func waitForFocusToStick(target element: AXUIElement, timeoutMs: Int = 800) -> (matched: Bool, focused: AXUIElement?) {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    var lastFocused: AXUIElement? = nil
    repeat {
        if let focused = resolveFocusedElement() {
            lastFocused = focused
            if focusMatches(target: element, focused: focused) {
                return (true, focused)
            }
        }
        Thread.sleep(forTimeInterval: 0.035)
    } while Date() < deadline
    return (false, lastFocused)
}

func focusElement(_ element: AXUIElement, window knownWindow: AXUIElement? = nil) -> Never {
    var tx = prepareFocusTransaction(target: element, window: knownWindow)
    var status = AXUIElementSetAttributeValue(
        element,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    )
    if status == .success {
        var verified = waitForFocusToStick(target: element)
        if !verified.matched {
            // One retry after reasserting app/window key state covers apps
            // that accepted the first setter before their focused window
            // transition finished.
            tx = prepareFocusTransaction(target: element, window: tx.window)
            status = AXUIElementSetAttributeValue(
                element,
                kAXFocusedAttribute as CFString,
                kCFBooleanTrue
            )
            if status == .success {
                verified = waitForFocusToStick(target: element)
            }
        }
        if verified.matched {
            var extras: [String: Any] = [
                "verified": true,
                "focus_statuses": statusPayload(tx.statuses),
            ]
            if let pid = tx.pid { extras["pid"] = Int(pid) }
            if let activated = tx.activated { extras["app_activated"] = activated }
            emitElementActionResult(ok: true, action: "focus", element: element, extras: extras)
        }
        var result: [String: Any] = [
            "error": "focus_not_sticky",
            "role": roleString(element),
            "detail": "AXFocused setter succeeded, but system AXFocusedUIElement did not match the target within the settle window.",
            "focus_statuses": statusPayload(tx.statuses),
        ]
        if let pid = tx.pid { result["pid"] = Int(pid) }
        if let activated = tx.activated { result["app_activated"] = activated }
        if let focused = verified.focused {
            result["focused_role"] = roleString(focused)
            if let focusedPid = pidOf(focused) {
                result["focused_pid"] = Int(focusedPid)
                if let focusedApp = NSRunningApplication(processIdentifier: focusedPid) {
                    result["focused_app"] = focusedApp.localizedName ?? ""
                    result["focused_bundle_id"] = focusedApp.bundleIdentifier ?? ""
                }
            }
            if let frame = frameOf(focused) {
                result["focused_frame"] = frame
            }
        } else {
            result["focused_role"] = NSNull()
        }
        if let frame = frameOf(element) { result["frame"] = frame }
        emit(result)
        exit(0)
    }
    if status == .attributeUnsupported || status == .notImplemented {
        var result: [String: Any] = [
            "error": "not_focusable",
            "role": roleString(element),
            "detail": "target does not accept kAXFocusedAttribute",
        ]
        if let frame = frameOf(element) { result["frame"] = frame }
        emit(result)
        exit(0)
    }
    var result: [String: Any] = [
        "error": "focus_failed",
        "role": roleString(element),
        "detail": "ax_status=\(status.rawValue)",
    ]
    if let frame = frameOf(element) { result["frame"] = frame }
    emit(result)
    exit(0)
}

func cmdFocusElement(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    let parsed = parseElementArgs(args, cmd: "focus-element")
    guard let window = resolveFocusedWindow() else {
        emitError("no_window")
    }
    let visited = NodeCounter()
    var matches: [(elem: AXUIElement, score: Int, ordinal: Int)] = []
    collectElementCandidates(
        in: window,
        role: parsed.role,
        label: parsed.label,
        depth: 0,
        visited: visited,
        preferRoles: parsed.preferRoles,
        out: &matches
    )
    guard let pick = resolveMatch(matches: matches, near: parsed.near, index: parsed.index) else {
        emit([
            "error": "not_found",
            "searched": visited.count,
            "match_count": matches.count,
        ])
        exit(0)
    }
    focusElement(pick.elem, window: window)
}

func cmdFocusAt(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    guard args.count >= 2,
          let x = Float(args[0]),
          let y = Float(args[1]) else {
        emitInternalError("focus-at requires <x> <y>")
    }
    guard let element = resolveElementAtPoint(x, y) else {
        emitError("no_element")
    }
    focusElement(element, window: resolveContainingWindow(element))
}

func cmdPressAt(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    guard args.count >= 2,
          let x = Float(args[0]),
          let y = Float(args[1]) else {
        emitInternalError("press-at requires <x> <y>")
    }
    guard let element = resolveElementAtPoint(x, y) else {
        emitError("no_element")
    }
    if !actionNames(element).contains(kAXPressAction as String) {
        var result: [String: Any] = [
            "error": "unsupported_action",
            "role": roleString(element),
            "detail": "target does not expose AXPress",
        ]
        if let frame = frameOf(element) { result["frame"] = frame }
        emit(result)
        exit(0)
    }
    let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
    if status == .success {
        emitElementActionResult(ok: true, action: "press", element: element)
    }
    var result: [String: Any] = [
        "error": "press_failed",
        "role": roleString(element),
        "detail": "ax_status=\(status.rawValue)",
    ]
    if let frame = frameOf(element) { result["frame"] = frame }
    emit(result)
    exit(0)
}

func cmdReadSubtree(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    let parsed = parseElementArgs(args, cmd: "read-subtree")
    guard let window = resolveFocusedWindow() else {
        emitError("no_window")
    }
    let visited = NodeCounter()
    var matches: [(elem: AXUIElement, score: Int, ordinal: Int)] = []
    collectElementCandidates(
        in: window,
        role: parsed.role,
        label: parsed.label,
        depth: 0,
        visited: visited,
        preferRoles: parsed.preferRoles,
        out: &matches
    )
    guard let pick = resolveMatch(matches: matches, near: parsed.near, index: parsed.index) else {
        emit([
            "error": "not_found",
            "searched": visited.count,
            "match_count": matches.count,
        ])
        exit(0)
    }
    let counter = NodeCounter()
    let tree = walkTreeScoped(
        pick.elem,
        depth: 0,
        counter: counter,
        skipRoles: parsed.skipRoles,
        preferRoles: parsed.preferRoles
    )
    var result: [String: Any] = [
        "tree": tree,
        "node_count": counter.count,
        "searched": visited.count,
        "match_count": pick.total,
        "match_index": pick.rank,
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
    "AXMoved",
    "AXResized",
    "AXMenuOpened",
    "AXMenuClosed",
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

// MARK: — Keyboard / selection / menu commands (v1.6 + v1.7)

// Map of named keys to HID virtual key codes. Apple's HIToolbox header
// "Events.h" defines kVK_* constants but they are not vended in Swift.
// These are stable since macOS 10.5.
let NAMED_KEYS: [String: CGKeyCode] = [
    "return": 0x24, "enter": 0x24,
    "tab": 0x30,
    "space": 0x31,
    "delete": 0x33, "backspace": 0x33,
    "escape": 0x35, "esc": 0x35,
    "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
    "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
    "forwarddelete": 0x75, "fwddelete": 0x75,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
    "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    // Letters A..Z. The values here are standard ANSI keycodes;
    // they will type the corresponding character in the user's
    // current keyboard layout regardless of layout, since modifier
    // combos (Cmd+Shift+J etc.) bypass the typed character mapping
    // and target the physical key.
    "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E, "f": 0x03,
    "g": 0x05, "h": 0x04, "i": 0x22, "j": 0x26, "k": 0x28, "l": 0x25,
    "m": 0x2E, "n": 0x2D, "o": 0x1F, "p": 0x23, "q": 0x0C, "r": 0x0F,
    "s": 0x01, "t": 0x11, "u": 0x20, "v": 0x09, "w": 0x0D, "x": 0x07,
    "y": 0x10, "z": 0x06,
    "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
    "5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,
    "-": 0x1B, "=": 0x18, "[": 0x21, "]": 0x1E, "\\": 0x2A,
    ";": 0x29, "'": 0x27, ",": 0x2B, ".": 0x2F, "/": 0x2C, "`": 0x32,
]

func parseModifierFlags(_ csv: String) -> CGEventFlags {
    var flags: CGEventFlags = []
    let tokens = csv.lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    for tok in tokens where !tok.isEmpty {
        switch tok {
        case "cmd", "command":   flags.insert(.maskCommand)
        case "shift":            flags.insert(.maskShift)
        case "opt", "option", "alt": flags.insert(.maskAlternate)
        case "ctrl", "control":  flags.insert(.maskControl)
        case "fn":               flags.insert(.maskSecondaryFn)
        default:                 emitError("bad_modifier", "unknown modifier '\(tok)'")
        }
    }
    return flags
}

func parseKey(_ raw: String) -> CGKeyCode {
    // Numeric form: "38" or "0x26"
    if let hex = raw.lowercased().hasPrefix("0x") ? UInt16(raw.dropFirst(2), radix: 16) : nil {
        return CGKeyCode(hex)
    }
    if let dec = UInt16(raw) {
        return CGKeyCode(dec)
    }
    if let mapped = NAMED_KEYS[raw.lowercased()] {
        return mapped
    }
    emitError("bad_key", "unknown key name '\(raw)' — use a named key or numeric virtual code")
}

// Refuse to post keys when nothing is focused. The keystroke would
// otherwise dispatch to whatever element happens to gain focus next,
// disrupting the user. Caller (JS) is also expected to verify focus
// matches a captured lease before invoking us.
func ensureFocusedElement() -> AXUIElement {
    let systemWide = AXUIElementCreateSystemWide()
    var focused: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &focused)
    guard status == .success, let raw = focused else {
        emitError("no_focus", "no focused UI element; keystroke would have no target")
    }
    return raw as! AXUIElement
}

// Build a CGEventSource using `.privateState` so posted modifier
// flags don't merge with stale hardware-keyboard state (Apple docs
// describe private state as an independent event-state table). Codex
// flagged the previous .hidSystemState fallback as a safety hole —
// if private creation fails we fail closed rather than silently
// reintroducing the hardware-state coupling we're trying to avoid.
func makeEventSource() -> CGEventSource? {
    return CGEventSource(stateID: .privateState)
}

func activeDisplayRects() -> [CGRect] {
    let maxDisplays: UInt32 = 32
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(maxDisplays))
    var count: UInt32 = 0
    let err = displays.withUnsafeMutableBufferPointer { buf in
        CGGetActiveDisplayList(maxDisplays, buf.baseAddress, &count)
    }
    if err == .success && count > 0 {
        return displays.prefix(Int(count)).map { CGDisplayBounds($0) }
    }
    return NSScreen.screens.map { $0.frame }
}

func distanceToRect(_ p: CGPoint, _ r: CGRect) -> CGFloat {
    let dx = max(r.minX - p.x, 0, p.x - r.maxX)
    let dy = max(r.minY - p.y, 0, p.y - r.maxY)
    return (dx * dx + dy * dy).squareRoot()
}

func clampPointToDisplay(_ p: CGPoint) -> (point: CGPoint, display: CGRect)? {
    let rects = activeDisplayRects().filter { $0.width > 1 && $0.height > 1 }
    guard !rects.isEmpty else { return nil }
    let rect = rects.first(where: { $0.contains(p) })
        ?? rects.min(by: { distanceToRect(p, $0) < distanceToRect(p, $1) })!
    let x = min(max(p.x, rect.minX), rect.maxX - 1)
    let y = min(max(p.y, rect.minY), rect.maxY - 1)
    return (CGPoint(x: x, y: y), rect)
}

func parseFiniteDouble(_ raw: String, _ name: String) -> Double {
    guard let v = Double(raw), v.isFinite else {
        emitError("bad_coordinate", "\(name) must be finite")
    }
    return v
}

func displayFramePayload(_ rect: CGRect) -> [String: Any] {
    return [
        "x": Double(rect.origin.x),
        "y": Double(rect.origin.y),
        "w": Double(rect.width),
        "h": Double(rect.height),
    ]
}

func pointFramePayload(_ p: CGPoint, size: Double = 12) -> [String: Any] {
    return [
        "x": Double(p.x) - size / 2,
        "y": Double(p.y) - size / 2,
        "w": size,
        "h": size,
    ]
}

struct MouseButtonSpec {
    let name: String
    let button: CGMouseButton
    let down: CGEventType
    let up: CGEventType
    let drag: CGEventType
}

func parseMouseButton(_ raw: String) -> MouseButtonSpec {
    switch raw.lowercased() {
    case "left":
        return MouseButtonSpec(name: "left", button: .left, down: .leftMouseDown, up: .leftMouseUp, drag: .leftMouseDragged)
    case "right":
        return MouseButtonSpec(name: "right", button: .right, down: .rightMouseDown, up: .rightMouseUp, drag: .rightMouseDragged)
    case "middle", "center":
        return MouseButtonSpec(name: "middle", button: .center, down: .otherMouseDown, up: .otherMouseUp, drag: .otherMouseDragged)
    default:
        emitError("bad_button", "expected left, right, or middle")
    }
}

func postMouseMove(_ src: CGEventSource, _ p: CGPoint) {
    guard let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) else {
        emitError("hid_event_create_failed", "mouse move")
    }
    move.post(tap: .cghidEventTap)
}

func postMouse(_ src: CGEventSource, _ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clickState: Int64 = 1) {
    guard let event = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button) else {
        emitError("hid_event_create_failed", "mouse event")
    }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    if button == .center {
        event.setIntegerValueField(.mouseEventButtonNumber, value: 2)
    }
    event.post(tap: .cghidEventTap)
}

func parsePointFromArgs(_ args: [String], cmd: String) -> CGPoint {
    guard args.count >= 2 else {
        emitInternalError("\(cmd) requires <x> <y>")
    }
    let x = parseFiniteDouble(args[0], "x")
    let y = parseFiniteDouble(args[1], "y")
    return CGPoint(x: x, y: y)
}

func clampRequired(_ p: CGPoint) -> (point: CGPoint, display: CGRect) {
    guard let clamped = clampPointToDisplay(p) else {
        emitError("display_unavailable", "no active display geometry")
    }
    return clamped
}

func cmdClickAt(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    let rawPoint = parsePointFromArgs(args, cmd: "click-at")
    var button = parseMouseButton("left")
    var count = 1
    var i = 2
    while i < args.count {
        let a = args[i]
        if a == "--button", i + 1 < args.count {
            button = parseMouseButton(args[i + 1])
            i += 2
        } else if a == "--count", i + 1 < args.count {
            guard let c = Int(args[i + 1]), c >= 1, c <= 3 else {
                emitError("bad_count", "click count must be 1, 2, or 3")
            }
            count = c
            i += 2
        } else {
            i += 1
        }
    }
    guard let src = makeEventSource() else {
        emitError("event_source_private_failed", "CGEventSource(.privateState) returned nil")
    }
    let clamped = clampRequired(rawPoint)
    postMouseMove(src, clamped.point)
    Thread.sleep(forTimeInterval: 0.025)
    for click in 1...count {
        postMouse(src, button.down, clamped.point, button.button, clickState: Int64(click))
        Thread.sleep(forTimeInterval: 0.025)
        postMouse(src, button.up, clamped.point, button.button, clickState: Int64(click))
        if click < count { Thread.sleep(forTimeInterval: 0.08) }
    }
    emit([
        "ok": true,
        "action": "click",
        "button": button.name,
        "count": count,
        "x": Double(clamped.point.x),
        "y": Double(clamped.point.y),
        "frame": pointFramePayload(clamped.point),
        "display": displayFramePayload(clamped.display),
    ])
    exit(0)
}

func cmdHoverAt(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    let rawPoint = parsePointFromArgs(args, cmd: "hover-at")
    var durationMs = 0
    var i = 2
    while i < args.count {
        if args[i] == "--duration-ms", i + 1 < args.count {
            guard let d = Int(args[i + 1]), d >= 0, d <= 5000 else {
                emitError("bad_duration", "hover duration must be 0..5000ms")
            }
            durationMs = d
            i += 2
        } else {
            i += 1
        }
    }
    guard let src = makeEventSource() else {
        emitError("event_source_private_failed", "CGEventSource(.privateState) returned nil")
    }
    let clamped = clampRequired(rawPoint)
    postMouseMove(src, clamped.point)
    if durationMs > 0 {
        Thread.sleep(forTimeInterval: Double(durationMs) / 1000.0)
    }
    emit([
        "ok": true,
        "action": "hover",
        "x": Double(clamped.point.x),
        "y": Double(clamped.point.y),
        "frame": pointFramePayload(clamped.point),
        "display": displayFramePayload(clamped.display),
    ])
    exit(0)
}

func cmdDrag(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    guard args.count >= 4 else {
        emitInternalError("drag requires <from_x> <from_y> <to_x> <to_y>")
    }
    let fromRaw = CGPoint(x: parseFiniteDouble(args[0], "from_x"), y: parseFiniteDouble(args[1], "from_y"))
    let toRaw = CGPoint(x: parseFiniteDouble(args[2], "to_x"), y: parseFiniteDouble(args[3], "to_y"))
    var durationMs = 450
    var button = parseMouseButton("left")
    var i = 4
    while i < args.count {
        let a = args[i]
        if a == "--duration-ms", i + 1 < args.count {
            guard let d = Int(args[i + 1]), d >= 50, d <= 5000 else {
                emitError("bad_duration", "drag duration must be 50..5000ms")
            }
            durationMs = d
            i += 2
        } else if a == "--button", i + 1 < args.count {
            button = parseMouseButton(args[i + 1])
            i += 2
        } else {
            i += 1
        }
    }
    guard let src = makeEventSource() else {
        emitError("event_source_private_failed", "CGEventSource(.privateState) returned nil")
    }
    let from = clampRequired(fromRaw)
    let to = clampRequired(toRaw)
    postMouseMove(src, from.point)
    Thread.sleep(forTimeInterval: 0.04)
    postMouse(src, button.down, from.point, button.button)
    let steps = max(4, min(80, durationMs / 16))
    for step in 1...steps {
        let t = Double(step) / Double(steps)
        let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
        let x = from.point.x + (to.point.x - from.point.x) * CGFloat(eased)
        let y = from.point.y + (to.point.y - from.point.y) * CGFloat(eased)
        postMouse(src, button.drag, CGPoint(x: x, y: y), button.button)
        Thread.sleep(forTimeInterval: Double(durationMs) / 1000.0 / Double(steps))
    }
    postMouse(src, button.up, to.point, button.button)
    emit([
        "ok": true,
        "action": "drag",
        "button": button.name,
        "duration_ms": durationMs,
        "from": ["x": Double(from.point.x), "y": Double(from.point.y)],
        "to": ["x": Double(to.point.x), "y": Double(to.point.y)],
        "frame": pointFramePayload(to.point),
        "display": displayFramePayload(to.display),
    ])
    exit(0)
}

func clampToInt32(_ v: Double) -> Int32 {
    if v > Double(Int32.max) { return Int32.max }
    if v < Double(Int32.min) { return Int32.min }
    return Int32(v.rounded())
}

func cmdScrollAt(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    guard args.count >= 4 else {
        emitInternalError("scroll-at requires <x> <y> <dx> <dy>")
    }
    let rawPoint = CGPoint(x: parseFiniteDouble(args[0], "x"), y: parseFiniteDouble(args[1], "y"))
    let dx = parseFiniteDouble(args[2], "dx")
    let dy = parseFiniteDouble(args[3], "dy")
    guard dx.isFinite && dy.isFinite else {
        emitError("bad_coordinate", "scroll deltas must be finite")
    }
    guard let src = makeEventSource() else {
        emitError("event_source_private_failed", "CGEventSource(.privateState) returned nil")
    }
    let clamped = clampRequired(rawPoint)
    postMouseMove(src, clamped.point)
    guard let event = CGEvent(
        scrollWheelEvent2Source: src,
        units: .pixel,
        wheelCount: 2,
        wheel1: clampToInt32(dy),
        wheel2: clampToInt32(dx),
        wheel3: 0
    ) else {
        emitError("hid_event_create_failed", "scroll event")
    }
    event.location = clamped.point
    event.post(tap: .cghidEventTap)
    emit([
        "ok": true,
        "action": "scroll",
        "dx": dx,
        "dy": dy,
        "x": Double(clamped.point.x),
        "y": Double(clamped.point.y),
        "frame": pointFramePayload(clamped.point),
        "display": displayFramePayload(clamped.display),
    ])
    exit(0)
}

func cmdKeystroke(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }

    var keyArg: String?
    var modCsv = ""
    var requireFocus = true
    var i = 0
    while i < args.count {
        let a = args[i]
        if a == "--mods" && i + 1 < args.count { modCsv = args[i + 1]; i += 2; continue }
        if a == "--no-focus-check" { requireFocus = false; i += 1; continue }
        keyArg = a; i += 1
    }
    guard let k = keyArg else { emitInternalError("keystroke: missing key arg") }

    let focusedElement: AXUIElement? = requireFocus ? ensureFocusedElement() : nil

    let key = parseKey(k)
    let flags = parseModifierFlags(modCsv)
    guard let src = makeEventSource() else {
        emitError("event_source_private_failed", "CGEventSource(.privateState) returned nil")
    }

    guard
        let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true),
        let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false)
    else { emitError("event_create_failed") }
    if !flags.isEmpty {
        down.flags = flags
        up.flags = flags
    }
    down.post(tap: .cghidEventTap)
    // Tiny delay so apps that latch on key-down register before the up.
    Thread.sleep(forTimeInterval: 0.012)
    up.post(tap: .cghidEventTap)

    var result: [String: Any] = [
        "ok": true,
        "key": k,
        "key_code": Int(key),
        "mods": modCsv,
    ]
    if let elem = focusedElement {
        result["role"] = roleString(elem)
        if let frame = frameOf(elem) { result["frame"] = frame }
    }
    emit(result)
    exit(0)
}

func cmdTypeText(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    var requireFocus = true
    var text: String?
    var i = 0
    while i < args.count {
        let a = args[i]
        if a == "--no-focus-check" { requireFocus = false; i += 1; continue }
        text = a; i += 1
    }
    guard let t = text, !t.isEmpty else { emitInternalError("type-text: missing text arg") }

    // Cap on UTF-16 code units, not Swift's grapheme-count Character
    // count. AX selection ranges and CGEvent's Unicode buffer are
    // both UTF-16-unit measured; emoji or composed characters can
    // expand to many UTF-16 units per Character. Lower default cap
    // for keyboard synthesis (this is a real key-event path, not the
    // AX value-write blast radius).
    let utf16 = Array(t.utf16)
    if utf16.count > 2000 {
        emitError("text_too_long", "max 2000 UTF-16 code units; got \(utf16.count)")
    }

    let focusedElement: AXUIElement? = requireFocus ? ensureFocusedElement() : nil
    guard let src = makeEventSource() else {
        emitError("event_source_private_failed", "CGEventSource(.privateState) returned nil")
    }

    // Use CGEvent.keyboardSetUnicodeString — types each Unicode scalar
    // through a single keyDown event, no per-key dispatch. Cheaper and
    // more reliable for plain text than per-character keystroke loops.
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true) else {
        emitError("event_create_failed")
    }
    utf16.withUnsafeBufferPointer { buf in
        down.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
    }
    down.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.012)
    if let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) {
        utf16.withUnsafeBufferPointer { buf in
            up.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
        }
        up.post(tap: .cghidEventTap)
    }
    var result: [String: Any] = [
        "ok": true,
        "length": utf16.count,
    ]
    if let elem = focusedElement {
        result["role"] = roleString(elem)
        if let frame = frameOf(elem) { result["frame"] = frame }
    }
    emit(result)
    exit(0)
}

let MODIFIER_KEY_SPECS: [String: (code: CGKeyCode, flag: CGEventFlags)] = [
    "cmd": (0x37, .maskCommand),
    "command": (0x37, .maskCommand),
    "shift": (0x38, .maskShift),
    "opt": (0x3A, .maskAlternate),
    "option": (0x3A, .maskAlternate),
    "alt": (0x3A, .maskAlternate),
    "ctrl": (0x3B, .maskControl),
    "control": (0x3B, .maskControl),
    "fn": (0x3F, .maskSecondaryFn),
]

func parseModifierSpecs(_ csv: String) -> [(name: String, code: CGKeyCode, flag: CGEventFlags)] {
    let tokens = csv.lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    var out: [(name: String, code: CGKeyCode, flag: CGEventFlags)] = []
    var seen = Set<String>()
    for tok in tokens where !tok.isEmpty {
        guard let spec = MODIFIER_KEY_SPECS[tok] else {
            emitError("bad_modifier", "unknown modifier '\(tok)'")
        }
        let canonical: String
        switch tok {
        case "command": canonical = "cmd"
        case "option", "alt": canonical = "opt"
        case "control": canonical = "ctrl"
        default: canonical = tok
        }
        if seen.contains(canonical) { continue }
        seen.insert(canonical)
        out.append((canonical, spec.code, spec.flag))
    }
    return out
}

func postKey(_ src: CGEventSource, key: CGKeyCode, down: Bool, flags: CGEventFlags) {
    guard let event = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: down) else {
        emitError("event_create_failed")
    }
    if !flags.isEmpty {
        event.flags = flags
    }
    event.post(tap: .cghidEventTap)
}

func cmdKeyHold(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    var keyArg: String?
    var modCsv = ""
    var requireFocus = true
    var durationMs = 250
    var i = 0
    while i < args.count {
        let a = args[i]
        if a == "--mods" && i + 1 < args.count { modCsv = args[i + 1]; i += 2; continue }
        if a == "--duration-ms" && i + 1 < args.count {
            guard let d = Int(args[i + 1]), d >= 10, d <= 5000 else {
                emitError("bad_duration", "key hold duration must be 10..5000ms")
            }
            durationMs = d
            i += 2
            continue
        }
        if a == "--no-focus-check" { requireFocus = false; i += 1; continue }
        keyArg = a; i += 1
    }
    guard let k = keyArg else { emitInternalError("key-hold: missing key arg") }
    let focusedElement: AXUIElement? = requireFocus ? ensureFocusedElement() : nil
    let key = parseKey(k)
    let flags = parseModifierFlags(modCsv)
    guard let src = makeEventSource() else {
        emitError("event_source_private_failed", "CGEventSource(.privateState) returned nil")
    }
    postKey(src, key: key, down: true, flags: flags)
    Thread.sleep(forTimeInterval: Double(durationMs) / 1000.0)
    postKey(src, key: key, down: false, flags: flags)
    var result: [String: Any] = [
        "ok": true,
        "action": "key_hold",
        "key": k,
        "key_code": Int(key),
        "mods": modCsv,
        "duration_ms": durationMs,
    ]
    if let elem = focusedElement {
        result["role"] = roleString(elem)
        if let frame = frameOf(elem) { result["frame"] = frame }
    }
    emit(result)
    exit(0)
}

func cmdModifierLatch(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    var modCsv = ""
    var durationMs = 250
    var i = 0
    while i < args.count {
        let a = args[i]
        if a == "--mods" && i + 1 < args.count { modCsv = args[i + 1]; i += 2; continue }
        if a == "--duration-ms" && i + 1 < args.count {
            guard let d = Int(args[i + 1]), d >= 10, d <= 5000 else {
                emitError("bad_duration", "modifier latch duration must be 10..5000ms")
            }
            durationMs = d
            i += 2
            continue
        }
        if modCsv.isEmpty {
            modCsv = a
        }
        i += 1
    }
    let specs = parseModifierSpecs(modCsv)
    if specs.isEmpty {
        emitError("bad_modifier", "at least one modifier is required")
    }
    guard let src = makeEventSource() else {
        emitError("event_source_private_failed", "CGEventSource(.privateState) returned nil")
    }
    var flags: CGEventFlags = []
    for spec in specs {
        flags.insert(spec.flag)
        postKey(src, key: spec.code, down: true, flags: flags)
        Thread.sleep(forTimeInterval: 0.01)
    }
    Thread.sleep(forTimeInterval: Double(durationMs) / 1000.0)
    for spec in specs.reversed() {
        postKey(src, key: spec.code, down: false, flags: flags)
        flags.remove(spec.flag)
        Thread.sleep(forTimeInterval: 0.01)
    }
    emit([
        "ok": true,
        "action": "modifier_latch",
        "mods": specs.map { $0.name }.joined(separator: ","),
        "duration_ms": durationMs,
    ])
    exit(0)
}

// Set kAXSelectedTextRangeAttribute on the focused element to a CFRange.
// Pure AX, no keystrokes. Ranges are character offsets, not byte offsets.
func setSelectedRange(_ element: AXUIElement, location: Int, length: Int) -> AXError {
    var range = CFRange(location: location, length: length)
    let axValue = AXValueCreate(.cfRange, &range)!
    return AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, axValue)
}

func axNumberOfCharacters(_ element: AXUIElement) -> Int? {
    var raw: CFTypeRef?
    let s = AXUIElementCopyAttributeValue(element, kAXNumberOfCharactersAttribute as CFString, &raw)
    if s == .success, let n = raw as? NSNumber {
        return n.intValue
    }
    // Fallback: count from the value string.
    if let v = axCopyString(element, kAXValueAttribute as String) {
        return v.utf16.count
    }
    return nil
}

func cmdSelectRange(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    var location: Int?
    var length: Int?
    var i = 0
    while i < args.count {
        let a = args[i]
        if a == "--location" && i + 1 < args.count { location = Int(args[i + 1]); i += 2; continue }
        if a == "--length" && i + 1 < args.count { length = Int(args[i + 1]); i += 2; continue }
        i += 1
    }
    guard let loc = location, let len = length else {
        emitInternalError("select-range: requires --location and --length")
    }
    if loc < 0 || len < 0 { emitError("bad_range", "negative values not allowed") }

    let elem = ensureFocusedElement()
    let total = axNumberOfCharacters(elem) ?? 0
    if loc > total { emitError("out_of_range", "location \(loc) > length \(total)") }
    let cappedLen = min(len, total - loc)
    let status = setSelectedRange(elem, location: loc, length: cappedLen)
    if status != .success {
        emitError("set_failed", "ax_status=\(status.rawValue)")
    }
    var result: [String: Any] = [
        "ok": true,
        "location": loc,
        "length": cappedLen,
        "total_chars": total,
        "role": roleString(elem),
    ]
    if let frame = frameOf(elem) { result["frame"] = frame }
    emit(result)
    exit(0)
}

func cmdSelectAll() -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    let elem = ensureFocusedElement()
    let total = axNumberOfCharacters(elem) ?? 0
    if total <= 0 {
        var empty: [String: Any] = [
            "ok": true,
            "location": 0,
            "length": 0,
            "total_chars": 0,
            "role": roleString(elem),
        ]
        if let frame = frameOf(elem) { empty["frame"] = frame }
        emit(empty)
        exit(0)
    }
    let status = setSelectedRange(elem, location: 0, length: total)
    if status != .success {
        emitError("set_failed", "ax_status=\(status.rawValue)")
    }
    var result: [String: Any] = [
        "ok": true,
        "location": 0,
        "length": total,
        "total_chars": total,
        "role": roleString(elem),
    ]
    if let frame = frameOf(elem) { result["frame"] = frame }
    emit(result)
    exit(0)
}

func cmdSelectSubstring(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    var occurrence = 0  // 0 = first
    var needle: String?
    var i = 0
    while i < args.count {
        let a = args[i]
        if a == "--occurrence" && i + 1 < args.count {
            occurrence = Int(args[i + 1]) ?? 0; i += 2; continue
        }
        needle = a; i += 1
    }
    guard let n = needle, !n.isEmpty else { emitInternalError("select-substring: missing needle") }
    let elem = ensureFocusedElement()
    guard let value = axCopyString(elem, kAXValueAttribute as String) else {
        emitError("no_value", "focused element has no AXValue text")
    }
    // Locate the Nth occurrence (0-based) of needle in the UTF-16 value.
    // AX selection ranges are UTF-16 code-unit offsets, matching what
    // Notes/TextEdit/Mail expect.
    let v = value as NSString
    var searchStart = 0
    var foundLoc = NSNotFound
    var hits = 0
    while searchStart < v.length {
        let r = v.range(of: n, options: [], range: NSRange(location: searchStart, length: v.length - searchStart))
        if r.location == NSNotFound { break }
        if hits == occurrence { foundLoc = r.location; break }
        hits += 1
        searchStart = r.location + max(1, r.length)
    }
    if foundLoc == NSNotFound {
        emitError("not_found", "needle not found at occurrence \(occurrence)")
    }
    let len = (n as NSString).length
    let status = setSelectedRange(elem, location: foundLoc, length: len)
    if status != .success {
        emitError("set_failed", "ax_status=\(status.rawValue)")
    }
    var result: [String: Any] = [
        "ok": true,
        "location": foundLoc,
        "length": len,
        "total_chars": v.length,
        "role": roleString(elem),
    ]
    if let frame = frameOf(elem) { result["frame"] = frame }
    emit(result)
    exit(0)
}

// AX-only menu navigation: walk the frontmost app's menu bar by path
// (e.g. ["Format", "Body"] or ["Edit", "Find", "Find…"]) and AXPress
// the leaf. No keystrokes; menus open and close through the AX
// channel only.
func cmdMenuCommand(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    if args.isEmpty { emitInternalError("menu-command: requires at least one path segment") }

    guard let app = NSWorkspace.shared.frontmostApplication else {
        emitError("no_app", "no frontmost application")
    }
    let appElem = AXUIElementCreateApplication(app.processIdentifier)
    var menuBar: CFTypeRef?
    let s = AXUIElementCopyAttributeValue(appElem, kAXMenuBarAttribute as CFString, &menuBar)
    guard s == .success, let bar = menuBar else {
        emitError("no_menu_bar", "frontmost app exposes no AXMenuBar")
    }

    // Real macOS AX menu trees nest as: AXMenuBar → AXMenuBarItem →
    // AXMenu → AXMenuItem (and submenus add another AXMenu container
    // under each non-leaf AXMenuItem). The previous walk assumed
    // direct child relationships and silently tripped on the AXMenu
    // intermediate. Hardened version: descend through any single
    // AXMenu container automatically before matching the next segment.
    func childrenOf(_ element: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        let s = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw)
        if s != .success { return [] }
        return (raw as? [AXUIElement]) ?? []
    }

    func actionNames(_ element: AXUIElement) -> Set<String> {
        var raw: CFArray?
        guard AXUIElementCopyActionNames(element, &raw) == .success,
              let names = raw as? [String] else { return [] }
        return Set(names)
    }

    // After AXPress/AXShowMenu, AX child list can be empty for a few
    // dozen ms while the menu populates. Poll briefly so menu_command
    // doesn't race the population window.
    func childrenAfterOpen(_ element: AXUIElement) -> [AXUIElement] {
        for delayMs in [0, 30, 70, 130] {
            if delayMs > 0 { Thread.sleep(forTimeInterval: Double(delayMs) / 1000.0) }
            let kids = childrenOf(element)
            if !kids.isEmpty { return kids }
        }
        return []
    }

    // Skip past a single AXMenu intermediate to the actual menu items.
    func unwrapAXMenu(_ kids: [AXUIElement]) -> [AXUIElement] {
        if kids.count == 1, roleString(kids[0]) == "AXMenu" {
            return childrenOf(kids[0])
        }
        return kids
    }

    // Open a non-leaf menu node. Prefer kAXShowMenuAction when
    // exposed (the action name Apple defines for opening menus), fall
    // back to kAXPressAction. Returns true on success.
    func openMenuNode(_ element: AXUIElement) -> Bool {
        let actions = actionNames(element)
        if actions.contains(kAXShowMenuAction as String) {
            if AXUIElementPerformAction(element, kAXShowMenuAction as CFString) == .success {
                return true
            }
        }
        if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
            return true
        }
        return false
    }

    // Pick a child by exact title match, falling back to a unique
    // prefix match. Ambiguous prefix matches return nil + an error
    // string so the caller can emit ambiguous_menu_segment.
    func pickChild(_ kids: [AXUIElement], segment: String) -> (match: AXUIElement?, err: String?) {
        let needle = segment.lowercased()
        var exact: AXUIElement?
        var prefixMatches: [AXUIElement] = []
        for k in kids {
            let title = (axCopyString(k, kAXTitleAttribute as String) ?? "").lowercased()
            if title == needle {
                exact = k; break
            }
            if title.hasPrefix(needle) {
                prefixMatches.append(k)
            }
        }
        if let e = exact { return (e, nil) }
        if prefixMatches.count == 1 { return (prefixMatches[0], nil) }
        if prefixMatches.count > 1 {
            let titles = prefixMatches.compactMap { axCopyString($0, kAXTitleAttribute as String) }.joined(separator: ", ")
            return (nil, "ambiguous segment '\(segment)' — multiple prefix matches: [\(titles)]")
        }
        return (nil, nil)
    }

    var current = bar as! AXUIElement
    var kids = unwrapAXMenu(childrenOf(current))
    for (idx, segment) in args.enumerated() {
        if kids.isEmpty {
            emitError("menu_walk_failed", "no children at depth \(idx)")
        }
        let pick = pickChild(kids, segment: segment)
        if let err = pick.err {
            emitError("ambiguous_menu_segment", err)
        }
        guard let next = pick.match else {
            emitError("menu_segment_not_found", "no menu item matching '\(segment)' at depth \(idx)")
        }
        if idx == args.count - 1 {
            let status = AXUIElementPerformAction(next, kAXPressAction as CFString)
            if status != .success {
                emitError("press_failed", "ax_status=\(status.rawValue)")
            }
            var result: [String: Any] = [
                "ok": true,
                "path": args,
                "leaf": axCopyString(next, kAXTitleAttribute as String) ?? segment,
                "role": roleString(next),
            ]
            if let frame = frameOf(next) { result["frame"] = frame }
            emit(result)
            exit(0)
        }
        // Non-leaf: open it, poll briefly for children, then descend
        // through any AXMenu intermediate.
        if !openMenuNode(next) {
            emitError("menu_open_failed", "could not open '\(segment)' (AXShowMenu and AXPress both failed)")
        }
        let opened = childrenAfterOpen(next)
        kids = unwrapAXMenu(opened)
        current = next
    }
    emitInternalError("menu-command: unreachable")
}

// MARK: — Entry point

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    emitInternalError("usage: ax-helper <read-at|read-focused|write-at|write-focused|read-window|read-subtree|find-element|focus-element|focus-at|press-named|press-at|click-at|drag|scroll-at|hover-at|keystroke|key-hold|modifier-latch|type-text|select-range|select-all|select-substring|menu-command|subscribe|check> [args]")
}

let cmd = argv[1]
let rest = Array(argv.dropFirst(2))

switch cmd {
case "check":             cmdCheck()
case "read-at":           cmdReadAt(rest)
case "read-focused":      cmdReadFocused()
case "write-at":          cmdWriteAt(rest)
case "write-focused":     cmdWriteFocused(rest)
case "read-window":       cmdReadWindow()
case "read-subtree":      cmdReadSubtree(rest)
case "find-element":      cmdFindElement(rest)
case "focus-element":     cmdFocusElement(rest)
case "focus-at":          cmdFocusAt(rest)
case "press-named":       cmdPressNamed(rest)
case "press-at":          cmdPressAt(rest)
case "click-at":          cmdClickAt(rest)
case "drag":              cmdDrag(rest)
case "scroll-at":         cmdScrollAt(rest)
case "hover-at":          cmdHoverAt(rest)
case "keystroke":         cmdKeystroke(rest)
case "key-hold":          cmdKeyHold(rest)
case "modifier-latch":    cmdModifierLatch(rest)
case "type-text":         cmdTypeText(rest)
case "select-range":      cmdSelectRange(rest)
case "select-all":        cmdSelectAll()
case "select-substring":  cmdSelectSubstring(rest)
case "menu-command":      cmdMenuCommand(rest)
case "subscribe":         cmdSubscribe()
default:                  emitInternalError("unknown command: \(cmd)")
}
