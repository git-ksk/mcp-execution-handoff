import Foundation

public enum ControlMessageKind: UInt8, Sendable, Codable {
    case revoke = 1
}

public struct ControlMessage: Sendable, Equatable {
    public let kind: ControlMessageKind
    public let sequence: UInt64

    public init(kind: ControlMessageKind, sequence: UInt64) {
        self.kind = kind
        self.sequence = sequence
    }

    fileprivate func encode() -> Data {
        var data = Data()
        data.reserveCapacity(16)
        data.appendInteger(UInt32(0x54544B43)) // TTKC
        data.append(UInt8(1))
        data.append(kind.rawValue)
        data.appendInteger(UInt16(16))
        data.appendInteger(sequence)
        return data
    }

    fileprivate static func decode(_ data: Data) throws -> ControlMessage {
        guard data.count == 16 else { throw ControlProtocolError.invalidLength }
        var cursor = ControlCursor(data)
        let magic: UInt32 = try cursor.readInteger()
        guard magic == 0x54544B43 else { throw ControlProtocolError.badMagic }
        guard try cursor.readByte() == 1 else { throw ControlProtocolError.unsupportedVersion }
        guard let kind = ControlMessageKind(rawValue: try cursor.readByte()) else {
            throw ControlProtocolError.invalidKind
        }
        let length: UInt16 = try cursor.readInteger()
        guard length == 16 else { throw ControlProtocolError.invalidLength }
        let sequence: UInt64 = try cursor.readInteger()
        return ControlMessage(kind: kind, sequence: sequence)
    }
}

public enum ControlProtocolError: Error, Equatable {
    case invalidLength
    case badMagic
    case unsupportedVersion
    case invalidKind
    case bindingMismatch
}

public struct SecureControlCodec: Sendable {
    private let cipher: TransportCipher
    private let context: TransportCryptoContext

    public init(rootKey: Data, sessionHash: UInt64, epoch: UInt64, generation: UInt32) throws {
        self.cipher = try TransportCipher(rootKey: rootKey)
        self.context = TransportCryptoContext(
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            direction: .clientToHost,
            channel: .control
        )
    }

    public func seal(_ message: ControlMessage) throws -> Data {
        let header = ControlEnvelopeHeader(sequence: message.sequence)
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

    public func open(_ datagram: Data) throws -> ControlMessage {
        let header = try ControlEnvelopeHeader.decode(datagram)
        let headerData = datagram.prefix(ControlEnvelopeHeader.encodedSize)
        let sealed = datagram.suffix(from: ControlEnvelopeHeader.encodedSize)
        let plaintext = try cipher.open(
            Data(sealed),
            sequence: header.sequence,
            context: context,
            associatedData: Data(headerData)
        )
        let message = try ControlMessage.decode(plaintext)
        guard message.sequence == header.sequence else { throw ControlProtocolError.bindingMismatch }
        return message
    }
}

public struct ControlSequenceGate: Sendable {
    private var highest: UInt64?

    public init() {}

    public mutating func accept(_ sequence: UInt64) -> Bool {
        if let highest, sequence <= highest { return false }
        highest = sequence
        return true
    }
}

private struct ControlEnvelopeHeader: Sendable, Equatable {
    static let magic: UInt32 = 0x54544B56 // TTKV
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

    static func decode(_ datagram: Data) throws -> ControlEnvelopeHeader {
        guard datagram.count >= encodedSize + TransportCipher.nonceBytes + TransportCipher.tagBytes else {
            throw ControlProtocolError.invalidLength
        }
        var cursor = ControlCursor(datagram)
        let magic: UInt32 = try cursor.readInteger()
        guard magic == Self.magic else { throw ControlProtocolError.badMagic }
        guard try cursor.readByte() == Self.version else { throw ControlProtocolError.unsupportedVersion }
        _ = try cursor.readByte()
        let length: UInt16 = try cursor.readInteger()
        guard length == encodedSize else { throw ControlProtocolError.invalidLength }
        let sequence: UInt64 = try cursor.readInteger()
        return ControlEnvelopeHeader(sequence: sequence)
    }
}

private extension Data {
    mutating func appendInteger<T: FixedWidthInteger>(_ value: T) {
        var value = value.bigEndian
        Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
    }
}

private struct ControlCursor {
    let data: Data
    var offset = 0

    init(_ data: Data) { self.data = data }

    mutating func readByte() throws -> UInt8 {
        guard offset < data.count else { throw ControlProtocolError.invalidLength }
        defer { offset += 1 }
        return data[offset]
    }

    mutating func readInteger<T: FixedWidthInteger>() throws -> T {
        let width = MemoryLayout<T>.size
        guard offset + width <= data.count else { throw ControlProtocolError.invalidLength }
        let slice = data[offset..<(offset + width)]
        offset += width
        var value: T = 0
        for byte in slice { value = (value << 8) | T(byte) }
        return value
    }
}
