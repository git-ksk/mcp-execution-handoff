import Foundation
import TakeoverCore

#if os(macOS)
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import VideoToolbox

private enum HostConfigurationError: Error, CustomStringConvertible {
    case missing(String)
    case invalid(String)

    var description: String {
        switch self {
        case .missing(let name): return "missing required environment variable \(name)"
        case .invalid(let name): return "invalid environment variable \(name)"
        }
    }
}

private struct HostSessionConfiguration {
    let rootKey: Data
    let sessionHash: UInt64
    let epoch: UInt64
    let generation: UInt32

    static func load() throws -> HostSessionConfiguration {
        let env = ProcessInfo.processInfo.environment
        guard let keyHex = env["THIN_TAKEOVER_SESSION_KEY_HEX"] else {
            throw HostConfigurationError.missing("THIN_TAKEOVER_SESSION_KEY_HEX")
        }
        guard let rootKey = decodeHex(keyHex), rootKey.count == TransportCipher.rootKeyBytes else {
            throw HostConfigurationError.invalid("THIN_TAKEOVER_SESSION_KEY_HEX")
        }
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
        return HostSessionConfiguration(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation
        )
    }
}

private func decodeHex(_ text: String) -> Data? {
    let bytes = Array(text.utf8)
    guard bytes.count.isMultiple(of: 2) else { return nil }
    var output = Data()
    output.reserveCapacity(bytes.count / 2)
    var index = 0
    while index < bytes.count {
        guard let high = hexNibble(bytes[index]), let low = hexNibble(bytes[index + 1]) else { return nil }
        output.append((high << 4) | low)
        index += 2
    }
    return output
}

private func hexNibble(_ byte: UInt8) -> UInt8? {
    switch byte {
    case 48...57: return byte - 48
    case 65...70: return byte - 55
    case 97...102: return byte - 87
    default: return nil
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

    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime, captureNanos: UInt64, completion: @escaping Completion) {
        guard let session else { completion(); return }
        var flags: VTEncodeInfoFlags = []
        let context = Unmanaged.passRetained(FrameContext(captureNanos: captureNanos, completion: completion)).toOpaque()
        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: nil,
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
    private let context: TransportCryptoContext

    init(sender: DatagramSender, configuration: HostSessionConfiguration) throws {
        self.sender = sender
        self.cipher = try TransportCipher(rootKey: configuration.rootKey)
        self.context = TransportCryptoContext(
            sessionHash: configuration.sessionHash,
            epoch: configuration.epoch,
            generation: configuration.generation,
            direction: .hostToClient,
            channel: .video
        )
    }

    func send(
        avccSample: Data,
        codecConfig: Data?,
        captureNanos: UInt64,
        encodeDoneNanos: UInt64,
        keyframe: Bool
    ) {
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
                try sender.send(header: slice.header, payload: sealed, payloadRange: slice.payloadRange)
            }
        } catch {
            // Media is best-effort, but authentication is not. Never fall back to plaintext.
        }
    }
}

private final class CaptureOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let encoder: H264Encoder
    private let admission = FrameAdmissionGate(maxInFlight: 1)

    init(encoder: H264Encoder) {
        self.encoder = encoder
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
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
        let host = CommandLine.arguments.dropFirst().first ?? "127.0.0.1"
        let videoPort = UInt16(CommandLine.arguments.dropFirst(2).first ?? "45555") ?? 45555
        let defaultInputPort = videoPort == UInt16.max ? UInt16.max - 1 : videoPort + 1
        let inputPort = UInt16(CommandLine.arguments.dropFirst(3).first ?? String(defaultInputPort)) ?? defaultInputPort
        let sessionConfiguration = try HostSessionConfiguration.load()

        let sender = try DatagramSender(host: host, port: videoPort)
        let frameSender = try EncodedFrameSender(sender: sender, configuration: sessionConfiguration)
        let inputServer = try SecureInputServer(
            bindHost: "0.0.0.0",
            port: inputPort,
            rootKey: sessionConfiguration.rootKey,
            sessionHash: sessionConfiguration.sessionHash,
            epoch: sessionConfiguration.epoch,
            generation: sessionConfiguration.generation
        )
        _ = Task.detached(priority: .high) {
            inputServer.run()
        }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { fatalError("No display available") }
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.width = min(display.width, 1920)
        config.height = min(display.height, 1080)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.queueDepth = 3
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.capturesAudio = false
        config.showsCursor = false

        let encoder = try H264Encoder(width: Int32(config.width), height: Int32(config.height)) { [frameSender] avccSample, codecConfig, capture, encodeDone, keyframe in
            frameSender.send(
                avccSample: avccSample,
                codecConfig: codecConfig,
                captureNanos: capture,
                encodeDoneNanos: encodeDone,
                keyframe: keyframe
            )
        }
        let output = CaptureOutput(encoder: encoder)
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture.frames", qos: .userInteractive))
        try await stream.startCapture()
        print("streaming authenticated ScreenCaptureKit -> VideoToolbox H.264 AVCC -> UDP to \(host):\(videoPort)")
        print("accepting authenticated Human input on 0.0.0.0:\(inputPort)")
        print("session=\(String(sessionConfiguration.sessionHash, radix: 16)) epoch=\(sessionConfiguration.epoch) generation=\(sessionConfiguration.generation)")
        print("Press Ctrl-C to stop")
        while true { try await Task.sleep(for: .seconds(3600)) }
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
