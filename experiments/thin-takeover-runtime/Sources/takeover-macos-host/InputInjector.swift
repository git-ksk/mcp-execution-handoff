import Foundation
import TakeoverCore

#if os(macOS)
import AppKit
import ApplicationServices
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
        case targetUnavailable
    }

    // Synthetic events are posted from the logged-in user session. Keep the same state source as
    // the accepted WebRTC host and post to the exact target PID whenever the takeover is bounded.
    private let source = CGEventSource(stateID: .combinedSessionState)
    private let inputBounds: CGRect
    private let targetProcessID: pid_t?
    private var pressedKeys = Set<CGKeyCode>()
    private var pressedButtons = Set<CGMouseButton>()
    private var lastPointerPoint: CGPoint

    init(inputBounds: CGRect, targetProcessID: pid_t?) {
        self.inputBounds = inputBounds
        self.targetProcessID = targetProcessID
        self.lastPointerPoint = CGPoint(x: inputBounds.midX, y: inputBounds.midY)
    }

    func inject(_ event: InputEvent) throws {
        guard activateTargetWindowForInput() else { throw InjectionError.targetUnavailable }
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
            post(cgEvent)

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
            post(cgEvent)
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
            post(cgEvent)

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
            post(cgEvent)
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
            post(down)
            post(up)
        }
    }

    /// Fail-safe cleanup used when the lease expires, is revoked, or the input server exits.
    /// A lost key-up/mouse-up datagram must not leave the bounded target logically pressed.
    func releaseAll() {
        for keyCode in pressedKeys {
            if let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) {
                post(event)
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
                post(event)
            }
        }
        pressedButtons.removeAll(keepingCapacity: true)
    }

    private func post(_ event: CGEvent) {
        if let targetProcessID {
            event.postToPid(targetProcessID)
        } else {
            event.post(tap: .cghidEventTap)
        }
    }

    /// For a bounded takeover, every Human event first proves that the target process still has
    /// exactly one AX window at the exact capture bounds. If the target disappeared, moved, or an
    /// indistinguishable second window appeared, input fails closed rather than landing elsewhere.
    private func activateTargetWindowForInput() -> Bool {
        guard let targetProcessID else { return true }
        guard let application = NSRunningApplication(processIdentifier: targetProcessID) else { return false }
        let appElement = AXUIElementCreateApplication(targetProcessID)
        var windowsRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRaw) == .success,
              let windows = windowsRaw as? [AXUIElement] else { return false }
        let matches = windows.filter { window in
            guard let frame = axFrame(window) else { return false }
            return abs(frame.minX - inputBounds.minX) <= 2
                && abs(frame.minY - inputBounds.minY) <= 2
                && abs(frame.width - inputBounds.width) <= 2
                && abs(frame.height - inputBounds.height) <= 2
        }
        guard matches.count == 1, let window = matches.first else { return false }
        guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { return false }
        _ = application.activate(options: [])
        for attempt in 0..<5 {
            if application.isActive { return true }
            if attempt < 4 { usleep(20_000) }
        }
        return application.isActive
    }

    private func axFrame(_ element: AXUIElement) -> CGRect? {
        var positionRaw: CFTypeRef?
        var sizeRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRaw) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRaw) == .success,
              let positionRaw, let sizeRaw,
              CFGetTypeID(positionRaw) == AXValueGetTypeID(),
              CFGetTypeID(sizeRaw) == AXValueGetTypeID() else { return nil }
        let positionValue = unsafeDowncast(positionRaw, to: AXValue.self)
        let sizeValue = unsafeDowncast(sizeRaw, to: AXValue.self)
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &point),
              AXValueGetValue(sizeValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
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
        let maxX = max(0, inputBounds.width - 1)
        let maxY = max(0, inputBounds.height - 1)
        return CGPoint(
            x: inputBounds.minX + maxX * CGFloat(x) / CGFloat(upper),
            y: inputBounds.minY + maxY * CGFloat(y) / CGFloat(upper)
        )
    }
}
#endif
