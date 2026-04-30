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
            emit(["ok": true, "mode": "selection", "role": role])
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
        emit(["ok": true, "mode": "value", "role": role])
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

// MARK: — Permission check

func cmdCheck() -> Never {
    let trusted = AXIsProcessTrusted()
    emit(["trusted": trusted])
    exit(0)
}

// MARK: — Entry point

let argv = CommandLine.arguments
guard argv.count >= 2 else {
    emitInternalError("usage: ax-helper <read-at|read-focused|write-at|write-focused|check> [args]")
}

let cmd = argv[1]
let rest = Array(argv.dropFirst(2))

switch cmd {
case "check":           cmdCheck()
case "read-at":         cmdReadAt(rest)
case "read-focused":    cmdReadFocused()
case "write-at":        cmdWriteAt(rest)
case "write-focused":   cmdWriteFocused(rest)
default:                emitInternalError("unknown command: \(cmd)")
}
