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

func axCopyAttributeWithStatus(_ element: AXUIElement, _ key: String) -> (status: AXError, value: CFTypeRef?) {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, key as CFString, &value)
    return (status, status == .success ? value : nil)
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

func axCopyElementWithStatus(_ element: AXUIElement, _ key: String) -> (status: AXError, element: AXUIElement?) {
    let copied = axCopyAttributeWithStatus(element, key)
    guard copied.status == .success,
          let raw = copied.value,
          CFGetTypeID(raw) == AXUIElementGetTypeID() else {
        return (copied.status, nil)
    }
    return (copied.status, (raw as! AXUIElement))
}

func axCopyArrayWithStatus(_ element: AXUIElement, _ key: String) -> (status: AXError, array: [AXUIElement]) {
    let copied = axCopyAttributeWithStatus(element, key)
    guard copied.status == .success,
          let raw = copied.value,
          CFGetTypeID(raw) == CFArrayGetTypeID() else {
        return (copied.status, [])
    }
    return (copied.status, raw as! [AXUIElement])
}

func axCopyBool(_ element: AXUIElement, _ key: String) -> Bool? {
    guard let raw = axCopyAttribute(element, key) else { return nil }
    if CFGetTypeID(raw) == CFBooleanGetTypeID() {
        return CFBooleanGetValue((raw as! CFBoolean))
    }
    if let n = raw as? NSNumber {
        return n.boolValue
    }
    if let b = raw as? Bool {
        return b
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
    // the requested control while AX returns a child text node. Accept
    // target -> focused ancestry only. A focused ancestor such as AXWindow
    // does not mean the requested text control owns keyboard focus.
    if elementHasAncestor(target, child: focused) { return true }
    return false
}

func numericValue(_ value: Any?) -> Double? {
    if let d = value as? Double { return d }
    if let n = value as? NSNumber { return n.doubleValue }
    if let i = value as? Int { return Double(i) }
    return nil
}

func framePayloadMatches(_ payload: Any?, _ frame: [String: Any]?) -> Bool {
    guard let p = payload as? [String: Any], let f = frame else { return false }
    for key in ["x", "y", "w", "h"] {
        guard let pv = numericValue(p[key]), let fv = numericValue(f[key]) else {
            return false
        }
        if abs(pv - fv) > 1.0 { return false }
    }
    return true
}

func snapshotPayload(_ element: AXUIElement) -> [String: Any] {
    var result: [String: Any] = ["role": roleString(element)]
    if let pid = pidOf(element) { result["pid"] = Int(pid) }
    if let label = displayLabel(element) { result["label"] = label }
    if let frame = frameOf(element) { result["frame"] = frame }
    return result
}

func snapshotMatchesElement(_ snapshot: [String: Any], _ element: AXUIElement) -> Bool {
    guard let snapshotRole = snapshot["role"] as? String,
          snapshotRole == roleString(element) else { return false }
    if let snapshotPid = numericValue(snapshot["pid"]),
       let elementPid = pidOf(element),
       Int(snapshotPid) != Int(elementPid) {
        return false
    }
    return framePayloadMatches(snapshot["frame"], frameOf(element))
}

func snapshotMatchesTargetOrDescendant(
    _ snapshot: [String: Any],
    target: AXUIElement,
    depth: Int = 0,
    visited: NodeCounter = NodeCounter()
) -> Bool {
    visited.count += 1
    if snapshotMatchesElement(snapshot, target) { return true }
    if depth >= TREE_MAX_DEPTH || visited.count >= TREE_MAX_NODES { return false }
    for child in axCopyChildren(target) {
        if snapshotMatchesTargetOrDescendant(snapshot, target: child, depth: depth + 1, visited: visited) {
            return true
        }
    }
    return false
}

func currentExecutableURL() -> URL {
    let raw = CommandLine.arguments[0]
    if raw.hasPrefix("/") {
        return URL(fileURLWithPath: raw)
    }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(raw)
}

func freshFocusedSnapshot(timeoutMs: Int = 900, pid: pid_t? = nil) -> [String: Any]? {
    let process = Process()
    process.executableURL = currentExecutableURL()
    if let pid = pid {
        process.arguments = ["focused-snapshot", "--pid", String(Int(pid))]
    } else {
        process.arguments = ["focused-snapshot"]
    }
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    do {
        try process.run()
    } catch {
        return ["error": "fresh_spawn_failed", "detail": error.localizedDescription]
    }

    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.01)
    }
    if process.isRunning {
        process.terminate()
        return ["error": "fresh_timeout"]
    }

    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    guard !data.isEmpty else {
        return ["error": "fresh_empty"]
    }
    do {
        let raw = try JSONSerialization.jsonObject(with: data, options: [])
        return raw as? [String: Any]
    } catch {
        return ["error": "fresh_parse_failed", "detail": error.localizedDescription]
    }
}

func freshFocusDiagnostics(timeoutMs: Int = 3500) -> [String: Any]? {
    let process = Process()
    process.executableURL = currentExecutableURL()
    process.arguments = ["diagnostics"]
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr

    do {
        try process.run()
    } catch {
        return ["error": "diagnostics_spawn_failed", "detail": error.localizedDescription]
    }

    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.01)
    }
    if process.isRunning {
        process.terminate()
        return ["error": "diagnostics_timeout"]
    }

    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    guard !data.isEmpty else {
        return ["error": "diagnostics_empty"]
    }
    do {
        let raw = try JSONSerialization.jsonObject(with: data, options: [])
        return raw as? [String: Any]
    } catch {
        return ["error": "diagnostics_parse_failed", "detail": error.localizedDescription]
    }
}

func runningAppMeta(pid: pid_t) -> [String: Any] {
    var out: [String: Any] = ["pid": Int(pid)]
    if let app = NSRunningApplication(processIdentifier: pid) {
        out["name"] = app.localizedName ?? ""
        out["bundle_id"] = app.bundleIdentifier ?? ""
        out["activation_policy"] = Int(app.activationPolicy.rawValue)
        if let path = app.executableURL?.path {
            out["executable"] = path
        }
    }
    return out
}

func appMeta(_ app: NSRunningApplication) -> [String: Any] {
    var out: [String: Any] = [
        "pid": Int(app.processIdentifier),
        "name": app.localizedName ?? "",
        "bundle_id": app.bundleIdentifier ?? "",
        "activation_policy": Int(app.activationPolicy.rawValue),
        "is_active": app.isActive,
        "is_hidden": app.isHidden,
        "is_finished_launching": app.isFinishedLaunching,
    ]
    if let path = app.executableURL?.path {
        out["executable"] = path
    }
    return out
}

func windowDiagnosticsPayload(_ window: AXUIElement) -> [String: Any] {
    _ = AXUIElementSetMessagingTimeout(window, 0.08)
    var out: [String: Any] = ["role": roleString(window)]
    if let pid = pidOf(window) { out["pid"] = Int(pid) }
    if let subrole = axCopyString(window, kAXSubroleAttribute as String), !subrole.isEmpty {
        out["subrole"] = subrole
    }
    if let title = axCopyString(window, kAXTitleAttribute as String), !title.isEmpty {
        out["title"] = truncate(title, TREE_VALUE_TRUNC)
    } else if let label = displayLabel(window) {
        out["title"] = truncate(label, TREE_VALUE_TRUNC)
    }
    if let frame = frameOf(window) {
        out["frame"] = frame
    }
    if let isMain = axCopyBool(window, kAXMainAttribute as String) {
        out["is_main"] = isMain
    }
    if let isKey = axCopyBool(window, kAXFocusedAttribute as String) {
        out["is_key"] = isKey
    }
    return out
}

func focusedElementDiagnosticsPayload(_ element: AXUIElement) -> [String: Any] {
    _ = AXUIElementSetMessagingTimeout(element, 0.08)
    var out = snapshotPayload(element)
    if let subrole = axCopyString(element, kAXSubroleAttribute as String), !subrole.isEmpty {
        out["subrole"] = subrole
    }
    if let value = axCopyString(element, kAXValueAttribute as String), !value.isEmpty {
        out["value"] = truncate(value, TREE_VALUE_TRUNC)
    }
    return out
}

func windowish(_ element: AXUIElement) -> Bool {
    let role = roleString(element)
    return role == "AXWindow" || role == "AXSheet" || role == "AXDialog"
}

func isRootOperatorApp(_ app: NSRunningApplication) -> Bool {
    let fields = [
        app.localizedName ?? "",
        app.bundleIdentifier ?? "",
        app.executableURL?.path ?? "",
        app.bundleURL?.path ?? "",
    ].joined(separator: " ").lowercased()
    return fields.contains("root_operator")
        || fields.contains("root operator")
        || fields.contains("rootoperator")
        || fields.contains("hjertefolger.rootoperator")
}

func appWindowsDiagnostics(_ appElem: AXUIElement) -> (childrenStatus: AXError, windowsStatus: AXError, windows: [[String: Any]]) {
    let childResult = axCopyArrayWithStatus(appElem, kAXChildrenAttribute as String)
    let axWindowsResult = axCopyArrayWithStatus(appElem, kAXWindowsAttribute as String)
    var out: [[String: Any]] = []
    for child in childResult.array where windowish(child) {
        var payload = windowDiagnosticsPayload(child)
        payload["source"] = "AXChildren"
        out.append(payload)
    }
    for window in axWindowsResult.array where windowish(window) {
        var payload = windowDiagnosticsPayload(window)
        payload["source"] = "AXWindows"
        out.append(payload)
    }
    return (childResult.status, axWindowsResult.status, out)
}

func focusDiagnosticsPayload() -> [String: Any] {
    let system = AXUIElementCreateSystemWide()
    var result: [String: Any] = [
        "trusted": AXIsProcessTrusted(),
        "ts": Date().timeIntervalSince1970,
    ]

    if let front = NSWorkspace.shared.frontmostApplication {
        result["frontmost_application"] = appMeta(front)
    }

    let focusedAppResult = axCopyElementWithStatus(system, kAXFocusedApplicationAttribute as String)
    result["system_focused_application_status"] = Int(focusedAppResult.status.rawValue)
    if let focusedApp = focusedAppResult.element {
        var appPayload: [String: Any] = [:]
        if let pid = pidOf(focusedApp) {
            appPayload = runningAppMeta(pid: pid)
            let appElem = AXUIElementCreateApplication(pid)
            _ = AXUIElementSetMessagingTimeout(appElem, 0.2)
            let focusedWindowResult = axCopyElementWithStatus(appElem, kAXFocusedWindowAttribute as String)
            appPayload["focused_window_status"] = Int(focusedWindowResult.status.rawValue)
            if let focusedWindow = focusedWindowResult.element {
                appPayload["focused_window"] = windowDiagnosticsPayload(focusedWindow)
                let windowFocusedResult = axCopyElementWithStatus(focusedWindow, kAXFocusedUIElementAttribute as String)
                appPayload["window_focused_ui_element_status"] = Int(windowFocusedResult.status.rawValue)
                if let windowFocused = windowFocusedResult.element {
                    appPayload["window_focused_ui_element"] = focusedElementDiagnosticsPayload(windowFocused)
                }
            }
            let appFocusedElementResult = axCopyElementWithStatus(appElem, kAXFocusedUIElementAttribute as String)
            appPayload["focused_ui_element_status"] = Int(appFocusedElementResult.status.rawValue)
            if let focusedElement = appFocusedElementResult.element {
                appPayload["focused_ui_element"] = focusedElementDiagnosticsPayload(focusedElement)
            }
        }
        result["system_focused_application"] = appPayload
    }

    let systemFocusedElementResult = axCopyElementWithStatus(system, kAXFocusedUIElementAttribute as String)
    result["system_focused_ui_element_status"] = Int(systemFocusedElementResult.status.rawValue)
    if let focusedElement = systemFocusedElementResult.element {
        result["system_focused_ui_element"] = focusedElementDiagnosticsPayload(focusedElement)
    }

    var appPayloads: [[String: Any]] = []
    var roFocusedWindows: [[String: Any]] = []
    let apps = NSWorkspace.shared.runningApplications.sorted {
        let left = ($0.localizedName ?? "").lowercased()
        let right = ($1.localizedName ?? "").lowercased()
        if left != right { return left < right }
        return $0.processIdentifier < $1.processIdentifier
    }
    for app in apps {
        let pid = app.processIdentifier
        let appElem = AXUIElementCreateApplication(pid)
        _ = AXUIElementSetMessagingTimeout(appElem, 0.06)
        var payload = appMeta(app)

        let mainWindowResult = axCopyElementWithStatus(appElem, kAXMainWindowAttribute as String)
        payload["ax_main_window_status"] = Int(mainWindowResult.status.rawValue)
        if let mainWindow = mainWindowResult.element {
            payload["ax_main_window"] = windowDiagnosticsPayload(mainWindow)
        }

        let focusedWindowResult = axCopyElementWithStatus(appElem, kAXFocusedWindowAttribute as String)
        payload["ax_focused_window_status"] = Int(focusedWindowResult.status.rawValue)
        if let focusedWindow = focusedWindowResult.element {
            let focusedPayload = windowDiagnosticsPayload(focusedWindow)
            payload["ax_focused_window"] = focusedPayload
            if isRootOperatorApp(app) {
                var roPayload = focusedPayload
                roPayload["app"] = app.localizedName ?? ""
                roPayload["bundle_id"] = app.bundleIdentifier ?? ""
                roFocusedWindows.append(roPayload)
            }
        }

        let windowsResult = appWindowsDiagnostics(appElem)
        payload["ax_children_status"] = Int(windowsResult.childrenStatus.rawValue)
        payload["ax_windows_status"] = Int(windowsResult.windowsStatus.rawValue)
        if !windowsResult.windows.isEmpty {
            payload["windows"] = windowsResult.windows
        }
        if isRootOperatorApp(app) {
            for window in windowsResult.windows {
                if (window["is_key"] as? Bool) == true {
                    var roPayload = window
                    roPayload["app"] = app.localizedName ?? ""
                    roPayload["bundle_id"] = app.bundleIdentifier ?? ""
                    roFocusedWindows.append(roPayload)
                }
            }
        }
        appPayloads.append(payload)
    }
    result["running_applications"] = appPayloads
    result["root_operator_focused_windows"] = roFocusedWindows
    return result
}

func cmdDiagnostics() -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    emit(focusDiagnosticsPayload())
    exit(0)
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

func attributeNames(_ element: AXUIElement) -> [String] {
    var raw: CFArray?
    guard AXUIElementCopyAttributeNames(element, &raw) == .success,
          let names = raw as? [String] else { return [] }
    return names
}

func settableAttributeNames(_ element: AXUIElement) -> [String] {
    return attributeNames(element).filter { name in
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success
            && settable.boolValue
    }.sorted()
}

func normalizeAXActionName(_ raw: String?) -> String? {
    guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
        return nil
    }
    let lower = raw.lowercased()
    switch lower {
    case "press", "axpress", "kaxpressaction":
        return kAXPressAction as String
    case "show_menu", "showmenu", "axshowmenu", "kaxshowmenuaction", "context_menu", "contextmenu":
        return kAXShowMenuAction as String
    case "increment", "axincrement", "kaxincrementaction":
        return kAXIncrementAction as String
    case "decrement", "axdecrement", "kaxdecrementaction":
        return kAXDecrementAction as String
    case "confirm", "axconfirm", "kaxconfirmaction":
        return "AXConfirm"
    case "cancel", "axcancel", "kaxcancelaction":
        return "AXCancel"
    case "pick", "axpick", "kaxpickaction":
        return "AXPick"
    case "raise", "axraise", "kaxraiseaction":
        return kAXRaiseAction as String
    default:
        return raw
    }
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

func cmdFocusedSnapshot(_ args: [String] = []) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    if args.count >= 2, args[0] == "--pid", let rawPid = Int32(args[1]) {
        let appElem = AXUIElementCreateApplication(rawPid)
        if let element = axCopyElement(appElem, kAXFocusedUIElementAttribute as String) {
            var payload = snapshotPayload(element)
            payload["source"] = "app_focused_ui_element"
            emit(payload)
            exit(0)
        }
        if let window = axCopyElement(appElem, kAXFocusedWindowAttribute as String),
           let element = axCopyElement(window, kAXFocusedUIElementAttribute as String) {
            var payload = snapshotPayload(element)
            payload["source"] = "window_focused_ui_element"
            emit(payload)
            exit(0)
        }
    }
    guard let element = resolveFocusedElement() else {
        emitError("no_focused_element")
    }
    var payload = snapshotPayload(element)
    payload["source"] = "system_focused_ui_element"
    emit(payload)
    exit(0)
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
let TREE_MAX_DEPTH = 12
let TREE_MAX_NODES = 2000
let TREE_VALUE_TRUNC = 200
let TREE_MAX_CHILDREN_PER_ELEMENT: CFIndex = 250

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
    // Inspired by mediar-ai/MacosUseSDK's bounded/ranged child retrieval
    // pattern (MIT). Full AXChildren reads can block on large containers.
    var childCount: CFIndex = 0
    let countStatus = AXUIElementGetAttributeValueCount(
        element,
        kAXChildrenAttribute as CFString,
        &childCount
    )
    if countStatus == .success && childCount > 0 {
        var raw: CFArray?
        let fetchCount = min(TREE_MAX_CHILDREN_PER_ELEMENT, childCount)
        let status = AXUIElementCopyAttributeValues(
            element,
            kAXChildrenAttribute as CFString,
            0,
            fetchCount,
            &raw
        )
        if status == .success, let arr = raw as? [AXUIElement] {
            return arr
        }
    }

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
    skipRoles: Set<String>,
    preferRoles: Set<String>,
    out: inout [(elem: AXUIElement, score: Int, ordinal: Int)]
) {
    visited.count += 1
    if depth > TREE_MAX_DEPTH || visited.count > TREE_MAX_NODES { return }
    let currentRole = roleString(element)
    let roleOk = !skipRoles.contains(currentRole)
        && (role == nil || role!.isEmpty || roleMatches(element, role!))
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
            skipRoles: skipRoles,
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
    var frontmostBeforePid: pid_t?
    var frontmostBeforeApp: String?
    var frontmostBeforeBundleID: String?
    var frontmostAfterPid: pid_t?
    var frontmostAfterApp: String?
    var frontmostAfterBundleID: String?
    var frontmostSettled: Bool?
}

func statusPayload(_ statuses: [String: Int]) -> [String: Any] {
    var out: [String: Any] = [:]
    for (k, v) in statuses { out[k] = v }
    return out
}

func captureFrontmost(prefix: String, into tx: inout FocusTransaction) {
    guard let app = NSWorkspace.shared.frontmostApplication else { return }
    if prefix == "before" {
        tx.frontmostBeforePid = app.processIdentifier
        tx.frontmostBeforeApp = app.localizedName ?? ""
        tx.frontmostBeforeBundleID = app.bundleIdentifier ?? ""
    } else {
        tx.frontmostAfterPid = app.processIdentifier
        tx.frontmostAfterApp = app.localizedName ?? ""
        tx.frontmostAfterBundleID = app.bundleIdentifier ?? ""
    }
}

func waitForFrontmost(pid: pid_t, timeoutMs: Int = 650) -> Bool {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    repeat {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
            return true
        }
        Thread.sleep(forTimeInterval: 0.03)
    } while Date() < deadline
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
}

func addFocusTransactionDetails(_ result: inout [String: Any], _ tx: FocusTransaction) {
    if let pid = tx.pid { result["pid"] = Int(pid) }
    if let activated = tx.activated { result["app_activated"] = activated }
    if let settled = tx.frontmostSettled { result["frontmost_settled"] = settled }
    if let pid = tx.frontmostBeforePid { result["frontmost_before_pid"] = Int(pid) }
    if let app = tx.frontmostBeforeApp { result["frontmost_before_app"] = app }
    if let bundle = tx.frontmostBeforeBundleID { result["frontmost_before_bundle_id"] = bundle }
    if let pid = tx.frontmostAfterPid { result["frontmost_after_pid"] = Int(pid) }
    if let app = tx.frontmostAfterApp { result["frontmost_after_app"] = app }
    if let bundle = tx.frontmostAfterBundleID { result["frontmost_after_bundle_id"] = bundle }
}

func prepareFocusTransaction(target element: AXUIElement, window knownWindow: AXUIElement?) -> FocusTransaction {
    var tx = FocusTransaction(pid: pidOf(element), window: knownWindow)
    captureFrontmost(prefix: "before", into: &tx)
    if let owningWindow = resolveContainingWindow(element) {
        tx.window = owningWindow
        tx.statuses["target_window_resolved"] = 0
    } else if tx.window != nil {
        tx.statuses["target_window_resolved"] = -1
    }

    guard let pid = tx.pid else {
        return tx
    }

    if let running = NSRunningApplication(processIdentifier: pid) {
        if #available(macOS 14.0, *) {
            tx.activated = running.activate(options: [.activateAllWindows])
        } else {
            tx.activated = running.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
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
        let mainBeforeRaiseStatus = AXUIElementSetAttributeValue(
            window,
            kAXMainAttribute as CFString,
            kCFBooleanTrue
        )
        tx.statuses["window_main_before_raise"] = Int(mainBeforeRaiseStatus.rawValue)

        let focusedWindowStatus = AXUIElementSetAttributeValue(
            appElem,
            kAXFocusedWindowAttribute as CFString,
            window
        )
        tx.statuses["app_focused_window"] = Int(focusedWindowStatus.rawValue)

        let raiseStatus = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        tx.statuses["window_raise"] = Int(raiseStatus.rawValue)

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

    let focusedElementStatus = AXUIElementSetAttributeValue(
        appElem,
        kAXFocusedUIElementAttribute as CFString,
        element
    )
    tx.statuses["app_focused_ui_element"] = Int(focusedElementStatus.rawValue)

    tx.frontmostSettled = waitForFrontmost(pid: pid)
    captureFrontmost(prefix: "after", into: &tx)

    // App/window activation is asynchronous in several Cocoa apps. A short
    // settle makes the following AXFocused setter land after the key-window
    // transition instead of racing it.
    Thread.sleep(forTimeInterval: 0.12)
    return tx
}

struct FocusVerification {
    var matched: Bool
    var focused: AXUIElement?
    var snapshot: [String: Any]?
}

func waitForFocusToStick(target element: AXUIElement, timeoutMs: Int = 1200) -> FocusVerification {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    var lastFocused: AXUIElement? = nil
    var lastSnapshot: [String: Any]? = nil
    let targetPid = pidOf(element)
    repeat {
        if let focused = resolveFocusedElement() {
            lastFocused = focused
            if focusMatches(target: element, focused: focused) {
                if let snapshot = freshFocusedSnapshot(pid: targetPid) {
                    lastSnapshot = snapshot
                    if snapshotMatchesTargetOrDescendant(snapshot, target: element) {
                        return FocusVerification(matched: true, focused: focused, snapshot: snapshot)
                    }
                }
            }
        }
        Thread.sleep(forTimeInterval: 0.035)
    } while Date() < deadline
    if lastSnapshot == nil {
        lastSnapshot = freshFocusedSnapshot(pid: targetPid)
    }
    return FocusVerification(matched: false, focused: lastFocused, snapshot: lastSnapshot)
}

let FOCUS_PRESS_FALLBACK_ROLES: Set<String> = [
    "AXTextArea",
    "AXTextField",
    "AXSearchField",
]

func tryTextFocusPressFallback(_ element: AXUIElement, tx: inout FocusTransaction) -> Bool {
    let role = roleString(element)
    guard FOCUS_PRESS_FALLBACK_ROLES.contains(role),
          actionNames(element).contains(kAXPressAction as String) else {
        return false
    }
    let pressStatus = AXUIElementPerformAction(element, kAXPressAction as CFString)
    tx.statuses["target_press"] = Int(pressStatus.rawValue)
    Thread.sleep(forTimeInterval: 0.08)
    return pressStatus == .success
}

func tryTextFocusHIDFallback(_ element: AXUIElement, tx: inout FocusTransaction) -> [String: Any]? {
    let role = roleString(element)
    guard FOCUS_PRESS_FALLBACK_ROLES.contains(role),
          let point = centerPointOf(element) else {
        return nil
    }
    // Cursor-invariant HID bootstrap, used only after AX focus setters and
    // AXPress fail fresh verification. The click path restores and verifies
    // the hardware cursor before this focus action can continue.
    var click = hidClickPayload(point: point, button: "left", count: 1)
    tx.statuses["target_hid_click"] = click["error"] == nil ? 0 : -1
    click["target_role"] = role
    if let frame = frameOf(element) {
        click["target_frame"] = frame
    }
    Thread.sleep(forTimeInterval: 0.08)
    return click
}

func focusElementPayload(_ element: AXUIElement, window knownWindow: AXUIElement? = nil) -> [String: Any] {
    var tx = prepareFocusTransaction(target: element, window: knownWindow)
    var status = AXUIElementSetAttributeValue(
        element,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
    )
    tx.statuses["target_focused"] = Int(status.rawValue)
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
            tx.statuses["target_focused_retry"] = Int(status.rawValue)
            if status == .success {
                verified = waitForFocusToStick(target: element)
            }
        }
        if !verified.matched, tryTextFocusPressFallback(element, tx: &tx) {
            status = AXUIElementSetAttributeValue(
                element,
                kAXFocusedAttribute as CFString,
                kCFBooleanTrue
            )
            tx.statuses["target_focused_after_press"] = Int(status.rawValue)
            if status == .success {
                verified = waitForFocusToStick(target: element)
            }
        }
        if !verified.matched, let hidFallback = tryTextFocusHIDFallback(element, tx: &tx) {
            if hidFallback["error"] != nil {
                var failed = hidFallback
                failed["focus_context"] = "hid_focus_fallback"
                failed["focus_statuses"] = statusPayload(tx.statuses)
                addFocusTransactionDetails(&failed, tx)
                return failed
            }
            status = AXUIElementSetAttributeValue(
                element,
                kAXFocusedAttribute as CFString,
                kCFBooleanTrue
            )
            tx.statuses["target_focused_after_hid"] = Int(status.rawValue)
            if status == .success {
                verified = waitForFocusToStick(target: element)
            }
        }
        if verified.matched {
            var extras: [String: Any] = [
                "verified": true,
                "fresh_verified": true,
                "focus_statuses": statusPayload(tx.statuses),
            ]
            addFocusTransactionDetails(&extras, tx)
            if let snapshot = verified.snapshot {
                extras["fresh_focused"] = snapshot
            }
            var result: [String: Any] = [
                "ok": true,
                "action": "focus",
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
            return result
        }
        var result: [String: Any] = [
            "error": "focus_not_sticky",
            "role": roleString(element),
            "detail": "AXFocused setter succeeded, but system AXFocusedUIElement did not match the target within the settle window.",
            "focus_statuses": statusPayload(tx.statuses),
        ]
        addFocusTransactionDetails(&result, tx)
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
        if let snapshot = verified.snapshot {
            result["fresh_focused"] = snapshot
            if let freshError = snapshot["error"] {
                result["fresh_error"] = freshError
            }
        }
        if let frame = frameOf(element) { result["frame"] = frame }
        if let window = tx.window {
            result["target_window"] = windowDiagnosticsPayload(window)
        }
        if let diagnostics = freshFocusDiagnostics() {
            result["diagnostics"] = diagnostics
        }
        return result
    }
    if status == .attributeUnsupported || status == .notImplemented {
        var result: [String: Any] = [
            "error": "not_focusable",
            "role": roleString(element),
            "detail": "target does not accept kAXFocusedAttribute",
        ]
        if let frame = frameOf(element) { result["frame"] = frame }
        return result
    }
    var result: [String: Any] = [
        "error": "focus_failed",
        "role": roleString(element),
        "detail": "ax_status=\(status.rawValue)",
    ]
    if let frame = frameOf(element) { result["frame"] = frame }
    return result
}

func focusElement(_ element: AXUIElement, window knownWindow: AXUIElement? = nil) -> Never {
    let result = focusElementPayload(element, window: knownWindow)
    emit(result)
    exit(0)
}

func cmdFocusElement(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    let parsed = parseElementArgs(args, cmd: "focus-element")
    var roots: [AXUIElement] = []
    appendUniqueElement(resolveFocusedWindow(), to: &roots)
    for root in appRootCandidates(identifier: nil) {
        appendUniqueElement(root.element, to: &roots)
    }
    guard !roots.isEmpty else {
        emitError("no_window")
    }
    let visited = NodeCounter()
    var matches: [(elem: AXUIElement, score: Int, ordinal: Int)] = []
    for root in roots {
        collectElementCandidates(
            in: root,
            role: parsed.role,
            label: parsed.label,
            depth: 0,
            visited: visited,
            skipRoles: parsed.skipRoles,
            preferRoles: parsed.preferRoles,
            out: &matches
        )
    }
    guard let pick = resolveMatch(matches: matches, near: parsed.near, index: parsed.index) else {
        emit([
            "error": "not_found",
            "searched": visited.count,
            "match_count": matches.count,
        ])
        exit(0)
    }
    focusElement(pick.elem, window: resolveContainingWindow(pick.elem))
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
        skipRoles: parsed.skipRoles,
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

func currentCursorLocation() -> CGPoint? {
    if let event = CGEvent(source: nil) {
        return event.location
    }
    return nil
}

func pointPayload(_ p: CGPoint) -> [String: Any] {
    return [
        "x": Double(p.x),
        "y": Double(p.y),
    ]
}

func cursorRestorePayload(before: CGPoint?, tolerance: Double = 1.0) -> [String: Any] {
    guard let before = before else {
        return ["cursor_restored": false, "cursor_error": "cursor_unavailable"]
    }
    let started = Date()
    // The macOS event stream can report the click location for a short
    // moment after restore is posted. Save/restore follows the mcp-server
    // state contract (MIT) but adds a bounded settle-poll before declaring
    // cursor invariance.
    CGWarpMouseCursorPosition(before)
    CGAssociateMouseAndMouseCursorPosition(boolean_t(1))
    var last = currentCursorLocation() ?? before
    var best = last
    var bestDistance = Double.greatestFiniteMagnitude
    var stableHits = 0
    var attempts = 0
    for attempt in 1...36 {
        attempts = attempt
        Thread.sleep(forTimeInterval: 0.008)
        let after = currentCursorLocation() ?? last
        let dx = Double(after.x - before.x)
        let dy = Double(after.y - before.y)
        let distance = (dx * dx + dy * dy).squareRoot()
        if distance < bestDistance {
            bestDistance = distance
            best = after
        }
        let sx = Double(after.x - last.x)
        let sy = Double(after.y - last.y)
        let stableDelta = (sx * sx + sy * sy).squareRoot()
        if distance <= tolerance && stableDelta <= 0.25 {
            stableHits += 1
            if stableHits >= 2 {
                let elapsed = Date().timeIntervalSince(started) * 1000.0
                return [
                    "cursor_before": pointPayload(before),
                    "cursor_after": pointPayload(after),
                    "cursor_delta": distance,
                    "cursor_restored": true,
                    "cursor_restore_attempts": attempts,
                    "cursor_restore_settle_ms": elapsed,
                ]
            }
        } else if distance <= tolerance {
            stableHits = 1
        } else {
            stableHits = 0
        }
        last = after
    }
    let elapsed = Date().timeIntervalSince(started) * 1000.0
    return [
        "cursor_before": pointPayload(before),
        "cursor_after": pointPayload(best),
        "cursor_delta": bestDistance,
        "cursor_restored": bestDistance <= tolerance,
        "cursor_restore_attempts": attempts,
        "cursor_restore_settle_ms": elapsed,
    ]
}

func cursorInvariantPayload(before: CGPoint?, tolerance: Double = 1.0) -> [String: Any] {
    guard let before = before else {
        return ["cursor_unchanged": false, "cursor_error": "cursor_unavailable"]
    }
    let after = currentCursorLocation() ?? before
    let dx = Double(after.x - before.x)
    let dy = Double(after.y - before.y)
    let distance = (dx * dx + dy * dy).squareRoot()
    return [
        "cursor_before": pointPayload(before),
        "cursor_after": pointPayload(after),
        "cursor_delta": distance,
        "cursor_unchanged": distance <= tolerance,
    ]
}

func hidResultWithCursorRestore(
    _ result: [String: Any],
    before: CGPoint?,
    tolerance: Double = 1.0
) -> [String: Any] {
    let restore = cursorRestorePayload(before: before, tolerance: tolerance)
    guard (restore["cursor_restored"] as? Bool) == true else {
        var failed = restore
        failed["error"] = "cursor_restore_failed"
        failed["detail"] = restore["cursor_error"] as? String ?? "hardware cursor did not return within tolerance"
        if let action = result["action"] { failed["action"] = action }
        if let frame = result["frame"] { failed["frame"] = frame }
        return failed
    }
    var out = result
    for (k, v) in restore {
        out[k] = v
    }
    return out
}

func cmdCursorPosition() -> Never {
    guard let point = currentCursorLocation() else {
        emitError("cursor_unavailable")
    }
    emit([
        "ok": true,
        "x": Double(point.x),
        "y": Double(point.y),
    ])
    exit(0)
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
    let cursorBefore = currentCursorLocation()
    let clamped = clampRequired(rawPoint)
    postMouseMove(src, clamped.point)
    Thread.sleep(forTimeInterval: 0.025)
    for click in 1...count {
        postMouse(src, button.down, clamped.point, button.button, clickState: Int64(click))
        Thread.sleep(forTimeInterval: 0.025)
        postMouse(src, button.up, clamped.point, button.button, clickState: Int64(click))
        if click < count { Thread.sleep(forTimeInterval: 0.08) }
    }
    let result: [String: Any] = [
        "ok": true,
        "action": "click",
        "button": button.name,
        "count": count,
        "x": Double(clamped.point.x),
        "y": Double(clamped.point.y),
        "frame": pointFramePayload(clamped.point),
        "display": displayFramePayload(clamped.display),
    ]
    emit(hidResultWithCursorRestore(result, before: cursorBefore))
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
    let cursorBefore = currentCursorLocation()
    let clamped = clampRequired(rawPoint)
    postMouseMove(src, clamped.point)
    if durationMs > 0 {
        Thread.sleep(forTimeInterval: Double(durationMs) / 1000.0)
    }
    let result: [String: Any] = [
        "ok": true,
        "action": "hover",
        "x": Double(clamped.point.x),
        "y": Double(clamped.point.y),
        "frame": pointFramePayload(clamped.point),
        "display": displayFramePayload(clamped.display),
    ]
    emit(hidResultWithCursorRestore(result, before: cursorBefore))
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
    let cursorBefore = currentCursorLocation()
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
    let result: [String: Any] = [
        "ok": true,
        "action": "drag",
        "button": button.name,
        "duration_ms": durationMs,
        "from": ["x": Double(from.point.x), "y": Double(from.point.y)],
        "to": ["x": Double(to.point.x), "y": Double(to.point.y)],
        "frame": pointFramePayload(to.point),
        "display": displayFramePayload(to.display),
    ]
    emit(hidResultWithCursorRestore(result, before: cursorBefore))
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
    let cursorBefore = currentCursorLocation()
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
    let result: [String: Any] = [
        "ok": true,
        "action": "scroll",
        "dx": dx,
        "dy": dy,
        "x": Double(clamped.point.x),
        "y": Double(clamped.point.y),
        "frame": pointFramePayload(clamped.point),
        "display": displayFramePayload(clamped.display),
    ]
    emit(hidResultWithCursorRestore(result, before: cursorBefore))
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

// MARK: - Single-process action chains

final class ChainContext {
    var targets: [String: AXUIElement] = [:]
    var missingTargets: Set<String> = []
}

func stringValue(_ value: Any?) -> String? {
    if let s = value as? String { return s }
    return nil
}

func boolValue(_ value: Any?, default fallback: Bool = false) -> Bool {
    if let b = value as? Bool { return b }
    if let n = value as? NSNumber { return n.boolValue }
    if let s = value as? String {
        let lower = s.lowercased()
        if lower == "true" || lower == "1" || lower == "yes" { return true }
        if lower == "false" || lower == "0" || lower == "no" { return false }
    }
    return fallback
}

func intValue(_ value: Any?) -> Int? {
    if let i = value as? Int { return i }
    if let n = value as? NSNumber { return n.intValue }
    if let s = value as? String { return Int(s) }
    return nil
}

func doubleValue(_ value: Any?) -> Double? {
    if let d = value as? Double, d.isFinite { return d }
    if let n = value as? NSNumber {
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }
    if let s = value as? String, let d = Double(s), d.isFinite { return d }
    return nil
}

func stringArrayValue(_ value: Any?) -> [String] {
    guard let arr = value as? [Any] else { return [] }
    return arr.compactMap { $0 as? String }.filter { !$0.isEmpty }
}

func normalizedRole(_ raw: String?) -> String? {
    guard let raw = raw, !raw.isEmpty else { return nil }
    return raw.lowercased().hasPrefix("ax") ? raw : "AX" + raw
}

func runningApplication(bundleID: String) -> NSRunningApplication? {
    return NSWorkspace.shared.runningApplications.first {
        ($0.bundleIdentifier ?? "") == bundleID && !$0.isTerminated
    }
}

func applicationElement(bundleID: String) -> (app: NSRunningApplication, element: AXUIElement)? {
    guard let app = runningApplication(bundleID: bundleID) else { return nil }
    return (app, AXUIElementCreateApplication(app.processIdentifier))
}

func stepAppIdentifier(_ step: [String: Any]) -> String? {
    return stringValue(step["bundle_id"])
        ?? stringValue(step["bundle"])
        ?? stringValue(step["app"])
        ?? stringValue(step["application"])
}

func bundleIDForAppIdentifier(_ identifier: String?) -> String? {
    guard let raw = identifier?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
        return nil
    }
    if raw.contains(".") {
        return raw
    }
    if let running = NSWorkspace.shared.runningApplications.first(where: {
        !$0.isTerminated
            && (($0.localizedName ?? "").caseInsensitiveCompare(raw) == .orderedSame
                || ($0.bundleIdentifier ?? "").caseInsensitiveCompare(raw) == .orderedSame)
    }) {
        return running.bundleIdentifier
    }
    let candidates = [
        "/Applications/\(raw).app",
        "/System/Applications/\(raw).app",
        "/System/Applications/Utilities/\(raw).app",
    ]
    for path in candidates {
        let url = URL(fileURLWithPath: path)
        if let appURL = NSWorkspace.shared.urlForApplication(toOpen: url),
           let bundle = Bundle(url: appURL),
           let bundleID = bundle.bundleIdentifier {
            return bundleID
        }
    }
    return nil
}

func runningApplication(identifier: String?) -> NSRunningApplication? {
    guard let raw = identifier?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
        return nil
    }
    if let bundleID = bundleIDForAppIdentifier(raw),
       let app = runningApplication(bundleID: bundleID) {
        return app
    }
    return NSWorkspace.shared.runningApplications.first {
        !$0.isTerminated
            && (($0.localizedName ?? "").caseInsensitiveCompare(raw) == .orderedSame
                || ($0.bundleIdentifier ?? "").caseInsensitiveCompare(raw) == .orderedSame)
    }
}

func applicationElement(identifier: String?) -> (app: NSRunningApplication, element: AXUIElement)? {
    guard let app = runningApplication(identifier: identifier) else { return nil }
    return (app, AXUIElementCreateApplication(app.processIdentifier))
}

func appWindows(_ appElem: AXUIElement) -> [AXUIElement] {
    var roots: [AXUIElement] = []
    appendUniqueElement(axCopyElement(appElem, kAXFocusedWindowAttribute as String), to: &roots)
    appendUniqueElement(axCopyElement(appElem, kAXMainWindowAttribute as String), to: &roots)
    for window in axCopyArrayWithStatus(appElem, kAXWindowsAttribute as String).array {
        appendUniqueElement(window, to: &roots)
    }
    return roots
}

func appRootCandidates(identifier: String?) -> [(element: AXUIElement, origin: String)] {
    var roots: [(element: AXUIElement, origin: String)] = []
    func append(_ element: AXUIElement?, _ origin: String) {
        guard let element = element else { return }
        if roots.contains(where: { elementIdentityMatches($0.element, element) }) { return }
        roots.append((element, origin))
    }

    let pair: (app: NSRunningApplication, element: AXUIElement)?
    if let identifier = identifier {
        pair = applicationElement(identifier: identifier)
    } else if let active = resolveActiveAppElement(),
              let front = NSWorkspace.shared.frontmostApplication {
        pair = (front, active.element)
    } else {
        pair = nil
    }
    guard let found = pair else { return roots }
    let appElem = found.element
    append(axCopyElement(appElem, kAXFocusedWindowAttribute as String), "focused_window")
    append(axCopyElement(appElem, kAXMainWindowAttribute as String), "main_window")
    for window in axCopyArrayWithStatus(appElem, kAXWindowsAttribute as String).array {
        append(window, "window")
    }
    append(appElem, "app")
    return roots
}

func resolveWindowForApp(bundleID: String?) -> AXUIElement? {
    let appElem: AXUIElement
    if let bundleID = bundleID {
        guard let pair = applicationElement(identifier: bundleID) else { return nil }
        appElem = pair.element
    } else {
        guard let (_, elem) = resolveActiveAppElement() else { return nil }
        appElem = elem
    }

    return appWindows(appElem).first
}

func waitForAppWindow(bundleID: String, timeoutMs: Int) -> [String: Any] {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    repeat {
        if let pair = applicationElement(identifier: bundleID),
           let window = resolveWindowForApp(bundleID: bundleID) {
            var result: [String: Any] = [
                "ok": true,
                "bundle_id": pair.app.bundleIdentifier ?? bundleID,
                "pid": Int(pair.app.processIdentifier),
                "app": pair.app.localizedName ?? "",
                "window": windowDiagnosticsPayload(window),
            ]
            if let frame = frameOf(window) { result["frame"] = frame }
            return result
        }
        Thread.sleep(forTimeInterval: 0.05)
    } while Date() < deadline
    return [
        "error": "no_window",
        "detail": "No AX window for \(bundleID) within \(timeoutMs)ms",
    ]
}

func activateAndRaiseApp(_ app: NSRunningApplication, timeoutMs: Int) -> [String: Any] {
    var out: [String: Any] = [:]
    let activated: Bool
    if #available(macOS 14.0, *) {
        activated = app.activate(options: [.activateAllWindows])
    } else {
        activated = app.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
    }
    out["app_activated"] = activated

    let appElem = AXUIElementCreateApplication(app.processIdentifier)
    let frontmostStatus = AXUIElementSetAttributeValue(
        appElem,
        kAXFrontmostAttribute as CFString,
        kCFBooleanTrue
    )
    out["app_frontmost_status"] = Int(frontmostStatus.rawValue)
    out["frontmost_settled"] = waitForFrontmost(pid: app.processIdentifier, timeoutMs: timeoutMs)

    if let window = appWindows(appElem).first {
        let mainBeforeStatus = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        let focusedWindowStatus = AXUIElementSetAttributeValue(
            appElem,
            kAXFocusedWindowAttribute as CFString,
            window
        )
        let raiseStatus = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        let mainStatus = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        let focusedStatus = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        out["window_main_before_raise_status"] = Int(mainBeforeStatus.rawValue)
        out["app_focused_window_status"] = Int(focusedWindowStatus.rawValue)
        out["window_raise_status"] = Int(raiseStatus.rawValue)
        out["window_main_status"] = Int(mainStatus.rawValue)
        out["window_focused_status"] = Int(focusedStatus.rawValue)
        out["raised_window"] = windowDiagnosticsPayload(window)
        if let frame = frameOf(window) { out["frame"] = frame }
    }

    Thread.sleep(forTimeInterval: 0.08)
    return out
}

func launchAppPayload(bundleID: String, activate: Bool, timeoutMs: Int) -> [String: Any] {
    let resolvedBundleID = bundleIDForAppIdentifier(bundleID) ?? bundleID
    if let app = runningApplication(identifier: resolvedBundleID) {
        var result: [String: Any] = [
            "ok": true,
            "bundle_id": app.bundleIdentifier ?? resolvedBundleID,
            "pid": Int(app.processIdentifier),
            "app": app.localizedName ?? "",
            "already_running": true,
        ]
        if activate {
            for (k, v) in activateAndRaiseApp(app, timeoutMs: timeoutMs) {
                result[k] = v
            }
        }
        return result
    }

    guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: resolvedBundleID) != nil else {
        return ["error": "app_not_found", "detail": "No application for \(bundleID)"]
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = activate ? ["-b", resolvedBundleID] : ["-g", "-b", resolvedBundleID]
    let stderr = Pipe()
    process.standardError = stderr
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        return ["error": "launch_failed", "detail": error.localizedDescription]
    }
    if process.terminationStatus != 0 {
        let data = stderr.fileHandleForReading.readDataToEndOfFile()
        let detail = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return ["error": "launch_failed", "detail": detail]
    }

    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    var launched: NSRunningApplication?
    repeat {
        if let app = runningApplication(identifier: resolvedBundleID) {
            launched = app
            break
        }
        Thread.sleep(forTimeInterval: 0.05)
    } while Date() < deadline

    guard let app = launched else {
        return ["error": "launch_timeout", "detail": "Opening \(resolvedBundleID) exceeded \(timeoutMs)ms"]
    }
    var result: [String: Any] = [
        "ok": true,
        "bundle_id": app.bundleIdentifier ?? resolvedBundleID,
        "pid": Int(app.processIdentifier),
        "app": app.localizedName ?? "",
        "already_running": false,
    ]
    if activate {
        for (k, v) in activateAndRaiseApp(app, timeoutMs: timeoutMs) {
            result[k] = v
        }
    }
    return result
}

func stepElementArgs(_ step: [String: Any]) -> ElementArgs {
    let nearX = doubleValue(step["near_x"])
    let nearY = doubleValue(step["near_y"])
    let near = nearX != nil && nearY != nil ? CGPoint(x: nearX!, y: nearY!) : nil
    let skipRoles = Set(stringArrayValue(step["skip_roles"]).compactMap { normalizedRole($0) })
    let preferRoles = Set(stringArrayValue(step["prefer_roles"]).compactMap { normalizedRole($0) })
    return ElementArgs(
        label: stringValue(step["label"]),
        role: normalizedRole(stringValue(step["role"])),
        index: intValue(step["index"]) ?? 0,
        near: near,
        skipRoles: skipRoles,
        preferRoles: preferRoles
    )
}

func resolveSearchDiagnostics(step: [String: Any], context: ChainContext) -> (searched: Int, matchCount: Int) {
    let parsed = stepElementArgs(step)
    let roots = chainRootElements(step: step, context: context)
    if stepPoint(step) != nil {
        return (roots.count, 0)
    }
    let visited = NodeCounter()
    var matches: [(elem: AXUIElement, score: Int, ordinal: Int)] = []
    for root in roots {
        collectElementCandidates(
            in: root,
            role: parsed.role,
            label: parsed.label,
            depth: 0,
            visited: visited,
            skipRoles: parsed.skipRoles,
            preferRoles: parsed.preferRoles,
            out: &matches
        )
    }
    return (visited.count, matches.count)
}

func resolveElementPayload(step: [String: Any], context: ChainContext) -> [String: Any] {
    guard let name = stringValue(step["as"]) ?? stringValue(step["var"]), !name.isEmpty else {
        return ["error": "bad_step", "detail": "resolve requires non-empty 'as' or 'var'"]
    }
    guard let resolved = resolveElementFromStep(step: step, context: context) else {
        if boolValue(step["optional"], default: false) {
            context.targets.removeValue(forKey: name)
            context.missingTargets.insert(name)
            return [
                "ok": true,
                "as": name,
                "found": false,
                "optional": true,
            ]
        }
        let diag = resolveSearchDiagnostics(step: step, context: context)
        return [
            "error": "not_found",
            "searched": diag.searched,
            "match_count": diag.matchCount,
        ]
    }
    context.targets[name] = resolved.element
    context.missingTargets.remove(name)
    var result = elementPayload(resolved.element)
    result.merge([
        "ok": true,
        "as": name,
        "found": true,
        "searched": resolved.searched,
        "match_count": resolved.matchCount,
        "match_index": resolved.matchIndex,
    ]) { _, new in new }
    return result
}

func targetElement(_ step: [String: Any], context: ChainContext) -> (name: String, element: AXUIElement)? {
    let name = stringValue(step["target"]) ?? "target"
    guard let element = context.targets[name] else { return nil }
    return (name, element)
}

func stepPoint(_ step: [String: Any]) -> CGPoint? {
    if let point = step["point"] as? [String: Any],
       let x = doubleValue(point["x"]),
       let y = doubleValue(point["y"]) {
        return CGPoint(x: x, y: y)
    }
    if let x = doubleValue(step["x"]),
       let y = doubleValue(step["y"]) {
        return CGPoint(x: x, y: y)
    }
    return nil
}

func appendUniqueElement(_ element: AXUIElement?, to out: inout [AXUIElement]) {
    guard let element = element else { return }
    if out.contains(where: { elementIdentityMatches($0, element) }) { return }
    out.append(element)
}

func chainRootElements(step: [String: Any], context: ChainContext) -> [AXUIElement] {
    var roots: [AXUIElement] = []
    if let within = stringValue(step["within"]),
       let target = context.targets[within] {
        appendUniqueElement(target, to: &roots)
        return roots
    }

    let scope = (stringValue(step["scope"]) ?? "window").lowercased()
    let appIdentifier = stepAppIdentifier(step)

    switch scope {
    case "app", "application":
        for root in appRootCandidates(identifier: appIdentifier) {
            appendUniqueElement(root.element, to: &roots)
        }
    case "focused", "focus":
        appendUniqueElement(resolveFocusedElement(), to: &roots)
    case "system", "global", "menu", "menus":
        appendUniqueElement(resolveFocusedElement(), to: &roots)
        let system = AXUIElementCreateSystemWide()
        appendUniqueElement(axCopyElement(system, kAXFocusedUIElementAttribute as String), to: &roots)
        if let focusedApp = axCopyElement(system, kAXFocusedApplicationAttribute as String) {
            appendUniqueElement(focusedApp, to: &roots)
            if let pid = pidOf(focusedApp) {
                let appElem = AXUIElementCreateApplication(pid)
                appendUniqueElement(axCopyElement(appElem, kAXFocusedWindowAttribute as String), to: &roots)
                appendUniqueElement(axCopyElement(appElem, kAXMainWindowAttribute as String), to: &roots)
                appendUniqueElement(appElem, to: &roots)
            }
        }
        for root in appRootCandidates(identifier: appIdentifier) {
            appendUniqueElement(root.element, to: &roots)
        }
        appendUniqueElement(system, to: &roots)
    case "target":
        if let target = targetElement(step, context: context) {
            appendUniqueElement(target.element, to: &roots)
        }
    case "window", "focused_window", "frontmost_window":
        fallthrough
    default:
        appendUniqueElement(resolveWindowForApp(bundleID: appIdentifier), to: &roots)
        for root in appRootCandidates(identifier: appIdentifier) {
            appendUniqueElement(root.element, to: &roots)
        }
    }

    return roots
}

func findSmallestElementContainingPoint(
    in root: AXUIElement,
    point: CGPoint,
    skipRoles: Set<String>,
    preferredRoles: Set<String>,
    maxNodes: Int = TREE_MAX_NODES
) -> AXUIElement? {
    // Based on mediar-ai/MacosUseSDK's point tree-walk fallback (MIT):
    // hit-test does not reliably pierce Catalyst/list rows, but frames in
    // the AX tree still identify the smallest actionable containing node.
    var queue: [AXUIElement] = [root]
    var readIndex = 0
    var visited = 0
    var bestPreferred: (element: AXUIElement, area: Double)?
    var bestAny: (element: AXUIElement, area: Double)?
    while readIndex < queue.count && visited < maxNodes {
        let current = queue[readIndex]
        readIndex += 1
        visited += 1
        if let frame = frameOf(current),
           let x = frame["x"] as? Double,
           let y = frame["y"] as? Double,
           let w = frame["w"] as? Double,
           let h = frame["h"] as? Double,
           CGRect(x: x, y: y, width: w, height: h).contains(point) {
            let currentRole = roleString(current)
            let area = max(0, w) * max(0, h)
            if skipRoles.contains(currentRole) {
                // Keep walking through skipped containers, but don't choose
                // them as the hit target.
            } else if preferredRoles.contains(currentRole) {
                if bestPreferred == nil || area < bestPreferred!.area {
                    bestPreferred = (current, area)
                }
            } else if bestAny == nil || area < bestAny!.area {
                bestAny = (current, area)
            }
        }
        queue.append(contentsOf: axCopyChildrenForWalk(current, preferRoles: preferredRoles))
    }
    return bestPreferred?.element ?? bestAny?.element
}

func resolveElementFromStep(
    step: [String: Any],
    context: ChainContext
) -> (element: AXUIElement, searched: Int, matchCount: Int, matchIndex: Int)? {
    let parsed = stepElementArgs(step)
    if let point = stepPoint(step) {
        let roots = chainRootElements(step: step, context: context)
        for root in roots {
            if let found = findSmallestElementContainingPoint(
                in: root,
                point: point,
                skipRoles: parsed.skipRoles,
                preferredRoles: parsed.preferRoles
            ) {
                return (found, 1, 1, 0)
            }
        }
        if let appIdentifier = stepAppIdentifier(step),
           let pair = applicationElement(identifier: appIdentifier) {
            var hit: AXUIElement?
            let status = AXUIElementCopyElementAtPosition(pair.element, Float(point.x), Float(point.y), &hit)
            if status == .success, let hit = hit {
                return (hit, 1, 1, 0)
            }
        } else if let hit = resolveElementAtPoint(Float(point.x), Float(point.y)) {
            return (hit, 1, 1, 0)
        }
        return nil
    }

    if (parsed.label == nil || parsed.label!.isEmpty) && (parsed.role == nil || parsed.role!.isEmpty) {
        return nil
    }
    let roots = chainRootElements(step: step, context: context)
    let visited = NodeCounter()
    var matches: [(elem: AXUIElement, score: Int, ordinal: Int)] = []
    for root in roots {
        collectElementCandidates(
            in: root,
            role: parsed.role,
            label: parsed.label,
            depth: 0,
            visited: visited,
            skipRoles: parsed.skipRoles,
            preferRoles: parsed.preferRoles,
            out: &matches
        )
    }
    guard let pick = resolveMatch(matches: matches, near: parsed.near, index: parsed.index) else {
        return nil
    }
    return (pick.elem, visited.count, pick.total, pick.rank)
}

func elementPayload(_ element: AXUIElement) -> [String: Any] {
    var result: [String: Any] = [
        "role": roleString(element),
        "actions": actionNames(element).sorted(),
        "settable_attributes": settableAttributeNames(element),
    ]
    if let label = displayLabel(element) { result["label"] = label }
    if let frame = frameOf(element) { result["frame"] = frame }
    if let value = axCopyString(element, kAXValueAttribute as String), !value.isEmpty {
        result["value"] = truncate(value, TREE_VALUE_TRUNC)
    }
    return result
}

func elementOrAncestorSupportingAction(_ element: AXUIElement, action: String, maxDepth: Int = 12) -> AXUIElement {
    if actionNames(element).contains(action) { return element }
    var current = element
    for _ in 0..<maxDepth {
        guard let parent = axCopyElement(current, kAXParentAttribute as String) else { break }
        if actionNames(parent).contains(action) { return parent }
        current = parent
    }
    return element
}

func elementOrAncestorSettable(_ element: AXUIElement, attribute: String, maxDepth: Int = 12) -> AXUIElement {
    if settableAttributeNames(element).contains(attribute) { return element }
    var current = element
    for _ in 0..<maxDepth {
        guard let parent = axCopyElement(current, kAXParentAttribute as String) else { break }
        if settableAttributeNames(parent).contains(attribute) { return parent }
        current = parent
    }
    return element
}

func centerPointOf(_ element: AXUIElement) -> CGPoint? {
    guard let frame = frameOf(element),
          let x = frame["x"] as? Double,
          let y = frame["y"] as? Double,
          let w = frame["w"] as? Double,
          let h = frame["h"] as? Double else { return nil }
    return CGPoint(x: x + w / 2.0, y: y + h / 2.0)
}

func hidClickPayload(point rawPoint: CGPoint, button: String, count: Int = 1) -> [String: Any] {
    let mouseButton = parseMouseButton(button)
    guard count >= 1 && count <= 3 else {
        return ["error": "bad_count", "detail": "click count must be 1, 2, or 3"]
    }
    guard let src = makeEventSource() else {
        return ["error": "event_source_private_failed", "detail": "CGEventSource(.privateState) returned nil"]
    }
    let cursorBefore = currentCursorLocation()
    let clamped = clampRequired(rawPoint)
    postMouseMove(src, clamped.point)
    Thread.sleep(forTimeInterval: 0.025)
    for click in 1...count {
        postMouse(src, mouseButton.down, clamped.point, mouseButton.button, clickState: Int64(click))
        Thread.sleep(forTimeInterval: 0.025)
        postMouse(src, mouseButton.up, clamped.point, mouseButton.button, clickState: Int64(click))
        if click < count { Thread.sleep(forTimeInterval: 0.08) }
    }
    let result: [String: Any] = [
        "ok": true,
        "action": "hid_click",
        "button": mouseButton.name,
        "count": count,
        "x": Double(clamped.point.x),
        "y": Double(clamped.point.y),
        "frame": pointFramePayload(clamped.point),
        "display": displayFramePayload(clamped.display),
    ]
    return hidResultWithCursorRestore(result, before: cursorBefore)
}

func pressNamedPayload(step: [String: Any]) -> [String: Any] {
    guard let label = stringValue(step["label"]), !label.isEmpty else {
        return ["error": "bad_step", "detail": "press_named requires label"]
    }
    let appIdentifier = stepAppIdentifier(step)
    let role = normalizedRole(stringValue(step["role"]))
    let nearX = doubleValue(step["near_x"])
    let nearY = doubleValue(step["near_y"])
    let near = nearX != nil && nearY != nil ? CGPoint(x: nearX!, y: nearY!) : nil
    let index = intValue(step["index"]) ?? 0

    var lastFailure: [String: Any] = ["error": "press_failed", "detail": "not attempted"]
    for attempt in 0..<16 {
        let roots = appRootCandidates(identifier: appIdentifier)
            .map { $0.element }
        guard !roots.isEmpty else {
            lastFailure = ["error": "no_window", "detail": appIdentifier ?? "frontmost app"]
            Thread.sleep(forTimeInterval: 0.25)
            continue
        }
        let visited = NodeCounter()
        var matches: [(elem: AXUIElement, score: Int, ordinal: Int)] = []
        for root in roots {
            collectMatches(in: root, role: role, label: label, depth: 0, visited: visited, out: &matches)
        }
        guard let pick = resolveMatch(matches: matches, near: near, index: index) else {
            lastFailure = [
                "error": "not_found",
                "searched": visited.count,
                "match_count": matches.count,
            ]
            Thread.sleep(forTimeInterval: 0.25)
            continue
        }
        let elemRole = roleString(pick.elem)
        if !PRESS_ALLOWED_ROLES.contains(elemRole) {
            return [
                "error": "unsupported_role",
                "role": elemRole,
                "match_count": pick.total,
                "match_index": pick.rank,
                "detail": "AX press is restricted to button-like roles.",
            ]
        }
        let status = AXUIElementPerformAction(pick.elem, kAXPressAction as CFString)
        if status == .success {
            var result: [String: Any] = [
                "ok": true,
                "action": "press",
                "role": elemRole,
                "match_count": pick.total,
                "match_index": pick.rank,
                "attempt": attempt + 1,
            ]
            if let foundLabel = displayLabel(pick.elem) { result["label"] = foundLabel }
            if let frame = frameOf(pick.elem) { result["frame"] = frame }
            return result
        }
        lastFailure = [
            "error": "press_failed",
            "role": elemRole,
            "detail": "ax_status=\(status.rawValue)",
            "attempt": attempt + 1,
        ]
        Thread.sleep(forTimeInterval: 0.25)
    }
    return lastFailure
}

func setValuePayload(element: AXUIElement, text: String) -> [String: Any] {
    let role = roleString(element)
    if WRITE_BLOCKED_ROLES.contains(role) {
        return ["error": "blocked_role", "role": role]
    }
    if !WRITE_ALLOWED_ROLES.contains(role) {
        return ["error": "unsupported_role", "role": role]
    }
    let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
    if status != .success {
        return ["error": "value_write_failed", "role": role, "detail": "ax_status=\(status.rawValue)"]
    }
    let verified = waitForAXAttributeValue(element, kAXValueAttribute as String, expected: text)
    if !verified.matched {
        var failed: [String: Any] = [
            "error": "value_verify_failed",
            "role": role,
            "expected": text,
            "actual": verified.actual,
            "detail": "AXValue did not match after AXUIElementSetAttributeValue succeeded",
        ]
        if let frame = frameOf(element) { failed["frame"] = frame }
        return failed
    }
    var result: [String: Any] = [
        "ok": true,
        "action": "set_value",
        "role": role,
        "length": (text as NSString).length,
        "verified": true,
    ]
    if let frame = frameOf(element) { result["frame"] = frame }
    return result
}

func selectRangePayload(element: AXUIElement, location: Int, length: Int) -> [String: Any] {
    if location < 0 || length < 0 {
        return ["error": "bad_range", "detail": "negative values not allowed"]
    }
    let total = axNumberOfCharacters(element) ?? 0
    if location > total {
        return ["error": "out_of_range", "detail": "location \(location) > length \(total)"]
    }
    let capped = min(length, total - location)
    let status = setSelectedRange(element, location: location, length: capped)
    if status != .success {
        return ["error": "set_failed", "detail": "ax_status=\(status.rawValue)"]
    }
    var result: [String: Any] = [
        "ok": true,
        "action": "select_range",
        "location": location,
        "length": capped,
        "total_chars": total,
        "role": roleString(element),
    ]
    if let frame = frameOf(element) { result["frame"] = frame }
    return result
}

func insertTextPayload(element: AXUIElement, text: String, location: Int?) -> [String: Any] {
    if let loc = location {
        let selected = selectRangePayload(element: element, location: loc, length: 0)
        if selected["error"] != nil { return selected }
    }
    let status = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
    if status != .success {
        return ["error": "insert_failed", "role": roleString(element), "detail": "ax_status=\(status.rawValue)"]
    }
    Thread.sleep(forTimeInterval: 0.05)
    var result: [String: Any] = [
        "ok": true,
        "action": "insert_text",
        "role": roleString(element),
        "length": (text as NSString).length,
    ]
    if let frame = frameOf(element) { result["frame"] = frame }
    return result
}

func readTargetPayload(element: AXUIElement) -> [String: Any] {
    let (value, selected) = readElementText(element)
    var result: [String: Any] = [
        "ok": true,
        "role": roleString(element),
        "value": value as Any? ?? NSNull(),
        "selectedText": selected as Any? ?? NSNull(),
    ]
    if let frame = frameOf(element) { result["frame"] = frame }
    return result
}

func verifyValuePayload(element: AXUIElement, equals: String?, contains: String?) -> [String: Any] {
    let value = axCopyString(element, kAXValueAttribute as String) ?? ""
    if let expected = equals, value != expected {
        return [
            "error": "value_mismatch",
            "detail": "value did not equal expected",
            "expected": expected,
            "actual": value,
        ]
    }
    if let needle = contains, !value.contains(needle) {
        return [
            "error": "value_missing",
            "detail": "value did not contain expected text",
            "expected": needle,
            "actual": value,
        ]
    }
    return [
        "ok": true,
        "action": "verify_value",
        "length": (value as NSString).length,
        "value": value,
    ]
}

func performMenuCommandPayload(_ args: [String], bundleID: String? = nil, activate: Bool = true) -> [String: Any] {
    if args.isEmpty {
        return ["error": "bad_step", "detail": "menu requires non-empty path"]
    }

    let app: NSRunningApplication
    if let bundleID = bundleID {
        guard let found = runningApplication(identifier: bundleID) else {
            return ["error": "app_not_running", "detail": bundleID]
        }
        app = found
    } else {
        guard let front = NSWorkspace.shared.frontmostApplication else {
            return ["error": "no_app", "detail": "no frontmost application"]
        }
        app = front
    }

    if activate {
        if #available(macOS 14.0, *) {
            _ = app.activate(options: [.activateAllWindows])
        } else {
            _ = app.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
        }
        _ = waitForFrontmost(pid: app.processIdentifier, timeoutMs: 800)
    }

    let appElem = AXUIElementCreateApplication(app.processIdentifier)
    var menuBar: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(appElem, kAXMenuBarAttribute as CFString, &menuBar)
    guard status == .success, let bar = menuBar else {
        return ["error": "no_menu_bar", "detail": "target app exposes no AXMenuBar"]
    }

    func childrenOf(_ element: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        let s = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw)
        if s != .success { return [] }
        return (raw as? [AXUIElement]) ?? []
    }

    func childrenAfterOpen(_ element: AXUIElement) -> [AXUIElement] {
        for delayMs in [0, 30, 70, 130] {
            if delayMs > 0 { Thread.sleep(forTimeInterval: Double(delayMs) / 1000.0) }
            let kids = childrenOf(element)
            if !kids.isEmpty { return kids }
        }
        return []
    }

    func unwrapAXMenu(_ kids: [AXUIElement]) -> [AXUIElement] {
        if kids.count == 1, roleString(kids[0]) == "AXMenu" {
            return childrenOf(kids[0])
        }
        return kids
    }

    func openMenuNode(_ element: AXUIElement) -> Bool {
        let actions = actionNames(element)
        if actions.contains(kAXShowMenuAction as String),
           AXUIElementPerformAction(element, kAXShowMenuAction as CFString) == .success {
            return true
        }
        return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
    }

    func pickChild(_ kids: [AXUIElement], segment: String) -> (match: AXUIElement?, err: String?) {
        let needle = segment.lowercased()
        var exact: AXUIElement?
        var prefixMatches: [AXUIElement] = []
        for k in kids {
            let title = (axCopyString(k, kAXTitleAttribute as String) ?? "").lowercased()
            if title == needle {
                exact = k
                break
            }
            if title.hasPrefix(needle) {
                prefixMatches.append(k)
            }
        }
        if let e = exact { return (e, nil) }
        if prefixMatches.count == 1 { return (prefixMatches[0], nil) }
        if prefixMatches.count > 1 {
            let titles = prefixMatches.compactMap { axCopyString($0, kAXTitleAttribute as String) }.joined(separator: ", ")
            return (nil, "ambiguous segment '\(segment)' - multiple prefix matches: [\(titles)]")
        }
        return (nil, nil)
    }

    var kids = unwrapAXMenu(childrenOf(bar as! AXUIElement))
    for (idx, segment) in args.enumerated() {
        if kids.isEmpty {
            return ["error": "menu_walk_failed", "detail": "no children at depth \(idx)"]
        }
        let pick = pickChild(kids, segment: segment)
        if let err = pick.err {
            return ["error": "ambiguous_menu_segment", "detail": err]
        }
        guard let next = pick.match else {
            return ["error": "menu_segment_not_found", "detail": "no menu item matching '\(segment)' at depth \(idx)"]
        }
        if idx == args.count - 1 {
            let press = AXUIElementPerformAction(next, kAXPressAction as CFString)
            if press != .success {
                return ["error": "press_failed", "detail": "ax_status=\(press.rawValue)"]
            }
            var result: [String: Any] = [
                "ok": true,
                "action": "menu",
                "path": args,
                "leaf": axCopyString(next, kAXTitleAttribute as String) ?? segment,
                "role": roleString(next),
                "bundle_id": app.bundleIdentifier ?? "",
                "app": app.localizedName ?? "",
            ]
            if let frame = frameOf(next) { result["frame"] = frame }
            return result
        }
        if !openMenuNode(next) {
            return ["error": "menu_open_failed", "detail": "could not open '\(segment)'"]
        }
        kids = unwrapAXMenu(childrenAfterOpen(next))
    }
    return ["error": "internal", "detail": "unreachable menu walk"]
}

func performGenericActionPayload(step: [String: Any], context: ChainContext) -> [String: Any] {
    let targetName = stringValue(step["target"]) ?? "target"
    if context.missingTargets.contains(targetName), boolValue(step["optional"], default: false) {
        return ["ok": true, "action": "perform_action", "target": targetName, "skipped": true, "reason": "optional_target_missing"]
    }
    guard let target = targetElement(step, context: context) else {
        if boolValue(step["optional"], default: false) {
            return ["ok": true, "action": "perform_action", "target": targetName, "skipped": true, "reason": "optional_target_missing"]
        }
        return ["error": "unknown_target", "detail": targetName]
    }
    guard let action = normalizeAXActionName(stringValue(step["action"])) else {
        return ["error": "bad_step", "detail": "perform_action requires action"]
    }

    let actionTarget = elementOrAncestorSupportingAction(target.element, action: action)
    let available = actionNames(actionTarget)
    let status = AXUIElementPerformAction(actionTarget, action as CFString)
    if status == .success {
        var result = elementPayload(actionTarget)
        result.merge([
            "ok": true,
            "action": "perform_action",
            "performed": action,
            "target": target.name,
        ]) { _, new in new }
        return result
    }

    if action == (kAXShowMenuAction as String),
       boolValue(step["fallback_right_click"], default: true),
       let point = centerPointOf(actionTarget) ?? centerPointOf(target.element) {
        var result = hidClickPayload(point: point, button: "right", count: 1)
        if result["error"] == nil {
            result["fallback"] = "right_click"
            result["performed"] = action
            result["target"] = target.name
        }
        return result
    }

    var result: [String: Any] = [
        "error": "action_failed",
        "target": target.name,
        "requested_action": action,
        "role": roleString(actionTarget),
        "available_actions": available.sorted(),
        "detail": "ax_status=\(status.rawValue)",
    ]
    if let frame = frameOf(actionTarget) { result["frame"] = frame }
    return result
}

func normalizedAXAttributeName(_ raw: String?) -> String? {
    guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
        return nil
    }
    let lower = raw.lowercased()
    switch lower {
    case "value", "axvalue", "kaxvalueattribute":
        return kAXValueAttribute as String
    case "selected", "axselected", "kaxselectedattribute":
        return kAXSelectedAttribute as String
    case "focused", "focus", "axfocused", "kaxfocusedattribute":
        return kAXFocusedAttribute as String
    case "selected_text", "selectedtext", "axselectedtext", "kaxselectedtextattribute":
        return kAXSelectedTextAttribute as String
    default:
        return raw
    }
}

func cfValueForAX(_ value: Any?) -> CFTypeRef? {
    if value is NSNull { return nil }
    if let s = value as? String { return s as CFString }
    if let b = value as? Bool { return (b ? kCFBooleanTrue : kCFBooleanFalse) }
    if let n = value as? NSNumber { return n }
    if let i = value as? Int { return NSNumber(value: i) }
    if let d = value as? Double { return NSNumber(value: d) }
    return nil
}

func serializableAXValue(_ value: CFTypeRef?) -> Any {
    guard let value = value else { return NSNull() }
    let typeID = CFGetTypeID(value)
    if typeID == CFStringGetTypeID(), let s = value as? String { return s }
    if typeID == CFBooleanGetTypeID() { return CFBooleanGetValue((value as! CFBoolean)) }
    if let n = value as? NSNumber { return n }
    if typeID == AXUIElementGetTypeID() { return ["role": roleString(value as! AXUIElement)] }
    return String(describing: value)
}

func axAttributeMatchesExpected(_ actual: CFTypeRef?, expected: Any?) -> Bool {
    guard let actual = actual else { return expected == nil || expected is NSNull }
    if let expected = expected as? String {
        if CFGetTypeID(actual) == CFStringGetTypeID(), let s = actual as? String {
            return s == expected
        }
        return String(describing: actual) == expected
    }
    if let expected = expected as? Bool {
        if CFGetTypeID(actual) == CFBooleanGetTypeID() {
            return CFBooleanGetValue((actual as! CFBoolean)) == expected
        }
        if let n = actual as? NSNumber {
            return n.boolValue == expected
        }
        return false
    }
    if let expected = expected as? NSNumber,
       let actualNumber = actual as? NSNumber {
        return actualNumber == expected
    }
    if let expected = expected as? Int,
       let actualNumber = actual as? NSNumber {
        return actualNumber.intValue == expected
    }
    if let expected = expected as? Double,
       let actualNumber = actual as? NSNumber {
        return abs(actualNumber.doubleValue - expected) <= 0.0001
    }
    return false
}

func waitForAXAttributeValue(
    _ element: AXUIElement,
    _ attribute: String,
    expected: Any?,
    timeoutMs: Int = 700
) -> (matched: Bool, actual: Any) {
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
    var last: CFTypeRef? = nil
    repeat {
        last = axCopyAttribute(element, attribute)
        if axAttributeMatchesExpected(last, expected: expected) {
            return (true, serializableAXValue(last))
        }
        Thread.sleep(forTimeInterval: 0.035)
    } while Date() < deadline
    return (false, serializableAXValue(last))
}

func setGenericAttributePayload(step: [String: Any], context: ChainContext) -> [String: Any] {
    let targetName = stringValue(step["target"]) ?? "target"
    guard let target = targetElement(step, context: context) else {
        return ["error": "unknown_target", "detail": targetName]
    }
    guard let attribute = normalizedAXAttributeName(stringValue(step["attribute"])) else {
        return ["error": "bad_step", "detail": "set_attribute requires attribute"]
    }

    let attrTarget = elementOrAncestorSettable(target.element, attribute: attribute)
    if attribute == kAXSelectedTextRangeAttribute as String {
        guard let location = intValue(step["location"]),
              let length = intValue(step["length"]) else {
            return ["error": "bad_step", "detail": "AXSelectedTextRange requires location and length"]
        }
        return selectRangePayload(element: attrTarget, location: location, length: length)
    }

    let rawValue = step.keys.contains("value") ? step["value"] : step["text"]
    guard let cfValue = cfValueForAX(rawValue) else {
        return ["error": "bad_step", "detail": "set_attribute requires value"]
    }
    let status = AXUIElementSetAttributeValue(attrTarget, attribute as CFString, cfValue)
    if status != .success {
        var result: [String: Any] = [
            "error": "set_attribute_failed",
            "target": target.name,
            "attribute": attribute,
            "role": roleString(attrTarget),
            "settable_attributes": settableAttributeNames(attrTarget),
            "detail": "ax_status=\(status.rawValue)",
        ]
        if let frame = frameOf(attrTarget) { result["frame"] = frame }
        return result
    }
    var verified = false
    if attribute != kAXSelectedTextAttribute as String {
        let verification = waitForAXAttributeValue(attrTarget, attribute, expected: rawValue)
        if !verification.matched {
            var result: [String: Any] = [
                "error": "set_attribute_verify_failed",
                "target": target.name,
                "attribute": attribute,
                "role": roleString(attrTarget),
                "expected": rawValue as Any,
                "actual": verification.actual,
                "detail": "\(attribute) did not match after AXUIElementSetAttributeValue succeeded",
            ]
            if let frame = frameOf(attrTarget) { result["frame"] = frame }
            return result
        }
        verified = true
    } else {
        Thread.sleep(forTimeInterval: 0.05)
    }
    var result = elementPayload(attrTarget)
    result.merge([
        "ok": true,
        "action": "set_attribute",
        "target": target.name,
        "attribute": attribute,
        "verified": verified,
    ]) { _, new in new }
    return result
}

func verifyPresencePayload(step: [String: Any], context: ChainContext, expectPresent: Bool) -> [String: Any] {
    let found = resolveElementFromStep(step: step, context: context)
    if expectPresent, let found = found {
        var result = elementPayload(found.element)
        result.merge([
            "ok": true,
            "action": "verify_present",
            "found": true,
        ]) { _, new in new }
        return result
    }
    if expectPresent {
        return ["error": "verify_present_failed", "detail": "target was not found"]
    }
    if found != nil {
        return ["error": "verify_absent_failed", "detail": "target still exists"]
    }
    return ["ok": true, "action": "verify_absent", "found": false]
}

func hidStepPayload(step: [String: Any], context: ChainContext) -> [String: Any] {
    let kind = (stringValue(step["kind"]) ?? stringValue(step["action"]) ?? "click").lowercased()
    let point: CGPoint?
    if let p = stepPoint(step) {
        point = p
    } else if let target = targetElement(step, context: context) {
        point = centerPointOf(target.element)
    } else {
        point = nil
    }
    guard let point = point else {
        return ["error": "bad_step", "detail": "hid step requires x/y or target with frame"]
    }
    switch kind {
    case "click", "right_click", "rightclick", "context_menu", "contextmenu":
        let defaultButton = kind == "right_click" || kind == "rightclick" || kind == "context_menu" || kind == "contextmenu"
            ? "right"
            : "left"
        return hidClickPayload(
            point: point,
            button: stringValue(step["button"]) ?? defaultButton,
            count: intValue(step["count"]) ?? 1
        )
    default:
        return ["error": "unsupported_hid_kind", "detail": kind]
    }
}

func performChainStep(_ step: [String: Any], context: ChainContext) -> [String: Any] {
    guard let op = stringValue(step["op"]), !op.isEmpty else {
        return ["error": "bad_step", "detail": "step missing op"]
    }

    switch op {
    case "launch_app", "launch":
        guard let bundleID = stepAppIdentifier(step), !bundleID.isEmpty else {
            return ["error": "bad_step", "detail": "launch_app requires bundle_id, bundle, or app"]
        }
        return launchAppPayload(
            bundleID: bundleID,
            activate: boolValue(step["activate"], default: true),
            timeoutMs: intValue(step["timeout_ms"]) ?? 8000
        )

    case "wait_for_app_window", "wait_window":
        guard let bundleID = stepAppIdentifier(step), !bundleID.isEmpty else {
            return ["error": "bad_step", "detail": "wait_for_app_window requires bundle_id, bundle, or app"]
        }
        return waitForAppWindow(bundleID: bundleID, timeoutMs: intValue(step["timeout_ms"]) ?? 8000)

    case "sleep":
        let durationMs = max(0, min(10000, intValue(step["duration_ms"]) ?? 0))
        if durationMs > 0 {
            Thread.sleep(forTimeInterval: Double(durationMs) / 1000.0)
        }
        return ["ok": true, "duration_ms": durationMs]

    case "press_named":
        return pressNamedPayload(step: step)

    case "resolve":
        return resolveElementPayload(step: step, context: context)

    case "inspect":
        guard let target = targetElement(step, context: context) else {
            return ["error": "unknown_target", "detail": stringValue(step["target"]) ?? "target"]
        }
        var result = elementPayload(target.element)
        result["ok"] = true
        result["action"] = "inspect"
        result["target"] = target.name
        return result

    case "perform_action", "action":
        return performGenericActionPayload(step: step, context: context)

    case "set_attribute":
        return setGenericAttributePayload(step: step, context: context)

    case "hid":
        return hidStepPayload(step: step, context: context)

    case "focus":
        guard let target = targetElement(step, context: context) else {
            return ["error": "unknown_target", "detail": stringValue(step["target"]) ?? "target"]
        }
        let result = focusElementPayload(target.element, window: resolveContainingWindow(target.element))
        if result["error"] as? String == "focus_not_sticky",
           boolValue(step["allow_unstable"], default: false),
           let focused = resolveFocusedElement(),
           focusMatches(target: target.element, focused: focused) {
            var ok: [String: Any] = [
                "ok": true,
                "action": "focus",
                "target": target.name,
                "warning": "fresh_process_focus_unavailable",
                "focus_result": result,
                "role": roleString(target.element),
            ]
            if let frame = frameOf(target.element) { ok["frame"] = frame }
            return ok
        }
        return result

    case "set_value":
        guard let target = targetElement(step, context: context) else {
            return ["error": "unknown_target", "detail": stringValue(step["target"]) ?? "target"]
        }
        guard let text = stringValue(step["text"]) else {
            return ["error": "bad_step", "detail": "set_value requires text"]
        }
        return setValuePayload(element: target.element, text: text)

    case "insert_text":
        guard let target = targetElement(step, context: context) else {
            return ["error": "unknown_target", "detail": stringValue(step["target"]) ?? "target"]
        }
        guard let text = stringValue(step["text"]) else {
            return ["error": "bad_step", "detail": "insert_text requires text"]
        }
        return insertTextPayload(element: target.element, text: text, location: intValue(step["location"]))

    case "select_all":
        guard let target = targetElement(step, context: context) else {
            return ["error": "unknown_target", "detail": stringValue(step["target"]) ?? "target"]
        }
        let total = axNumberOfCharacters(target.element) ?? 0
        return selectRangePayload(element: target.element, location: 0, length: total)

    case "select_range":
        guard let target = targetElement(step, context: context) else {
            return ["error": "unknown_target", "detail": stringValue(step["target"]) ?? "target"]
        }
        guard let location = intValue(step["location"]), let length = intValue(step["length"]) else {
            return ["error": "bad_step", "detail": "select_range requires location and length"]
        }
        return selectRangePayload(element: target.element, location: location, length: length)

    case "select_substring":
        guard let target = targetElement(step, context: context) else {
            return ["error": "unknown_target", "detail": stringValue(step["target"]) ?? "target"]
        }
        guard let needle = stringValue(step["needle"]), !needle.isEmpty else {
            return ["error": "bad_step", "detail": "select_substring requires needle"]
        }
        let occurrence = intValue(step["occurrence"]) ?? 0
        let value = axCopyString(target.element, kAXValueAttribute as String) ?? ""
        let ns = value as NSString
        var searchStart = 0
        var found = NSNotFound
        var hits = 0
        while searchStart < ns.length {
            let range = ns.range(of: needle, options: [], range: NSRange(location: searchStart, length: ns.length - searchStart))
            if range.location == NSNotFound { break }
            if hits == occurrence {
                found = range.location
                break
            }
            hits += 1
            searchStart = range.location + max(1, range.length)
        }
        if found == NSNotFound {
            return ["error": "not_found", "detail": "needle not found at occurrence \(occurrence)"]
        }
        return selectRangePayload(element: target.element, location: found, length: (needle as NSString).length)

    case "menu":
        let path = stringArrayValue(step["path"])
        return performMenuCommandPayload(
            path,
            bundleID: stepAppIdentifier(step),
            activate: boolValue(step["activate"], default: true)
        )

    case "read":
        guard let target = targetElement(step, context: context) else {
            return ["error": "unknown_target", "detail": stringValue(step["target"]) ?? "target"]
        }
        return readTargetPayload(element: target.element)

    case "verify_value":
        guard let target = targetElement(step, context: context) else {
            return ["error": "unknown_target", "detail": stringValue(step["target"]) ?? "target"]
        }
        return verifyValuePayload(
            element: target.element,
            equals: stringValue(step["equals"]),
            contains: stringValue(step["contains"])
        )

    case "verify_absent":
        return verifyPresencePayload(step: step, context: context, expectPresent: false)

    case "verify_present":
        return verifyPresencePayload(step: step, context: context, expectPresent: true)

    default:
        return ["error": "unknown_chain_op", "detail": op]
    }
}

func parseChainPayload(_ args: [String]) -> [String: Any] {
    let raw: String
    if args.count >= 2 && args[0] == "--file" {
        do {
            raw = try String(contentsOfFile: args[1], encoding: .utf8)
        } catch {
            emitInternalError("run-chain: failed reading file: \(error.localizedDescription)")
        }
    } else if !args.isEmpty {
        raw = args.joined(separator: " ")
    } else {
        emitInternalError("run-chain requires JSON payload or --file <path>")
    }
    guard let data = raw.data(using: .utf8) else {
        emitInternalError("run-chain: payload is not UTF-8")
    }
    do {
        let obj = try JSONSerialization.jsonObject(with: data, options: [])
        guard let dict = obj as? [String: Any] else {
            emitInternalError("run-chain: payload must be a JSON object")
        }
        return dict
    } catch {
        emitInternalError("run-chain: bad JSON: \(error.localizedDescription)")
    }
}

func cmdRunChain(_ args: [String]) -> Never {
    guard AXIsProcessTrusted() else { emitError("not_trusted") }
    let payload = parseChainPayload(args)
    guard let rawSteps = payload["steps"] as? [Any], !rawSteps.isEmpty else {
        emitError("bad_chain", "payload requires non-empty steps array")
    }
    let steps = rawSteps.compactMap { $0 as? [String: Any] }
    if steps.count != rawSteps.count {
        emitError("bad_chain", "every step must be an object")
    }

    let context = ChainContext()
    let cursorBefore = currentCursorLocation()
    let tolerance = doubleValue(payload["cursor_tolerance"]) ?? 1.0
    var results: [[String: Any]] = []

    for (idx, step) in steps.enumerated() {
        let op = stringValue(step["op"]) ?? "unknown"
        var result = performChainStep(step, context: context)
        result["index"] = idx
        result["op"] = op
        results.append(result)
        if result["error"] != nil {
            var out: [String: Any] = [
                "ok": false,
                "error": "chain_step_failed",
                "failed_step": idx,
                "failed_op": op,
                "steps": results,
            ]
            for (k, v) in cursorInvariantPayload(before: cursorBefore, tolerance: tolerance) {
                out[k] = v
            }
            emit(out)
            exit(0)
        }
    }

    var out: [String: Any] = [
        "ok": true,
        "steps": results,
    ]
    for (k, v) in cursorInvariantPayload(before: cursorBefore, tolerance: tolerance) {
        out[k] = v
    }
    emit(out)
    exit(0)
}

// MARK: — Entry point

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    emitInternalError("usage: ax-helper <read-at|read-focused|focused-snapshot|diagnostics|write-at|write-focused|read-window|read-subtree|find-element|focus-element|focus-at|press-named|press-at|click-at|drag|scroll-at|hover-at|keystroke|key-hold|modifier-latch|type-text|select-range|select-all|select-substring|menu-command|run-chain|act|cursor-position|subscribe|check> [args]")
}

let cmd = argv[1]
let rest = Array(argv.dropFirst(2))

switch cmd {
case "check":             cmdCheck()
case "read-at":           cmdReadAt(rest)
case "read-focused":      cmdReadFocused()
case "focused-snapshot":  cmdFocusedSnapshot(rest)
case "diagnostics":       cmdDiagnostics()
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
case "run-chain":         cmdRunChain(rest)
case "act":               cmdRunChain(rest)
case "cursor-position":   cmdCursorPosition()
case "subscribe":         cmdSubscribe()
default:                  emitInternalError("unknown command: \(cmd)")
}
