import Foundation
import TakeoverCore

#if os(macOS)
import CoreGraphics

final class MacOSInputInjector: @unchecked Sendable {
    enum InjectionError: Error {
        case invalidCoordinate
        case invalidKeyCode
        case invalidText
        case eventCreationFailed
    }

    private let source = CGEventSource(stateID: .hidSystemState)

    func inject(_ event: InputEvent) throws {
        switch event.kind {
        case .pointerMove:
            let point = try screenPoint(x: event.x, y: event.y)
            guard let cgEvent = CGEvent(
                mouseEventSource: source,
                mouseType: .mouseMoved,
                mouseCursorPosition: point,
                mouseButton: .left
            ) else { throw InjectionError.eventCreationFailed }
            cgEvent.post(tap: .cghidEventTap)

        case .pointerButton:
            let point = try screenPoint(x: event.x, y: event.y)
            let buttonByte = event.payload.first ?? 0
            let button: CGMouseButton
            let downType: CGEventType
            let upType: CGEventType
            switch buttonByte {
            case 0:
                button = .left
                downType = .leftMouseDown
                upType = .leftMouseUp
            case 1:
                button = .right
                downType = .rightMouseDown
                upType = .rightMouseUp
            default:
                button = .center
                downType = .otherMouseDown
                upType = .otherMouseUp
            }
            guard let cgEvent = CGEvent(
                mouseEventSource: source,
                mouseType: event.value == 0 ? upType : downType,
                mouseCursorPosition: point,
                mouseButton: button
            ) else { throw InjectionError.eventCreationFailed }
            cgEvent.post(tap: .cghidEventTap)

        case .scroll:
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
            guard let cgEvent = CGEvent(
                keyboardEventSource: source,
                virtualKey: CGKeyCode(event.x),
                keyDown: event.value != 0
            ) else { throw InjectionError.eventCreationFailed }
            cgEvent.post(tap: .cghidEventTap)

        case .textCommit:
            guard let text = String(data: event.payload, encoding: .utf8), !text.isEmpty else {
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

    private func screenPoint(x: Int32, y: Int32) throws -> CGPoint {
        let upper: Int32 = 1_000_000
        guard (0...upper).contains(x), (0...upper).contains(y) else {
            throw InjectionError.invalidCoordinate
        }
        let bounds = CGDisplayBounds(CGMainDisplayID())
        return CGPoint(
            x: bounds.minX + bounds.width * CGFloat(x) / CGFloat(upper),
            y: bounds.minY + bounds.height * CGFloat(y) / CGFloat(upper)
        )
    }
}
#endif
