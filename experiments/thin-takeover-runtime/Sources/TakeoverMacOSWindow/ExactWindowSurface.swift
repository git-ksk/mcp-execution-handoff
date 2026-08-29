#if os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit

public struct MacOSWindowCandidate: Sendable, Equatable {
    public let processID: pid_t
    public let windowID: CGWindowID
    public let frame: CGRect
    public let isOnScreen: Bool
    public let layer: Int

    public init(
        processID: pid_t,
        windowID: CGWindowID,
        frame: CGRect,
        isOnScreen: Bool,
        layer: Int
    ) {
        self.processID = processID
        self.windowID = windowID
        self.frame = frame
        self.isOnScreen = isOnScreen
        self.layer = layer
    }
}

public struct MacOSDisplayCandidate: Sendable, Equatable {
    public let displayID: CGDirectDisplayID
    public let frame: CGRect

    public init(displayID: CGDirectDisplayID, frame: CGRect) {
        self.displayID = displayID
        self.frame = frame
    }
}

public enum MacOSExactWindowResolutionError: Error, Equatable {
    case windowUnavailable
    case containingDisplayUnavailable
    case cropOutsideDisplay
}

/// Revalidation for an already-authorized exact Window identity. Unlike initial resolution this
/// never resolves a replacement window: the exact WindowServer id, owner PID, visibility, layer,
/// and captured bounds must still match immediately before a Human mutation.
public enum MacOSExactWindowAuthority {
    public static func matches(
        candidates: [MacOSWindowCandidate],
        targetProcessID: pid_t,
        targetWindowID: CGWindowID,
        inputBounds: CGRect,
        allowNonZeroLayer: Bool = false
    ) -> Bool {
        let exact = candidates.filter { candidate in
            candidate.windowID == targetWindowID
                && candidate.processID == targetProcessID
                && candidate.isOnScreen
                && (allowNonZeroLayer || candidate.layer == 0)
                && MacOSExactWindowGeometry.framesMatch(candidate.frame, inputBounds)
        }
        return exact.count == 1
    }

    public static func revalidate(
        processID: pid_t,
        windowID: CGWindowID,
        inputBounds: CGRect,
        allowNonZeroLayer: Bool = false
    ) -> Bool {
        guard processID > 0, windowID > 0, inputBounds.width > 0, inputBounds.height > 0,
              let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]]
        else { return false }
        let candidates = raw.compactMap { info -> MacOSWindowCandidate? in
            guard let number = info[kCGWindowNumber as String] as? NSNumber,
                  number.uint32Value == windowID,
                  let owner = info[kCGWindowOwnerPID as String] as? NSNumber,
                  let layer = info[kCGWindowLayer as String] as? NSNumber,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds)
            else { return nil }
            let onScreen = (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
            return MacOSWindowCandidate(
                processID: pid_t(owner.int32Value),
                windowID: CGWindowID(number.uint32Value),
                frame: frame,
                isOnScreen: onScreen,
                layer: layer.intValue
            )
        }
        return matches(
            candidates: candidates,
            targetProcessID: processID,
            targetWindowID: windowID,
            inputBounds: inputBounds,
            allowNonZeroLayer: allowNonZeroLayer
        )
    }
}

public struct MacOSExactWindowResolution: Sendable, Equatable {
    public let windowIndex: Int
    public let displayIndex: Int
    public let sourceRect: CGRect
    public let inputBounds: CGRect

    public init(windowIndex: Int, displayIndex: Int, sourceRect: CGRect, inputBounds: CGRect) {
        self.windowIndex = windowIndex
        self.displayIndex = displayIndex
        self.sourceRect = sourceRect
        self.inputBounds = inputBounds
    }
}

/// Pure geometry/ownership rules for one bounded macOS window. This primitive never widens to a
/// display or desktop surface; callers that intentionally support a display-only mode own that
/// separate policy outside this module.
public enum MacOSExactWindowGeometry {
    public static func resolve(
        windows: [MacOSWindowCandidate],
        displays: [MacOSDisplayCandidate],
        targetProcessID: pid_t,
        targetWindowID: CGWindowID?,
        minimumSize: CGSize = CGSize(width: 160, height: 120)
    ) throws -> MacOSExactWindowResolution {
        let matchingWindowIndices = windows.indices.filter { index in
            let window = windows[index]
            return window.processID == targetProcessID
                && window.isOnScreen
                && window.layer == 0
                && (targetWindowID == nil || window.windowID == targetWindowID)
                && window.frame.width >= minimumSize.width
                && window.frame.height >= minimumSize.height
        }
        guard matchingWindowIndices.count == 1, let windowIndex = matchingWindowIndices.first else {
            throw MacOSExactWindowResolutionError.windowUnavailable
        }
        let window = windows[windowIndex]
        let containingDisplayIndices = displays.indices.filter { displays[$0].frame.contains(window.frame) }
        guard containingDisplayIndices.count == 1, let displayIndex = containingDisplayIndices.first else {
            throw MacOSExactWindowResolutionError.containingDisplayUnavailable
        }
        let display = displays[displayIndex]
        let sourceRect = CGRect(
            x: window.frame.minX - display.frame.minX,
            y: window.frame.minY - display.frame.minY,
            width: window.frame.width,
            height: window.frame.height
        )
        let displayLocalBounds = CGRect(origin: .zero, size: display.frame.size)
        guard displayLocalBounds.contains(sourceRect) else {
            throw MacOSExactWindowResolutionError.cropOutsideDisplay
        }
        return MacOSExactWindowResolution(
            windowIndex: windowIndex,
            displayIndex: displayIndex,
            sourceRect: sourceRect,
            inputBounds: window.frame
        )
    }

    public static func framesMatch(_ observed: CGRect, _ expected: CGRect, tolerance: CGFloat = 2) -> Bool {
        guard tolerance >= 0 else { return false }
        return abs(observed.minX - expected.minX) <= tolerance
            && abs(observed.minY - expected.minY) <= tolerance
            && abs(observed.width - expected.width) <= tolerance
            && abs(observed.height - expected.height) <= tolerance
    }
}

public struct MacOSLocalAuthenticationWindowCandidate: Sendable, Equatable {
    public let processID: pid_t
    public let windowID: CGWindowID
    public let frame: CGRect
    public let isOnScreen: Bool
    public let layer: Int
    public let bundleIdentifier: String?
    public let axIdentifier: String?
    public let axRole: String?
    public let axSubrole: String?
    public let isMain: Bool
    public let isFocused: Bool

    public init(
        processID: pid_t,
        windowID: CGWindowID,
        frame: CGRect,
        isOnScreen: Bool,
        layer: Int,
        bundleIdentifier: String?,
        axIdentifier: String?,
        axRole: String?,
        axSubrole: String?,
        isMain: Bool,
        isFocused: Bool
    ) {
        self.processID = processID
        self.windowID = windowID
        self.frame = frame
        self.isOnScreen = isOnScreen
        self.layer = layer
        self.bundleIdentifier = bundleIdentifier
        self.axIdentifier = axIdentifier
        self.axRole = axRole
        self.axSubrole = axSubrole
        self.isMain = isMain
        self.isFocused = isFocused
    }
}

public enum MacOSLocalAuthenticationWindowResolutionError: Error, Equatable {
    case windowUnavailable
    case containingDisplayUnavailable
    case cropOutsideDisplay
}

public struct MacOSLocalAuthenticationWindowResolution: Sendable, Equatable {
    public let windowIndices: [Int]
    public let displayIndex: Int
    public let sourceRect: CGRect
    public let inputBounds: CGRect

    public var windowIndex: Int { windowIndices[0] }
}

/// Explicit opt-in admission for Apple's LocalAuthentication passcode dialog when it is the
/// initial Window target. Ordinary exact-window resolution remains layer-zero only.
public enum MacOSLocalAuthenticationWindowGeometry {
    public static let bundleIdentifier = "com.apple.LocalAuthentication.UIAgent"
    public static let axIdentifier = "com.apple.LocalAuthentication.PasscodeDialog"
    private static let maximumEquivalentPresentations = 2

    static func canonicalAXMetadata(
        from observed: [MacOSLocalAuthenticationAXMetadata]
    ) -> MacOSLocalAuthenticationAXMetadata? {
        let canonical = observed.filter { metadata in
            metadata.identifier == axIdentifier
                && metadata.role == (kAXWindowRole as String)
                && metadata.subrole == (kAXStandardWindowSubrole as String)
                && metadata.isMain
                && metadata.isFocused
        }
        return canonical.count == 1 ? canonical[0] : nil
    }

    public static func resolve(
        windows: [MacOSLocalAuthenticationWindowCandidate],
        displays: [MacOSDisplayCandidate],
        targetProcessID: pid_t,
        minimumSize: CGSize = CGSize(width: 160, height: 120)
    ) throws -> MacOSLocalAuthenticationWindowResolution {
        let eligible = windows.indices.filter { index in
            let window = windows[index]
            return window.processID == targetProcessID
                && window.isOnScreen
                && window.layer != 0
                && window.bundleIdentifier == bundleIdentifier
                && window.axIdentifier == axIdentifier
                && window.axRole == (kAXWindowRole as String)
                && window.axSubrole == (kAXStandardWindowSubrole as String)
                && window.isMain
                && window.isFocused
                && window.frame.width >= minimumSize.width
                && window.frame.height >= minimumSize.height
        }
        guard (1...maximumEquivalentPresentations).contains(eligible.count),
              let firstIndex = eligible.first else {
            throw MacOSLocalAuthenticationWindowResolutionError.windowUnavailable
        }
        let first = windows[firstIndex]
        guard Set(eligible.map { windows[$0].windowID }).count == eligible.count,
              eligible.allSatisfy({ index in
                  let candidate = windows[index]
                  return candidate.layer == first.layer
                      && MacOSExactWindowGeometry.framesMatch(candidate.frame, first.frame)
              }) else {
            throw MacOSLocalAuthenticationWindowResolutionError.windowUnavailable
        }
        let ordered = eligible.sorted { windows[$0].windowID < windows[$1].windowID }
        let containingDisplays = displays.indices.filter { displays[$0].frame.contains(first.frame) }
        guard containingDisplays.count == 1, let displayIndex = containingDisplays.first else {
            throw MacOSLocalAuthenticationWindowResolutionError.containingDisplayUnavailable
        }
        let display = displays[displayIndex]
        let sourceRect = CGRect(
            x: first.frame.minX - display.frame.minX,
            y: first.frame.minY - display.frame.minY,
            width: first.frame.width,
            height: first.frame.height
        )
        guard CGRect(origin: .zero, size: display.frame.size).contains(sourceRect) else {
            throw MacOSLocalAuthenticationWindowResolutionError.cropOutsideDisplay
        }
        return MacOSLocalAuthenticationWindowResolution(
            windowIndices: ordered,
            displayIndex: displayIndex,
            sourceRect: sourceRect,
            inputBounds: first.frame
        )
    }
}

struct MacOSLocalAuthenticationAXMetadata: Sendable, Equatable {
    let frame: CGRect
    let identifier: String?
    let role: String?
    let subrole: String?
    let isMain: Bool
    let isFocused: Bool
}

private func secureAXFrame(_ element: AXUIElement) -> CGRect? {
    var positionRaw: CFTypeRef?
    var sizeRaw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRaw) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRaw) == .success,
          let positionRaw, let sizeRaw,
          CFGetTypeID(positionRaw) == AXValueGetTypeID(),
          CFGetTypeID(sizeRaw) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(unsafeDowncast(positionRaw, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeDowncast(sizeRaw, to: AXValue.self), .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

private func secureAXString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success else { return nil }
    return raw as? String
}

private func secureAXBool(_ element: AXUIElement, _ attribute: CFString) -> Bool {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success else { return false }
    return (raw as? NSNumber)?.boolValue ?? false
}

private func localAuthenticationAXMetadata(processID: pid_t) -> [MacOSLocalAuthenticationAXMetadata] {
    let app = AXUIElementCreateApplication(processID)
    var windowsRaw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRaw) == .success,
          let windows = windowsRaw as? [AXUIElement] else { return [] }
    var focusedRaw: CFTypeRef?
    let focused = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focusedRaw) == .success
        ? focusedRaw.map { unsafeDowncast($0, to: AXUIElement.self) }
        : nil
    let focusedFrame = focused.flatMap(secureAXFrame)
    let observed = windows.compactMap { window -> MacOSLocalAuthenticationAXMetadata? in
        guard let frame = secureAXFrame(window) else { return nil }
        return MacOSLocalAuthenticationAXMetadata(
            frame: frame,
            identifier: secureAXString(window, "AXIdentifier" as CFString),
            role: secureAXString(window, kAXRoleAttribute as CFString),
            subrole: secureAXString(window, kAXSubroleAttribute as CFString),
            isMain: secureAXBool(window, kAXMainAttribute as CFString),
            isFocused: focusedFrame.map { MacOSExactWindowGeometry.framesMatch($0, frame) } ?? false
        )
    }
    guard let canonical = MacOSLocalAuthenticationWindowGeometry.canonicalAXMetadata(from: observed) else {
        return []
    }
    return [canonical]
}

public enum MacOSLocalAuthenticationWindowCapture {
    public static func resolve(
        from content: SCShareableContent,
        targetProcessID: pid_t
    ) throws -> MacOSExactWindowCaptureSurface {
        let axMetadata = localAuthenticationAXMetadata(processID: targetProcessID)
        let windows = content.windows.map { window -> MacOSLocalAuthenticationWindowCandidate in
            let processID = window.owningApplication?.processID ?? 0
            let matches = processID == targetProcessID
                ? axMetadata.filter { MacOSExactWindowGeometry.framesMatch($0.frame, window.frame) }
                : []
            let metadata = matches.count == 1 ? matches[0] : nil
            return MacOSLocalAuthenticationWindowCandidate(
                processID: processID,
                windowID: window.windowID,
                frame: window.frame,
                isOnScreen: window.isOnScreen,
                layer: window.windowLayer,
                bundleIdentifier: window.owningApplication?.bundleIdentifier,
                axIdentifier: metadata?.identifier,
                axRole: metadata?.role,
                axSubrole: metadata?.subrole,
                isMain: metadata?.isMain ?? false,
                isFocused: metadata?.isFocused ?? false
            )
        }
        let displays = content.displays.map {
            MacOSDisplayCandidate(displayID: $0.displayID, frame: $0.frame)
        }
        let resolution = try MacOSLocalAuthenticationWindowGeometry.resolve(
            windows: windows,
            displays: displays,
            targetProcessID: targetProcessID
        )
        let selectedWindows = resolution.windowIndices.map { content.windows[$0] }
        guard let representative = selectedWindows.first else {
            throw MacOSLocalAuthenticationWindowResolutionError.windowUnavailable
        }
        let display = content.displays[resolution.displayIndex]
        let filter = SCContentFilter(display: display, including: selectedWindows)
        let scale = max(1.0, Double(filter.pointPixelScale))
        return MacOSExactWindowCaptureSurface(
            windowID: representative.windowID,
            filter: filter,
            sourceRect: resolution.sourceRect,
            inputBounds: resolution.inputBounds,
            pixelWidth: max(2.0, Double(resolution.sourceRect.width) * scale),
            pixelHeight: max(2.0, Double(resolution.sourceRect.height) * scale)
        )
    }
}

/// LocalAuthentication does not become an ordinary active application. Human pointer input is
/// admitted only while Apple's exact focused passcode dialog still matches the captured bounds.
public enum MacOSLocalAuthenticationWindowInput {
    public static func verifyFocused(processID: pid_t, inputBounds: CGRect) -> Bool {
        guard let app = verifiedApplication(processID: processID, inputBounds: inputBounds) else { return false }
        return equivalentPasscodeWindowCount(app: app, inputBounds: inputBounds) > 0
    }

    /// Human-entered credentials are admitted only while LocalAuthentication itself reports one exact
    /// secure text field as focused inside the already verified Apple passcode dialog. This function
    /// never reads the field value and is intentionally unavailable to ordinary Window Handoff.
    public static func verifyFocusedSecureTextField(processID: pid_t, inputBounds: CGRect) -> Bool {
        guard let app = verifiedApplication(processID: processID, inputBounds: inputBounds),
              equivalentPasscodeWindowCount(app: app, inputBounds: inputBounds) > 0 else { return false }
        var focusedRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedRaw) == .success,
              let focusedRaw else { return false }
        let focused = unsafeDowncast(focusedRaw, to: AXUIElement.self)
        return isSecureTextField(
            role: secureAXString(focused, kAXRoleAttribute as CFString),
            subrole: secureAXString(focused, kAXSubroleAttribute as CFString)
        )
    }

    public static func isSecureTextField(role: String?, subrole: String?) -> Bool {
        role == (kAXTextFieldRole as String) && subrole == "AXSecureTextField"
    }

    private static func verifiedApplication(processID: pid_t, inputBounds: CGRect) -> AXUIElement? {
        guard let application = NSRunningApplication(processIdentifier: processID),
              !application.isTerminated,
              application.bundleIdentifier == MacOSLocalAuthenticationWindowGeometry.bundleIdentifier else {
            return nil
        }
        let app = AXUIElementCreateApplication(processID)
        var focusedRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focusedRaw) == .success,
              let focusedRaw else { return nil }
        let focused = unsafeDowncast(focusedRaw, to: AXUIElement.self)
        guard let frame = secureAXFrame(focused),
              MacOSExactWindowGeometry.framesMatch(frame, inputBounds),
              secureAXString(focused, "AXIdentifier" as CFString) == MacOSLocalAuthenticationWindowGeometry.axIdentifier,
              secureAXString(focused, kAXRoleAttribute as CFString) == (kAXWindowRole as String),
              secureAXString(focused, kAXSubroleAttribute as CFString) == (kAXStandardWindowSubrole as String),
              secureAXBool(focused, kAXMainAttribute as CFString) else { return nil }
        return app
    }

    private static func equivalentPasscodeWindowCount(app: AXUIElement, inputBounds: CGRect) -> Int {
        var windowsRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRaw) == .success,
              let windows = windowsRaw as? [AXUIElement] else { return 0 }
        let exact = windows.filter { window in
            guard let frame = secureAXFrame(window),
                  MacOSExactWindowGeometry.framesMatch(frame, inputBounds) else { return false }
            return secureAXString(window, "AXIdentifier" as CFString) == MacOSLocalAuthenticationWindowGeometry.axIdentifier
                && secureAXString(window, kAXRoleAttribute as CFString) == (kAXWindowRole as String)
                && secureAXString(window, kAXSubroleAttribute as CFString) == (kAXStandardWindowSubrole as String)
                && secureAXBool(window, kAXMainAttribute as CFString)
        }
        return (1...2).contains(exact.count) ? exact.count : 0
    }
}

public struct MacOSExactWindowCaptureSurface {
    public let windowID: CGWindowID
    public let filter: SCContentFilter
    public let sourceRect: CGRect
    public let inputBounds: CGRect
    public let pixelWidth: Double
    public let pixelHeight: Double

    public init(
        windowID: CGWindowID,
        filter: SCContentFilter,
        sourceRect: CGRect,
        inputBounds: CGRect,
        pixelWidth: Double,
        pixelHeight: Double
    ) {
        self.windowID = windowID
        self.filter = filter
        self.sourceRect = sourceRect
        self.inputBounds = inputBounds
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
    }
}

/// ScreenCaptureKit adapter over the pure exact-window resolver. This requires a process boundary
/// and never falls back to full-display capture when resolution is ambiguous or unavailable.
public enum MacOSExactWindowCapture {
    public static func resolve(
        from content: SCShareableContent,
        targetProcessID: pid_t,
        targetWindowID: CGWindowID?
    ) throws -> MacOSExactWindowCaptureSurface {
        let windowCandidates = content.windows.map { window in
            MacOSWindowCandidate(
                processID: window.owningApplication?.processID ?? 0,
                windowID: window.windowID,
                frame: window.frame,
                isOnScreen: window.isOnScreen,
                layer: window.windowLayer
            )
        }
        let displayCandidates = content.displays.map { display in
            MacOSDisplayCandidate(displayID: display.displayID, frame: display.frame)
        }
        let resolution = try MacOSExactWindowGeometry.resolve(
            windows: windowCandidates,
            displays: displayCandidates,
            targetProcessID: targetProcessID,
            targetWindowID: targetWindowID
        )
        let window = content.windows[resolution.windowIndex]
        let display = content.displays[resolution.displayIndex]
        let filter = SCContentFilter(display: display, including: [window])
        let scale = max(1.0, Double(filter.pointPixelScale))
        return MacOSExactWindowCaptureSurface(
            windowID: window.windowID,
            filter: filter,
            sourceRect: resolution.sourceRect,
            inputBounds: resolution.inputBounds,
            pixelWidth: max(2.0, Double(resolution.sourceRect.width) * scale),
            pixelHeight: max(2.0, Double(resolution.sourceRect.height) * scale)
        )
    }
}

/// Accessibility revalidation for Human input. Input is admitted only while exactly one AX window
/// still matches the capture bounds for the same process. Ambiguity, movement, disappearance, or
/// activation failure returns false and leaves the caller fail-closed.
public enum MacOSExactWindowInput {
    public static func activate(processID: pid_t, inputBounds: CGRect) -> Bool {
        guard let application = exactRunningApplication(processID: processID) else { return false }
        let appElement = AXUIElementCreateApplication(processID)
        var windowsRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRaw) == .success,
              let windows = windowsRaw as? [AXUIElement] else { return false }
        let matches = windows.filter { window in
            guard let frame = frame(of: window) else { return false }
            return MacOSExactWindowGeometry.framesMatch(frame, inputBounds)
        }
        guard matches.count == 1, let window = matches.first else { return false }
        // Raising is an activation aid, not an authority proof. Some first-party system windows
        // (including System Settings privacy panes) can expose AXRaise yet reject the action even
        // while the exact same window is already focused/frontmost. Treat raise as best-effort and
        // keep the actual admission criterion below: the same process must be active and its focused
        // AX window must still match the exact capture bounds.
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        // Raising a window and seeing the process become active are not sufficient proof that the
        // exact captured window is ready for Human input. Chromium can report the application active
        // while focus is still transitioning from the previously-frontmost application/window.
        // Ask AX for the exact window, then wait until that same bounded frame is the focused window.
        _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        _ = application.activate(options: [])
        for attempt in 0..<4 {
            if application.isActive && focusedWindowMatches(appElement: appElement, inputBounds: inputBounds) { return true }
            if attempt < 3 { usleep(20_000) }
        }
        // Since macOS 14, `activateIgnoringOtherApps` no longer overrides the foreground app and
        // `NSRunningApplication.activate` may accept a request without making the target frontmost.
        // System Events can set the frontmost application by exact numeric PID. The script contains
        // no provider/user data; if Apple Events policy denies it, activation simply fails closed.
        guard requestExactFrontmost(processID: processID) else { return false }
        for attempt in 0..<10 {
            if application.isActive && focusedWindowMatches(appElement: appElement, inputBounds: inputBounds) { return true }
            if attempt < 9 { usleep(20_000) }
        }
        return application.isActive && focusedWindowMatches(appElement: appElement, inputBounds: inputBounds)
    }

    private static func exactRunningApplication(processID: pid_t) -> NSRunningApplication? {
        // LaunchServices/AppKit can transiently return nil for a still-live exact process while
        // foreground ownership changes. Retry only the already-authorized numeric PID; never widen
        // to a bundle identifier, application name, or another running instance.
        for attempt in 0..<6 {
            if let application = NSRunningApplication(processIdentifier: processID), !application.isTerminated {
                return application
            }
            if attempt < 5 { usleep(20_000) }
        }
        return nil
    }

    private static func requestExactFrontmost(processID: pid_t) -> Bool {
        let execute: () -> Bool = {
            let source = "tell application \"System Events\" to set frontmost of first application process whose unix id is \(processID) to true"
            guard let script = NSAppleScript(source: source) else { return false }
            var error: NSDictionary?
            _ = script.executeAndReturnError(&error)
            return error == nil
        }
        if Thread.isMainThread { return execute() }
        return DispatchQueue.main.sync(execute: execute)
    }

    private static func focusedWindowMatches(appElement: AXUIElement, inputBounds: CGRect) -> Bool {
        var focusedRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedRaw) == .success,
              let focusedRaw else { return false }
        let focused = unsafeDowncast(focusedRaw, to: AXUIElement.self)
        guard let focusedFrame = frame(of: focused) else { return false }
        return MacOSExactWindowGeometry.framesMatch(focusedFrame, inputBounds)
    }

    private static func frame(of element: AXUIElement) -> CGRect? {
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
}
#endif

#if os(macOS)
/// Metadata-only candidate used to decide whether one newly appeared macOS window may replace the
/// currently authorized exact Window target. No title, content, credential, or Human input is part
/// of this contract.
public struct MacOSWindowLineageCandidate: Sendable, Equatable {
    public let processID: pid_t
    public let windowID: CGWindowID
    public let frame: CGRect
    public let isOnScreen: Bool
    public let layer: Int
    public let isFocused: Bool
    public let isModal: Bool
    public let isDialog: Bool

    public init(
        processID: pid_t,
        windowID: CGWindowID,
        frame: CGRect,
        isOnScreen: Bool,
        layer: Int,
        isFocused: Bool,
        isModal: Bool,
        isDialog: Bool
    ) {
        self.processID = processID
        self.windowID = windowID
        self.frame = frame
        self.isOnScreen = isOnScreen
        self.layer = layer
        self.isFocused = isFocused
        self.isModal = isModal
        self.isDialog = isDialog
    }
}

public struct MacOSWindowLineageResolution: Sendable, Equatable {
    public let windowID: CGWindowID
    public let frame: CGRect

    public init(windowID: CGWindowID, frame: CGRect) {
        self.windowID = windowID
        self.frame = frame
    }
}

public enum MacOSWindowLineageResolutionError: Error, Equatable {
    case noSuccessor
    case ambiguousSuccessor
}

/// Pure successor-admission policy for bounded Window Handoff.
///
/// A successor must be a newly observed window from the exact same process and must carry a
/// bounded UI relationship signal (focused, modal, or dialog). Pre-existing sibling windows and
/// arbitrary frontmost windows are never eligible. More than one eligible successor fails closed.
public enum MacOSWindowLineage {
    /// Layer zero remains the ordinary Window surface. A non-zero-layer window is eligible only
    /// when AX independently proves that the same exact window is both focused and a modal/dialog.
    /// This is intentionally narrower than accepting arbitrary floating/system-owned layers.
    public static func isSupportedSurface(_ candidate: MacOSWindowLineageCandidate) -> Bool {
        candidate.layer == 0
            || (candidate.isFocused && (candidate.isModal || candidate.isDialog))
    }

    public static func resolveSuccessor(
        candidates: [MacOSWindowLineageCandidate],
        targetProcessID: pid_t,
        currentWindowID: CGWindowID,
        knownWindowIDs: Set<CGWindowID>,
        minimumSize: CGSize = CGSize(width: 80, height: 60)
    ) throws -> MacOSWindowLineageResolution {
        let eligible = candidates.filter { candidate in
            candidate.processID == targetProcessID
                && candidate.windowID != currentWindowID
                && !knownWindowIDs.contains(candidate.windowID)
                && candidate.isOnScreen
                && isSupportedSurface(candidate)
                && candidate.frame.width >= minimumSize.width
                && candidate.frame.height >= minimumSize.height
                && (candidate.isFocused || candidate.isModal || candidate.isDialog)
        }
        guard !eligible.isEmpty else { throw MacOSWindowLineageResolutionError.noSuccessor }
        guard eligible.count == 1, let successor = eligible.first else {
            throw MacOSWindowLineageResolutionError.ambiguousSuccessor
        }
        return MacOSWindowLineageResolution(windowID: successor.windowID, frame: successor.frame)
    }

    /// A modal/successor may return only to its immediate exact predecessor after the current
    /// window disappears. Arbitrary older/pre-existing siblings are never considered here.
    public static func canReturnToPredecessor(
        candidates: [MacOSWindowLineageCandidate],
        targetProcessID: pid_t,
        currentWindowID: CGWindowID,
        predecessorWindowID: CGWindowID
    ) -> Bool {
        let currentStillPresent = candidates.contains { candidate in
            candidate.processID == targetProcessID
                && candidate.windowID == currentWindowID
                && candidate.isOnScreen
                && isSupportedSurface(candidate)
        }
        guard !currentStillPresent else { return false }
        let predecessor = candidates.filter { candidate in
            candidate.processID == targetProcessID
                && candidate.windowID == predecessorWindowID
                && candidate.isOnScreen
                && candidate.layer == 0
                && candidate.isFocused
        }
        return predecessor.count == 1
    }
}
#endif
