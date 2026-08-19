import Foundation
import TakeoverCore

#if os(macOS)
import CoreMedia
import CoreVideo
import VideoToolbox

private final class EncodeProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var samplesNanos: [UInt64] = []
    private var sampleBytes: [Int] = []

    func record(latencyNanos: UInt64, bytes: Int) {
        lock.lock()
        samplesNanos.append(latencyNanos)
        sampleBytes.append(bytes)
        lock.unlock()
    }

    func snapshot() -> ([UInt64], [Int]) {
        lock.lock()
        defer { lock.unlock() }
        return (samplesNanos, sampleBytes)
    }
}

private final class FrameContext {
    var startNanos: UInt64 = 0
    let record: Bool
    let semaphore: DispatchSemaphore

    init(record: Bool, semaphore: DispatchSemaphore) {
        self.record = record
        self.semaphore = semaphore
    }
}

private final class SerialH264Probe: @unchecked Sendable {
    private var session: VTCompressionSession?
    private let probe = EncodeProbe()

    init(
        width: Int32,
        height: Int32,
        fps: Int32 = 60,
        bitrate: Int32 = 8_000_000,
        requireHardware: Bool
    ) throws {
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let encoderSpecification: CFDictionary
        if requireHardware {
            encoderSpecification = [
                kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true,
                kVTVideoEncoderSpecification_EnableLowLatencyRateControl as String: true
            ] as CFDictionary
        } else {
            encoderSpecification = [
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true,
                kVTVideoEncoderSpecification_EnableLowLatencyRateControl as String: true
            ] as CFDictionary
        }

        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: encoderSpecification,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: { refCon, sourceFrameRefCon, status, _, sampleBuffer in
                guard let sourceFrameRefCon else { return }
                let context = Unmanaged<FrameContext>.fromOpaque(sourceFrameRefCon).takeRetainedValue()
                defer { context.semaphore.signal() }
                guard status == noErr, let refCon, let sampleBuffer else { return }
                let owner = Unmanaged<SerialH264Probe>.fromOpaque(refCon).takeUnretainedValue()
                if context.record {
                    owner.probe.record(
                        latencyNanos: MonotonicClock.nowNanos() &- context.startNanos,
                        bytes: CMSampleBufferGetTotalSampleSize(sampleBuffer)
                    )
                }
            },
            refcon: refcon,
            compressionSessionOut: &session
        )
        guard status == noErr, let session else {
            throw NSError(
                domain: NSOSStatusErrorDomain,
                code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: requireHardware
                    ? "VideoToolbox could not create a required-hardware H.264 session"
                    : "VideoToolbox could not create an H.264 session"]
            )
        }

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

    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime, record: Bool) throws {
        guard let session else { return }
        let semaphore = DispatchSemaphore(value: 0)
        let context = FrameContext(record: record, semaphore: semaphore)
        context.startNanos = MonotonicClock.nowNanos()
        let pointer = Unmanaged.passRetained(context).toOpaque()
        var flags: VTEncodeInfoFlags = []
        let status = VTCompressionSessionEncodeFrame(
            session,
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
            throw NSError(domain: "thin-takeover.vt-bench", code: 1, userInfo: [NSLocalizedDescriptionKey: "encode callback timeout"])
        }
    }

    func result() -> ([UInt64], [Int]) {
        probe.snapshot()
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

@main
struct VideoToolboxBench {
    static func main() throws {
        let width = Int(CommandLine.arguments.dropFirst().first ?? "1920") ?? 1920
        let height = Int(CommandLine.arguments.dropFirst(2).first ?? "1080") ?? 1080
        let measuredFrames = Int(CommandLine.arguments.dropFirst(3).first ?? "180") ?? 180
        let warmupFrames = Int(CommandLine.arguments.dropFirst(4).first ?? "20") ?? 20
        let hardwareMode = CommandLine.arguments.dropFirst(5).first ?? "require"
        let requireHardware = hardwareMode != "allow"
        let fps: Int32 = 60

        let buffers = try [
            makePixelBuffer(width: width, height: height, seed: 3),
            makePixelBuffer(width: width, height: height, seed: 67)
        ]
        let encoder = try SerialH264Probe(
            width: Int32(width),
            height: Int32(height),
            fps: fps,
            requireHardware: requireHardware
        )

        for index in 0..<(warmupFrames + measuredFrames) {
            let buffer = buffers[index & 1]
            try encoder.encode(
                buffer,
                pts: CMTime(value: Int64(index), timescale: fps),
                record: index >= warmupFrames
            )
        }

        let (samples, sizes) = encoder.result()
        guard let summary = LatencySummary.summarize(samplesNanos: samples) else {
            fatalError("no encode samples")
        }
        let averageBytes = sizes.isEmpty ? 0 : Double(sizes.reduce(0, +)) / Double(sizes.count)
        let maxBytes = sizes.max() ?? 0

        print("codec=h264 width=\(width) height=\(height) frames=\(summary.count) warmup=\(warmupFrames)")
        print("hardware_policy=\(requireHardware ? "required" : "allowed")")
        print("hardware_encoder_confirmed=\(requireHardware ? "true" : "not_asserted")")
        print("encode_callback_latency_ms p50=\(String(format: "%.3f", summary.p50Millis)) p95=\(String(format: "%.3f", summary.p95Millis)) p99=\(String(format: "%.3f", summary.p99Millis)) max=\(String(format: "%.3f", summary.maxMillis))")
        print("encoded_bytes avg=\(String(format: "%.1f", averageBytes)) max=\(maxBytes)")
    }
}
#else
@main
struct VideoToolboxBench {
    static func main() {
        print("takeover-vt-bench requires macOS")
    }
}
#endif
