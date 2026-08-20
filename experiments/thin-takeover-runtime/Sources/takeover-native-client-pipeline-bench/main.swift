import Foundation
import TakeoverCore
import TakeoverNativeClient

#if os(macOS)
import CoreMedia
import CoreVideo
import VideoToolbox

private struct EncodedFrame {
    let sample: Data
    let avcC: Data?
    let keyframe: Bool
    let encodeDoneNanos: UInt64
}

private final class EncoderProbe: @unchecked Sendable {
    private var session: VTCompressionSession?

    init(width: Int32, height: Int32, fps: Int32 = 60) throws {
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: [
                kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
                kVTVideoEncoderSpecification_EnableLowLatencyRateControl as String: true
            ] as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: { _, sourceFrameRefCon, status, _, sampleBuffer in
                guard let sourceFrameRefCon else { return }
                let context = Unmanaged<EncodeContext>.fromOpaque(sourceFrameRefCon).takeRetainedValue()
                defer { context.semaphore.signal() }
                guard status == noErr, let sampleBuffer,
                      CMSampleBufferDataIsReady(sampleBuffer),
                      let block = CMSampleBufferGetDataBuffer(sampleBuffer) else {
                    context.status = status
                    return
                }

                let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]]
                let keyframe = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
                var avcC: Data?
                if keyframe, let format = CMSampleBufferGetFormatDescription(sampleBuffer),
                   let atoms = CMFormatDescriptionGetExtension(
                        format,
                        extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms
                   ) as? NSDictionary {
                    avcC = atoms["avcC"] as? Data
                }

                var total = 0
                var pointer: UnsafeMutablePointer<Int8>?
                let pointerStatus = CMBlockBufferGetDataPointer(
                    block,
                    atOffset: 0,
                    lengthAtOffsetOut: nil,
                    totalLengthOut: &total,
                    dataPointerOut: &pointer
                )
                guard pointerStatus == noErr, let pointer, total > 0 else {
                    context.status = pointerStatus
                    return
                }
                context.frame = EncodedFrame(
                    sample: Data(bytes: pointer, count: total),
                    avcC: avcC,
                    keyframe: keyframe,
                    encodeDoneNanos: MonotonicClock.nowNanos()
                )
            },
            refcon: nil,
            compressionSessionOut: &session
        )
        guard status == noErr, let session else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: NSNumber(value: 0))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: 8_000_000))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: fps * 2))
        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    deinit {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
    }

    func encode(_ buffer: CVPixelBuffer, index: Int) throws -> EncodedFrame {
        guard let session else { throw NSError(domain: "thin-takeover.native-pipeline", code: 1) }
        let context = EncodeContext()
        let pointer = Unmanaged.passRetained(context).toOpaque()
        var flags: VTEncodeInfoFlags = []
        let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: buffer,
            presentationTimeStamp: CMTime(value: Int64(index), timescale: 60),
            duration: .invalid,
            frameProperties: index == 0 ? [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true] as CFDictionary : nil,
            sourceFrameRefcon: pointer,
            infoFlagsOut: &flags
        )
        guard status == noErr else {
            Unmanaged<EncodeContext>.fromOpaque(pointer).release()
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        guard context.semaphore.wait(timeout: .now() + .seconds(2)) == .success else {
            throw NSError(domain: "thin-takeover.native-pipeline", code: 2)
        }
        if context.status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(context.status)) }
        guard let frame = context.frame else { throw NSError(domain: "thin-takeover.native-pipeline", code: 3) }
        return frame
    }

    private final class EncodeContext {
        let semaphore = DispatchSemaphore(value: 0)
        var status: OSStatus = noErr
        var frame: EncodedFrame?
    }
}

private func makePixelBuffer(width: Int, height: Int, seed: Int) throws -> CVPixelBuffer {
    var output: CVPixelBuffer?
    let status = CVPixelBufferCreate(
        kCFAllocatorDefault,
        width,
        height,
        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        [kCVPixelBufferIOSurfacePropertiesKey as String: [:] as NSDictionary] as CFDictionary,
        &output
    )
    guard status == kCVReturnSuccess, let output else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    CVPixelBufferLockBaseAddress(output, [])
    defer { CVPixelBufferUnlockBaseAddress(output, []) }
    if let y = CVPixelBufferGetBaseAddressOfPlane(output, 0)?.assumingMemoryBound(to: UInt8.self) {
        let height = CVPixelBufferGetHeightOfPlane(output, 0)
        let width = CVPixelBufferGetWidthOfPlane(output, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(output, 0)
        for row in 0..<height {
            let line = y.advanced(by: row * stride)
            for column in 0..<width { line[column] = UInt8(32 + ((row ^ column ^ seed) & 0x7F)) }
        }
    }
    if let uv = CVPixelBufferGetBaseAddressOfPlane(output, 1) {
        memset(uv, 128, CVPixelBufferGetHeightOfPlane(output, 1) * CVPixelBufferGetBytesPerRowOfPlane(output, 1))
    }
    return output
}

private final class PipelineSamples: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [UInt64] = []
    private var pendingStart: UInt64 = 0
    let semaphore = DispatchSemaphore(value: 0)

    func begin() {
        lock.lock(); pendingStart = MonotonicClock.nowNanos(); lock.unlock()
    }

    func decoded(_ frame: DecodedVideoFrame) {
        lock.lock()
        let start = pendingStart
        values.append(frame.decodeDoneNanos &- start)
        lock.unlock()
        semaphore.signal()
    }

    func snapshot() -> [UInt64] {
        lock.lock(); defer { lock.unlock() }; return values
    }
}

@main
struct NativeClientPipelineBench {
    static func main() throws {
        let width = Int(CommandLine.arguments.dropFirst().first ?? "1280") ?? 1280
        let height = Int(CommandLine.arguments.dropFirst(2).first ?? "720") ?? 720
        let frames = Int(CommandLine.arguments.dropFirst(3).first ?? "60") ?? 60
        let warmup = min(10, max(1, frames / 5))
        let key = Data(repeating: 0x5A, count: 32)
        let sessionHash: UInt64 = 0x1122334455667788
        let epoch: UInt64 = 7
        let generation: UInt32 = 9
        let encoder = try EncoderProbe(width: Int32(width), height: Int32(height))
        let samples = PipelineSamples()
        let pipeline = try NativeVideoClientPipeline(
            rootKey: key,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            output: { frame in samples.decoded(frame) }
        )
        let cipher = try TransportCipher(rootKey: key)
        let context = TransportCryptoContext(
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            direction: .hostToClient,
            channel: .video
        )
        let authenticator = try VideoHeaderAuthenticator(rootKey: key, sessionHash: sessionHash, epoch: epoch, generation: generation)
        let packetizer = VideoPacketizer(maxDatagramBytes: 1200)
        let buffers = try [
            makePixelBuffer(width: width, height: height, seed: 3),
            makePixelBuffer(width: width, height: height, seed: 91)
        ]
        var frameID: UInt64 = 0

        func feed(_ payload: Data, flags: UInt8, capture: UInt64, encodeDone: UInt64) throws {
            let id = frameID
            frameID &+= 1
            let sealed = try cipher.seal(payload, sequence: id, context: context, associatedData: Data([flags]))
            try packetizer.forEachPacket(
                payloadBytes: sealed.count,
                sessionHash: sessionHash,
                epoch: epoch,
                generation: generation,
                frameID: id,
                captureNanos: capture,
                encodeDoneNanos: encodeDone,
                flags: flags
            ) { slice in
                let header = authenticator.authenticate(slice.header)
                var packet = header.encode()
                packet.append(sealed.subdata(in: slice.payloadRange))
                try pipeline.ingest(packet)
            }
        }

        for index in 0..<frames {
            let capture = MonotonicClock.nowNanos()
            let encoded = try encoder.encode(buffers[index & 1], index: index)
            if let avcC = encoded.avcC {
                try feed(avcC, flags: VideoPacketFlags.codecConfig, capture: capture, encodeDone: encoded.encodeDoneNanos)
            }
            samples.begin()
            var flags = VideoPacketFlags.avccSample
            if encoded.keyframe { flags |= VideoPacketFlags.keyframe }
            try feed(encoded.sample, flags: flags, capture: capture, encodeDone: encoded.encodeDoneNanos)
            guard samples.semaphore.wait(timeout: .now() + .seconds(2)) == .success else {
                throw NSError(domain: "thin-takeover.native-pipeline", code: 4)
            }
        }
        pipeline.flush()
        let values = Array(samples.snapshot().dropFirst(warmup))
        guard let summary = LatencySummary.summarize(samplesNanos: values) else {
            throw NSError(domain: "thin-takeover.native-pipeline", code: 5)
        }
        print("native_secure_pipeline width=\(width) height=\(height) frames=\(frames) warmup=\(warmup)")
        print("path=frame_aead+header_auth+mtu_packetize+reassembly+aead_open+hardware_decode")
        print("post_encode_to_decode_ms p50=\(String(format: "%.3f", summary.p50Millis)) p95=\(String(format: "%.3f", summary.p95Millis)) p99=\(String(format: "%.3f", summary.p99Millis)) max=\(String(format: "%.3f", summary.maxMillis))")
    }
}
#else
@main
struct NativeClientPipelineBench {
    static func main() { print("takeover-native-client-pipeline-bench requires macOS") }
}
#endif
