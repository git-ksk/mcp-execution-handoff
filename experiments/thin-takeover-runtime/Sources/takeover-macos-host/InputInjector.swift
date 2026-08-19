import Foundation
import TakeoverCore

#if os(macOS)
import CoreGraphics

final class MacOSInputInjector: @unchecked Sendable {
    enum InjectionError: Error {
        case invalidCoordinate
        case invalidButton
        case invalidScroll
        case invalidKeyCode
        case invalidKeyState
        case invalidText
        case eventCreationFailed
    }

    private let source = CGEventSource(stateID: .hidSystemState)
    private let displayID: CGDirectDisplayID
    private var pressedKeys = Set<CGKeyCode>()
    private var pressedButtons = Set<CGMouseButton>()
    private var lastPointerPoint: CGPoint

    init(displayID: CGDirectDisplayID) {
        self.displayID = displayID
        let bounds = CGDisplayBounds(displayID)
        self.lastPointerPoint = CGPoint(x: bounds.midX, y: bounds.midY)
    }

    func inject(_ event: InputEvent) throws {
        switch event.kind {
        case .pointerMove:
            let point = try screenPoint(x: event.x, y: event.y)
            lastPointerPoint = point
            guard let cgEvent = CGEvent(
                mouseEventSource: source,
                mouseType: .mouseMoved,
                mouseCursorPosition: point,
                mouseButton: .left
            ) else { throw InjectionError.eventCreationFailed }
            cgEvent.post(tap: .cghidEventTap)

        case .pointerButton:
            guard event.value == 0 || event.value == 1 else { throw InjectionError.invalidButton }
            let point = try screenPoint(x: event.x, y: event.y)
            lastPointerPoint = point
            let buttonByte: UInt8
            if event.payload.isEmpty {
                buttonByte = 0
            } else {
                guard event.payload.count == 1, let first = event.payload.first else {
                    throw InjectionError.invalidButton
                }
                buttonByte = first
            }
            let mapping = try buttonMapping(buttonByte)
            let eventType = event.value == 0 ? mapping.up : mapping.down
            guard let cgEvent = CGEvent(
                mouseEventSource: source,
                mouseType: eventType,
                mouseCursorPosition: point,
                mouseButton: mapping.button
            ) else { throw InjectionError.eventCreationFailed }
            cgEvent.post(tap: .cghidEventTap)
            if event.value == 0 {
                pressedButtons.remove(mapping.button)
            } else {
                pressedButtons.insert(mapping.button)
            }

        case .scroll:
            let limit: Int32 = 100_000
            guard (-limit...limit).contains(event.x), (-limit...limit).contains(event.y) else {
                throw InjectionError.invalidScroll
            }
            guard let cgEvent = CGEvent(
                scrollWheelEvent2Source: source,
                units: .pixel,
                wheelCount: 2,
                wheel1: event.y,
                wheel2: event.x,
                wheel3: 0
            ) else { throw InjectionError.eventCreationFailed }
            cgEvent.post(tap: .cghidEventTap)

        case .key:
            guard event.x >= 0, event.x <= Int32(UInt16.max) else {
                throw InjectionError.invalidKeyCode
            }
            guard event.value == 0 || event.value == 1 else {
                throw InjectionError.invalidKeyState
            }
            let keyCode = CGKeyCode(event.x)
            guard let cgEvent = CGEvent(
                keyboardEventSource: source,
                virtualKey: keyCode,
                keyDown: event.value == 1
            ) else { throw InjectionError.eventCreationFailed }
            cgEvent.post(tap: .cghidEventTap)
            if event.value == 0 {
                pressedKeys.remove(keyCode)
            } else {
                pressedKeys.insert(keyCode)
            }

        case .textCommit:
            guard event.payload.count <= 4_096,
                  let text = String(data: event.payload, encoding: .utf8),
                  !text.isEmpty else {
                throw InjectionError.invalidText
            }
            let utf16 = Array(text.utf16)
            guard utf16.count <= 1024 else { throw InjectionError.invalidText }
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                throw InjectionError.eventCreationFailed
            }
            utf16.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    /// Fail-safe cleanup used when the lease expires, is revoked, or the input server exits.
    /// A lost key-up/mouse-up datagram must not leave the local desktop logically pressed.
    func releaseAll() {
        for keyCode in pressedKeys {
            if let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) {
                event.post(tap: .cghidEventTap)
            }
        }
        pressedKeys.removeAll(keepingCapacity: true)

        for button in pressedButtons {
            let mapping = buttonMappingForRelease(button)
            if let event = CGEvent(
                mouseEventSource: source,
                mouseType: mapping,
                mouseCursorPosition: lastPointerPoint,
                mouseButton: button
            ) {
                event.post(tap: .cghidEventTap)
            }
        }
        pressedButtons.removeAll(keepingCapacity: true)
    }

    private func buttonMapping(_ byte: UInt8) throws -> (button: CGMouseButton, down: CGEventType, up: CGEventType) {
        switch byte {
        case 0:
            return (.left, .leftMouseDown, .leftMouseUp)
        case 1:
            return (.right, .rightMouseDown, .rightMouseUp)
        case 2:
            return (.center, .otherMouseDown, .otherMouseUp)
        default:
            throw InjectionError.invalidButton
        }
    }

    private func buttonMappingForRelease(_ button: CGMouseButton) -> CGEventType {
        switch button {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        default: return .otherMouseUp
        }
    }

    private func screenPoint(x: Int32, y: Int32) throws -> CGPoint {
        let upper: Int32 = 1_000_000
        guard (0...upper).contains(x), (0...upper).contains(y) else {
            throw InjectionError.invalidCoordinate
        }
        let bounds = CGDisplayBounds(displayID)
        return CGPoint(
            x: bounds.minX + bounds.width * CGFloat(x) / CGFloat(upper),
            y: bounds.minY + bounds.height * CGFloat(y) / CGFloat(upper)
        )
    }
}
#endif
