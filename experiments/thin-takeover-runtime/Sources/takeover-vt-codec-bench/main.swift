import Foundation
import TakeoverCore

#if os(macOS)
import CoreMedia
import CoreVideo
import VideoToolbox

private final class CodecSamples: @unchecked Sendable {
    private let lock = NSLock()
    private var encodeNanos: [UInt64] = []
    private var decodeNanos: [UInt64] = []
    private var roundTripNanos: [UInt64] = []

    func recordEncode(_ nanos: UInt64) {
        lock.lock()
        encodeNanos.append(nanos)
        lock.unlock()
    }

    func recordDecode(_ nanos: UInt64, roundTrip: UInt64) {
        lock.lock()
        decodeNanos.append(nanos)
        roundTripNanos.append(roundTrip)
        lock.unlock()
    }

    func snapshot() -> ([UInt64], [UInt64], [UInt64]) {
        lock.lock()
        defer { lock.unlock() }
        return (encodeNanos, decodeNanos, roundTripNanos)
    }
}

private final class FrameContext {
    let startNanos: UInt64
    let record: Bool
    let semaphore: DispatchSemaphore
    private let lock = NSLock()
    private var failureStatus: OSStatus?

    init(record: Bool, semaphore: DispatchSemaphore) {
        self.startNanos = MonotonicClock.nowNanos()
        self.record = record
        self.semaphore = semaphore
    }

    func fail(_ status: OSStatus) {
        lock.lock()
        if failureStatus == nil { failureStatus = status }
        lock.unlock()
    }

    func failure() -> OSStatus? {
        lock.lock()
        defer { lock.unlock() }
        return failureStatus
    }
}

private final class DecodeContext {
    let frameStartNanos: UInt64
    let decodeStartNanos: UInt64
    let record: Bool

    init(frameStartNanos: UInt64, decodeStartNanos: UInt64, record: Bool) {
        self.frameStartNanos = frameStartNanos
        self.decodeStartNanos = decodeStartNanos
        self.record = record
    }
}

private final class HardwareCodecProbe: @unchecked Sendable {
    private var encoder: VTCompressionSession?
    private var decoder: VTDecompressionSession?
    private let samples = CodecSamples()

    init(width: Int32, height: Int32, fps: Int32 = 60, bitrate: Int32 = 8_000_000) throws {
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let encoderSpec = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl as String: true
        ] as CFDictionary

        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: encoderSpec,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: { refCon, sourceFrameRefCon, status, _, sampleBuffer in
                guard let sourceFrameRefCon else { return }
                let frame = Unmanaged<FrameContext>.fromOpaque(sourceFrameRefCon).takeRetainedValue()
                defer { frame.semaphore.signal() }
                guard status == noErr, let refCon, let sampleBuffer else {
                    frame.fail(status)
                    return
                }

                let owner = Unmanaged<HardwareCodecProbe>.fromOpaque(refCon).takeUnretainedValue()
                let encodeDone = MonotonicClock.nowNanos()
                if frame.record {
                    owner.samples.recordEncode(encodeDone &- frame.startNanos)
                }

                let decodeStatus = owner.decodeSynchronously(sampleBuffer, frame: frame)
                if decodeStatus != noErr {
                    frame.fail(decodeStatus)
                }
            },
            refcon: refcon,
            compressionSessionOut: &encoder
        )
        guard status == noErr, let encoder else {
            throw NSError(
                domain: NSOSStatusErrorDomain,
                code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "required hardware H.264 encoder unavailable"]
            )
        }

        VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: NSNumber(value: 0))
        VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
        VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, value: kCFBooleanTrue)
        if #available(macOS 15.0, *) {
            VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_SuggestedLookAheadFrameCount, value: NSNumber(value: 0))
        }
        VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrate))
        VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: fps * 2))
        VTSessionSetProperty(encoder, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Main_AutoLevel)
        VTCompressionSessionPrepareToEncodeFrames(encoder)
    }

    deinit {
        if let decoder {
            VTDecompressionSessionInvalidate(decoder)
        }
        if let encoder {
            VTCompressionSessionCompleteFrames(encoder, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(encoder)
        }
    }

    func process(_ pixelBuffer: CVPixelBuffer, pts: CMTime, record: Bool) throws {
        guard let encoder else { return }
        let semaphore = DispatchSemaphore(value: 0)
        let frame = FrameContext(record: record, semaphore: semaphore)
        let pointer = Unmanaged.passRetained(frame).toOpaque()
        var flags: VTEncodeInfoFlags = []
        let status = VTCompressionSessionEncodeFrame(
            encoder,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: nil,
            sourceFrameRefcon: pointer,
            infoFlagsOut: &flags
        )
        guard status == noErr else {
            Unmanaged<FrameContext>.fromOpaque(pointer).release()
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        guard semaphore.wait(timeout: .now() + .seconds(2)) == .success else {
            throw NSError(domain: "thin-takeover.vt-codec-bench", code: 1, userInfo: [NSLocalizedDescriptionKey: "codec callback timeout"])
        }
        if let failure = frame.failure() {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(failure))
        }
    }

    func result() -> ([UInt64], [UInt64], [UInt64]) {
        samples.snapshot()
    }

    private func decodeSynchronously(_ sampleBuffer: CMSampleBuffer, frame: FrameContext) -> OSStatus {
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer) else {
            return kVTVideoDecoderUnsupportedDataFormatErr
        }
        let decoderStatus = ensureDecoder(format: format)
        guard decoderStatus == noErr, let decoder else { return decoderStatus }

        let context = DecodeContext(
            frameStartNanos: frame.startNanos,
            decodeStartNanos: MonotonicClock.nowNanos(),
            record: frame.record
        )
        let pointer = Unmanaged.passRetained(context).toOpaque()
        var info: VTDecodeInfoFlags = []
        let status = VTDecompressionSessionDecodeFrame(
            decoder,
            sampleBuffer: sampleBuffer,
            flags: [],
            frameRefcon: pointer,
            infoFlagsOut: &info
        )
        if status != noErr {
            Unmanaged<DecodeContext>.fromOpaque(pointer).release()
        }
        return status
    }

    private func ensureDecoder(format: CMFormatDescription) -> OSStatus {
        if let decoder {
            return VTDecompressionSessionCanAcceptFormatDescription(decoder, formatDescription: format)
                ? noErr
                : kVTFormatDescriptionChangeNotSupportedErr
        }

        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var callback = VTDecompressionOutputCallbackRecord(
            decompressionOutputCallback: { refCon, sourceFrameRefCon, status, _, imageBuffer, _, _ in
                guard let sourceFrameRefCon else { return }
                let context = Unmanaged<DecodeContext>.fromOpaque(sourceFrameRefCon).takeRetainedValue()
                guard status == noErr, imageBuffer != nil, let refCon else { return }
                guard context.record else { return }
                let owner = Unmanaged<HardwareCodecProbe>.fromOpaque(refCon).takeUnretainedValue()
                let now = MonotonicClock.nowNanos()
                owner.samples.recordDecode(
                    now &- context.decodeStartNanos,
                    roundTrip: now &- context.frameStartNanos
                )
            },
            decompressionOutputRefCon: refcon
        )
        let decoderSpec = [
            kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder as String: true
        ] as CFDictionary
        let imageAttributes = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as NSDictionary
        ] as CFDictionary

        let status = VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            formatDescription: format,
            decoderSpecification: decoderSpec,
            imageBufferAttributes: imageAttributes,
            outputCallback: &callback,
            decompressionSessionOut: &decoder
        )
        if status == noErr, let decoder {
            VTSessionSetProperty(decoder, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        }
        return status
    }
}

private func makePixelBuffer(width: Int, height: Int, seed: Int) throws -> CVPixelBuffer {
    var pixelBuffer: CVPixelBuffer?
    let attrs = [kCVPixelBufferIOSurfacePropertiesKey as String: [:] as NSDictionary] as CFDictionary
    let status = CVPixelBufferCreate(
        kCFAllocatorDefault,
        width,
        height,
        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        attrs,
        &pixelBuffer
    )
    guard status == kCVReturnSuccess, let pixelBuffer else {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }

    CVPixelBufferLockBaseAddress(pixelBuffer, [])
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }

    if CVPixelBufferGetPlaneCount(pixelBuffer) >= 2 {
        let yHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let yWidth = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let yStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        if let yBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0)?.assumingMemoryBound(to: UInt8.self) {
            for row in 0..<yHeight {
                let line = yBase.advanced(by: row * yStride)
                for column in 0..<yWidth {
                    let tile = ((row >> 4) ^ (column >> 4) ^ seed) & 0x7F
                    line[column] = UInt8(32 + tile)
                }
            }
        }

        let uvHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 1)
        let uvStride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
        if let uvBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) {
            memset(uvBase, 128, uvHeight * uvStride)
        }
    }
    return pixelBuffer
}

private func printSummary(_ label: String, samples: [UInt64]) {
    guard let summary = LatencySummary.summarize(samplesNanos: samples) else {
        print("\(label)=no_samples")
        return
    }
    print("\(label)_ms p50=\(String(format: "%.3f", summary.p50Millis)) p95=\(String(format: "%.3f", summary.p95Millis)) p99=\(String(format: "%.3f", summary.p99Millis)) max=\(String(format: "%.3f", summary.maxMillis))")
}

@main
struct VideoToolboxCodecBench {
    static func main() throws {
        let width = Int(CommandLine.arguments.dropFirst().first ?? "1280") ?? 1280
        let height = Int(CommandLine.arguments.dropFirst(2).first ?? "720") ?? 720
        let measuredFrames = Int(CommandLine.arguments.dropFirst(3).first ?? "120") ?? 120
        let warmupFrames = Int(CommandLine.arguments.dropFirst(4).first ?? "20") ?? 20
        let fps: Int32 = 60

        let buffers = try [
            makePixelBuffer(width: width, height: height, seed: 3),
            makePixelBuffer(width: width, height: height, seed: 67)
        ]
        let codec = try HardwareCodecProbe(width: Int32(width), height: Int32(height), fps: fps)

        for index in 0..<(warmupFrames + measuredFrames) {
            try codec.process(
                buffers[index & 1],
                pts: CMTime(value: Int64(index), timescale: fps),
                record: index >= warmupFrames
            )
        }

        let (encode, decode, roundTrip) = codec.result()
        print("codec=h264 width=\(width) height=\(height) frames=\(measuredFrames) warmup=\(warmupFrames)")
        print("hardware_encoder_required=true hardware_decoder_required=true")
        printSummary("encode_callback_latency", samples: encode)
        printSummary("decode_callback_latency", samples: decode)
        printSummary("codec_roundtrip_latency", samples: roundTrip)
    }
}
#else
@main
struct VideoToolboxCodecBench {
    static func main() {
        print("takeover-vt-codec-bench requires macOS")
    }
}
#endif
