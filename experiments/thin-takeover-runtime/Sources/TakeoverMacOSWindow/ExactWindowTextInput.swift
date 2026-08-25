#if os(macOS)
import ApplicationServices
import CoreGraphics

public enum MacOSExactWindowTextCommitResult: Sendable, Equatable {
    case committed
    case unsupported
    case rejected
}

enum MacOSExactWindowTextAncestry: Sendable, Equatable {
    case native
    case web
    case unknown
}

enum MacOSExactWindowTextPolicyDecision: Sendable, Equatable {
    case allow
    case unsupported
    case rejected
}

enum MacOSExactWindowTextInputPolicy {
    static func decision(
        focusedWindowMatches: Bool,
        focusedPIDMatches: Bool,
        role: String?,
        subrole: String?,
        ancestry: MacOSExactWindowTextAncestry,
        selectedTextSettable: Bool
    ) -> MacOSExactWindowTextPolicyDecision {
        guard focusedWindowMatches, focusedPIDMatches else { return .rejected }
        guard subrole != (kAXSecureTextFieldSubrole as String) else { return .unsupported }
        guard role == (kAXTextFieldRole as String)
                || role == (kAXTextAreaRole as String)
                || role == (kAXComboBoxRole as String)
        else { return .unsupported }
        guard ancestry == .native, selectedTextSettable else { return .unsupported }
        return .allow
    }
}

/// Inserts ordinary native text only when the focused control is still bounded to the exact
/// process/window selected for takeover. Web content and unsupported controls keep the existing
/// keyboard-event path; ownership/window mismatches fail closed instead of falling back.
public enum MacOSExactWindowTextInput {
    public static func commitFocusedText(
        processID: pid_t,
        inputBounds: CGRect,
        text: String
    ) -> MacOSExactWindowTextCommitResult {
        guard !text.isEmpty else { return .unsupported }
        let app = AXUIElementCreateApplication(processID)
        var focusedWindowRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            app,
            kAXFocusedWindowAttribute as CFString,
            &focusedWindowRaw
        ) == .success,
              let focusedWindowRaw,
              CFGetTypeID(focusedWindowRaw) == AXUIElementGetTypeID()
        else { return .rejected }

        let focusedWindow = unsafeDowncast(focusedWindowRaw, to: AXUIElement.self)
        guard let frame = frame(of: focusedWindow) else { return .rejected }
        let focusedWindowMatches = MacOSExactWindowGeometry.framesMatch(frame, inputBounds)

        let system = AXUIElementCreateSystemWide()
        var focusedElementRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            system,
            kAXFocusedUIElementAttribute as CFString,
            &focusedElementRaw
        ) == .success,
              let focusedElementRaw,
              CFGetTypeID(focusedElementRaw) == AXUIElementGetTypeID()
        else { return .rejected }

        let focusedElement = unsafeDowncast(focusedElementRaw, to: AXUIElement.self)
        var focusedPID: pid_t = 0
        guard AXUIElementGetPid(focusedElement, &focusedPID) == .success else { return .rejected }

        var selectedTextSettable = DarwinBoolean(false)
        let settableStatus = AXUIElementIsAttributeSettable(
            focusedElement,
            kAXSelectedTextAttribute as CFString,
            &selectedTextSettable
        )
        let policy = MacOSExactWindowTextInputPolicy.decision(
            focusedWindowMatches: focusedWindowMatches,
            focusedPIDMatches: focusedPID == processID,
            role: role(of: focusedElement),
            subrole: subrole(of: focusedElement),
            ancestry: ancestry(of: focusedElement),
            selectedTextSettable: settableStatus == .success && selectedTextSettable.boolValue
        )
        switch policy {
        case .allow:
            break
        case .unsupported:
            return .unsupported
        case .rejected:
            return .rejected
        }

        let result = AXUIElementSetAttributeValue(
            focusedElement,
            kAXSelectedTextAttribute as CFString,
            text as CFString
        )
        return result == .success ? .committed : .unsupported
    }

    private static func ancestry(of element: AXUIElement) -> MacOSExactWindowTextAncestry {
        var current = element
        for _ in 0..<16 {
            guard let currentRole = role(of: current) else { return .unknown }
            if currentRole == "AXWebArea" { return .web }
            if currentRole == (kAXApplicationRole as String) { return .native }

            var parentRaw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(
                current,
                kAXParentAttribute as CFString,
                &parentRaw
            ) == .success,
                  let parentRaw,
                  CFGetTypeID(parentRaw) == AXUIElementGetTypeID()
            else { return .unknown }
            current = unsafeDowncast(parentRaw, to: AXUIElement.self)
        }
        return .unknown
    }

    private static func subrole(of element: AXUIElement) -> String? {
        var subroleRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXSubroleAttribute as CFString,
            &subroleRaw
        ) == .success else { return nil }
        return subroleRaw as? String
    }

    private static func role(of element: AXUIElement) -> String? {
        var roleRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXRoleAttribute as CFString,
            &roleRaw
        ) == .success else { return nil }
        return roleRaw as? String
    }

    private static func frame(of element: AXUIElement) -> CGRect? {
        var positionRaw: CFTypeRef?
        var sizeRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXPositionAttribute as CFString,
            &positionRaw
        ) == .success,
              AXUIElementCopyAttributeValue(
                  element,
                  kAXSizeAttribute as CFString,
                  &sizeRaw
              ) == .success,
              let positionRaw,
              let sizeRaw,
              CFGetTypeID(positionRaw) == AXValueGetTypeID(),
              CFGetTypeID(sizeRaw) == AXValueGetTypeID()
        else { return nil }

        let positionValue = unsafeDowncast(positionRaw, to: AXValue.self)
        let sizeValue = unsafeDowncast(sizeRaw, to: AXValue.self)
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &point),
              AXValueGetValue(sizeValue, .cgSize, &size)
        else { return nil }
        return CGRect(origin: point, size: size)
    }
}
#endif
