import Foundation
import TakeoverCore

#if os(macOS)
final class SecureControlServer: @unchecked Sendable {
    private let receiver: DatagramReceiver
    private let codec: SecureControlCodec
    private let lease: EphemeralSessionLease

    init(
        bindHost: String,
        port: UInt16,
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        lease: EphemeralSessionLease
    ) throws {
        self.receiver = try DatagramReceiver(
            host: bindHost,
            port: port,
            receiveTimeoutMillis: 50,
            receiveBufferBytes: 65_536
        )
        self.codec = try SecureControlCodec(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation
        )
        self.lease = lease
    }

    func run() {
        var sequenceGate = ControlSequenceGate()
        while lease.isActive() {
            do {
                guard let datagram = try receiver.receiveOrTimeout(maxBytes: 4_096) else {
                    continue
                }
                guard lease.isActive() else { break }
                let message = try codec.open(datagram)
                guard sequenceGate.accept(message.sequence) else { continue }
                switch message.kind {
                case .revoke:
                    lease.revoke()
                    return
                }
            } catch {
                // Control datagrams are fail-closed. Invalid, stale or unauthenticated packets
                // cannot alter authority or extend the lease.
                continue
            }
        }
    }
}
#endif
