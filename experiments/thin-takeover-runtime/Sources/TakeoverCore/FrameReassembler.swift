import Foundation

public struct ReassembledFrame: Sendable, Equatable {
    public let header: VideoPacketHeader
    public let sealedPayload: Data

    public init(header: VideoPacketHeader, sealedPayload: Data) {
        self.header = header
        self.sealedPayload = sealedPayload
    }
}

public enum FrameReassemblyResult: Sendable, Equatable {
    case incomplete
    case complete(ReassembledFrame)
    case droppedStale
    case droppedInvalid
    case droppedOversize
}

/// A deliberately tiny receive-side jitter/reassembly buffer.
///
/// Only the newest frame is retained. Starting a newer frame abandons an older incomplete one.
/// Clear routing headers are authenticated before any reassembly allocation/state mutation, and
/// completed frame IDs are remembered for the lifetime of the receiver generation to reject replay.
public struct FrameReassembler: Sendable {
    public let sessionHash: UInt64
    public let epoch: UInt64
    public let generation: UInt32
    public let maxFrameBytes: Int
    public let maxPacketCount: Int
    public let maxDatagramBytes: Int

    private let headerAuthenticator: VideoHeaderAuthenticator
    private var assembly: Assembly?
    private var highestCompletedFrameID: UInt64?

    public init(
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        headerAuthenticator: VideoHeaderAuthenticator,
        maxFrameBytes: Int = 2 * 1024 * 1024,
        maxPacketCount: Int = 2048,
        maxDatagramBytes: Int = 1500
    ) {
        precondition(maxFrameBytes > 0)
        precondition(maxPacketCount > 0 && maxPacketCount <= Int(UInt16.max))
        precondition(maxDatagramBytes >= VideoPacketHeader.encodedSize)
        self.sessionHash = sessionHash
        self.epoch = epoch
        self.generation = generation
        self.headerAuthenticator = headerAuthenticator
        self.maxFrameBytes = maxFrameBytes
        self.maxPacketCount = maxPacketCount
        self.maxDatagramBytes = maxDatagramBytes
    }

    public mutating func ingest(_ datagram: Data) -> FrameReassemblyResult {
        guard datagram.count >= VideoPacketHeader.encodedSize,
              datagram.count <= maxDatagramBytes,
              let header = try? VideoPacketHeader.decode(datagram),
              headerAuthenticator.verify(header) else {
            return .droppedInvalid
        }

        guard header.sessionHash == sessionHash,
              header.epoch == epoch,
              header.generation == generation,
              header.packetCount > 0,
              header.packetIndex < header.packetCount,
              Int(header.packetCount) <= maxPacketCount else {
            return .droppedInvalid
        }

        if let highestCompletedFrameID, header.frameID <= highestCompletedFrameID {
            return .droppedStale
        }

        if let assembly, header.frameID < assembly.header.frameID {
            return .droppedStale
        }

        if assembly == nil || header.frameID > assembly!.header.frameID {
            assembly = Assembly(header: header)
        }

        guard var current = assembly else { return .droppedInvalid }
        guard current.header.frameID == header.frameID,
              current.header.packetCount == header.packetCount,
              current.header.flags == header.flags,
              current.header.captureNanos == header.captureNanos,
              current.header.encodeDoneNanos == header.encodeDoneNanos else {
            return .droppedInvalid
        }

        let index = Int(header.packetIndex)
        if current.parts[index] == nil {
            let payload = datagram.subdata(in: VideoPacketHeader.encodedSize..<datagram.count)
            if current.totalBytes + payload.count > maxFrameBytes {
                assembly = nil
                return .droppedOversize
            }
            current.parts[index] = payload
            current.totalBytes += payload.count
            current.received += 1
            assembly = current
        }

        guard current.received == current.parts.count else { return .incomplete }
        var payload = Data()
        payload.reserveCapacity(current.totalBytes)
        for part in current.parts {
            guard let part else {
                assembly = current
                return .incomplete
            }
            payload.append(part)
        }
        let completed = ReassembledFrame(header: current.header, sealedPayload: payload)
        highestCompletedFrameID = current.header.frameID
        assembly = nil
        return .complete(completed)
    }

    private struct Assembly: Sendable {
        let header: VideoPacketHeader
        var parts: [Data?]
        var received: Int = 0
        var totalBytes: Int = 0

        init(header: VideoPacketHeader) {
            self.header = header
            self.parts = Array(repeating: nil, count: Int(header.packetCount))
        }
    }
}
