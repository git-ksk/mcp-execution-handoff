import Foundation

public enum InputLane: UInt8, Sendable, Codable {
    case realtime = 1
    case critical = 2
}

public enum InputEventKind: UInt8, Sendable, Codable {
    case pointerMove = 1
    case pointerButton = 2
    case scroll = 3
    case key = 4
    case textCommit = 5
}

public struct InputEvent: Sendable, Equatable {
    public static let magic: UInt32 = 0x54544B49 // TTKI
    public static let version: UInt8 = 1
    public static let fixedHeaderBytes = 36

    public let lane: InputLane
    public let kind: InputEventKind
    public let sequence: UInt64
    public let clientNanos: UInt64
    public let x: Int32
    public let y: Int32
    public let value: Int32
    public let payload: Data

    public init(
        lane: InputLane,
        kind: InputEventKind,
        sequence: UInt64,
        clientNanos: UInt64,
        x: Int32 = 0,
        y: Int32 = 0,
        value: Int32 = 0,
        payload: Data = Data()
    ) {
        precondition(payload.count <= Int(UInt16.max))
        self.lane = lane
        self.kind = kind
        self.sequence = sequence
        self.clientNanos = clientNanos
        self.x = x
        self.y = y
        self.value = value
        self.payload = payload
    }

    public func encode() -> Data {
        var data = Data()
        data.reserveCapacity(Self.fixedHeaderBytes + payload.count)
        data.appendInteger(Self.magic)
        data.append(Self.version)
        data.append(lane.rawValue)
        data.append(kind.rawValue)
        data.append(0)
        data.appendInteger(sequence)
        data.appendInteger(clientNanos)
        data.appendInteger(UInt32(bitPattern: x))
        data.appendInteger(UInt32(bitPattern: y))
        data.appendInteger(UInt32(bitPattern: value))
        data.appendInteger(UInt16(payload.count))
        data.appendInteger(UInt16(0))
        data.append(payload)
        return data
    }

    public static func decode(_ data: Data) throws -> InputEvent {
        guard data.count >= fixedHeaderBytes else { throw InputProtocolError.truncated }
        var cursor = InputCursor(data)
        let magic: UInt32 = try cursor.readInteger()
        guard magic == Self.magic else { throw InputProtocolError.badMagic }
        let version = try cursor.readByte()
        guard version == Self.version else { throw InputProtocolError.unsupportedVersion }
        guard let lane = InputLane(rawValue: try cursor.readByte()) else { throw InputProtocolError.invalidLane }
        guard let kind = InputEventKind(rawValue: try cursor.readByte()) else { throw InputProtocolError.invalidKind }
        _ = try cursor.readByte()
        let sequence: UInt64 = try cursor.readInteger()
        let clientNanos: UInt64 = try cursor.readInteger()
        let xBits: UInt32 = try cursor.readInteger()
        let yBits: UInt32 = try cursor.readInteger()
        let valueBits: UInt32 = try cursor.readInteger()
        let payloadLength: UInt16 = try cursor.readInteger()
        _ = try cursor.readInteger() as UInt16
        guard cursor.offset + Int(payloadLength) == data.count else {
            throw InputProtocolError.invalidPayloadLength
        }
        let payload = data.subdata(in: cursor.offset..<data.count)
        return InputEvent(
            lane: lane,
            kind: kind,
            sequence: sequence,
            clientNanos: clientNanos,
            x: Int32(bitPattern: xBits),
            y: Int32(bitPattern: yBits),
            value: Int32(bitPattern: valueBits),
            payload: payload
        )
    }
}

public enum InputProtocolError: Error, Equatable {
    case truncated
    case badMagic
    case unsupportedVersion
    case invalidLane
    case invalidKind
    case invalidPayloadLength
}

public enum InputAcceptance: Sendable, Equatable {
    case accepted
    case duplicateOrStale
    case laneKindMismatch
}

/// Receiver-side replay/deduplication gate.
/// Realtime events are latest-wins. Critical events retain a 64-sequence replay window so
/// bounded retransmission can be used without injecting an action twice.
public struct InputSequenceGate: Sendable {
    private var latestRealtime: UInt64?
    private var criticalWindow = ReplayWindow()

    public init() {}

    public mutating func accept(_ event: InputEvent) -> InputAcceptance {
        guard laneIsValid(for: event) else { return .laneKindMismatch }
        switch event.lane {
        case .realtime:
            if let latestRealtime, event.sequence <= latestRealtime {
                return .duplicateOrStale
            }
            latestRealtime = event.sequence
            return .accepted
        case .critical:
            return criticalWindow.accept(event.sequence) ? .accepted : .duplicateOrStale
        }
    }

    private func laneIsValid(for event: InputEvent) -> Bool {
        switch event.kind {
        case .pointerMove:
            return event.lane == .realtime
        case .pointerButton, .key, .textCommit:
            return event.lane == .critical
        case .scroll:
            return true
        }
    }
}

private struct ReplayWindow: Sendable {
    private var highest: UInt64?
    private var bitmap: UInt64 = 0

    mutating func accept(_ sequence: UInt64) -> Bool {
        guard let highest else {
            self.highest = sequence
            bitmap = 1
            return true
        }

        if sequence > highest {
            let delta = sequence - highest
            bitmap = delta >= 64 ? 1 : (bitmap << delta) | 1
            self.highest = sequence
            return true
        }

        let age = highest - sequence
        guard age < 64 else { return false }
        let mask = UInt64(1) << age
        guard bitmap & mask == 0 else { return false }
        bitmap |= mask
        return true
    }
}

private extension Data {
    mutating func appendInteger<T: FixedWidthInteger>(_ value: T) {
        var value = value.bigEndian
        Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
    }
}

private struct InputCursor {
    let data: Data
    var offset = 0

    init(_ data: Data) { self.data = data }

    mutating func readByte() throws -> UInt8 {
        guard offset < data.count else { throw InputProtocolError.truncated }
        defer { offset += 1 }
        return data[offset]
    }

    mutating func readInteger<T: FixedWidthInteger>() throws -> T {
        let width = MemoryLayout<T>.size
        guard offset + width <= data.count else { throw InputProtocolError.truncated }
        let slice = data[offset..<(offset + width)]
        offset += width
        var value: T = 0
        for byte in slice { value = (value << 8) | T(byte) }
        return value
    }
}
