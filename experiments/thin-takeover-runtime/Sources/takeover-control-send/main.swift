import Foundation
import TakeoverCore

private enum ControlSendError: Error, CustomStringConvertible {
    case missing(String)
    case invalid(String)

    var description: String {
        switch self {
        case .missing(let name): return "missing required environment variable \(name)"
        case .invalid(let name): return "invalid value for \(name)"
        }
    }
}

private func decodeHex(_ text: String) -> Data? {
    let bytes = Array(text.utf8)
    guard bytes.count.isMultiple(of: 2) else { return nil }
    var output = Data()
    output.reserveCapacity(bytes.count / 2)
    var index = 0
    while index < bytes.count {
        func nibble(_ byte: UInt8) -> UInt8? {
            switch byte {
            case 48...57: return byte - 48
            case 65...70: return byte - 55
            case 97...102: return byte - 87
            default: return nil
            }
        }
        guard let high = nibble(bytes[index]), let low = nibble(bytes[index + 1]) else { return nil }
        output.append((high << 4) | low)
        index += 2
    }
    return output
}

@main
struct TakeoverControlSend {
    static func main() throws {
        let env = ProcessInfo.processInfo.environment
        guard let keyHex = env["THIN_TAKEOVER_SESSION_KEY_HEX"],
              let rootKey = decodeHex(keyHex),
              rootKey.count == TransportCipher.rootKeyBytes else {
            throw ControlSendError.missing("THIN_TAKEOVER_SESSION_KEY_HEX")
        }
        guard let sessionHex = env["THIN_TAKEOVER_SESSION_HASH_HEX"],
              sessionHex.count == 16,
              let sessionHash = UInt64(sessionHex, radix: 16) else {
            throw ControlSendError.missing("THIN_TAKEOVER_SESSION_HASH_HEX")
        }
        guard let epochText = env["THIN_TAKEOVER_EPOCH"], let epoch = UInt64(epochText) else {
            throw ControlSendError.missing("THIN_TAKEOVER_EPOCH")
        }
        guard let generationText = env["THIN_TAKEOVER_GENERATION"], let generation = UInt32(generationText) else {
            throw ControlSendError.missing("THIN_TAKEOVER_GENERATION")
        }

        let host = CommandLine.arguments.dropFirst().first ?? "127.0.0.1"
        let port = UInt16(CommandLine.arguments.dropFirst(2).first ?? "45557") ?? 45557
        var rng = SystemRandomNumberGenerator()
        let sequence = UInt64.random(in: 1...UInt64.max, using: &rng)

        let codec = try SecureControlCodec(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation
        )
        let datagram = try codec.seal(ControlMessage(kind: .revoke, sequence: sequence))
        let sender = try DatagramSender(host: host, port: port)
        try sender.send(datagram)
        print("authenticated revoke sent to \(host):\(port)")
    }
}
