import Foundation
import TakeoverCore

#if os(macOS)
enum HostSessionKeySourceError: Error, CustomStringConvertible {
    case missing
    case invalidFileDescriptor
    case invalidKeyLength(Int)
    case invalidHex

    var description: String {
        switch self {
        case .missing:
            return "missing THIN_TAKEOVER_SESSION_KEY_FD or development THIN_TAKEOVER_SESSION_KEY_HEX"
        case .invalidFileDescriptor:
            return "invalid THIN_TAKEOVER_SESSION_KEY_FD"
        case .invalidKeyLength(let count):
            return "session key source returned \(count) bytes; expected \(TransportCipher.rootKeyBytes)"
        case .invalidHex:
            return "invalid THIN_TAKEOVER_SESSION_KEY_HEX"
        }
    }
}

/// Loads the ephemeral root transport key without requiring it in argv or durable storage.
///
/// Production embeddings should prefer an inherited read-only FD containing exactly 32 raw bytes.
/// The hex environment variable remains only as a development fallback for the standalone probe.
enum HostSessionKeySource {
    static func load(environment: [String: String] = ProcessInfo.processInfo.environment) throws -> Data {
        if let fdText = environment["THIN_TAKEOVER_SESSION_KEY_FD"] {
            guard let fd = Int32(fdText), fd >= 0 else { throw HostSessionKeySourceError.invalidFileDescriptor }
            let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
            var key = Data()
            key.reserveCapacity(TransportCipher.rootKeyBytes)
            while key.count < TransportCipher.rootKeyBytes {
                let remaining = TransportCipher.rootKeyBytes - key.count
                guard let chunk = try handle.read(upToCount: remaining), !chunk.isEmpty else { break }
                key.append(chunk)
            }
            guard key.count == TransportCipher.rootKeyBytes else {
                throw HostSessionKeySourceError.invalidKeyLength(key.count)
            }
            return key
        }

        guard let hex = environment["THIN_TAKEOVER_SESSION_KEY_HEX"] else {
            throw HostSessionKeySourceError.missing
        }
        guard let key = decodeHex(hex), key.count == TransportCipher.rootKeyBytes else {
            throw HostSessionKeySourceError.invalidHex
        }
        return key
    }

    private static func decodeHex(_ text: String) -> Data? {
        let bytes = Array(text.utf8)
        guard bytes.count.isMultiple(of: 2) else { return nil }
        var output = Data()
        output.reserveCapacity(bytes.count / 2)
        var index = 0
        while index < bytes.count {
            guard let high = nibble(bytes[index]), let low = nibble(bytes[index + 1]) else { return nil }
            output.append((high << 4) | low)
            index += 2
        }
        return output
    }

    private static func nibble(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 48...57: return byte - 48
        case 65...70: return byte - 55
        case 97...102: return byte - 87
        default: return nil
        }
    }
}
#endif
