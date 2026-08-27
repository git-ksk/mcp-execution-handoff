import Foundation
import TakeoverCore
import TakeoverMacOSWindow

#if os(macOS)
import AppKit
import ApplicationServices
import CoreGraphics
import CoreImage
import ImageIO
import Darwin
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import VideoToolbox

private enum WebRtcHostExitReason: String {
    case stdinEOF = "stdin_eof"
    case permission
    case windowResolution = "window_resolution"
    case captureStart = "capture_start"
    case encoder
    case leaseExpiry = "lease_expiry"
    case explicitStop = "explicit_stop"
    case targetUnavailable = "target_unavailable"
    case unexpected
}

private enum WebRtcHostError: Error {
    case configuration, permission, display, captureStart, encoder(OSStatus)

    var exitReason: WebRtcHostExitReason {
        switch self {
        case .permission: return .permission
        case .display: return .windowResolution
        case .captureStart: return .captureStart
        case .encoder: return .encoder
        case .configuration: return .unexpected
        }
    }
}

private func emitHostExitReason(_ reason: WebRtcHostExitReason) {
    FileHandle.standardError.write(Data("MCP_HANDOFF_DIAGNOSTIC host_exit_reason=\(reason.rawValue)\n".utf8))
}

private final class StopState: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private var reason: WebRtcHostExitReason?
    func stop(_ reason: WebRtcHostExitReason) {
        lock.lock()
        if !stopped { self.reason = reason }
        stopped = true
        lock.unlock()
    }
    var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    var exitReason: WebRtcHostExitReason? { lock.lock(); defer { lock.unlock() }; return reason }
}

private func monitorLocalAuthenticationTarget(
    stop: StopState,
    processID: pid_t,
    inputBounds: CGRect
) {
    Task.detached(priority: .userInitiated) {
        while !stop.isStopped {
            if !MacOSLocalAuthenticationWindowInput.verifyFocused(
                processID: processID,
                inputBounds: inputBounds
            ) {
                stop.stop(.targetUnavailable)
                return
            }
            try? await Task.sleep(for: .milliseconds(60))
        }
    }
}

private func selectedDisplay(from displays: [SCDisplay], requested: CGDirectDisplayID?) throws -> SCDisplay {
    guard !displays.isEmpty else { throw WebRtcHostError.display }
    if let requested {
        guard let display = displays.first(where: { $0.displayID == requested }) else { throw WebRtcHostError.display }
        return display
    }
    guard displays.count == 1, let display = displays.first else { throw WebRtcHostError.display }
    return display
}

private func loadDisplayID() throws -> CGDirectDisplayID? {
    guard let text = ProcessInfo.processInfo.environment["TAKEOVER_WEBRTC_DISPLAY_ID"] else { return nil }
    guard let value = UInt32(text) else { throw WebRtcHostError.configuration }
    return CGDirectDisplayID(value)
}

private func loadTargetProcessID() throws -> pid_t? {
    guard let text = ProcessInfo.processInfo.environment["TAKEOVER_WEBRTC_TARGET_PID"] else { return nil }
    guard let value = Int32(text), value > 0 else { throw WebRtcHostError.configuration }
    return pid_t(value)
}

private func loadTargetWindowID(targetProcessID: pid_t?) throws -> CGWindowID? {
    guard let text = ProcessInfo.processInfo.environment["TAKEOVER_WEBRTC_TARGET_WINDOW_ID"] else { return nil }
    guard targetProcessID != nil, let value = UInt32(text), value > 0 else { throw WebRtcHostError.configuration }
    return CGWindowID(value)
}

private enum HostFrameFormat: String {
    case h264
    case jpeg
}

private func loadHostFrameFormat() throws -> HostFrameFormat {
    guard let raw = ProcessInfo.processInfo.environment["TAKEOVER_WEBRTC_FRAME_FORMAT"] else {
        return .h264
    }
    guard let format = HostFrameFormat(rawValue: raw) else { throw WebRtcHostError.configuration }
    return format
}

private enum InitialSecureWindowPolicy: String {
    case macosLocalAuthentication = "macos_local_authentication"
}

private func loadInitialSecureWindowPolicy(
    targetProcessID: pid_t?,
    targetWindowID: CGWindowID?
) throws -> InitialSecureWindowPolicy? {
    guard let raw = ProcessInfo.processInfo.environment["TAKEOVER_WEBRTC_INITIAL_SECURE_WINDOW"] else {
        return nil
    }
    guard raw == InitialSecureWindowPolicy.macosLocalAuthentication.rawValue,
          targetProcessID != nil,
          targetWindowID == nil else { throw WebRtcHostError.configuration }
    return .macosLocalAuthentication
}

private func loadMediaProfile() throws -> MacOSWindowMediaProfile {
    guard let value = ProcessInfo.processInfo.environment["TAKEOVER_WEBRTC_MEDIA_PROFILE"] else {
        return .standard
    }
    guard value == MacOSWindowMediaProfile.windowText.rawValue else { throw WebRtcHostError.configuration }
    return .windowText
}

private func emitMediaProfile(_ profile: MacOSWindowMediaProfile, policy: MacOSWindowMediaPolicy) {
    guard profile == .windowText else { return }
    let speedPriority = policy.prioritizeEncodingSpeedOverQuality ? 1 : 0
    FileHandle.standardError.write(Data(
        "MCP_HANDOFF_DIAGNOSTIC media_profile=window_text width=\(policy.width) height=\(policy.height) bitrate_kbps=\(policy.averageBitrate / 1_000) speed_priority=\(speedPriority)\n".utf8
    ))
}

private struct WindowLineageConfig {
    let transitionWindowMs: Int
}

private func loadWindowLineageConfig(targetProcessID: pid_t?) throws -> WindowLineageConfig? {
    let environment = ProcessInfo.processInfo.environment
    guard let mode = environment["TAKEOVER_WEBRTC_WINDOW_LINEAGE"] else {
        if environment["TAKEOVER_WEBRTC_WINDOW_LINEAGE_TRANSITION_MS"] != nil { throw WebRtcHostError.configuration }
        return nil
    }
    guard mode == "same_process_successor", targetProcessID != nil else { throw WebRtcHostError.configuration }
    let transitionWindowMs: Int
    if let raw = environment["TAKEOVER_WEBRTC_WINDOW_LINEAGE_TRANSITION_MS"] {
        guard let parsed = Int(raw), (100...2_000).contains(parsed) else { throw WebRtcHostError.configuration }
        transitionWindowMs = parsed
    } else {
        transitionWindowMs = 800
    }
    return WindowLineageConfig(transitionWindowMs: transitionWindowMs)
}

private struct WindowTargetSnapshot: Sendable, Equatable {
    let processID: pid_t
    let windowID: CGWindowID
    let inputBounds: CGRect
    let allowNonZeroLayer: Bool
}

private struct WindowTargetFrameToken: Sendable, Equatable {
    let snapshot: WindowTargetSnapshot
    let generation: UInt64
}

/// Mutable authority for exactly one Window target. During successor discovery no mutable input
/// snapshot exists; the old target is fenced before a new target can be admitted.
private final class WindowTargetAuthority: @unchecked Sendable {
    private let lock = NSLock()
    private var current: WindowTargetSnapshot
    private var generation: UInt64 = 0
    private var fenced = false
    private var failed = false

    init(_ initial: WindowTargetSnapshot) { current = initial }

    func snapshotForInput() -> WindowTargetSnapshot? {
        lock.lock(); defer { lock.unlock() }
        return (!fenced && !failed) ? current : nil
    }

    func currentSnapshot() -> WindowTargetSnapshot {
        lock.lock(); defer { lock.unlock() }; return current
    }

    func snapshotForFrame() -> WindowTargetFrameToken? {
        lock.lock(); defer { lock.unlock() }
        guard !fenced, !failed else { return nil }
        return WindowTargetFrameToken(snapshot: current, generation: generation)
    }

    func frameTokenIsCurrent(_ token: WindowTargetFrameToken) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !fenced && !failed && generation == token.generation && current == token.snapshot
    }

    func isFailed() -> Bool {
        lock.lock(); defer { lock.unlock() }; return failed
    }

    func fenceForTransition() -> WindowTargetSnapshot? {
        lock.lock(); defer { lock.unlock() }
        guard !fenced, !failed else { return nil }
        generation &+= 1
        fenced = true
        return current
    }

    func resume(_ expected: WindowTargetSnapshot) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !failed, fenced, current.windowID == expected.windowID else { return false }
        fenced = false
        return true
    }

    func rotate(from expected: WindowTargetSnapshot, to successor: WindowTargetSnapshot) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !failed, fenced, current.windowID == expected.windowID, successor.processID == current.processID else { return false }
        current = successor
        fenced = false
        return true
    }

    func failClosed() { lock.lock(); failed = true; fenced = true; lock.unlock() }
}

private struct CaptureSurface {
    let targetWindowID: CGWindowID?
    let filter: SCContentFilter
    let sourceRect: CGRect?
    let inputBounds: CGRect
    let pixelWidth: Double
    let pixelHeight: Double
    let allowNonZeroLayer: Bool
}

private func selectedCaptureSurface(
    from content: SCShareableContent,
    requestedDisplay: CGDirectDisplayID?,
    targetProcessID: pid_t?,
    targetWindowID: CGWindowID?,
    initialSecureWindowPolicy: InitialSecureWindowPolicy?
) throws -> CaptureSurface {
    if let targetProcessID {
        do {
            let exact: MacOSExactWindowCaptureSurface
            if initialSecureWindowPolicy == .macosLocalAuthentication {
                exact = try MacOSLocalAuthenticationWindowCapture.resolve(
                    from: content,
                    targetProcessID: targetProcessID
                )
            } else {
                exact = try MacOSExactWindowCapture.resolve(
                    from: content,
                    targetProcessID: targetProcessID,
                    targetWindowID: targetWindowID
                )
            }
            return CaptureSurface(
                targetWindowID: exact.windowID,
                filter: exact.filter,
                sourceRect: exact.sourceRect,
                inputBounds: exact.inputBounds,
                pixelWidth: exact.pixelWidth,
                pixelHeight: exact.pixelHeight,
                allowNonZeroLayer: initialSecureWindowPolicy == .macosLocalAuthentication
            )
        } catch {
            throw WebRtcHostError.display
        }
    }
    let display = try selectedDisplay(from: content.displays, requested: requestedDisplay)
    return CaptureSurface(
        targetWindowID: nil,
        filter: SCContentFilter(display: display, excludingWindows: []),
        sourceRect: nil,
        inputBounds: CGDisplayBounds(display.displayID),
        pixelWidth: Double(display.width),
        pixelHeight: Double(display.height),
        allowNonZeroLayer: false
    )
}

/// Resolve one already-admitted lineage successor without weakening ordinary exact-window capture.
/// Non-zero layers are accepted only after the current AX snapshot independently confirms the same
/// PID/window/frame as a focused modal/dialog. There is no display/desktop fallback.
private func selectedLineageCaptureSurface(
    from content: SCShareableContent,
    targetProcessID: pid_t,
    resolution: MacOSWindowLineageResolution
) throws -> CaptureSurface {
    let candidates = windowLineageCandidates(from: content, targetProcessID: targetProcessID)
    let eligible = candidates.filter { candidate in
        candidate.processID == targetProcessID
            && candidate.windowID == resolution.windowID
            && candidate.isOnScreen
            && MacOSExactWindowGeometry.framesMatch(candidate.frame, resolution.frame)
            && MacOSWindowLineage.isSupportedSurface(candidate)
    }
    guard eligible.count == 1 else { throw WebRtcHostError.display }

    let windows = content.windows.filter { window in
        window.owningApplication?.processID == targetProcessID
            && window.windowID == resolution.windowID
            && window.isOnScreen
            && MacOSExactWindowGeometry.framesMatch(window.frame, resolution.frame)
    }
    guard windows.count == 1, let window = windows.first else { throw WebRtcHostError.display }
    let displays = content.displays.filter { $0.frame.contains(window.frame) }
    guard displays.count == 1, let display = displays.first else { throw WebRtcHostError.display }

    let sourceRect = CGRect(
        x: window.frame.minX - display.frame.minX,
        y: window.frame.minY - display.frame.minY,
        width: window.frame.width,
        height: window.frame.height
    )
    let displayLocalBounds = CGRect(origin: .zero, size: display.frame.size)
    guard displayLocalBounds.contains(sourceRect) else { throw WebRtcHostError.display }
    let filter = SCContentFilter(display: display, including: [window])
    let scale = max(1.0, Double(filter.pointPixelScale))
    return CaptureSurface(
        targetWindowID: window.windowID,
        filter: filter,
        sourceRect: sourceRect,
        inputBounds: window.frame,
        pixelWidth: max(2.0, Double(sourceRect.width) * scale),
        pixelHeight: max(2.0, Double(sourceRect.height) * scale),
        allowNonZeroLayer: window.windowLayer != 0
    )
}

private struct AXWindowLineageMetadata {
    let frame: CGRect
    let isFocused: Bool
    let isModal: Bool
    let isDialog: Bool
}

private func axWindowFrame(_ element: AXUIElement) -> CGRect? {
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

private func axWindowLineageMetadata(processID: pid_t) -> [AXWindowLineageMetadata] {
    let app = AXUIElementCreateApplication(processID)
    var windowsRaw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windowsRaw) == .success,
          let windows = windowsRaw as? [AXUIElement] else { return [] }
    var focusedRaw: CFTypeRef?
    let focused = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focusedRaw) == .success
        ? focusedRaw.map { unsafeDowncast($0, to: AXUIElement.self) }
        : nil
    let focusedFrame = focused.flatMap(axWindowFrame)
    return windows.compactMap { window in
        guard let frame = axWindowFrame(window) else { return nil }
        var modalRaw: CFTypeRef?
        let modal = AXUIElementCopyAttributeValue(window, kAXModalAttribute as CFString, &modalRaw) == .success
            ? (modalRaw as? NSNumber)?.boolValue ?? false
            : false
        var subroleRaw: CFTypeRef?
        let subrole = AXUIElementCopyAttributeValue(window, kAXSubroleAttribute as CFString, &subroleRaw) == .success
            ? subroleRaw as? String
            : nil
        let isFocused = focusedFrame.map { MacOSExactWindowGeometry.framesMatch($0, frame) } ?? false
        return AXWindowLineageMetadata(
            frame: frame,
            isFocused: isFocused,
            isModal: modal,
            isDialog: subrole == (kAXDialogSubrole as String)
        )
    }
}

private func windowLineageCandidates(from content: SCShareableContent, targetProcessID: pid_t) -> [MacOSWindowLineageCandidate] {
    let metadata = axWindowLineageMetadata(processID: targetProcessID)
    return content.windows.map { window in
        let processID = window.owningApplication?.processID ?? 0
        let matches = processID == targetProcessID
            ? metadata.filter { MacOSExactWindowGeometry.framesMatch($0.frame, window.frame) }
            : []
        let relation = matches.count == 1 ? matches[0] : nil
        return MacOSWindowLineageCandidate(
            processID: processID,
            windowID: window.windowID,
            frame: window.frame,
            isOnScreen: window.isOnScreen,
            layer: window.windowLayer,
            isFocused: relation?.isFocused ?? false,
            isModal: relation?.isModal ?? false,
            isDialog: relation?.isDialog ?? false
        )
    }
}

private func currentLineageCandidate(for snapshot: WindowTargetSnapshot) -> MacOSWindowLineageCandidate? {
    guard let raw = CGWindowListCopyWindowInfo([.optionIncludingWindow], snapshot.windowID) as? [[String: Any]] else {
        return nil
    }
    let metadata = axWindowLineageMetadata(processID: snapshot.processID)
    let candidates = raw.compactMap { info -> MacOSWindowLineageCandidate? in
        guard let number = info[kCGWindowNumber as String] as? NSNumber,
              number.uint32Value == snapshot.windowID,
              let owner = info[kCGWindowOwnerPID as String] as? NSNumber,
              let layer = info[kCGWindowLayer as String] as? NSNumber,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds) else { return nil }
        let matches = metadata.filter { MacOSExactWindowGeometry.framesMatch($0.frame, frame) }
        let relation = matches.count == 1 ? matches[0] : nil
        return MacOSWindowLineageCandidate(
            processID: pid_t(owner.int32Value),
            windowID: CGWindowID(number.uint32Value),
            frame: frame,
            isOnScreen: (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
            layer: layer.intValue,
            isFocused: relation?.isFocused ?? false,
            isModal: relation?.isModal ?? false,
            isDialog: relation?.isDialog ?? false
        )
    }.filter { candidate in
        candidate.processID == snapshot.processID
            && candidate.windowID == snapshot.windowID
            && candidate.isOnScreen
            && MacOSExactWindowGeometry.framesMatch(candidate.frame, snapshot.inputBounds)
    }
    guard candidates.count == 1 else { return nil }
    return candidates[0]
}

/// Revalidate a lineage-owned target through the same exact-window and successor-surface policies
/// that admitted it. Non-zero-layer successors keep focused modal/dialog proof at every mutable
/// input/frame boundary; layer-zero successors retain the ordinary exact-window rule.
private func revalidateLineageTarget(_ snapshot: WindowTargetSnapshot) -> Bool {
    guard MacOSExactWindowAuthority.revalidate(
        processID: snapshot.processID,
        windowID: snapshot.windowID,
        inputBounds: snapshot.inputBounds,
        allowNonZeroLayer: snapshot.allowNonZeroLayer
    ) else { return false }
    guard snapshot.allowNonZeroLayer else { return true }
    guard let candidate = currentLineageCandidate(for: snapshot) else { return false }
    return MacOSWindowLineage.isSupportedSurface(candidate)
}

private func sameProcessWindowIDs(from content: SCShareableContent, targetProcessID: pid_t) -> Set<CGWindowID> {
    Set(content.windows.compactMap { window in
        window.owningApplication?.processID == targetProcessID ? window.windowID : nil
    })
}

private func makeStreamConfiguration(
    surface: CaptureSurface,
    width: Int,
    height: Int,
    preserveAspectRatio: Bool,
    frameFormat: HostFrameFormat = .h264
) -> SCStreamConfiguration {
    let configuration = SCStreamConfiguration()
    if let sourceRect = surface.sourceRect { configuration.sourceRect = sourceRect }
    configuration.width = width
    configuration.height = height
    configuration.scalesToFit = true
    configuration.preservesAspectRatio = preserveAspectRatio
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    configuration.queueDepth = 2
    configuration.pixelFormat = frameFormat == .jpeg
        ? kCVPixelFormatType_32BGRA
        : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    configuration.capturesAudio = false
    configuration.showsCursor = false
    return configuration
}

private func makeLease() throws -> EphemeralSessionLease {
    guard let text = ProcessInfo.processInfo.environment["TAKEOVER_WEBRTC_EXPIRES_AT_UNIX_MS"], let expiry = UInt64(text) else {
        throw WebRtcHostError.configuration
    }
    let wallMillis = UInt64(max(0, Date().timeIntervalSince1970 * 1_000))
    return try EphemeralLeaseFactory.make(expiresAtUnixMillis: expiry, nowUnixMillis: wallMillis, nowMonotonicNanos: MonotonicClock.nowNanos())
}

private final class HostMetricWriter: @unchecked Sendable {
    private let lock = NSLock()
    private var lastEmitNs: UInt64 = 0

    func submitEncodeMs(_ encodeMs: Double) {
        let nowNs = DispatchTime.now().uptimeNanoseconds
        lock.lock()
        if lastEmitNs != 0, nowNs >= lastEmitNs, nowNs - lastEmitNs < 500_000_000 { lock.unlock(); return }
        lastEmitNs = nowNs
        lock.unlock()
        let tenths = UInt16(min(Double(UInt16.max), max(0, (encodeMs * 10).rounded())))
        FileHandle.standardError.write(Data("MCP_HANDOFF_METRIC encode_tenths=\(tenths)\n".utf8))
    }
}

private enum InputTextDiagnosticRoute: String {
    case nativeAX = "native_ax"
    case pidKeyboard = "pid_keyboard"
    case eventCreationFailure = "event_creation_failure"
    case activationRejected = "activation_rejected"
    case nativeBoundaryRejected = "native_boundary_rejected"
}

private final class HostControlWriter: @unchecked Sendable {
    private let handle = FileHandle.standardError
    private let lock = NSLock()

    func submitEditableRegions(_ regions: [[Int]]) {
        let payload = regions.prefix(32).map { region in
            region.prefix(4).map(String.init).joined(separator: ",")
        }.joined(separator: ";")
        lock.lock(); defer { lock.unlock() }
        handle.write(Data("MCP_HANDOFF_CONTROL editable_regions=\(payload)\n".utf8))
    }

    func submitInputTextRoute(_ route: InputTextDiagnosticRoute) {
        lock.lock(); defer { lock.unlock() }
        handle.write(Data("MCP_HANDOFF_DIAGNOSTIC input_text_route=\(route.rawValue)\n".utf8))
    }
}

private final class EditableRegionPublisher: @unchecked Sendable {
    private let targetProcessID: pid_t
    private let inputBoundsProvider: @Sendable () -> CGRect?
    private let writer: HostControlWriter

    init(
        targetProcessID: pid_t,
        inputBoundsProvider: @escaping @Sendable () -> CGRect?,
        writer: HostControlWriter
    ) {
        self.targetProcessID = targetProcessID
        self.inputBoundsProvider = inputBoundsProvider
        self.writer = writer
    }

    func start(stop: StopState) {
        Thread.detachNewThread { [self, stop] in
            while !stop.isStopped {
                writer.submitEditableRegions(snapshot())
                usleep(250_000)
            }
        }
    }

    private func snapshot() -> [[Int]] {
        guard let inputBounds = inputBoundsProvider(), inputBounds.width > 0, inputBounds.height > 0 else { return [] }
        let app = AXUIElementCreateApplication(targetProcessID)
        guard let webArea = firstWebArea(in: app) else { return [] }
        var stack: [AXUIElement] = [webArea]
        var visited = 0
        var regions: [[Int]] = []
        while let element = stack.popLast(), visited < 1_024, regions.count < 32 {
            visited += 1
            if elementIsEditable(element), let frame = elementFrame(element) {
                let clipped = frame.intersection(inputBounds)
                if !clipped.isNull, clipped.width >= 2, clipped.height >= 2 {
                    let x = normalized(clipped.minX - inputBounds.minX, inputBounds.width)
                    let y = normalized(clipped.minY - inputBounds.minY, inputBounds.height)
                    let maxX = normalized(clipped.maxX - inputBounds.minX, inputBounds.width)
                    let maxY = normalized(clipped.maxY - inputBounds.minY, inputBounds.height)
                    let w = max(1, min(10_000 - x, maxX - x))
                    let h = max(1, min(10_000 - y, maxY - y))
                    regions.append([x, y, w, h])
                }
            }
            children(of: element).reversed().forEach { stack.append($0) }
        }
        return regions
    }

    private func firstWebArea(in root: AXUIElement) -> AXUIElement? {
        var stack: [AXUIElement] = [root]
        var visited = 0
        while let element = stack.popLast(), visited < 512 {
            visited += 1
            if role(of: element) == "AXWebArea" { return element }
            children(of: element).reversed().forEach { stack.append($0) }
        }
        return nil
    }

    private func children(of element: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
              let values = raw as? [AXUIElement] else { return [] }
        return values
    }

    private func role(of element: AXUIElement) -> String? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &raw) == .success else { return nil }
        return raw as? String
    }

    private func elementIsEditable(_ element: AXUIElement) -> Bool {
        let value = role(of: element)
        return value == (kAXTextFieldRole as String)
            || value == (kAXTextAreaRole as String)
            || value == (kAXComboBoxRole as String)
    }

    private func elementFrame(_ element: AXUIElement) -> CGRect? {
        var positionRaw: CFTypeRef?
        var sizeRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRaw) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRaw) == .success,
              let positionRaw, let sizeRaw,
              CFGetTypeID(positionRaw) == AXValueGetTypeID(), CFGetTypeID(sizeRaw) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(unsafeDowncast(positionRaw, to: AXValue.self), .cgPoint, &point),
              AXValueGetValue(unsafeDowncast(sizeRaw, to: AXValue.self), .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }

    private func normalized(_ value: CGFloat, _ extent: CGFloat) -> Int {
        Int(min(10_000, max(0, (value / extent * 10_000).rounded())))
    }
}

private final class LatestOutputWriter: @unchecked Sendable {
    private struct PendingOutput {
        let record: Data
        let stillValid: (@Sendable () -> Bool)?
    }

    private let handle = FileHandle.standardOutput
    private let queue = DispatchQueue(label: "takeover.webrtc.stdout", qos: .userInteractive)
    private let lock = NSLock()
    private var writing = false
    private var latestFrame: PendingOutput?
    private var latestControl: PendingOutput?

    func submitFrame(_ record: Data, stillValid: (@Sendable () -> Bool)? = nil) {
        enqueue(PendingOutput(record: record, stillValid: stillValid), control: false)
    }
    func submitEditable(_ editable: Bool) {
        let payload = Data([editable ? 1 : 0])
        var record = Data([2]); var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { record.append(contentsOf: $0) }
        record.append(payload)
        enqueue(PendingOutput(record: record, stillValid: nil), control: true)
    }
    private func enqueue(_ output: PendingOutput, control: Bool) {
        lock.lock()
        if writing {
            if control { latestControl = output } else { latestFrame = output }
            lock.unlock()
            return
        }
        writing = true
        lock.unlock()
        queue.async { [weak self] in self?.drain(first: output) }
    }
    private func drain(first: PendingOutput) {
        var current: PendingOutput? = first
        while let output = current {
            if output.stillValid?() ?? true { handle.write(output.record) }
            lock.lock()
            if let control = latestControl { latestControl = nil; current = control }
            else if let frame = latestFrame { latestFrame = nil; current = frame }
            else { writing = false; current = nil }
            lock.unlock()
        }
    }
}

private func jpegFrameRecord(jpeg: Data, width: Int, height: Int) -> Data? {
    guard width > 0, width <= Int(UInt16.max), height > 0, height <= Int(UInt16.max),
          jpeg.count >= 4, jpeg.count <= 8 * 1024 * 1024 - 9,
          jpeg.starts(with: [0xff, 0xd8]), jpeg.suffix(2).elementsEqual([0xff, 0xd9])
    else { return nil }
    var payload = Data()
    payload.reserveCapacity(4 + jpeg.count)
    var widthBE = UInt16(width).bigEndian
    var heightBE = UInt16(height).bigEndian
    withUnsafeBytes(of: &widthBE) { payload.append(contentsOf: $0) }
    withUnsafeBytes(of: &heightBE) { payload.append(contentsOf: $0) }
    payload.append(jpeg)
    var record = Data([2])
    var length = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: &length) { record.append(contentsOf: $0) }
    record.append(payload)
    return record
}

private final class JPEGFrameOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private let admission = FrameAdmissionGate(maxInFlight: 1)
    private let lease: EphemeralSessionLease
    private let writer: LatestOutputWriter
    private let width: Int
    private let height: Int
    private let targetProcessID: pid_t
    private let targetWindowID: CGWindowID
    private let inputBounds: CGRect
    private let targetAuthority: WindowTargetAuthority?
    private let secureWindow: Bool
    private let authorityLost: @Sendable () -> Void

    init(
        lease: EphemeralSessionLease,
        writer: LatestOutputWriter,
        width: Int,
        height: Int,
        targetProcessID: pid_t,
        targetWindowID: CGWindowID,
        inputBounds: CGRect,
        targetAuthority: WindowTargetAuthority? = nil,
        secureWindow: Bool,
        authorityLost: @escaping @Sendable () -> Void
    ) {
        self.lease = lease
        self.writer = writer
        self.width = width
        self.height = height
        self.targetProcessID = targetProcessID
        self.targetWindowID = targetWindowID
        self.inputBounds = inputBounds
        self.targetAuthority = targetAuthority
        self.secureWindow = secureWindow
        self.authorityLost = authorityLost
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard lease.isActive(), type == .screen, let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if let array = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let info = array.first, let raw = info[.status] as? Int,
           let status = SCFrameStatus(rawValue: raw), status != .complete { return }
        guard admission.tryAcquire() else { return }
        defer { admission.release() }

        let activeTarget: WindowTargetSnapshot?
        let frameStillValid: @Sendable () -> Bool
        if let targetAuthority {
            guard let token = targetAuthority.snapshotForFrame() else {
                if targetAuthority.isFailed() {
                    FileHandle.standardError.write(Data("MCP_HANDOFF_DIAGNOSTIC capture_stage=authority_lost\n".utf8))
                    authorityLost()
                }
                return
            }
            activeTarget = token.snapshot
            frameStillValid = { targetAuthority.frameTokenIsCurrent(token) }
        } else {
            activeTarget = nil
            frameStillValid = { true }
        }
        let activeProcessID = activeTarget?.processID ?? targetProcessID
        let activeWindowID = activeTarget?.windowID ?? targetWindowID
        let activeInputBounds = activeTarget?.inputBounds ?? inputBounds
        let allowNonZeroLayer = activeTarget?.allowNonZeroLayer ?? secureWindow
        let exactWindowValid = activeTarget.map(revalidateLineageTarget) ?? MacOSExactWindowAuthority.revalidate(
            processID: activeProcessID,
            windowID: activeWindowID,
            inputBounds: activeInputBounds,
            allowNonZeroLayer: allowNonZeroLayer
        )
        let secureIdentityValid = !secureWindow || MacOSLocalAuthenticationWindowInput.verifyFocused(
            processID: activeProcessID, inputBounds: activeInputBounds
        )
        guard exactWindowValid, secureIdentityValid else {
            FileHandle.standardError.write(Data("MCP_HANDOFF_DIAGNOSTIC capture_stage=authority_lost\n".utf8))
            targetAuthority?.failClosed()
            authorityLost()
            return
        }
        autoreleasepool {
            let image = CIImage(cvPixelBuffer: pixel)
            guard let jpeg = context.jpegRepresentation(
                of: image,
                colorSpace: colorSpace,
                options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.72]
            ), let record = jpegFrameRecord(jpeg: jpeg, width: width, height: height) else { return }
            writer.submitFrame(record, stillValid: frameStillValid)
        }
    }
}

private final class H264PipeEncoder: @unchecked Sendable {
    typealias Completion = @Sendable () -> Void
    typealias Output = @Sendable (_ avcc: Data, _ timestamp: UInt32, _ keyframe: Bool, _ encodeMs: Double) -> Void
    private var session: VTCompressionSession?
    private let output: Output
    private let keyframeLock = NSLock()
    private var forceNextKeyframe = false

    init(
        width: Int32,
        height: Int32,
        averageBitrate: Int,
        prioritizeEncodingSpeedOverQuality: Bool,
        output: @escaping Output
    ) throws {
        self.output = output
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault, width: width, height: height, codecType: kCMVideoCodecType_H264,
            encoderSpecification: [
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true,
                kVTVideoEncoderSpecification_EnableLowLatencyRateControl as String: true
            ] as CFDictionary,
            imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { refCon, sourceFrameRefCon, status, _, sampleBuffer in
                guard let sourceFrameRefCon else { return }
                let context = Unmanaged<FrameContext>.fromOpaque(sourceFrameRefCon).takeRetainedValue()
                defer { context.completion() }
                guard status == noErr, let refCon, let sampleBuffer else { return }
                Unmanaged<H264PipeEncoder>.fromOpaque(refCon).takeUnretainedValue().handle(sampleBuffer, startedAtNs: context.startedAtNs)
            }, refcon: refcon, compressionSessionOut: &session
        )
        guard status == noErr, let session else { throw WebRtcHostError.encoder(status) }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: NSNumber(value: 0))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: 30))
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
            value: prioritizeEncodingSpeedOverQuality ? kCFBooleanTrue : kCFBooleanFalse
        )
        if #available(macOS 15.0, *) { VTSessionSetProperty(session, key: kVTCompressionPropertyKey_SuggestedLookAheadFrameCount, value: NSNumber(value: 0)) }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: averageBitrate))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: 30))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel)
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    deinit {
        if let session { VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(session) }
    }

    func requestIDR() {
        keyframeLock.lock(); forceNextKeyframe = true; keyframeLock.unlock()
    }

    private func consumeKeyframeRequest() -> Bool {
        keyframeLock.lock(); defer { keyframeLock.unlock() }
        let value = forceNextKeyframe; forceNextKeyframe = false; return value
    }

    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime, completion: @escaping Completion) {
        guard let session else { completion(); return }
        let context = Unmanaged.passRetained(FrameContext(completion: completion)).toOpaque()
        var flags: VTEncodeInfoFlags = []
        let frameProperties: CFDictionary? = consumeKeyframeRequest()
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary
            : nil
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: pixelBuffer, presentationTimeStamp: pts, duration: .invalid, frameProperties: frameProperties, sourceFrameRefcon: context, infoFlagsOut: &flags)
        if status != noErr { Unmanaged<FrameContext>.fromOpaque(context).release(); completion() }
    }

    private final class FrameContext {
        let completion: Completion
        let startedAtNs: UInt64
        init(completion: @escaping Completion) {
            self.completion = completion
            self.startedAtNs = DispatchTime.now().uptimeNanoseconds
        }
    }

    private func handle(_ sampleBuffer: CMSampleBuffer, startedAtNs: UInt64) {
        guard CMSampleBufferDataIsReady(sampleBuffer), let block = CMSampleBufferGetDataBuffer(sampleBuffer), let format = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]]
        let keyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        var nalHeaderLength = 4
        var parameterSets: [Data] = []
        var pointer: UnsafePointer<UInt8>?
        var size = 0
        var count = 0
        var headerLength: Int32 = 0
        let parameterStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
            parameterSetCountOut: &count, nalUnitHeaderLengthOut: &headerLength
        )
        if parameterStatus == noErr, headerLength > 0 { nalHeaderLength = Int(headerLength) }
        if keyframe, parameterStatus == noErr, let pointer, size > 0 {
            parameterSets.append(Data(bytes: pointer, count: size))
            if count > 1 {
                var ppsPointer: UnsafePointer<UInt8>?; var ppsSize = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    format, parameterSetIndex: 1, parameterSetPointerOut: &ppsPointer, parameterSetSizeOut: &ppsSize,
                    parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
                ) == noErr, let ppsPointer, ppsSize > 0 { parameterSets.append(Data(bytes: ppsPointer, count: ppsSize)) }
            }
        }
        let totalLength = CMBlockBufferGetDataLength(block)
        guard totalLength > 0 else { return }
        var sample = Data(count: totalLength)
        let copyStatus = sample.withUnsafeMutableBytes { bytes -> OSStatus in
            guard let base = bytes.baseAddress else { return -1 }
            return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: totalLength, destination: base)
        }
        guard copyStatus == noErr, let normalized = normalizeAvcc(sample, nalHeaderLength: nalHeaderLength, prefix: parameterSets) else { return }
        sample.resetBytes(in: 0..<sample.count)
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let scaled = CMTimeConvertScale(pts, timescale: 90_000, method: .default)
        let nowNs = DispatchTime.now().uptimeNanoseconds
        let encodeMs = nowNs >= startedAtNs ? Double(nowNs - startedAtNs) / 1_000_000.0 : 0
        output(normalized, UInt32(truncatingIfNeeded: max(Int64(0), scaled.value)), keyframe, min(6_553.5, max(0, encodeMs)))
    }

    private func normalizeAvcc(_ sample: Data, nalHeaderLength: Int, prefix: [Data]) -> Data? {
        guard (1...4).contains(nalHeaderLength) else { return nil }
        var result = Data(); result.reserveCapacity(sample.count + prefix.reduce(0) { $0 + $1.count + 4 })
        func appendNAL(_ nal: Data) {
            var length = UInt32(nal.count).bigEndian
            withUnsafeBytes(of: &length) { result.append(contentsOf: $0) }; result.append(nal)
        }
        for nal in prefix { appendNAL(nal) }
        var offset = 0
        while offset < sample.count {
            guard offset + nalHeaderLength <= sample.count else { return nil }
            var length = 0
            for byte in sample[offset..<(offset + nalHeaderLength)] { length = (length << 8) | Int(byte) }
            offset += nalHeaderLength
            guard length > 0, offset + length <= sample.count else { return nil }
            appendNAL(sample.subdata(in: offset..<(offset + length))); offset += length
        }
        return result.isEmpty ? nil : result
    }
}

private final class CaptureOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    private let encoder: H264PipeEncoder
    private let admission = FrameAdmissionGate(maxInFlight: 1)
    private let lease: EphemeralSessionLease
    init(encoder: H264PipeEncoder, lease: EphemeralSessionLease) { self.encoder = encoder; self.lease = lease }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard lease.isActive(), type == .screen, let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if let array = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let info = array.first, let raw = info[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status != .complete { return }
        guard admission.tryAcquire() else { return }
        encoder.encode(pixel, pts: CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) { [admission] in admission.release() }
    }
}

private final class WindowLineageController: @unchecked Sendable {
    private let targetProcessID: pid_t
    private let authority: WindowTargetAuthority
    private let stream: SCStream
    private let width: Int
    private let height: Int
    private let transitionWindowMs: Int
    private let requestIDR: @Sendable () -> Void
    private let stop: StopState
    private let knownLock = NSLock()
    private var knownWindowIDs: Set<CGWindowID>
    private var predecessorStack: [WindowTargetSnapshot] = []

    init(
        targetProcessID: pid_t,
        authority: WindowTargetAuthority,
        stream: SCStream,
        width: Int,
        height: Int,
        transitionWindowMs: Int,
        initialKnownWindowIDs: Set<CGWindowID>,
        requestIDR: @escaping @Sendable () -> Void,
        stop: StopState
    ) {
        self.targetProcessID = targetProcessID
        self.authority = authority
        self.stream = stream
        self.width = width
        self.height = height
        self.transitionWindowMs = transitionWindowMs
        self.knownWindowIDs = initialKnownWindowIDs
        self.requestIDR = requestIDR
        self.stop = stop
    }

    func afterPrimaryRelease() {
        guard let previous = authority.fenceForTransition(), !stop.isStopped else { return }
        emit("probe_started")
        Task { [weak self] in await self?.probe(from: previous) }
    }

    private func probe(from previous: WindowTargetSnapshot) async {
        let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(transitionWindowMs) * 1_000_000
        var lastObservedSameProcessIDs = Set<CGWindowID>()
        do {
            while !stop.isStopped, DispatchTime.now().uptimeNanoseconds <= deadline {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                let observedIDs = sameProcessWindowIDs(from: content, targetProcessID: targetProcessID)
                lastObservedSameProcessIDs = observedIDs
                let known = knownSnapshot()
                let candidates = windowLineageCandidates(from: content, targetProcessID: targetProcessID)
                if let predecessor = predecessorSnapshot(),
                   MacOSWindowLineage.canReturnToPredecessor(
                       candidates: candidates,
                       targetProcessID: targetProcessID,
                       currentWindowID: previous.windowID,
                       predecessorWindowID: predecessor.windowID
                   ) {
                    let predecessorSurface = try selectedCaptureSurface(
                        from: content,
                        requestedDisplay: nil,
                        targetProcessID: targetProcessID,
                        targetWindowID: predecessor.windowID,
                        initialSecureWindowPolicy: nil
                    )
                    let configuration = makeStreamConfiguration(
                        surface: predecessorSurface,
                        width: width,
                        height: height,
                        preserveAspectRatio: false
                    )
                    try await stream.updateContentFilter(predecessorSurface.filter)
                    try await stream.updateConfiguration(configuration)
                    let restored = WindowTargetSnapshot(
                        processID: targetProcessID,
                        windowID: predecessor.windowID,
                        inputBounds: predecessorSurface.inputBounds,
                        allowNonZeroLayer: predecessorSurface.allowNonZeroLayer
                    )
                    guard authority.rotate(from: previous, to: restored) else { return failClosed("failure") }
                    popPredecessor()
                    remember(observedIDs)
                    requestIDR()
                    emit("returned")
                    return
                }
                do {
                    let resolution = try MacOSWindowLineage.resolveSuccessor(
                        candidates: candidates,
                        targetProcessID: targetProcessID,
                        currentWindowID: previous.windowID,
                        knownWindowIDs: known
                    )
                    let surface = try selectedLineageCaptureSurface(
                        from: content,
                        targetProcessID: targetProcessID,
                        resolution: resolution
                    )
                    guard surface.targetWindowID == resolution.windowID else { return failClosed("failure") }
                    let configuration = makeStreamConfiguration(
                        surface: surface,
                        width: width,
                        height: height,
                        preserveAspectRatio: false
                    )
                    try await stream.updateContentFilter(surface.filter)
                    try await stream.updateConfiguration(configuration)
                    let successor = WindowTargetSnapshot(
                        processID: targetProcessID,
                        windowID: resolution.windowID,
                        inputBounds: surface.inputBounds,
                        allowNonZeroLayer: surface.allowNonZeroLayer
                    )
                    guard authority.rotate(from: previous, to: successor) else { return failClosed("failure") }
                    pushPredecessor(previous)
                    remember(observedIDs)
                    requestIDR()
                    emit("admitted")
                    return
                } catch MacOSWindowLineageResolutionError.noSuccessor {
                    try await Task.sleep(for: .milliseconds(40))
                } catch MacOSWindowLineageResolutionError.ambiguousSuccessor {
                    return failClosed("ambiguous")
                }
            }
            if !lastObservedSameProcessIDs.contains(previous.windowID) { return failClosed("unsupported") }
            let unseen = lastObservedSameProcessIDs.subtracting(knownSnapshot())
            if !unseen.isEmpty { return failClosed("unsupported") }
            if authority.resume(previous) { emit("none") } else { failClosed("failure") }
        } catch {
            failClosed("failure")
        }
    }

    private func knownSnapshot() -> Set<CGWindowID> {
        knownLock.lock(); defer { knownLock.unlock() }; return knownWindowIDs
    }

    private func remember(_ ids: Set<CGWindowID>) {
        knownLock.lock(); knownWindowIDs.formUnion(ids); knownLock.unlock()
    }

    private func predecessorSnapshot() -> WindowTargetSnapshot? {
        knownLock.lock(); defer { knownLock.unlock() }; return predecessorStack.last
    }

    private func pushPredecessor(_ snapshot: WindowTargetSnapshot) {
        knownLock.lock(); predecessorStack.append(snapshot); knownLock.unlock()
    }

    private func popPredecessor() {
        knownLock.lock(); if !predecessorStack.isEmpty { predecessorStack.removeLast() }; knownLock.unlock()
    }

    private func failClosed(_ stage: String) {
        authority.failClosed()
        emit(stage)
        stop.stop(.unexpected)
    }

    private func emit(_ stage: String) {
        FileHandle.standardError.write(Data("MCP_HANDOFF_DIAGNOSTIC successor_stage=\(stage)\n".utf8))
    }
}

private final class HumanInputInjector: @unchecked Sendable {
    // This host posts synthetic events from within the logged-in user session. Apple documents
    // combinedSessionState for that case; hidSystemState is for HID-interpreting daemons/drivers.
    private let source = CGEventSource(stateID: .combinedSessionState)
    private let inputBounds: CGRect
    private let targetProcessID: pid_t?
    private let targetWindowID: CGWindowID?
    private let targetAuthority: WindowTargetAuthority?
    private let initialSecureWindowPolicy: InitialSecureWindowPolicy?
    private let afterPrimaryRelease: @Sendable () -> Void
    private let writer: LatestOutputWriter
    private let controlWriter: HostControlWriter
    private let inputLock = NSLock()
    private var primaryPressed = false
    private var primaryPoint = CGPoint.zero
    private var cursorBeforePrimary: CGPoint?
    init(
        inputBounds: CGRect,
        targetProcessID: pid_t?,
        targetWindowID: CGWindowID? = nil,
        targetAuthority: WindowTargetAuthority? = nil,
        initialSecureWindowPolicy: InitialSecureWindowPolicy? = nil,
        afterPrimaryRelease: @escaping @Sendable () -> Void = {},
        writer: LatestOutputWriter,
        controlWriter: HostControlWriter
    ) {
        self.inputBounds = inputBounds
        self.targetProcessID = targetProcessID
        self.targetWindowID = targetWindowID
        self.targetAuthority = targetAuthority
        self.initialSecureWindowPolicy = initialSecureWindowPolicy
        self.afterPrimaryRelease = afterPrimaryRelease
        self.writer = writer
        self.controlWriter = controlWriter
    }

    @discardableResult
    func apply(_ object: [String: Any]) -> Bool {
        guard let kind = object["kind"] as? String else { return false }
        let activeTarget: WindowTargetSnapshot?
        if let targetAuthority {
            guard let snapshot = targetAuthority.snapshotForInput() else {
                if kind == "text" { controlWriter.submitInputTextRoute(.activationRejected) }
                FileHandle.standardError.write(Data("MCP_HANDOFF_DIAGNOSTIC input_stage=activation_failed\n".utf8))
                return false
            }
            activeTarget = snapshot
        } else {
            activeTarget = nil
        }
        let activeProcessID = activeTarget?.processID ?? targetProcessID
        let activeWindowID = activeTarget?.windowID ?? targetWindowID
        let activeInputBounds = activeTarget?.inputBounds ?? inputBounds
        if let activeProcessID, let activeWindowID {
            let exactWindowValid = activeTarget.map(revalidateLineageTarget) ?? MacOSExactWindowAuthority.revalidate(
                processID: activeProcessID,
                windowID: activeWindowID,
                inputBounds: activeInputBounds,
                allowNonZeroLayer: initialSecureWindowPolicy == .macosLocalAuthentication
            )
            guard exactWindowValid else {
                if kind == "text" { controlWriter.submitInputTextRoute(.nativeBoundaryRejected) }
                FileHandle.standardError.write(Data("MCP_HANDOFF_DIAGNOSTIC input_stage=authority_lost\n".utf8))
                return false
            }
        }
        guard activateTargetWindowForInput(processID: activeProcessID, inputBounds: activeInputBounds) else {
            if kind == "text", activeProcessID != nil {
                controlWriter.submitInputTextRoute(.activationRejected)
            }
            FileHandle.standardError.write(Data("MCP_HANDOFF_DIAGNOSTIC input_stage=activation_failed\n".utf8))
            return false
        }
        switch kind {
        case "tap":
            guard let x = number(object["x"]), let y = number(object["y"]), (0...1).contains(x), (0...1).contains(y) else { return false }
            let point = screenPoint(x: x, y: y, inputBounds: activeInputBounds)
            let editableAtPoint = editableElement(at: point)
            guard postPrimaryButton(state: "down", at: point) else { return false }
            usleep(20_000)
            guard postPrimaryButton(state: "up", at: point) else { releaseAll(); return false }
            afterPrimaryRelease()
            writer.submitEditable(editableAtPoint || editableAfterTap())
            return true
        case "pointer_button":
            guard object["button"] as? String == "primary",
                  let state = object["state"] as? String, state == "down" || state == "up",
                  let x = number(object["x"]), let y = number(object["y"]),
                  (0...1).contains(x), (0...1).contains(y) else { return false }
            let point = screenPoint(x: x, y: y, inputBounds: activeInputBounds)
            let editableAtPoint = state == "up" ? editableElement(at: point) : false
            guard postPrimaryButton(state: state, at: point) else {
                FileHandle.standardError.write(Data("MCP_HANDOFF_DIAGNOSTIC input_stage=primary_\(state)_rejected\n".utf8))
                return false
            }
            FileHandle.standardError.write(Data("MCP_HANDOFF_DIAGNOSTIC input_stage=primary_\(state)_sent\n".utf8))
            if state == "up" {
                afterPrimaryRelease()
                writer.submitEditable(editableAtPoint || editableAfterTap())
            }
            return true
        case "scroll":
            guard let dx = number(object["deltaX"]), let dy = number(object["deltaY"]),
                  abs(dx) <= 2_000, abs(dy) <= 2_000,
                  let event = CGEvent(
                    scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                    wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0
                  ) else { return false }
            event.post(tap: .cghidEventTap)
            return true
        case "text":
            guard let text = object["text"] as? String, !text.isEmpty, text.utf8.count <= 4_096 else { return false }
            if initialSecureWindowPolicy == .macosLocalAuthentication {
                guard let activeProcessID,
                      text.utf8.count <= 256,
                      MacOSLocalAuthenticationWindowInput.verifyFocusedSecureTextField(
                          processID: activeProcessID,
                          inputBounds: activeInputBounds
                      ) else {
                    controlWriter.submitInputTextRoute(.nativeBoundaryRejected)
                    return false
                }
                guard postUnicodeKeyboardText(text, targetProcessID: activeProcessID) else {
                    controlWriter.submitInputTextRoute(.eventCreationFailure)
                    return false
                }
                controlWriter.submitInputTextRoute(.pidKeyboard)
                return true
            }
            if let activeProcessID {
                switch MacOSExactWindowTextInput.commitFocusedText(
                    processID: activeProcessID,
                    inputBounds: activeInputBounds,
                    text: text
                ) {
                case .committed:
                    controlWriter.submitInputTextRoute(.nativeAX)
                    return true
                case .rejected:
                    controlWriter.submitInputTextRoute(.nativeBoundaryRejected)
                    return false
                case .unsupported:
                    break
                }
            }
            guard postUnicodeKeyboardText(text, targetProcessID: activeProcessID) else {
                if activeProcessID != nil { controlWriter.submitInputTextRoute(.eventCreationFailure) }
                return false
            }
            if activeProcessID != nil { controlWriter.submitInputTextRoute(.pidKeyboard) }
            return true
        case "key":
            guard let key = object["key"] as? String else { return false }
            if initialSecureWindowPolicy == .macosLocalAuthentication {
                guard key == "Backspace", let activeProcessID,
                      MacOSLocalAuthenticationWindowInput.verifyFocusedSecureTextField(
                          processID: activeProcessID,
                          inputBounds: activeInputBounds
                      ) else { return false }
                guard let down = CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: false) else { return false }
                postKeyboard(down, targetProcessID: activeProcessID)
                postKeyboard(up, targetProcessID: activeProcessID)
                return true
            }
            let code: CGKeyCode
            switch key { case "Backspace": code = 51; case "Enter": code = 36; default: return false }
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return false }
            postKeyboard(down, targetProcessID: activeProcessID)
            postKeyboard(up, targetProcessID: activeProcessID)
            return true
        default:
            return false
        }
    }

    private func syncPointer(at point: CGPoint) -> Bool {
        let previous = CGEvent(source: source)?.location ?? point
        guard let move = CGEvent(
            mouseEventSource: source,
            mouseType: .mouseMoved,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else { return false }
        move.flags = []
        move.setIntegerValueField(.mouseEventButtonNumber, value: 0)
        move.setIntegerValueField(.mouseEventClickState, value: 0)
        move.setDoubleValueField(.mouseEventDeltaX, value: point.x - previous.x)
        move.setDoubleValueField(.mouseEventDeltaY, value: point.y - previous.y)
        move.post(tap: .cghidEventTap)
        CGWarpMouseCursorPosition(point)
        return true
    }

    private func makePrimaryEvent(type: CGEventType, at point: CGPoint) -> CGEvent? {
        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else { return nil }
        event.flags = []
        event.setIntegerValueField(.mouseEventButtonNumber, value: 0)
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        event.setDoubleValueField(.mouseEventDeltaX, value: 0)
        event.setDoubleValueField(.mouseEventDeltaY, value: 0)
        return event
    }

    private func postPrimaryButton(state: String, at point: CGPoint) -> Bool {
        inputLock.lock()
        defer { inputLock.unlock() }
        guard syncPointer(at: point) else { return false }
        if state == "down" {
            guard !primaryPressed, let event = makePrimaryEvent(type: .leftMouseDown, at: point) else { return false }
            cursorBeforePrimary = CGEvent(source: source)?.location
            event.post(tap: .cghidEventTap)
            primaryPressed = true
            primaryPoint = point
            return true
        }
        guard state == "up", primaryPressed, let event = makePrimaryEvent(type: .leftMouseUp, at: point) else { return false }
        event.post(tap: .cghidEventTap)
        primaryPressed = false
        primaryPoint = point
        cursorBeforePrimary = nil
        return true
    }

    private func cancellationPoint() -> CGPoint {
        let activeBounds = targetAuthority?.currentSnapshot().inputBounds ?? inputBounds
        var display = CGDirectDisplayID()
        var count: UInt32 = 0
        let resolved = CGGetDisplaysWithRect(activeBounds, 1, &display, &count) == .success && count == 1
        let displayBounds = resolved ? CGDisplayBounds(display) : CGDisplayBounds(CGMainDisplayID())
        let margin: CGFloat = 8
        let safeY = min(max(primaryPoint.y, displayBounds.minY + 1), displayBounds.maxY - 1)
        let safeX = min(max(primaryPoint.x, displayBounds.minX + 1), displayBounds.maxX - 1)
        if activeBounds.minX - margin >= displayBounds.minX { return CGPoint(x: activeBounds.minX - margin, y: safeY) }
        if activeBounds.maxX + margin <= displayBounds.maxX { return CGPoint(x: activeBounds.maxX + margin, y: safeY) }
        if activeBounds.minY - margin >= displayBounds.minY { return CGPoint(x: safeX, y: activeBounds.minY - margin) }
        if activeBounds.maxY + margin <= displayBounds.maxY { return CGPoint(x: safeX, y: activeBounds.maxY + margin) }
        let corners = [
            CGPoint(x: displayBounds.minX + 2, y: displayBounds.minY + 2),
            CGPoint(x: displayBounds.maxX - 2, y: displayBounds.minY + 2),
            CGPoint(x: displayBounds.minX + 2, y: displayBounds.maxY - 2),
            CGPoint(x: displayBounds.maxX - 2, y: displayBounds.maxY - 2)
        ]
        return corners.max(by: { hypot($0.x - primaryPoint.x, $0.y - primaryPoint.y) < hypot($1.x - primaryPoint.x, $1.y - primaryPoint.y) }) ?? primaryPoint
    }

    private func movePointerForCancellation(to point: CGPoint) {
        // While the primary button is still down, move as a drag rather than a hover. Chromium then
        // treats lifecycle cleanup as an interrupted drag/release instead of synthesizing a click on
        // the nearest common ancestor of the original press and the off-control release point.
        guard let move = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left) else { return }
        move.flags = []
        move.setIntegerValueField(.mouseEventButtonNumber, value: 0)
        move.setIntegerValueField(.mouseEventClickState, value: 0)
        move.post(tap: .cghidEventTap)
        CGWarpMouseCursorPosition(point)
    }

    private func restorePointerAfterCancellation(to point: CGPoint) {
        guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else { return }
        move.flags = []
        move.setIntegerValueField(.mouseEventButtonNumber, value: 0)
        move.setIntegerValueField(.mouseEventClickState, value: 0)
        move.post(tap: .cghidEventTap)
        CGWarpMouseCursorPosition(point)
    }

    func releaseAll() {
        inputLock.lock()
        defer { inputLock.unlock() }
        guard primaryPressed else { return }
        // Lifecycle cleanup must release the WindowServer button state without turning an
        // interrupted Human press into an activation. Move away from the original control, post a
        // global mouse-up with click-state zero, then restore the pre-press cursor position.
        let cancelAt = cancellationPoint()
        let restore = cursorBeforePrimary
        movePointerForCancellation(to: cancelAt)
        if let event = makePrimaryEvent(type: .leftMouseUp, at: cancelAt) {
            event.setIntegerValueField(.mouseEventClickState, value: 0)
            event.post(tap: .cghidEventTap)
        }
        primaryPressed = false
        cursorBeforePrimary = nil
        if let restore { restorePointerAfterCancellation(to: restore) }
    }

    private func postUnicodeKeyboardText(_ text: String, targetProcessID: pid_t?) -> Bool {
        let utf16 = Array(text.utf16)
        guard !utf16.isEmpty, utf16.count <= 1_024,
              let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return false }
        utf16.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        postKeyboard(down, targetProcessID: targetProcessID)
        postKeyboard(up, targetProcessID: targetProcessID)
        return true
    }

    private func postKeyboard(_ event: CGEvent, targetProcessID: pid_t?) {
        if let targetProcessID {
            event.postToPid(targetProcessID)
        } else {
            event.post(tap: .cghidEventTap)
        }
    }

    private func activateTargetWindowForInput(processID: pid_t?, inputBounds: CGRect) -> Bool {
        guard let processID else { return true }
        if initialSecureWindowPolicy == .macosLocalAuthentication {
            return MacOSLocalAuthenticationWindowInput.verifyFocused(
                processID: processID,
                inputBounds: inputBounds
            )
        }
        return MacOSExactWindowInput.activate(processID: processID, inputBounds: inputBounds)
    }

    private func number(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }
    private func screenPoint(x: Double, y: Double, inputBounds: CGRect) -> CGPoint {
        return CGPoint(x: inputBounds.minX + inputBounds.width * x, y: inputBounds.minY + inputBounds.height * y)
    }
    private func editableElement(at point: CGPoint) -> Bool {
        let system = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element) == .success,
              let element else { return false }
        if elementIsEditable(element) { return true }
        var current = element
        for _ in 0..<4 {
            var parentRaw: CFTypeRef?
            guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentRaw) == .success,
                  let parentRaw else { break }
            let parent = unsafeDowncast(parentRaw, to: AXUIElement.self)
            if elementIsEditable(parent) { return true }
            current = parent
        }
        return false
    }

    private func elementIsEditable(_ element: AXUIElement) -> Bool {
        var roleRaw: CFTypeRef?
        let role = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRaw) == .success ? roleRaw as? String : nil
        return role == (kAXTextFieldRole as String)
            || role == (kAXTextAreaRole as String)
            || role == (kAXComboBoxRole as String)
    }

    private func editableAfterTap() -> Bool {
        // Chromium focus can arrive a few run-loop turns after the synthetic mouse-up. Keep this
        // bounded so non-editable taps never stall the Human input lane indefinitely.
        for attempt in 0..<5 {
            if focusedElementIsEditable() { return true }
            if attempt < 4 { usleep(20_000) }
        }
        return false
    }

    private func focusedElementIsEditable() -> Bool {
        let system = AXUIElementCreateSystemWide(); var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &raw) == .success, let raw else { return false }
        let element = unsafeDowncast(raw, to: AXUIElement.self)
        return elementIsEditable(element)
    }
}

private final class InputReader: @unchecked Sendable {
    private let stop: StopState
    private let injector: HumanInputInjector
    private let requestIDR: @Sendable () -> Void
    init(stop: StopState, injector: HumanInputInjector, requestIDR: @escaping @Sendable () -> Void) {
        self.stop = stop; self.injector = injector; self.requestIDR = requestIDR
    }
    func start() {
        Thread.detachNewThread { [stop, injector, requestIDR] in
            let inputFD = FileHandle.standardInput.fileDescriptor
            var pending = Data()
            var buffer = [UInt8](repeating: 0, count: 2_048)
            while !stop.isStopped {
                let count = buffer.withUnsafeMutableBytes { rawBuffer -> Int in
                    guard let base = rawBuffer.baseAddress else { return -1 }
                    return Darwin.read(inputFD, base, rawBuffer.count)
                }
                if count == 0 { stop.stop(.stdinEOF); break }
                if count < 0 {
                    if errno == EINTR { continue }
                    stop.stop(.unexpected); break
                }
                pending.append(contentsOf: buffer.prefix(count))
                if pending.count > 8_192 { stop.stop(.unexpected); break }
                while let newline = pending.firstIndex(of: 0x0A) {
                    let line = pending.prefix(upTo: newline); pending.removeSubrange(...newline)
                    guard !line.isEmpty, line.count <= 4_096,
                          let value = try? JSONSerialization.jsonObject(with: Data(line)),
                          let object = value as? [String: Any], let kind = object["kind"] as? String else { continue }
                    if kind == "stop" { stop.stop(.explicitStop); return }
                    if kind == "requestIDR" { requestIDR(); continue }
                    let applied = injector.apply(object)
                    let stage = applied ? "applied" : "rejected"
                    FileHandle.standardError.write(Data("MCP_HANDOFF_DIAGNOSTIC input_stage=\(stage)\n".utf8))
                }
            }
        }
    }
}

private func frameRecord(avcc: Data, timestamp: UInt32, keyframe: Bool, width: Int, height: Int) -> Data? {
    guard width > 0, width <= Int(UInt16.max), height > 0, height <= Int(UInt16.max), avcc.count <= 8 * 1024 * 1024 - 9 else { return nil }
    var payload = Data(); payload.reserveCapacity(9 + avcc.count)
    var timestampBE = timestamp.bigEndian; withUnsafeBytes(of: &timestampBE) { payload.append(contentsOf: $0) }
    payload.append(keyframe ? 1 : 0)
    var widthBE = UInt16(width).bigEndian; var heightBE = UInt16(height).bigEndian
    withUnsafeBytes(of: &widthBE) { payload.append(contentsOf: $0) }; withUnsafeBytes(of: &heightBE) { payload.append(contentsOf: $0) }
    payload.append(avcc)
    var record = Data([1]); var length = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: &length) { record.append(contentsOf: $0) }; record.append(payload); return record
}

@main
struct WebRtcMacHost {
    static func main() async {
        do {
            try await run()
        } catch let error as WebRtcHostError {
            emitHostExitReason(error.exitReason)
        } catch {
            emitHostExitReason(.unexpected)
        }
    }

    private static func run() async throws {
        guard CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() else { throw WebRtcHostError.permission }
        let lease = try makeLease(); let stop = StopState()
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let targetProcessID = try loadTargetProcessID()
        let targetWindowID = try loadTargetWindowID(targetProcessID: targetProcessID)
        let initialSecureWindowPolicy = try loadInitialSecureWindowPolicy(
            targetProcessID: targetProcessID,
            targetWindowID: targetWindowID
        )
        let lineageConfig = try loadWindowLineageConfig(targetProcessID: targetProcessID)
        guard initialSecureWindowPolicy == nil || lineageConfig == nil else {
            throw WebRtcHostError.configuration
        }
        let surface = try selectedCaptureSurface(
            from: content,
            requestedDisplay: loadDisplayID(),
            targetProcessID: targetProcessID,
            targetWindowID: targetWindowID,
            initialSecureWindowPolicy: initialSecureWindowPolicy
        )
        let nativeWidth = surface.pixelWidth, nativeHeight = surface.pixelHeight
        guard nativeWidth > 0, nativeHeight > 0 else { throw WebRtcHostError.display }
        let frameFormat = try loadHostFrameFormat()
        let mediaProfile = try loadMediaProfile()
        let mediaPolicy: MacOSWindowMediaPolicy
        do {
            mediaPolicy = try MacOSWindowMediaPolicyResolver.resolve(
                nativeWidth: nativeWidth,
                nativeHeight: nativeHeight,
                profile: mediaProfile
            )
        } catch {
            throw WebRtcHostError.configuration
        }
        let width = mediaPolicy.width, height = mediaPolicy.height
        emitMediaProfile(mediaProfile, policy: mediaPolicy)

        let targetAuthority: WindowTargetAuthority?
        if lineageConfig != nil {
            guard let targetProcessID, let resolvedWindowID = surface.targetWindowID else {
                throw WebRtcHostError.configuration
            }
            targetAuthority = WindowTargetAuthority(WindowTargetSnapshot(
                processID: targetProcessID,
                windowID: resolvedWindowID,
                inputBounds: surface.inputBounds,
                allowNonZeroLayer: surface.allowNonZeroLayer
            ))
        } else {
            targetAuthority = nil
        }

        let writer = LatestOutputWriter()
        let metricWriter = HostMetricWriter()
        let controlWriter = HostControlWriter()
        let streamOutput: any SCStreamOutput
        let requestIDR: @Sendable () -> Void
        if frameFormat == .jpeg {
            guard let targetProcessID, let exactWindowID = surface.targetWindowID else {
                throw WebRtcHostError.configuration
            }
            streamOutput = JPEGFrameOutput(
                lease: lease,
                writer: writer,
                width: width,
                height: height,
                targetProcessID: targetProcessID,
                targetWindowID: exactWindowID,
                inputBounds: surface.inputBounds,
                targetAuthority: targetAuthority,
                secureWindow: initialSecureWindowPolicy == .macosLocalAuthentication,
                authorityLost: { stop.stop(.windowResolution) }
            )
            requestIDR = {}
        } else {
            let encoder = try H264PipeEncoder(
                width: Int32(width),
                height: Int32(height),
                averageBitrate: mediaPolicy.averageBitrate,
                prioritizeEncodingSpeedOverQuality: mediaPolicy.prioritizeEncodingSpeedOverQuality
            ) { avcc, timestamp, keyframe, encodeMs in
                metricWriter.submitEncodeMs(encodeMs)
                if lease.isActive(), !stop.isStopped,
                   let record = frameRecord(avcc: avcc, timestamp: timestamp, keyframe: keyframe, width: width, height: height) {
                    writer.submitFrame(record)
                }
            }
            streamOutput = CaptureOutput(encoder: encoder, lease: lease)
            requestIDR = { encoder.requestIDR() }
        }
        let configuration = makeStreamConfiguration(
            surface: surface,
            width: width,
            height: height,
            preserveAspectRatio: lineageConfig == nil,
            frameFormat: frameFormat
        )
        let stream = SCStream(filter: surface.filter, configuration: configuration, delegate: nil)
        do {
            try stream.addStreamOutput(streamOutput, type: .screen, sampleHandlerQueue: DispatchQueue(label: "takeover.webrtc.capture", qos: .userInteractive))
            try await stream.startCapture()
        } catch {
            throw WebRtcHostError.captureStart
        }

        let initialInputBounds = surface.inputBounds
        let lineageController: WindowLineageController?
        if let lineageConfig, let targetProcessID, let targetAuthority {
            // Inventory all existing windows, including currently hidden/off-screen siblings. A later
            // visibility change must never make a pre-existing window look like a newly created successor.
            let lineageInventory = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            lineageController = WindowLineageController(
                targetProcessID: targetProcessID,
                authority: targetAuthority,
                stream: stream,
                width: width,
                height: height,
                transitionWindowMs: lineageConfig.transitionWindowMs,
                initialKnownWindowIDs: sameProcessWindowIDs(from: lineageInventory, targetProcessID: targetProcessID),
                requestIDR: requestIDR,
                stop: stop
            )
        } else {
            lineageController = nil
        }

        let injector = HumanInputInjector(
            inputBounds: surface.inputBounds,
            targetProcessID: targetProcessID,
            targetWindowID: surface.targetWindowID,
            targetAuthority: targetAuthority,
            initialSecureWindowPolicy: initialSecureWindowPolicy,
            afterPrimaryRelease: { lineageController?.afterPrimaryRelease() },
            writer: writer,
            controlWriter: controlWriter
        )
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let terminateSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: DispatchQueue.global(qos: .userInteractive))
        let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: DispatchQueue.global(qos: .userInteractive))
        let stopForSignal: @Sendable () -> Void = {
            injector.releaseAll()
            stop.stop(.explicitStop)
        }
        terminateSource.setEventHandler(handler: stopForSignal)
        interruptSource.setEventHandler(handler: stopForSignal)
        terminateSource.resume(); interruptSource.resume()
        defer {
            terminateSource.cancel(); interruptSource.cancel()
            injector.releaseAll()
        }
        InputReader(stop: stop, injector: injector, requestIDR: requestIDR).start()
        if initialSecureWindowPolicy == .macosLocalAuthentication, let targetProcessID {
            monitorLocalAuthenticationTarget(
                stop: stop,
                processID: targetProcessID,
                inputBounds: initialInputBounds
            )
        }
        if let targetProcessID {
            EditableRegionPublisher(
                targetProcessID: targetProcessID,
                inputBoundsProvider: {
                    if let targetAuthority { return targetAuthority.snapshotForInput()?.inputBounds }
                    return initialInputBounds
                },
                writer: controlWriter
            ).start(stop: stop)
        }

        while lease.isActive(), !stop.isStopped { try await Task.sleep(for: .milliseconds(40)) }
        emitHostExitReason(stop.exitReason ?? (lease.isActive() ? .unexpected : .leaseExpiry))
        lease.revoke(); try? await stream.stopCapture()
    }
}
#else
@main
struct WebRtcMacHost { static func main() {} }
#endif
