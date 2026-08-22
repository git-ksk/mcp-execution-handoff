import Foundation
import TakeoverCore

#if os(macOS)
import ApplicationServices
import CoreGraphics
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import VideoToolbox

private enum HostConfigurationError: Error, CustomStringConvertible {
    case missing(String)
    case invalid(String)
    case unavailable(String)

    var description: String {
        switch self {
        case .missing(let name): return "missing required environment variable \(name)"
        case .invalid(let name): return "invalid environment variable \(name)"
        case .unavailable(let reason): return reason
        }
    }
}

private struct HostSessionConfiguration {
    let rootKey: Data
    let sessionHash: UInt64
    let epoch: UInt64
    let generation: UInt32
    let expiresAtUnixMillis: UInt64
    let inputBindHost: String
    let controlBindHost: String
    let feedbackBindHost: String
    let displayID: CGDirectDisplayID?
    let targetProcessID: pid_t?
    let targetWindowID: CGWindowID?

    static func load() throws -> HostSessionConfiguration {
        let env = ProcessInfo.processInfo.environment
        let rootKey = try HostSessionKeySource.load(environment: env)
        guard let sessionHex = env["THIN_TAKEOVER_SESSION_HASH_HEX"] else {
            throw HostConfigurationError.missing("THIN_TAKEOVER_SESSION_HASH_HEX")
        }
        guard sessionHex.count == 16, let sessionHash = UInt64(sessionHex, radix: 16) else {
            throw HostConfigurationError.invalid("THIN_TAKEOVER_SESSION_HASH_HEX")
        }
        guard let epochText = env["THIN_TAKEOVER_EPOCH"] else {
            throw HostConfigurationError.missing("THIN_TAKEOVER_EPOCH")
        }
        guard let epoch = UInt64(epochText) else {
            throw HostConfigurationError.invalid("THIN_TAKEOVER_EPOCH")
        }
        guard let generationText = env["THIN_TAKEOVER_GENERATION"] else {
            throw HostConfigurationError.missing("THIN_TAKEOVER_GENERATION")
        }
        guard let generation = UInt32(generationText) else {
            throw HostConfigurationError.invalid("THIN_TAKEOVER_GENERATION")
        }
        guard let expiryText = env["THIN_TAKEOVER_EXPIRES_AT_UNIX_MS"] else {
            throw HostConfigurationError.missing("THIN_TAKEOVER_EXPIRES_AT_UNIX_MS")
        }
        guard let expiresAtUnixMillis = UInt64(expiryText) else {
            throw HostConfigurationError.invalid("THIN_TAKEOVER_EXPIRES_AT_UNIX_MS")
        }

        let inputBindHost = env["THIN_TAKEOVER_INPUT_BIND_HOST"] ?? "127.0.0.1"
        let controlBindHost = env["THIN_TAKEOVER_CONTROL_BIND_HOST"] ?? "127.0.0.1"
        let feedbackBindHost = env["THIN_TAKEOVER_FEEDBACK_BIND_HOST"] ?? "127.0.0.1"
        guard !inputBindHost.isEmpty else { throw HostConfigurationError.invalid("THIN_TAKEOVER_INPUT_BIND_HOST") }
        guard !controlBindHost.isEmpty else { throw HostConfigurationError.invalid("THIN_TAKEOVER_CONTROL_BIND_HOST") }
        guard !feedbackBindHost.isEmpty else { throw HostConfigurationError.invalid("THIN_TAKEOVER_FEEDBACK_BIND_HOST") }

        let displayID: CGDirectDisplayID?
        if let text = env["THIN_TAKEOVER_DISPLAY_ID"] {
            guard let value = UInt32(text) else { throw HostConfigurationError.invalid("THIN_TAKEOVER_DISPLAY_ID") }
            displayID = CGDirectDisplayID(value)
        } else {
            displayID = nil
        }

        let targetProcessID: pid_t?
        if let text = env["THIN_TAKEOVER_TARGET_PID"] {
            guard let value = Int32(text), value > 0 else { throw HostConfigurationError.invalid("THIN_TAKEOVER_TARGET_PID") }
            targetProcessID = pid_t(value)
        } else {
            targetProcessID = nil
        }

        let targetWindowID: CGWindowID?
        if let text = env["THIN_TAKEOVER_TARGET_WINDOW_ID"] {
            guard targetProcessID != nil else { throw HostConfigurationError.invalid("THIN_TAKEOVER_TARGET_WINDOW_ID") }
            guard let value = UInt32(text), value > 0 else { throw HostConfigurationError.invalid("THIN_TAKEOVER_TARGET_WINDOW_ID") }
            targetWindowID = CGWindowID(value)
        } else {
            targetWindowID = nil
        }

        return HostSessionConfiguration(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            expiresAtUnixMillis: expiresAtUnixMillis,
            inputBindHost: inputBindHost,
            controlBindHost: controlBindHost,
            feedbackBindHost: feedbackBindHost,
            displayID: displayID,
            targetProcessID: targetProcessID,
            targetWindowID: targetWindowID
        )
    }

    func makeLease() throws -> EphemeralSessionLease {
        let wallMillis = UInt64(max(0, Date().timeIntervalSince1970 * 1_000))
        return try EphemeralLeaseFactory.make(
            expiresAtUnixMillis: expiresAtUnixMillis,
            nowUnixMillis: wallMillis,
            nowMonotonicNanos: MonotonicClock.nowNanos()
        )
    }
}

private func adjacentPort(_ base: UInt16, offset: Int) -> UInt16 {
    let upward = Int(base) + offset
    if upward <= Int(UInt16.max) { return UInt16(upward) }
    return UInt16(max(1, Int(base) - offset))
}

private func evenDimension(_ value: Double) -> Int {
    let rounded = max(2, Int(value.rounded(.down)))
    return rounded.isMultiple(of: 2) ? rounded : rounded - 1
}

private func selectDisplay(from displays: [SCDisplay], requested: CGDirectDisplayID?) throws -> SCDisplay {
    guard !displays.isEmpty else { throw HostConfigurationError.unavailable("No capturable display available") }
    if let requested {
        guard let display = displays.first(where: { $0.displayID == requested }) else {
            throw HostConfigurationError.invalid("THIN_TAKEOVER_DISPLAY_ID")
        }
        return display
    }
    guard displays.count == 1, let only = displays.first else {
        throw HostConfigurationError.missing("THIN_TAKEOVER_DISPLAY_ID (required when multiple displays are capturable)")
    }
    return only
}

private struct CaptureSurface {
    let filter: SCContentFilter
    let sourceRect: CGRect?
    let inputBounds: CGRect
    let pixelWidth: Double
    let pixelHeight: Double
    let scope: String
}

private func selectCaptureSurface(
    from content: SCShareableContent,
    requestedDisplay: CGDirectDisplayID?,
    targetProcessID: pid_t?,
    targetWindowID: CGWindowID?
) throws -> CaptureSurface {
    if let targetProcessID {
        let windows = content.windows.filter { window in
            guard window.owningApplication?.processID == targetProcessID,
                  window.isOnScreen,
                  window.windowLayer == 0,
                  targetWindowID == nil || window.windowID == targetWindowID else { return false }
            return window.frame.width >= 160 && window.frame.height >= 120
        }
        guard windows.count == 1, let window = windows.first else {
            let boundary = targetWindowID == nil ? "process" : "process/window"
            throw HostConfigurationError.unavailable("Target \(boundary) must resolve to exactly one capturable on-screen window")
        }
        let containingDisplays = content.displays.filter { $0.frame.contains(window.frame) }
        guard containingDisplays.count == 1, let display = containingDisplays.first else {
            throw HostConfigurationError.unavailable("Target browser window must be fully contained in exactly one capturable display")
        }
        let filter = SCContentFilter(display: display, including: [window])
        let displayLocalBounds = CGRect(origin: .zero, size: display.frame.size)
        let sourceRect = CGRect(
            x: window.frame.minX - display.frame.minX,
            y: window.frame.minY - display.frame.minY,
            width: window.frame.width,
            height: window.frame.height
        )
        guard displayLocalBounds.contains(sourceRect) else {
            throw HostConfigurationError.unavailable("Target browser crop is outside the selected display")
        }
        let scale = max(1.0, Double(filter.pointPixelScale))
        let pixelWidth = max(2.0, Double(sourceRect.width) * scale)
        let pixelHeight = max(2.0, Double(sourceRect.height) * scale)
        return CaptureSurface(
            filter: filter,
            sourceRect: sourceRect,
            inputBounds: window.frame,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            scope: "window"
        )
    }

    let display = try selectDisplay(from: content.displays, requested: requestedDisplay)
    return CaptureSurface(
        filter: SCContentFilter(display: display, excludingWindows: []),
        sourceRect: nil,
        inputBounds: CGDisplayBounds(display.displayID),
        pixelWidth: Double(display.width),
        pixelHeight: Double(display.height),
        scope: "display"
    )
}

private func preflightHumanSurfacePermissions() throws {
    guard CGPreflightScreenCaptureAccess() else {
        throw HostConfigurationError.unavailable("Screen Recording permission is required before Human authority is granted")
    }
    guard AXIsProcessTrusted() else {
        throw HostConfigurationError.unavailable("Accessibility permission is required before Human authority is granted")
    }
}

private final class H264Encoder: @unchecked Sendable {
    typealias Output = @Sendable (
        _ avccSample: Data,
        _ codecConfig: Data?,
        _ captureNanos: UInt64,
        _ encodeDoneNanos: UInt64,
        _ keyframe: Bool
    ) -> Void
    typealias Completion = @Sendable () -> Void

    private var session: VTCompressionSession?
    private let output: Output
    private let keyframeLock = NSLock()
    private var forceNextKeyframe = false

    init(width: Int32, height: Int32, fps: Int32 = 60, bitrate: Int32 = 8_000_000, output: @escaping Output) throws {
        self.output = output
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: [
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true,
                kVTVideoEncoderSpecification_EnableLowLatencyRateControl as String: true
            ] as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: { refCon, sourceFrameRefCon, status, _, sampleBuffer in
                guard let sourceFrameRefCon else { return }
                let frameContext = Unmanaged<FrameContext>.fromOpaque(sourceFrameRefCon).takeRetainedValue()
                defer { frameContext.completion() }
                guard status == noErr, let refCon, let sampleBuffer else { return }
                let encoder = Unmanaged<H264Encoder>.fromOpaque(refCon).takeUnretainedValue()
                encoder.handle(sampleBuffer, captureNanos: frameContext.captureNanos)
            },
            refcon: refcon,
            compressionSessionOut: &session
        )
        guard status == noErr, let session else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }

        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: NSNumber(value: 0))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, value: kCFBooleanTrue)
        if #available(macOS 15.0, *) {
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_SuggestedLookAheadFrameCount, value: NSNumber(value: 0))
        }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrate))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: fps * 2))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Main_AutoLevel)
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    deinit {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
    }

    func requestIDR() {
        keyframeLock.lock()
        forceNextKeyframe = true
        keyframeLock.unlock()
    }

    private func consumeKeyframeRequest() -> Bool {
        keyframeLock.lock()
        defer { keyframeLock.unlock() }
        let value = forceNextKeyframe
        forceNextKeyframe = false
        return value
    }

    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime, captureNanos: UInt64, completion: @escaping Completion) {
        guard let session else { completion(); return }
        var flags: VTEncodeInfoFlags = []
        let context = Unmanaged.passRetained(FrameContext(captureNanos: captureNanos, completion: completion)).toOpaque()
        let frameProperties: CFDictionary? = consumeKeyframeRequest()
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary
            : nil
        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: frameProperties,
            sourceFrameRefcon: context,
            infoFlagsOut: &flags
        )
        if status != noErr {
            Unmanaged<FrameContext>.fromOpaque(context).release()
            completion()
        }
    }

    private final class FrameContext {
        let captureNanos: UInt64
        let completion: Completion
        init(captureNanos: UInt64, completion: @escaping Completion) {
            self.captureNanos = captureNanos
            self.completion = completion
        }
    }

    private func handle(_ sampleBuffer: CMSampleBuffer, captureNanos: UInt64) {
        let encodeDone = MonotonicClock.nowNanos()
        guard CMSampleBufferDataIsReady(sampleBuffer), let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]]
        let isKeyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)

        var codecConfig: Data?
        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sampleBuffer),
           let atoms = CMFormatDescriptionGetExtension(
                format,
                extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms
           ) as? NSDictionary {
            codecConfig = atoms["avcC"] as? Data
        }

        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            block,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )
        guard status == noErr, let dataPointer, totalLength > 0 else { return }

        let avccSample = Data(
            bytesNoCopy: UnsafeMutableRawPointer(dataPointer),
            count: totalLength,
            deallocator: .none
        )
        output(avccSample, codecConfig, captureNanos, encodeDone, isKeyframe)
    }
}

private final class EncodedFrameSender: @unchecked Sendable {
    private var frameID: UInt64 = 0
    private let frameIDLock = NSLock()
    private let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
    private let sender: DatagramSender
    private let cipher: TransportCipher
    private let headerAuthenticator: VideoHeaderAuthenticator
    private let context: TransportCryptoContext
    private let lease: EphemeralSessionLease

    init(sender: DatagramSender, configuration: HostSessionConfiguration, lease: EphemeralSessionLease) throws {
        self.sender = sender
        self.cipher = try TransportCipher(rootKey: configuration.rootKey)
        self.headerAuthenticator = try VideoHeaderAuthenticator(
            rootKey: configuration.rootKey,
            sessionHash: configuration.sessionHash,
            epoch: configuration.epoch,
            generation: configuration.generation
        )
        self.context = TransportCryptoContext(
            sessionHash: configuration.sessionHash,
            epoch: configuration.epoch,
            generation: configuration.generation,
            direction: .hostToClient,
            channel: .video
        )
        self.lease = lease
    }

    func send(
        avccSample: Data,
        codecConfig: Data?,
        captureNanos: UInt64,
        encodeDoneNanos: UInt64,
        keyframe: Bool
    ) {
        guard lease.isActive() else { return }
        if let codecConfig {
            sendPayload(
                codecConfig,
                captureNanos: captureNanos,
                encodeDoneNanos: encodeDoneNanos,
                flags: VideoPacketFlags.codecConfig
            )
        }

        var flags = VideoPacketFlags.avccSample
        if keyframe { flags |= VideoPacketFlags.keyframe }
        sendPayload(
            avccSample,
            captureNanos: captureNanos,
            encodeDoneNanos: encodeDoneNanos,
            flags: flags
        )
    }

    private func sendPayload(_ data: Data, captureNanos: UInt64, encodeDoneNanos: UInt64, flags: UInt8) {
        guard lease.isActive() else { return }
        frameIDLock.lock()
        let id = frameID
        frameID &+= 1
        frameIDLock.unlock()

        do {
            let sealed = try cipher.seal(
                data,
                sequence: id,
                context: context,
                associatedData: Data([flags])
            )
            guard lease.isActive() else { return }
            try packetizer.forEachPacket(
                payloadBytes: sealed.count,
                sessionHash: context.sessionHash,
                epoch: context.epoch,
                generation: context.generation,
                frameID: id,
                captureNanos: captureNanos,
                encodeDoneNanos: encodeDoneNanos,
                flags: flags
            ) { slice in
                guard lease.isActive() else { return }
                let authenticatedHeader = headerAuthenticator.authenticate(slice.header)
                try sender.send(header: authenticatedHeader, payload: sealed, payloadRange: slice.payloadRange)
            }
        } catch {
            // Media is best-effort, but authentication is not. Never fall back to plaintext.
        }
    }
}

private final class CaptureOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let encoder: H264Encoder
    private let admission = FrameAdmissionGate(maxInFlight: 1)
    private let lease: EphemeralSessionLease

    init(encoder: H264Encoder, lease: EphemeralSessionLease) {
        self.encoder = encoder
        self.lease = lease
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard lease.isActive(), type == .screen, let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let attachments = attachmentsArray.first,
           let rawStatus = attachments[.status] as? Int,
           let status = SCFrameStatus(rawValue: rawStatus),
           status != .complete {
            return
        }
        guard admission.tryAcquire() else { return }
        let captureNanos = MonotonicClock.nowNanos()
        encoder.encode(
            pixel,
            pts: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
            captureNanos: captureNanos,
            completion: { [admission] in admission.release() }
        )
    }
}

@main
struct MacHost {
    static func main() async throws {
        let clientHost = CommandLine.arguments.dropFirst().first ?? "127.0.0.1"
        let videoPort = UInt16(CommandLine.arguments.dropFirst(2).first ?? "45555") ?? 45555
        let inputPort = UInt16(CommandLine.arguments.dropFirst(3).first ?? String(adjacentPort(videoPort, offset: 1))) ?? adjacentPort(videoPort, offset: 1)
        let controlPort = UInt16(CommandLine.arguments.dropFirst(4).first ?? String(adjacentPort(videoPort, offset: 2))) ?? adjacentPort(videoPort, offset: 2)
        let videoFeedbackPort = UInt16(CommandLine.arguments.dropFirst(5).first ?? String(adjacentPort(videoPort, offset: 3))) ?? adjacentPort(videoPort, offset: 3)
        let clientFeedbackPort = UInt16(CommandLine.arguments.dropFirst(6).first ?? String(adjacentPort(videoPort, offset: 4))) ?? adjacentPort(videoPort, offset: 4)
        let ports = [videoPort, inputPort, controlPort, videoFeedbackPort, clientFeedbackPort]
        guard Set(ports).count == ports.count else {
            throw HostConfigurationError.invalid("video/input/control/video-feedback/client-feedback ports must be distinct")
        }

        let sessionConfiguration = try HostSessionConfiguration.load()
        let lease = try sessionConfiguration.makeLease()

        // Permission checks happen before capture/input sockets become active. A takeover runtime
        // without both required macOS permissions is not a usable Human surface and fails closed.
        try preflightHumanSurfacePermissions()

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let surface = try selectCaptureSurface(
            from: content,
            requestedDisplay: sessionConfiguration.displayID,
            targetProcessID: sessionConfiguration.targetProcessID,
            targetWindowID: sessionConfiguration.targetWindowID
        )
        let nativeWidth = surface.pixelWidth
        let nativeHeight = surface.pixelHeight
        guard nativeWidth > 0, nativeHeight > 0 else {
            throw HostConfigurationError.unavailable("Selected capture surface has invalid dimensions")
        }
        let scale = min(1.0, min(1920.0 / nativeWidth, 1080.0 / nativeHeight))

        let filter = surface.filter
        let config = SCStreamConfiguration()
        if let sourceRect = surface.sourceRect { config.sourceRect = sourceRect }
        config.width = evenDimension(nativeWidth * scale)
        config.height = evenDimension(nativeHeight * scale)
        config.scalesToFit = true
        config.preservesAspectRatio = true
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.queueDepth = 3
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.capturesAudio = false
        config.showsCursor = false

        let sender = try DatagramSender(host: clientHost, port: videoPort)
        let frameSender = try EncodedFrameSender(sender: sender, configuration: sessionConfiguration, lease: lease)
        let encoder = try H264Encoder(width: Int32(config.width), height: Int32(config.height)) { [frameSender] avccSample, codecConfig, capture, encodeDone, keyframe in
            frameSender.send(
                avccSample: avccSample,
                codecConfig: codecConfig,
                captureNanos: capture,
                encodeDoneNanos: encodeDone,
                keyframe: keyframe
            )
        }

        let inputServer = try SecureInputServer(
            bindHost: sessionConfiguration.inputBindHost,
            port: inputPort,
            feedbackHost: clientHost,
            feedbackPort: clientFeedbackPort,
            rootKey: sessionConfiguration.rootKey,
            sessionHash: sessionConfiguration.sessionHash,
            epoch: sessionConfiguration.epoch,
            generation: sessionConfiguration.generation,
            inputBounds: surface.inputBounds,
            targetProcessID: sessionConfiguration.targetProcessID,
            lease: lease
        )
        let controlServer = try SecureControlServer(
            bindHost: sessionConfiguration.controlBindHost,
            port: controlPort,
            rootKey: sessionConfiguration.rootKey,
            sessionHash: sessionConfiguration.sessionHash,
            epoch: sessionConfiguration.epoch,
            generation: sessionConfiguration.generation,
            lease: lease
        )
        let feedbackServer = try SecureVideoFeedbackServer(
            bindHost: sessionConfiguration.feedbackBindHost,
            port: videoFeedbackPort,
            rootKey: sessionConfiguration.rootKey,
            sessionHash: sessionConfiguration.sessionHash,
            epoch: sessionConfiguration.epoch,
            generation: sessionConfiguration.generation,
            lease: lease,
            requestIDR: { [encoder] in encoder.requestIDR() }
        )
        _ = Task.detached(priority: .high) { inputServer.run() }
        _ = Task.detached(priority: .high) { controlServer.run() }
        _ = Task.detached(priority: .high) { feedbackServer.run() }

        let output = CaptureOutput(encoder: encoder, lease: lease)
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture.frames", qos: .userInteractive))
        try await stream.startCapture()
        print("streaming authenticated ScreenCaptureKit -> VideoToolbox H.264 AVCC -> UDP to \(clientHost):\(videoPort)")
        print("capture-scope=\(surface.scope) encoded=\(config.width)x\(config.height)")
        print("accepting authenticated Human input on \(sessionConfiguration.inputBindHost):\(inputPort)")
        print("accepting authenticated revoke control on \(sessionConfiguration.controlBindHost):\(controlPort)")
        print("accepting authenticated IDR feedback on \(sessionConfiguration.feedbackBindHost):\(videoFeedbackPort)")
        print("sending authenticated critical-input ACKs to \(clientHost):\(clientFeedbackPort)")
        print("session=\(String(sessionConfiguration.sessionHash, radix: 16)) epoch=\(sessionConfiguration.epoch) generation=\(sessionConfiguration.generation)")
        print("transport expires_at_unix_ms=\(sessionConfiguration.expiresAtUnixMillis)")
        print("Press Ctrl-C to stop")

        while lease.isActive() {
            try await Task.sleep(for: .milliseconds(50))
        }
        lease.revoke()
        try? await stream.stopCapture()
        print("takeover transport revoked or expired; capture/input stopped")
    }
}
#else
@main
struct MacHost {
    static func main() {
        print("takeover-macos-host requires macOS 14+")
    }
}
#endif
