import Foundation

public struct VideoPacketHeader: Sendable, Equatable {
    public static let magic: UInt32 = 0x54544B52 // TTKR
    public static let version: UInt8 = 1
    public static let encodedSize = 56

    public var flags: UInt8
    public var sessionHash: UInt64
    public var epoch: UInt64
    public var generation: UInt32
    public var frameID: UInt64
    public var packetIndex: UInt16
    public var packetCount: UInt16
    public var captureNanos: UInt64
    public var encodeDoneNanos: UInt64

    public init(
        flags: UInt8 = 0,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        frameID: UInt64,
        packetIndex: UInt16,
        packetCount: UInt16,
        captureNanos: UInt64,
        encodeDoneNanos: UInt64
    ) {
        self.flags = flags
        self.sessionHash = sessionHash
        self.epoch = epoch
        self.generation = generation
        self.frameID = frameID
        self.packetIndex = packetIndex
        self.packetCount = packetCount
        self.captureNanos = captureNanos
        self.encodeDoneNanos = encodeDoneNanos
    }

    public func encode() -> Data {
        var data = Data()
        data.reserveCapacity(Self.encodedSize)
        data.appendInteger(Self.magic)
        data.append(Self.version)
        data.append(flags)
        data.appendInteger(UInt16(Self.encodedSize))
        data.appendInteger(sessionHash)
        data.appendInteger(epoch)
        data.appendInteger(generation)
        data.appendInteger(frameID)
        data.appendInteger(packetIndex)
        data.appendInteger(packetCount)
        data.appendInteger(captureNanos)
        data.appendInteger(encodeDoneNanos)
        return data
    }

    public static func decode(_ data: Data) throws -> VideoPacketHeader {
        guard data.count >= encodedSize else { throw VideoPacketError.truncated }
        var cursor = DataCursor(data)
        let receivedMagic: UInt32 = try cursor.readInteger()
        guard receivedMagic == magic else { throw VideoPacketError.badMagic }
        let receivedVersion = try cursor.readByte()
        guard receivedVersion == version else { throw VideoPacketError.unsupportedVersion }
        let flags = try cursor.readByte()
        let headerLength: UInt16 = try cursor.readInteger()
        guard headerLength == encodedSize else { throw VideoPacketError.invalidHeaderLength }
        return VideoPacketHeader(
            flags: flags,
            sessionHash: try cursor.readInteger(),
            epoch: try cursor.readInteger(),
            generation: try cursor.readInteger(),
            frameID: try cursor.readInteger(),
            packetIndex: try cursor.readInteger(),
            packetCount: try cursor.readInteger(),
            captureNanos: try cursor.readInteger(),
            encodeDoneNanos: try cursor.readInteger()
        )
    }
}

public enum VideoPacketError: Error, Equatable {
    case truncated
    case badMagic
    case unsupportedVersion
    case invalidHeaderLength
}

public struct VideoPacketSlice: Sendable, Equatable {
    public let header: VideoPacketHeader
    public let payloadRange: Range<Int>

    public init(header: VideoPacketHeader, payloadRange: Range<Int>) {
        self.header = header
        self.payloadRange = payloadRange
    }
}

public struct VideoPacketizer: Sendable {
    public let maxDatagramBytes: Int

    public init(maxDatagramBytes: Int = 1200) {
        precondition(maxDatagramBytes > VideoPacketHeader.encodedSize)
        self.maxDatagramBytes = maxDatagramBytes
    }

    public func forEachPacket(
        payloadBytes: Int,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        frameID: UInt64,
        captureNanos: UInt64,
        encodeDoneNanos: UInt64,
        keyframe: Bool,
        _ body: (VideoPacketSlice) throws -> Void
    ) rethrows {
        precondition(payloadBytes >= 0)
        let maxPayload = maxDatagramBytes - VideoPacketHeader.encodedSize
        let count = max(1, (payloadBytes + maxPayload - 1) / maxPayload)
        precondition(count <= Int(UInt16.max))

        for index in 0..<count {
            let lower = index * maxPayload
            let upper = min(payloadBytes, lower + maxPayload)
            let header = VideoPacketHeader(
                flags: keyframe ? 0x01 : 0,
                sessionHash: sessionHash,
                epoch: epoch,
                generation: generation,
                frameID: frameID,
                packetIndex: UInt16(index),
                packetCount: UInt16(count),
                captureNanos: captureNanos,
                encodeDoneNanos: encodeDoneNanos
            )
            try body(VideoPacketSlice(header: header, payloadRange: lower..<upper))
        }
    }

    // Compatibility/reference path. The hot sender path should use forEachPacket + send(header:payload:range:)
    // so encoded payload bytes are not copied once per UDP datagram.
    public func packetize(
        payload: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        frameID: UInt64,
        captureNanos: UInt64,
        encodeDoneNanos: UInt64,
        keyframe: Bool
    ) -> [Data] {
        var packets: [Data] = []
        forEachPacket(
            payloadBytes: payload.count,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            frameID: frameID,
            captureNanos: captureNanos,
            encodeDoneNanos: encodeDoneNanos,
            keyframe: keyframe
        ) { slice in
            var datagram = slice.header.encode()
            if !slice.payloadRange.isEmpty {
                datagram.append(payload.subdata(in: slice.payloadRange))
            }
            packets.append(datagram)
        }
        return packets
    }
}

private extension Data {
    mutating func appendInteger<T: FixedWidthInteger>(_ value: T) {
        var value = value.bigEndian
        Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
    }
}

private struct DataCursor {
    let data: Data
    var offset = 0

    init(_ data: Data) { self.data = data }

    mutating func readByte() throws -> UInt8 {
        guard offset < data.count else { throw VideoPacketError.truncated }
        defer { offset += 1 }
        return data[offset]
    }

    mutating func readInteger<T: FixedWidthInteger>() throws -> T {
        let width = MemoryLayout<T>.size
        guard offset + width <= data.count else { throw VideoPacketError.truncated }
        let slice = data[offset..<(offset + width)]
        offset += width
        var value: T = 0
        for byte in slice { value = (value << 8) | T(byte) }
        return value
    }
}
