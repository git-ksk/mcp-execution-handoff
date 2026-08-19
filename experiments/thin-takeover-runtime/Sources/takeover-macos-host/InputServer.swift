import Foundation
import TakeoverCore

#if os(macOS)
import CoreGraphics

final class SecureInputServer: @unchecked Sendable {
    private let receiver: DatagramReceiver
    private let codec: SecureInputCodec
    private let lease: EphemeralSessionLease
    private let injector: MacOSInputInjector

    init(
        bindHost: String,
        port: UInt16,
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        displayID: CGDirectDisplayID,
        lease: EphemeralSessionLease
    ) throws {
        self.receiver = try DatagramReceiver(
            host: bindHost,
            port: port,
            receiveTimeoutMillis: 50,
            receiveBufferBytes: 131_072
        )
        self.codec = try SecureInputCodec(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation
        )
        self.lease = lease
        self.injector = MacOSInputInjector(displayID: displayID)
    }

    func run() {
        var gate = InputSequenceGate()
        defer { injector.releaseAll() }

        while lease.isActive() {
            do {
                guard let datagram = try receiver.receiveOrTimeout(maxBytes: 65_535) else {
                    continue
                }
                guard lease.isActive() else { break }
                let event = try codec.open(datagram)
                guard gate.accept(event) == .accepted else { continue }
                guard lease.isActive() else { break }
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
