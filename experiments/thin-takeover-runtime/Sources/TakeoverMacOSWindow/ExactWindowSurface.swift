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

public struct MacOSExactWindowCaptureSurface {
    public let filter: SCContentFilter
    public let sourceRect: CGRect
    public let inputBounds: CGRect
    public let pixelWidth: Double
    public let pixelHeight: Double

    public init(
        filter: SCContentFilter,
        sourceRect: CGRect,
        inputBounds: CGRect,
        pixelWidth: Double,
        pixelHeight: Double
    ) {
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
        guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { return false }
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
