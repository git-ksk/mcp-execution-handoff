import Foundation
import TakeoverCore

#if canImport(CoreMedia) && canImport(CoreVideo) && canImport(VideoToolbox)
import CoreMedia
import CoreVideo
import VideoToolbox

private let takeoverParameterError: OSStatus = -50

public enum NativeH264DecoderError: Error, Equatable {
    case invalidAVCC
    case noParameterSets
    case formatDescription(OSStatus)
    case decoderCreation(OSStatus)
    case blockBuffer(OSStatus)
    case sampleBuffer(OSStatus)
    case decode(OSStatus)
    case decoderNotConfigured
}

public struct AVCDecoderConfigurationRecord: Sendable, Equatable {
    public let nalUnitHeaderLength: Int
    public let parameterSets: [Data]

    public init(avcC: Data) throws {
        guard avcC.count >= 7, avcC[0] == 1 else { throw NativeH264DecoderError.invalidAVCC }
        let headerLength = Int(avcC[4] & 0x03) + 1
        guard (1...4).contains(headerLength) else { throw NativeH264DecoderError.invalidAVCC }

        var index = 5
        let spsCount = Int(avcC[index] & 0x1F)
        index += 1
        var sets: [Data] = []
        sets.reserveCapacity(spsCount + 2)

        func readSet(_ bytes: Data, index: inout Int) throws -> Data {
            guard index + 2 <= bytes.count else { throw NativeH264DecoderError.invalidAVCC }
            let length = (Int(bytes[index]) << 8) | Int(bytes[index + 1])
            index += 2
            guard length > 0, index + length <= bytes.count else { throw NativeH264DecoderError.invalidAVCC }
            let value = Data(bytes[index..<(index + length)])
            index += length
            return value
        }

        for _ in 0..<spsCount { sets.append(try readSet(avcC, index: &index)) }
        guard index < avcC.count else { throw NativeH264DecoderError.invalidAVCC }
        let ppsCount = Int(avcC[index])
        index += 1
        for _ in 0..<ppsCount { sets.append(try readSet(avcC, index: &index)) }
        guard !sets.isEmpty, spsCount > 0, ppsCount > 0 else { throw NativeH264DecoderError.noParameterSets }

        self.nalUnitHeaderLength = headerLength
        self.parameterSets = sets
    }
}

public struct DecodedVideoFrame: @unchecked Sendable {
    public let pixelBuffer: CVPixelBuffer
    public let metadata: NativeVideoFrameMetadata
    public let decodeStartNanos: UInt64
    public let decodeDoneNanos: UInt64

    public init(
        pixelBuffer: CVPixelBuffer,
        metadata: NativeVideoFrameMetadata,
        decodeStartNanos: UInt64,
        decodeDoneNanos: UInt64
    ) {
        self.pixelBuffer = pixelBuffer
        self.metadata = metadata
        self.decodeStartNanos = decodeStartNanos
        self.decodeDoneNanos = decodeDoneNanos
    }
}

/// Hardware-required H.264 AVCC decoder shared by macOS/iOS native takeover clients.
///
/// The output is a GPU-shareable IOSurface-backed bi-planar CVPixelBuffer suitable for direct
/// presentation by a platform renderer (for example Metal on iOS) without an intermediate RGB
/// CPU conversion.
public final class VideoToolboxH264Decoder: @unchecked Sendable {
    public typealias Output = @Sendable (DecodedVideoFrame) -> Void

    private var session: VTDecompressionSession?
    private var formatDescription: CMVideoFormatDescription?
    private let output: Output

    public init(output: @escaping Output) {
        self.output = output
    }

    deinit {
        if let session {
            VTDecompressionSessionWaitForAsynchronousFrames(session)
            VTDecompressionSessionInvalidate(session)
        }
    }

    public func configure(avcC: Data) throws {
        let record = try AVCDecoderConfigurationRecord(avcC: avcC)
        let format = try Self.makeFormatDescription(record)

        if let session, VTDecompressionSessionCanAcceptFormatDescription(session, formatDescription: format) {
            self.formatDescription = format
            return
        }

        if let session {
            VTDecompressionSessionWaitForAsynchronousFrames(session)
            VTDecompressionSessionInvalidate(session)
            self.session = nil
        }
        self.formatDescription = format
        try createSession(format: format)
    }

    public func decode(avccSample: Data, metadata: NativeVideoFrameMetadata) throws {
        guard !avccSample.isEmpty else { throw NativeH264DecoderError.blockBuffer(takeoverParameterError) }
        guard let formatDescription, let session else { throw NativeH264DecoderError.decoderNotConfigured }

        var block: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: nil,
            blockLength: avccSample.count,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: avccSample.count,
            flags: 0,
            blockBufferOut: &block
        )
        guard status == kCMBlockBufferNoErr, let block else { throw NativeH264DecoderError.blockBuffer(status) }

        status = avccSample.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return takeoverParameterError }
            return CMBlockBufferReplaceDataBytes(
                with: base,
                blockBuffer: block,
                offsetIntoDestination: 0,
                dataLength: raw.count
            )
        }
        guard status == kCMBlockBufferNoErr else { throw NativeH264DecoderError.blockBuffer(status) }

        var sample: CMSampleBuffer?
        var sampleSize = avccSample.count
        status = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: block,
            formatDescription: formatDescription,
            sampleCount: 1,
            sampleTimingEntryCount: 0,
            sampleTimingArray: nil,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sample
        )
        guard status == noErr, let sample else { throw NativeH264DecoderError.sampleBuffer(status) }

        let context = DecodeContext(metadata: metadata, decodeStartNanos: MonotonicClock.nowNanos())
        let pointer = Unmanaged.passRetained(context).toOpaque()
        var info: VTDecodeInfoFlags = []
        status = VTDecompressionSessionDecodeFrame(
            session,
            sampleBuffer: sample,
            flags: [],
            frameRefcon: pointer,
            infoFlagsOut: &info
        )
        if status != noErr {
            Unmanaged<DecodeContext>.fromOpaque(pointer).release()
            throw NativeH264DecoderError.decode(status)
        }
    }

    public func flush() {
        if let session { VTDecompressionSessionWaitForAsynchronousFrames(session) }
    }

    private func createSession(format: CMVideoFormatDescription) throws {
        let owner = Unmanaged.passUnretained(self).toOpaque()
        var callback = VTDecompressionOutputCallbackRecord(
            decompressionOutputCallback: { refCon, sourceFrameRefCon, status, _, imageBuffer, _, _ in
                guard let sourceFrameRefCon else { return }
                let context = Unmanaged<DecodeContext>.fromOpaque(sourceFrameRefCon).takeRetainedValue()
                guard status == noErr, let imageBuffer, let refCon else { return }
                let decoder = Unmanaged<VideoToolboxH264Decoder>.fromOpaque(refCon).takeUnretainedValue()
                decoder.output(DecodedVideoFrame(
                    pixelBuffer: imageBuffer,
                    metadata: context.metadata,
                    decodeStartNanos: context.decodeStartNanos,
                    decodeDoneNanos: MonotonicClock.nowNanos()
                ))
            },
            decompressionOutputRefCon: owner
        )
        let decoderSpec = [
            kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder as String: true
        ] as CFDictionary
        let imageAttributes = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as NSDictionary
        ] as CFDictionary
        var created: VTDecompressionSession?
        let status = VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            formatDescription: format,
            decoderSpecification: decoderSpec,
            imageBufferAttributes: imageAttributes,
            outputCallback: &callback,
            decompressionSessionOut: &created
        )
        guard status == noErr, let created else { throw NativeH264DecoderError.decoderCreation(status) }
        VTSessionSetProperty(created, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        session = created
    }

    private static func makeFormatDescription(_ record: AVCDecoderConfigurationRecord) throws -> CMVideoFormatDescription {
        var allocations: [UnsafeMutablePointer<UInt8>] = []
        allocations.reserveCapacity(record.parameterSets.count)
        var sizes: [Int] = []
        sizes.reserveCapacity(record.parameterSets.count)
        for set in record.parameterSets {
            let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: set.count)
            set.copyBytes(to: pointer, count: set.count)
            allocations.append(pointer)
            sizes.append(set.count)
        }
        defer { allocations.forEach { $0.deallocate() } }

        let pointers: [UnsafePointer<UInt8>] = allocations.map { UnsafePointer($0) }
        var format: CMFormatDescription?
        let status = pointers.withUnsafeBufferPointer { pointerBuffer in
            sizes.withUnsafeBufferPointer { sizeBuffer in
                CMVideoFormatDescriptionCreateFromH264ParameterSets(
                    allocator: kCFAllocatorDefault,
                    parameterSetCount: record.parameterSets.count,
                    parameterSetPointers: pointerBuffer.baseAddress!,
                    parameterSetSizes: sizeBuffer.baseAddress!,
                    nalUnitHeaderLength: Int32(record.nalUnitHeaderLength),
                    formatDescriptionOut: &format
                )
            }
        }
        guard status == noErr, let format else {
            throw NativeH264DecoderError.formatDescription(status)
        }
        return format
    }

    private final class DecodeContext {
        let metadata: NativeVideoFrameMetadata
        let decodeStartNanos: UInt64

        init(metadata: NativeVideoFrameMetadata, decodeStartNanos: UInt64) {
            self.metadata = metadata
            self.decodeStartNanos = decodeStartNanos
        }
    }
}

/// End-to-end native receive state machine. The caller owns the UDP socket and presentation layer.
public final class NativeVideoClientPipeline: @unchecked Sendable {
    private var receiver: SecureVideoReceiver
    private let decoder: VideoToolboxH264Decoder
    private let lock = NSLock()

    public init(
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        output: @escaping VideoToolboxH264Decoder.Output
    ) throws {
        self.receiver = try SecureVideoReceiver(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation
        )
        self.decoder = VideoToolboxH264Decoder(output: output)
    }

    @discardableResult
    public func ingest(_ datagram: Data, nowNanos: UInt64 = MonotonicClock.nowNanos()) throws -> SecureVideoReceiverEvent {
        lock.lock()
        let event = receiver.ingest(datagram, nowNanos: nowNanos)
        lock.unlock()

        switch event {
        case .codecConfiguration(let avcC, _):
            try decoder.configure(avcC: avcC)
        case .avccSample(let sample, let metadata):
            try decoder.decode(avccSample: sample, metadata: metadata)
        default:
            break
        }
        return event
    }

    public func flush() { decoder.flush() }
}
#endif
