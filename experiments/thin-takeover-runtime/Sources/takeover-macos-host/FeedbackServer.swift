import Foundation
import TakeoverCore

#if os(macOS)
final class SecureVideoFeedbackServer: @unchecked Sendable {
    private let receiver: DatagramReceiver
    private let codec: SecureFeedbackCodec
    private let lease: EphemeralSessionLease
    private let requestIDR: @Sendable () -> Void
    private let minIDRIntervalNanos: UInt64

    init(
        bindHost: String,
        port: UInt16,
        rootKey: Data,
        sessionHash: UInt64,
        epoch: UInt64,
        generation: UInt32,
        lease: EphemeralSessionLease,
        minIDRIntervalNanos: UInt64 = 150_000_000,
        requestIDR: @escaping @Sendable () -> Void
    ) throws {
        precondition(minIDRIntervalNanos > 0)
        self.receiver = try DatagramReceiver(
            host: bindHost,
            port: port,
            receiveTimeoutMillis: 50,
            receiveBufferBytes: 65_536
        )
        self.codec = try SecureFeedbackCodec(
            rootKey: rootKey,
            sessionHash: sessionHash,
            epoch: epoch,
            generation: generation,
            direction: .clientToHost,
            channel: .videoFeedback
        )
        self.lease = lease
        self.minIDRIntervalNanos = minIDRIntervalNanos
        self.requestIDR = requestIDR
    }

    func run() {
        var sequenceGate = FeedbackSequenceGate()
        var lastAcceptedRequestNanos: UInt64?
        while lease.isActive() {
            do {
                guard let datagram = try receiver.receiveOrTimeout(maxBytes: 4_096) else { continue }
                guard lease.isActive() else { break }
                let message = try codec.open(datagram)
                guard message.kind == .requestIDR else { continue }
                guard sequenceGate.accept(message.sequence) else { continue }

                let now = MonotonicClock.nowNanos()
                if let lastAcceptedRequestNanos,
                   now &- lastAcceptedRequestNanos < minIDRIntervalNanos {
                    continue
                }
                lastAcceptedRequestNanos = now
                requestIDR()
            } catch {
                // Feedback is advisory and fail-closed. Invalid, replayed or unauthenticated
                // packets can neither mutate authority nor force encoder work.
                continue
            }
        }
    }
}
#endif
