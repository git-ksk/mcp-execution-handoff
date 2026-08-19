import CryptoKit
import Foundation

public enum TransportDirection: UInt8, Sendable, Codable {
    case hostToClient = 1
    case clientToHost = 2
}

public enum TransportChannel: UInt8, Sendable, Codable {
    case video = 1
    case inputRealtime = 2
    case inputCritical = 3
    case control = 4
}

public struct TransportCryptoContext: Sendable, Equatable {
    public let sessionHash: UInt64
    public let epoch: UInt64
    public let generation: UInt32
    public let direction: TransportDirection
    public let channel: TransportChannel

    public init(
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        direction: TransportDirection,
        channel: TransportChannel
    ) {
        self.sessionHash = sessionHash
        self.epoch = epoch
        self.generation = generation
        self.direction = direction
        self.channel = channel
    }
}

public enum TransportCryptoError: Error, Equatable {
    case invalidRootKeyLength
    case invalidTagLength
    case authenticationFailed
}

/// Frame/message-level AEAD for the thin transport.
///
/// The handoff/control plane owns key establishment. The runtime only receives a short-lived
/// 32-byte root key and derives a distinct ChaCha20-Poly1305 key for each
/// session/epoch/generation/direction/channel tuple. The sequence number is used only as the
/// per-derived-key nonce, so callers must never reuse a sequence within one context.
public struct TransportCipher: Sendable {
    public static let rootKeyBytes = 32
    public static let tagBytes = 16

    private let rootKeyData: Data

    public init(rootKey: Data) throws {
        guard rootKey.count == Self.rootKeyBytes else {
            throw TransportCryptoError.invalidRootKeyLength
        }
        self.rootKeyData = rootKey
    }

    public func seal(
        _ plaintext: Data,
        sequence: UInt64,
        context: TransportCryptoContext,
        associatedData: Data = Data()
    ) throws -> Data {
        let key = derivedKey(for: context)
        let nonce = try ChaChaPoly.Nonce(data: nonceData(sequence: sequence))
        let aad = contextAAD(context: context, sequence: sequence, associatedData: associatedData)
        let box = try ChaChaPoly.seal(plaintext, using: key, nonce: nonce, authenticating: aad)
        var output = Data()
        output.reserveCapacity(box.ciphertext.count + box.tag.count)
        output.append(box.ciphertext)
        output.append(box.tag)
        return output
    }

    public func open(
        _ sealedPayload: Data,
        sequence: UInt64,
        context: TransportCryptoContext,
        associatedData: Data = Data()
    ) throws -> Data {
        guard sealedPayload.count >= Self.tagBytes else {
            throw TransportCryptoError.invalidTagLength
        }
        let split = sealedPayload.count - Self.tagBytes
        let ciphertext = sealedPayload.prefix(split)
        let tag = sealedPayload.suffix(Self.tagBytes)
        let key = derivedKey(for: context)
        let nonce = try ChaChaPoly.Nonce(data: nonceData(sequence: sequence))
        let aad = contextAAD(context: context, sequence: sequence, associatedData: associatedData)
        do {
            let box = try ChaChaPoly.SealedBox(
                nonce: nonce,
                ciphertext: Data(ciphertext),
                tag: Data(tag)
            )
            return try ChaChaPoly.open(box, using: key, authenticating: aad)
        } catch {
            throw TransportCryptoError.authenticationFailed
        }
    }

    private func derivedKey(for context: TransportCryptoContext) -> SymmetricKey {
        let root = SymmetricKey(data: rootKeyData)
        let info = contextKeyInfo(context)
        return HKDF<SHA256>.deriveKey(
            inputKeyMaterial: root,
            salt: Data("thin-takeover-runtime/v1".utf8),
            info: info,
            outputByteCount: Self.rootKeyBytes
        )
    }

    private func nonceData(sequence: UInt64) -> Data {
        var data = Data(repeating: 0, count: 4)
        data.appendInteger(sequence)
        return data
    }

    private func contextKeyInfo(_ context: TransportCryptoContext) -> Data {
        var data = Data("TTKR-key-v1".utf8)
        data.appendInteger(context.sessionHash)
        data.appendInteger(context.epoch)
        data.appendInteger(context.generation)
        data.append(context.direction.rawValue)
        data.append(context.channel.rawValue)
        return data
    }

    private func contextAAD(
        context: TransportCryptoContext,
        sequence: UInt64,
        associatedData: Data
    ) -> Data {
        var data = Data("TTKR-aad-v1".utf8)
        data.appendInteger(context.sessionHash)
        data.appendInteger(context.epoch)
        data.appendInteger(context.generation)
        data.append(context.direction.rawValue)
        data.append(context.channel.rawValue)
        data.appendInteger(sequence)
        data.append(associatedData)
        return data
    }
}

private extension Data {
    mutating func appendInteger<T: FixedWidthInteger>(_ value: T) {
        var value = value.bigEndian
        Swift.withUnsafeBytes(of: &value) { append(contentsOf: $0) }
    }
}
