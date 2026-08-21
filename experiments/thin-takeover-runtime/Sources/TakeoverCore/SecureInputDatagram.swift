import Foundation

public struct SecureInputCodec: Sendable {
    private let cipher: TransportCipher
    private let baseContext: TransportCryptoContext

    public init(rootKey: Data, sessionHash: UInt64, epoch: UInt64, generation: UInt32) throws {
        self.cipher = try TransportCipher(rootKey: rootKey)
        self.baseContext = TransportCryptoContext(
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            direction: .clientToHost,
            channel: .inputRealtime
        )
    }

    public func seal(_ event: InputEvent) throws -> Data {
        let context = context(for: event.lane)
        let header = SecureInputHeader(lane: event.lane, sequence: event.sequence)
        let headerData = header.encode()
        let sealed = try cipher.seal(
            event.encode(),
            sequence: event.sequence,
            context: context,
            associatedData: headerData
        )
        var datagram = headerData
        datagram.append(sealed)
        return datagram
    }

    public func open(_ datagram: Data) throws -> InputEvent {
        let header = try SecureInputHeader.decode(datagram)
        let headerData = datagram.prefix(SecureInputHeader.encodedSize)
        let sealed = datagram.suffix(from: SecureInputHeader.encodedSize)
        let context = context(for: header.lane)
        let plaintext = try cipher.open(
            Data(sealed),
            sequence: header.sequence,
            context: context,
            associatedData: Data(headerData)
        )
        let event = try InputEvent.decode(plaintext)
        guard event.sequence == header.sequence, event.lane == header.lane else {
            throw SecureInputError.bindingMismatch
        }
        return event
    }

    private func context(for lane: InputLane) -> TransportCryptoContext {
        TransportCryptoContext(
            sessionHash: baseContext.sessionHash,
            epoch: baseContext.epoch,
            generation: baseContext.generation,
            direction: .clientToHost,
            channel: lane == .realtime ? .inputRealtime : .inputCritical
        )
    }
}

public enum SecureInputError: Error, Equatable {
    case truncated
    case badMagic
    case unsupportedVersion
    case invalidLane
    case bindingMismatch
}

private struct SecureInputHeader: Sendable, Equatable {
    static let magic: UInt32 = 0x54544B55 // TTKU
    static let version: UInt8 = 1
    static let encodedSize = 16

    let lane: InputLane
    let sequence: UInt64

    func encode() -> Data {
        var data = Data()
        data.reserveCapacity(Self.encodedSize)
        data.appendInteger(Self.magic)
        data.append(Self.version)
        data.append(lane.rawValue)
        data.appendInteger(UInt16(Self.encodedSize))
        data.appendInteger(sequence)
        return data
    }

    static func decode(_ data: Data) throws -> SecureInputHeader {
        guard data.count >= encodedSize else { throw SecureInputError.truncated }
        var cursor = SecureInputCursor(data)
        let magic: UInt32 = try cursor.readInteger()
        guard magic == Self.magic else { throw SecureInputError.badMagic }
        let version = try cursor.readByte()
        guard version == Self.version else { throw SecureInputError.unsupportedVersion }
        guard let lane = InputLane(rawValue: try cursor.readByte()) else { throw SecureInputError.invalidLane }
        let headerLength: UInt16 = try cursor.readInteger()
        guard headerLength == encodedSize else { throw SecureInputError.truncated }
        let sequence: UInt64 = try cursor.readInteger()
        return SecureInputHeader(lane: lane, sequence: sequence)
    }
}

private extension Data {
    mutating func appendInteger<T: FixedWidthInteger>(_ value: T) {
        var value = value.bigEndian
        Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
    }
}

private struct SecureInputCursor {
    let data: Data
    var offset = 0

    init(_ data: Data) { self.data = data }

    mutating func readByte() throws -> UInt8 {
        guard offset < data.count else { throw SecureInputError.truncated }
        defer { offset += 1 }
        return data[offset]
    }

    mutating func readInteger<T: FixedWidthInteger>() throws -> T {
        let width = MemoryLayout<T>.size
        guard offset + width <= data.count else { throw SecureInputError.truncated }
        let slice = data[offset..<(offset + width)]
        offset += width
        var value: T = 0
        for byte in slice { value = (value << 8) | T(byte) }
        return value
    }
}
