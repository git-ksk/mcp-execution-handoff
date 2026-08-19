import Foundation
import TakeoverCore

#if os(macOS)
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import VideoToolbox

private final class H264Encoder: @unchecked Sendable {
    typealias Output = @Sendable (_ annexB: Data, _ captureNanos: UInt64, _ encodeDoneNanos: UInt64, _ keyframe: Bool) -> Void
    typealias Completion = @Sendable () -> Void

    private var session: VTCompressionSession?
    private let output: Output
    private var parameterSets: Data?

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
                frameContext.completion()
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
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_SuggestedLookAheadFrameCount, value: NSNumber(value: 0))
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
        guard let session else { return }
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

        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
            var sets = Data()
            var index = 0
            while true {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                var count = 0
                let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    format,
                    parameterSetIndex: index,
                    parameterSetPointerOut: &pointer,
                    parameterSetSizeOut: &size,
                    parameterSetCountOut: &count,
                    nalUnitHeaderLengthOut: nil
                )
                guard status == noErr, let pointer else { break }
                sets.append(contentsOf: [0, 0, 0, 1])
                sets.append(pointer, count: size)
                index += 1
                if index >= count { break }
            }
            parameterSets = sets
        }

        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &totalLength, dataPointerOut: &dataPointer)
        guard status == noErr, let dataPointer else { return }
        let bytes = UnsafeRawBufferPointer(start: dataPointer, count: totalLength)
        var offset = 0
        var annexB = isKeyframe ? (parameterSets ?? Data()) : Data()
        while offset + 4 <= totalLength {
            let length = bytes[offset..<(offset + 4)].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            offset += 4
            let end = offset + Int(length)
            guard end <= totalLength else { break }
            annexB.append(contentsOf: [0, 0, 0, 1])
            annexB.append(contentsOf: bytes[offset..<end])
            offset = end
        }

        output(annexB, captureNanos, encodeDone, isKeyframe)
    }
}

private final class CaptureOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let encoder: H264Encoder
    private var frameID: UInt64 = 0
    private let frameIDLock = NSLock()
    private let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
    private let sender: DatagramSender
    private let sessionHash: UInt64
    private let admission = FrameAdmissionGate(maxInFlight: 1)

    init(encoder: H264Encoder, sender: DatagramSender, sessionHash: UInt64) {
        self.encoder = encoder
        self.sender = sender
        self.sessionHash = sessionHash
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

    func sendEncoded(_ data: Data, captureNanos: UInt64, encodeDoneNanos: UInt64, keyframe: Bool) {
        frameIDLock.lock()
        let id = frameID
        frameID &+= 1
        frameIDLock.unlock()

        try? packetizer.forEachPacket(
            payloadBytes: data.count,
            sessionHash: sessionHash,
            epoch: 1,
            generation: 1,
            frameID: id,
            captureNanos: captureNanos,
            encodeDoneNanos: encodeDoneNanos,
            keyframe: keyframe
        ) { slice in
            try sender.send(header: slice.header, payload: data, payloadRange: slice.payloadRange)
        }
    }
}

@main
struct MacHost {
    static func main() async throws {
        let host = CommandLine.arguments.dropFirst().first ?? "127.0.0.1"
        let port = UInt16(CommandLine.arguments.dropFirst(2).first ?? "45555") ?? 45555
        let sender = try DatagramSender(host: host, port: port)

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

        var outputRef: CaptureOutput!
        let encoder = try H264Encoder(width: Int32(config.width), height: Int32(config.height)) { data, capture, encodeDone, keyframe in
            outputRef?.sendEncoded(data, captureNanos: capture, encodeDoneNanos: encodeDone, keyframe: keyframe)
        }
        let output = CaptureOutput(encoder: encoder, sender: sender, sessionHash: 0xA11CE001)
        outputRef = output
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture.frames", qos: .userInteractive))
        try await stream.startCapture()
        print("streaming ScreenCaptureKit -> VideoToolbox H.264 -> UDP to \(host):\(port)")
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
