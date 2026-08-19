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
/// This is a latency policy, not a reliable-transfer policy.
public struct FrameReassembler: Sendable {
    public let sessionHash: UInt64
    public let epoch: UInt64
    public let generation: UInt32
    public let maxFrameBytes: Int
    public let maxPacketCount: Int

    private var assembly: Assembly?

    public init(
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        maxFrameBytes: Int = 2 * 1024 * 1024,
        maxPacketCount: Int = 2048
    ) {
        precondition(maxFrameBytes > 0)
        precondition(maxPacketCount > 0 && maxPacketCount <= Int(UInt16.max))
        self.sessionHash = sessionHash
        self.epoch = epoch
        self.generation = generation
        self.maxFrameBytes = maxFrameBytes
        self.maxPacketCount = maxPacketCount
    }

    public mutating func ingest(_ datagram: Data) -> FrameReassemblyResult {
        guard let header = try? VideoPacketHeader.decode(datagram) else { return .droppedInvalid }
        guard header.sessionHash == sessionHash,
              header.epoch == epoch,
              header.generation == generation,
              header.packetCount > 0,
              header.packetIndex < header.packetCount,
              Int(header.packetCount) <= maxPacketCount,
              datagram.count >= VideoPacketHeader.encodedSize else {
            return .droppedInvalid
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
              current.header.flags == header.flags else {
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
