import Foundation

public enum FeedbackKind: UInt8, Sendable, Codable {
    /// Host confirms that one critical input event passed authentication, replay gating and OS injection.
    case criticalInputAck = 1
    /// Native client requests decoder resynchronization. The host may force the next encoded frame to IDR.
    case requestIDR = 2
}

public struct FeedbackMessage: Sendable, Equatable {
    public static let magic: UInt32 = 0x54544B46 // TTKF
    public static let version: UInt8 = 1
    public static let encodedSize = 32

    public let kind: FeedbackKind
    public let sequence: UInt64
    public let reference: UInt64
    public let monotonicNanos: UInt64

    public init(kind: FeedbackKind, sequence: UInt64, reference: UInt64, monotonicNanos: UInt64) {
        self.kind = kind
        self.sequence = sequence
        self.reference = reference
        self.monotonicNanos = monotonicNanos
    }

    fileprivate func encode() -> Data {
        var data = Data()
        data.reserveCapacity(Self.encodedSize)
        data.appendInteger(Self.magic)
        data.append(Self.version)
        data.append(kind.rawValue)
        data.appendInteger(UInt16(Self.encodedSize))
        data.appendInteger(sequence)
        data.appendInteger(reference)
        data.appendInteger(monotonicNanos)
        return data
    }

    fileprivate static func decode(_ data: Data) throws -> FeedbackMessage {
        guard data.count == Self.encodedSize else { throw FeedbackProtocolError.invalidLength }
        var cursor = FeedbackCursor(data)
        let magic: UInt32 = try cursor.readInteger()
        guard magic == Self.magic else { throw FeedbackProtocolError.badMagic }
        guard try cursor.readByte() == Self.version else { throw FeedbackProtocolError.unsupportedVersion }
        guard let kind = FeedbackKind(rawValue: try cursor.readByte()) else { throw FeedbackProtocolError.invalidKind }
        let length: UInt16 = try cursor.readInteger()
        guard length == Self.encodedSize else { throw FeedbackProtocolError.invalidLength }
        let sequence: UInt64 = try cursor.readInteger()
        let reference: UInt64 = try cursor.readInteger()
        let monotonicNanos: UInt64 = try cursor.readInteger()
        return FeedbackMessage(kind: kind, sequence: sequence, reference: reference, monotonicNanos: monotonicNanos)
    }
}

public enum FeedbackProtocolError: Error, Equatable {
    case invalidLength
    case badMagic
    case unsupportedVersion
    case invalidKind
    case bindingMismatch
    case directionMismatch
}

/// Authenticated feedback codec with explicit direction and channel separation.
///
/// - `criticalInputAck` MUST travel host->client on `.inputFeedback`.
/// - `requestIDR` MUST travel client->host on `.videoFeedback`.
///
/// Feedback never grants authority. It can only confirm already-injected input or request a fresh
/// decoder synchronization frame.
public struct SecureFeedbackCodec: Sendable {
    public let direction: TransportDirection
    public let channel: TransportChannel

    private let cipher: TransportCipher
    private let context: TransportCryptoContext

    public init(
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        direction: TransportDirection,
        channel: TransportChannel
    ) throws {
        guard (direction == .hostToClient && channel == .inputFeedback) ||
              (direction == .clientToHost && channel == .videoFeedback) else {
            throw FeedbackProtocolError.directionMismatch
        }
        self.direction = direction
        self.channel = channel
        self.cipher = try TransportCipher(rootKey: rootKey)
        self.context = TransportCryptoContext(
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            direction: direction,
            channel: channel
        )
    }

    public func seal(_ message: FeedbackMessage) throws -> Data {
        guard kindIsAllowed(message.kind) else { throw FeedbackProtocolError.directionMismatch }
        let header = FeedbackEnvelope(sequence: message.sequence)
        let headerData = header.encode()
        let sealed = try cipher.seal(
            message.encode(),
            sequence: message.sequence,
            context: context,
            associatedData: headerData
        )
        var datagram = headerData
        datagram.append(sealed)
        return datagram
    }

    public func open(_ datagram: Data) throws -> FeedbackMessage {
        let header = try FeedbackEnvelope.decode(datagram)
        let headerData = datagram.prefix(FeedbackEnvelope.encodedSize)
        let sealed = datagram.suffix(from: FeedbackEnvelope.encodedSize)
        let plaintext = try cipher.open(
            Data(sealed),
            sequence: header.sequence,
            context: context,
            associatedData: Data(headerData)
        )
        let message = try FeedbackMessage.decode(plaintext)
        guard message.sequence == header.sequence else { throw FeedbackProtocolError.bindingMismatch }
        guard kindIsAllowed(message.kind) else { throw FeedbackProtocolError.directionMismatch }
        return message
    }

    private func kindIsAllowed(_ kind: FeedbackKind) -> Bool {
        switch (direction, channel, kind) {
        case (.hostToClient, .inputFeedback, .criticalInputAck),
             (.clientToHost, .videoFeedback, .requestIDR):
            return true
        default:
            return false
        }
    }
}

public struct FeedbackSequenceGate: Sendable {
    private var highest: UInt64?

    public init() {}

    public mutating func accept(_ sequence: UInt64) -> Bool {
        if let highest, sequence <= highest { return false }
        highest = sequence
        return true
    }
}

private struct FeedbackEnvelope: Sendable, Equatable {
    static let magic: UInt32 = 0x54544B51 // TTKQ
    static let version: UInt8 = 1
    static let encodedSize = 16

    let sequence: UInt64

    func encode() -> Data {
        var data = Data()
        data.reserveCapacity(Self.encodedSize)
        data.appendInteger(Self.magic)
        data.append(Self.version)
        data.append(0)
        data.appendInteger(UInt16(Self.encodedSize))
        data.appendInteger(sequence)
        return data
    }

    static func decode(_ datagram: Data) throws -> FeedbackEnvelope {
        guard datagram.count >= encodedSize + TransportCipher.nonceBytes + TransportCipher.tagBytes else {
            throw FeedbackProtocolError.invalidLength
        }
        var cursor = FeedbackCursor(datagram)
        let magic: UInt32 = try cursor.readInteger()
        guard magic == Self.magic else { throw FeedbackProtocolError.badMagic }
        guard try cursor.readByte() == Self.version else { throw FeedbackProtocolError.unsupportedVersion }
        _ = try cursor.readByte()
        let length: UInt16 = try cursor.readInteger()
        guard length == Self.encodedSize else { throw FeedbackProtocolError.invalidLength }
        return FeedbackEnvelope(sequence: try cursor.readInteger())
    }
}

private extension Data {
    mutating func appendInteger<T: FixedWidthInteger>(_ value: T) {
        var value = value.bigEndian
        Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
    }
}

private struct FeedbackCursor {
    let data: Data
    var offset = 0

    init(_ data: Data) { self.data = data }

    mutating func readByte() throws -> UInt8 {
        guard offset < data.count else { throw FeedbackProtocolError.invalidLength }
        defer { offset += 1 }
        return data[offset]
    }

    mutating func readInteger<T: FixedWidthInteger>() throws -> T {
        let width = MemoryLayout<T>.size
        guard offset + width <= data.count else { throw FeedbackProtocolError.invalidLength }
        var value: T = 0
        for index in offset..<(offset + width) { value = (value << 8) | T(data[index]) }
        offset += width
        return value
    }
}
