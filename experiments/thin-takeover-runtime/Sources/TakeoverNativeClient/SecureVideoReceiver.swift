import Foundation
import TakeoverCore

public struct NativeVideoFrameMetadata: Sendable, Equatable {
    public let frameID: UInt64
    public let captureNanos: UInt64
    public let encodeDoneNanos: UInt64
    public let receiveDoneNanos: UInt64
    public let keyframe: Bool

    public init(
        frameID: UInt64,
        captureNanos: UInt64,
        encodeDoneNanos: UInt64,
        receiveDoneNanos: UInt64,
        keyframe: Bool
    ) {
        self.frameID = frameID
        self.captureNanos = captureNanos
        self.encodeDoneNanos = encodeDoneNanos
        self.receiveDoneNanos = receiveDoneNanos
        self.keyframe = keyframe
    }
}

public enum SecureVideoReceiverEvent: Sendable, Equatable {
    case incomplete
    case codecConfiguration(Data, NativeVideoFrameMetadata)
    case avccSample(Data, NativeVideoFrameMetadata)
    case droppedStale
    case droppedInvalid
    case droppedOversize
    case droppedAuthentication
}

/// Authenticated host->client video depacketization for native clients.
///
/// The receiver authenticates the fixed routing header before reassembly, keeps only one newest
/// incomplete frame, verifies the complete frame AEAD, and only then exposes codec bytes to the
/// decoder adapter. No unverified framebuffer/codec bytes cross this boundary.
public struct SecureVideoReceiver: Sendable {
    private var reassembler: FrameReassembler
    private let cipher: TransportCipher
    private let context: TransportCryptoContext

    public init(
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        maxFrameBytes: Int = 2 * 1024 * 1024,
        maxPacketCount: Int = 2048,
        maxDatagramBytes: Int = 1500
    ) throws {
        let headerAuthenticator = try VideoHeaderAuthenticator(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation
        )
        self.reassembler = FrameReassembler(
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            headerAuthenticator: headerAuthenticator,
            maxFrameBytes: maxFrameBytes,
            maxPacketCount: maxPacketCount,
            maxDatagramBytes: maxDatagramBytes
        )
        self.cipher = try TransportCipher(rootKey: rootKey)
        self.context = TransportCryptoContext(
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            direction: .hostToClient,
            channel: .video
        )
    }

    public mutating func ingest(_ datagram: Data, nowNanos: UInt64 = MonotonicClock.nowNanos()) -> SecureVideoReceiverEvent {
        switch reassembler.ingest(datagram) {
        case .incomplete:
            return .incomplete
        case .droppedStale:
            return .droppedStale
        case .droppedInvalid:
            return .droppedInvalid
        case .droppedOversize:
            return .droppedOversize
        case .complete(let frame):
            let flags = frame.header.flags
            let plaintext: Data
            do {
                plaintext = try cipher.open(
                    frame.sealedPayload,
                    sequence: frame.header.frameID,
                    context: context,
                    associatedData: Data([flags])
                )
            } catch {
                return .droppedAuthentication
            }

            let metadata = NativeVideoFrameMetadata(
                frameID: frame.header.frameID,
                captureNanos: frame.header.captureNanos,
                encodeDoneNanos: frame.header.encodeDoneNanos,
                receiveDoneNanos: nowNanos,
                keyframe: (flags & VideoPacketFlags.keyframe) != 0
            )

            if (flags & VideoPacketFlags.codecConfig) != 0 {
                guard (flags & VideoPacketFlags.avccSample) == 0 else { return .droppedInvalid }
                return .codecConfiguration(plaintext, metadata)
            }
            guard (flags & VideoPacketFlags.avccSample) != 0 else { return .droppedInvalid }
            return .avccSample(plaintext, metadata)
        }
    }
}
