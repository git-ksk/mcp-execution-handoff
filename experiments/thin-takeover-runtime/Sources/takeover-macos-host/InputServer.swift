import Foundation
import TakeoverCore

#if os(macOS)
final class SecureInputServer: @unchecked Sendable {
    private let receiver: DatagramReceiver
    private let codec: SecureInputCodec
    private let injector = MacOSInputInjector()

    init(
        bindHost: String,
        port: UInt16,
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32
    ) throws {
        self.receiver = try DatagramReceiver(host: bindHost, port: port)
        self.codec = try SecureInputCodec(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation
        )
    }

    func run() {
        var gate = InputSequenceGate()
        while true {
            do {
                let datagram = try receiver.receive(maxBytes: 65_535)
                let event = try codec.open(datagram)
                guard gate.accept(event) == .accepted else { continue }
                try injector.inject(event)
            } catch {
                // Human-plane input is fail-closed and best-effort. Invalid, stale, unauthenticated,
                // or unsupported events are dropped without changing authority.
                continue
            }
        }
    }
}
#endif
